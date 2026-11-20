import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { FEATHERLESS_MODELS_FORMAT, featherlessCatalogRequest, filterFeatherlessModels, readFeatherlessModels } = await import("../featherless-model-catalog.ts");
const id = "Qwen/Qwen3-32B", key = "synthetic-selected-featherless-key";
const row = (model = id) => ({ id: model });
const page = (data = [row()], current = 1, total = 1) => ({ data,
  pagination: { current_page: current, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100) }, total });
const allows = value => value === id;
const signal = () => new AbortController().signal;
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Featherless model catalog is invalid or exceeds the discovery bound";

test("Featherless discovery pins canonical Chat query, original credential and bounded page", () => {
  assert.equal(FEATHERLESS_MODELS_FORMAT, "featherless.models");
  for (const base of ["https://api.featherless.ai/v1", "https://api.featherless.ai/v1/"]) {
    for (const number of [1, 2, 1000]) {
      const controller = new AbortController(), r = featherlessCatalogRequest(base, key, number, controller.signal);
      assert.equal(r.url, `https://api.featherless.ai/v1/models?capabilities=chat&page=${number}&per_page=100`);
      assert.equal(r.method, "GET"); assert.equal(r.body, null);
      assert.deepEqual([...r.headers], [["accept", "application/json"], ["authorization", `Bearer ${key}`]]);
      assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "manual");
      controller.abort(); assert.equal(r.signal.aborted, true);
    }
  }
});

