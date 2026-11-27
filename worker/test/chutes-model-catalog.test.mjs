import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { CHUTES_MODELS_FORMAT, chutesCatalogRequest, filterChutesModels, readChutesModels } = await import("../chutes-model-catalog.ts");
const ids = ["deepseek-ai/DeepSeek-V3.2-TEE", "moonshotai/Kimi-K2.6-TEE", "zai-org/GLM-5.2-TEE", "Qwen/Qwen3.6-27B-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"];
const row = (id = ids[0]) => ({ id, object: "model" });
const list = (...data) => ({ object: "list", data });
const allows = id => ids.includes(id);
const signal = () => new AbortController().signal;
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Chutes model catalog is invalid or exceeds the discovery bound";

test("Chutes documented public discovery omits all inference and OAuth credentials", () => {
  assert.equal(CHUTES_MODELS_FORMAT, "chutes.models");
  for (const base of ["https://llm.chutes.ai/v1", "https://llm.chutes.ai/v1/"]) {
    const controller = new AbortController(), r = chutesCatalogRequest(base, controller.signal);
    assert.equal(r.url, "https://llm.chutes.ai/v1/models"); assert.equal(r.method, "GET"); assert.equal(r.body, null);
    assert.deepEqual([...r.headers], [["accept", "application/json"]]); assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "manual");
    controller.abort(); assert.equal(r.signal.aborted, true);
  }
});

test("Chutes discovery rejects control-plane, OAuth, proxy and noncanonical origins", () => {
  for (const base of ["https://api.chutes.ai", "https://api.chutes.ai/idp", "https://chutes.ai/v1", "https://proxy.example/v1",
    "http://llm.chutes.ai/v1", "https://llm.chutes.ai:444/v1", "https://llm.chutes.ai/v1?key=synthetic-private",
    "https://llm.chutes.ai/v1#fragment", "https://synthetic-private@llm.chutes.ai/v1", "https://llm.chutes.ai/x/../v1",
    "https://llm.chutes.ai/%2e%2e/v1", "https://llm.chutes.ai/v1//", null]) {
    assert.throws(() => chutesCatalogRequest(base, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

for (const id of ids) test(`Chutes native catalog preserves frozen ID ${id}`, () => {
  assert.deepEqual(filterChutesModels(list(row(id)), allows), list(row(id)));
});

test("Chutes exact original-policy filtering does not inherit a public inventory entitlement", () => {
  for (const permitted of ["chutes/" + ids[0], "*", "deepseek-ai/*", ids[0].toLowerCase()]) {
    assert.deepEqual(filterChutesModels(list(row()), id => id === permitted), list());
  }
  assert.deepEqual(filterChutesModels(list(...ids.map(row)), () => false), list());
  assert.deepEqual(filterChutesModels(list(), allows), list());
  assert.deepEqual(filterChutesModels(list(row("synthetic-ungranted")), allows), list());
  assert.deepEqual(filterChutesModels(list(row("synthetic-ungranted")), id => id === "synthetic-ungranted"), list(row("synthetic-ungranted")));
});

test("Chutes empty or partial native lists never restore frozen seeds or replacement models", () => {
  const deprecated = ids[4];
  assert.deepEqual(filterChutesModels(list(row(deprecated)), allows), list(row(deprecated)));
  assert.deepEqual(filterChutesModels(list(), allows), list());
});

test("Chutes names and TEE suffixes never invent reasoning, modalities, confidentiality or zero prices", () => {
  const native = { ...row(), name: "reasoning vision TEE", root: "synthetic-alias", parent: "synthetic-parent" };
  assert.deepEqual(filterChutesModels(list(native), allows), list(row()));
});

test("Chutes preserves explicit empty features and boolean confidentiality observations only", () => {
  for (const value of [undefined, null, "true", 1, {}]) {
    assert.deepEqual(filterChutesModels(list({ ...row(), confidential_compute: value }), allows), list(row()));
  }
  for (const value of [true, false]) {
    const native = { ...row(), supported_features: [], supported_sampling_parameters: [], confidential_compute: value };
    assert.deepEqual(filterChutesModels(list(native), allows), list(native));
  }
});

test("Chutes optional modalities and feature lists are bounded without default claims", () => {
  for (const [field, max] of [["input_modalities", 16], ["output_modalities", 16], ["supported_features", 32], ["supported_sampling_parameters", 64]]) {
    for (const value of [null, "text", [null], ["bad value"], Array(max + 1).fill("text"), ["x".repeat(129)]]) {
      assert.deepEqual(filterChutesModels(list({ ...row(), [field]: value }), allows), list(row()));
    }
  }
  const native = { ...row(), input_modalities: ["text", "image", "video"], output_modalities: ["text"], supported_features: ["tools", "reasoning"], supported_sampling_parameters: ["temperature"] };
  assert.deepEqual(filterChutesModels(list(native), allows), list(native));
});

test("Chutes explicit non-text modalities cannot become Chat rows", () => {
  for (const patch of [{ input_modalities: ["image"] }, { input_modalities: [] }, { output_modalities: ["embedding"] }, { output_modalities: [] }]) {
    assert.deepEqual(filterChutesModels(list({ ...row(), ...patch }), allows), list());
  }
});

test("Chutes context, native model length and output limits remain separate observations", () => {
  const native = { ...row(), context_length: 4096, max_model_len: 8192, max_output_length: 1024 };
  assert.deepEqual(filterChutesModels(list(native), allows), list(native));
  for (const field of ["context_length", "max_model_len", "max_output_length"]) {
    for (const value of [null, 0, -1, 0.5, "4096", Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(filterChutesModels(list({ ...row(), [field]: value }), allows), list(row()));
    }
    assert.deepEqual(filterChutesModels(list({ ...row(), [field]: 8192 }), allows), list({ ...row(), [field]: 8192 }));
  }
});

test("Chutes numeric prices preserve independent observations without coercion, unit math or cache defaults", () => {
  const pricing = { prompt: 0.2, completion: 0.8, input_cache_read: 0.019999999999999997 };
  assert.deepEqual(filterChutesModels(list({ ...row(), pricing }), allows), list({ ...row(), pricing }));
  for (const prompt of [undefined, null, "0.2", -1, Infinity, NaN, 1_000_001, {}]) {
    assert.deepEqual(filterChutesModels(list({ ...row(), pricing: { prompt } }), allows), list(row()));
  }
  assert.deepEqual(filterChutesModels(list({ ...row(), pricing: { prompt: 0 } }), allows), list({ ...row(), pricing: { prompt: 0 } }));
  assert.deepEqual(filterChutesModels(list({ ...row(), price: { input: { usd: 1, tao: 2 } } }), allows), list(row()));
});

test("Chutes rejects malformed root lists, pagination, duplicates and model identities", () => {
  for (const payload of [null, [], {}, { data: [] }, { object: "list", data: {} }, { ...list(), error: "synthetic-private" },
    { ...list(), has_more: true }, { ...list(), next: "cursor" }, list(null), list({}), list({ id: ids[0] }), list({ ...row(), object: "embedding" }),
    list({ ...row(), id: "" }), list({ ...row(), id: "bad id" }), list({ ...row(), id: "bad\0id" }), list({ ...row(), id: "x".repeat(513) }),
    list(row(), row()), list(...Array(4097).fill(null))]) assert.throws(() => filterChutesModels(payload, allows), invalid);
});

test("Chutes projects stable named metadata without control-plane routing hints or secrets", () => {
  const native = { ...row(), chute_id: "synthetic-private", api_key: "synthetic-private", endpoint: "https://untrusted.example",
    supported_features: ["tools", "tools"] };
  const result = filterChutesModels(list(native, row(ids[3])), allows);
  assert.deepEqual(result, list(row(ids[3]), { ...row(), supported_features: ["tools"] }));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted/);
});

test("Chutes complete native reader preserves fragmented lists", async () => {
  const body = list(row()), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readChutesModels(response, signal(), allows), body);
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
]) test(`Chutes reader rejects ${name} without credential retry or exposing content`, async () => {
  await assert.rejects(readChutesModels(make(), signal(), allows), invalid);
});

test("Chutes catalog reader requires EOF and cancels incomplete delivery", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readChutesModels(response, controller.signal, allows).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Chutes catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/chutes-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