test("Featherless rejects alternate destinations and auth fallback before request construction", () => {
  for (const base of ["https://featherless.ai/v1", "http://api.featherless.ai/v1", "https://proxy.example/v1",
    "https://api.featherless.ai:444/v1", "https://api.featherless.ai/v1?key=synthetic-private", "https://api.featherless.ai/v1#fragment",
    "https://synthetic-private@api.featherless.ai/v1", "https://api.featherless.ai/x/../v1", "https://api.featherless.ai/%2e%2e/v1", null]) {
    assert.throws(() => featherlessCatalogRequest(base, key, 1, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
  for (const value of [undefined, null, "", " bad", "bad key", "bad\nkey", "x".repeat(8193)]) {
    assert.throws(() => featherlessCatalogRequest("https://api.featherless.ai/v1", value, 1, signal()), e => e.status === 503);
  }
  for (const value of [undefined, null, 0, -1, 1.5, "2", 1001, NaN, Infinity]) {
    assert.throws(() => featherlessCatalogRequest("https://api.featherless.ai/v1", key, value, signal()), e => e.status === 503);
  }
});

test("Featherless preserves exact original-policy filtering and upstream pagination independently", () => {
  const native = page([row(), row("synthetic-ungranted")], 1, 844);
  for (const allowed of ["featherless/" + id, "Qwen/*", "*", id.toLowerCase()]) {
    assert.deepEqual(filterFeatherlessModels(native, value => value === allowed, 1), page([], 1, 844));
  }
  assert.deepEqual(filterFeatherlessModels(native, allows, 1), page([row()], 1, 844));
  assert.deepEqual(filterFeatherlessModels(native, value => value === "synthetic-ungranted", 1), page([row("synthetic-ungranted")], 1, 844));
});

test("Featherless short, empty and fully filtered intermediate pages retain next-page evidence", () => {
  for (const data of [[], [row()], [row("synthetic-ungranted")]]) {
    const result = filterFeatherlessModels(page(data, 2, 844), allows, 2);
    assert.equal(result.pagination.current_page, 2); assert.equal(result.pagination.total_pages, 9);
    assert.equal(result.pagination.per_page, 100); assert.equal(result.total, 844);
  }
});

test("Featherless authentic empty and last pages do not restore a seed or fabricate a cursor", () => {
  assert.deepEqual(filterFeatherlessModels(page([], 1, 0), allows, 1), page([], 1, 0));
  const empty = page([], 1, 0); empty.pagination.total_pages = 1;
  assert.deepEqual(filterFeatherlessModels(empty, allows, 1), empty);
  assert.deepEqual(filterFeatherlessModels(page([], 9, 844), allows, 9), page([], 9, 844));
});

test("Featherless rejects missing pagination instead of guessing completeness from the documented minimal list", () => {
  for (const payload of [{ data: [] }, { data: [row()] }, { object: "list", data: [row()] },
    { ...page(), next: "https://untrusted.example" }, { ...page(), has_more: true }, { ...page(), error: "synthetic-private" }]) {
    assert.throws(() => filterFeatherlessModels(payload, allows, 1), invalid);
  }
});

test("Featherless rejects changed, malformed or unbounded page evidence", () => {
  for (const [field, values] of [
    ["current_page", [0, 2, "1", null]], ["per_page", [2, 101, "100", null]],
    ["total_items", [-1, 1.5, "1", null, 100001]], ["total_pages", [-1, 0, 2, "1", null, 1001]],
    ["next_url", ["https://untrusted.example"]],
  ]) for (const value of values) {
    const native = page(); native.pagination[field] = value;
    assert.throws(() => filterFeatherlessModels(native, allows, 1), invalid);
  }
  for (const payload of [null, [], {}, { ...page(), data: {} }, { ...page(), total: 2 }, { ...page(), total: "1" },
    { ...page(), pagination: null }, page([row()], 2, 1), page([row()], 1, 0), page([], 2, 0),
    page(Array.from({ length: 101 }, (_, i) => row(`synthetic-${i}`)), 1, 200)]) {
    assert.throws(() => filterFeatherlessModels(payload, allows, 1), invalid);
  }
  for (const expected of [null, "1", 0, 1001]) assert.throws(() => filterFeatherlessModels(page(), allows, expected), invalid);
});

test("Featherless filters explicit plan denial without treating an absent field as eligibility", () => {
  assert.deepEqual(filterFeatherlessModels(page([{ ...row(), available_on_current_plan: false }]), allows, 1), page([]));
  for (const is_gated of [true, false]) {
    const native = page([{ ...row(), available_on_current_plan: true, is_gated }]);
    assert.deepEqual(filterFeatherlessModels(native, allows, 1), native);
  }
  assert.deepEqual(filterFeatherlessModels(page(), allows, 1), page());
  for (const value of [null, 0, "false", "true", {}]) {
    assert.throws(() => filterFeatherlessModels(page([{ ...row(), available_on_current_plan: value }]), allows, 1), invalid);
  }
});

test("Featherless non-active or non-model observations do not become Chat offers", () => {
  for (const patch of [{ status: "pending_deploy" }, { status: "not_deployed" }, { status: "unknown" }, { object: "embedding" }]) {
    assert.deepEqual(filterFeatherlessModels(page([{ ...row(), ...patch }]), allows, 1), page([]));
  }
  assert.deepEqual(filterFeatherlessModels(page([{ ...row(), status: "active", object: "model" }]), allows, 1), page());
});

test("Featherless native limits and concurrency are independent observations, not fallback plan limits", () => {
  for (const field of ["context_length", "max_completion_tokens", "concurrency_cost"]) {
    for (const value of [undefined, null, 0, -1, "4096", 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(filterFeatherlessModels(page([{ ...row(), [field]: value }]), allows, 1), page());
    }
    const native = page([{ ...row(), [field]: 4096 }]);
    assert.deepEqual(filterFeatherlessModels(native, allows, 1), native);
  }
});

test("Featherless feature and pricing observations never infer name-based facts, unit math or cache defaults", () => {
  const native = page([{ ...row(), features: { tool_use: true, image_input: false }, pricing: { prompt: "0.000000102", completion: "0.000000493" } }]);
  assert.deepEqual(filterFeatherlessModels(native, allows, 1), native);
  assert.deepEqual(filterFeatherlessModels(page([{ ...row(), name: "reasoning vision", features: { tool_use: "true" }, pricing: {} }]), allows, 1), page());
  for (const value of [null, 0.2, "-1", "1e-7", "NaN", "1000000", "0.1234567890123456789"]) {
    assert.deepEqual(filterFeatherlessModels(page([{ ...row(), pricing: { prompt: value } }]), allows, 1), page());
  }
  assert.deepEqual(filterFeatherlessModels(page([{ ...row(), pricing: { prompt: "0" } }]), allows, 1), page([{ ...row(), pricing: { prompt: "0" } }]));
});

test("Featherless rejects duplicate or malformed IDs even when the original grant would remove them", () => {
  for (const data of [[null], [{}], [row(), row()], [row("")], [row("bad id")], [row("bad\0id")], [row("x".repeat(513))]]) {
    assert.throws(() => filterFeatherlessModels(page(data, 1, 100), () => false, 1), invalid);
  }
});

test("Featherless projects named fields without routing hints, secrets, loading guesses or HuggingFace entitlement", () => {
  const native = page([{ ...row(), api_key: "synthetic-private", endpoint: "https://untrusted.example", huggingface_id: "synthetic-alias",
    availability: { tier: "warm", is_hot_live: true }, license: "synthetic-license", parameters: 32_000_000_000 }]);
  const result = filterFeatherlessModels(native, allows, 1);
  assert.deepEqual(result, page()); assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted|warm|synthetic-alias/);
});

test("Featherless complete reader binds fragmented JSON to the requested page", async () => {
  const body = page([row()], 2, 844), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readFeatherlessModels(response, signal(), allows, 2), body);
  await assert.rejects(readFeatherlessModels(Response.json(body), signal(), allows, 1), invalid);
});

for (const [name, make] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 401 })],
  ["wrong MIME", () => new Response("{}", { headers: { "content-type": "text/html" } })],
  ["partial range", () => Response.json({}, { headers: { "content-range": "bytes 0-1/20" } })],
  ["truncated length", () => Response.json({}, { headers: { "content-length": "20" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => Response.json({}, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`Featherless reader rejects ${name} without anonymous retry or exposing content`, async () => {
  await assert.rejects(readFeatherlessModels(make(), signal(), allows, 1), invalid);
});

test("Featherless catalog reader requires EOF and cancels incomplete delivery", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(page()))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readFeatherlessModels(response, controller.signal, allows, 1).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Featherless catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/featherless-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
