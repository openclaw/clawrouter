import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
const { deepinfraCatalogRequests, parseDeepInfraCatalog, readDeepInfraCatalog } = await import("../deepinfra-model-catalog.ts");

const signal = () => new AbortController().signal;
const allowed = new Set(["deepseek-ai/DeepSeek-V4-Flash", "zai-org/GLM-5.1"]);
const row = (id = "deepseek-ai/DeepSeek-V4-Flash", tags = ["chat", "reasoning"]) => ({ id, object: "model",
  metadata: { tags, context_length: 1048576, max_tokens: 1048576 } });
const prices = (model_name = "deepseek-ai/DeepSeek-V4-Flash") => ({ model_name, deprecated: null, replaced_by: null,
  pricing: { type: "tokens", cents_per_input_token: 0.0001, cents_per_output_token: 0.0002, discount: 0.25, rate_per_input_token_cached: 0.1 } });
const list = (...data) => ({ object: "list", data });
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const invalid = e => e.status === 502 && e.code === "provider_catalog_invalid" && e.message === "DeepInfra model catalog is invalid";

test("DeepInfra codec loads in native Node without the test resolver hook", () => {
  execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const codec = await import(${JSON.stringify(new URL("../deepinfra-model-catalog.ts", import.meta.url).href)}); if (typeof codec.readDeepInfraCatalog !== "function") throw new Error("missing native catalog export");`],
  { encoding: "utf8", timeout: 10000 });
});

// Every value is synthetic. Observed native prices are not checked in as tariffs.
test("DeepInfra requests isolate the original credential from public metadata pricing", () => {
  for (const base of ["https://api.deepinfra.com/v1/openai", "https://api.deepinfra.com/v1/openai/"]) {
    const controller = new AbortController();
    const requests = deepinfraCatalogRequests(base, "synthetic-selected-key", controller.signal);
    assert.equal(requests.metadata.url, "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta");
    assert.equal(requests.metadata.headers.get("authorization"), "Bearer synthetic-selected-key");
    assert.equal(requests.pricing.url, "https://api.deepinfra.com/models/list");
    assert.deepEqual([...requests.pricing.headers], [["accept", "application/json"]]);
    for (const request of Object.values(requests)) {
      assert.equal(request.method, "GET"); assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit"); assert.equal(request.body, null);
    }
    controller.abort(); assert.equal(requests.metadata.signal.aborted, true); assert.equal(requests.pricing.signal.aborted, true);
  }
});

test("DeepInfra requests reject alternate origins, paths and missing credentials", () => {
  for (const base of ["https://proxy.example/v1/openai", "http://api.deepinfra.com/v1/openai", "https://api.deepinfra.com/v1",
    "https://api.deepinfra.com/v1/openai?key=synthetic-private", "https://api.deepinfra.com/v1/openai#x",
    "https://synthetic-private@api.deepinfra.com/v1/openai", "https://api.deepinfra.com:444/v1/openai",
    "https://api.deepinfra.com/x/../v1/openai", "https://api.deepinfra.com/%2e%2e/v1/openai"]) {
    assert.throws(() => deepinfraCatalogRequests(base, "synthetic-selected-key", signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
  for (const key of ["", " synthetic-private", "synthetic-private\r\nx: y", "é", "x".repeat(8193), null]) {
    assert.throws(() => deepinfraCatalogRequests("https://api.deepinfra.com/v1/openai", key, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

test("DeepInfra preserves native facts and pricing units without inventing completion limits", () => {
  assert.deepEqual(parseDeepInfraCatalog(list(row()), [prices()], allowed), { models: [{
    id: row().id, tags: ["chat", "reasoning"], contextWindow: 1048576, nativeMaxTokens: 1048576,
    reasoning: true, vision: null,
    pricing: { currency: "USD", unit: "cents_per_token", input: 0.0001, output: 0.0002, discount: 0.25, cachedInputRatio: 0.1 },
  }], availability: [] });
});

test("DeepInfra native chat bucket wins over VLM fallback before original-policy filtering", () => {
  const vision = row("vision-model", ["vlm"]), chat = row();
  assert.deepEqual(parseDeepInfraCatalog(list(chat, vision), [], new Set([vision.id])).models, []);
  assert.equal(parseDeepInfraCatalog(list(vision), [], new Set([vision.id])).models[0].vision, true);
  assert.deepEqual(parseDeepInfraCatalog(list(row("image", ["image-gen"]), row("video", ["video-gen"])), [], allowed).models, []);
});

test("DeepInfra missing limits and feature tags remain unknown", () => {
  const native = row(); native.metadata = { tags: ["chat"], context_length: -1, max_tokens: "4096" };
  const [model] = parseDeepInfraCatalog(list(native), [], allowed).models;
  assert.equal(model.contextWindow, null); assert.equal(model.nativeMaxTokens, null);
  assert.equal(model.reasoning, null); assert.equal(model.vision, null); assert.equal(model.pricing, null);
});

test("DeepInfra null metadata is skipped, but an entirely unusable nonempty response fails", () => {
  const unavailable = { id: "unknown", object: "model", metadata: null };
  assert.equal(parseDeepInfraCatalog(list(unavailable, row()), [], allowed).models.length, 1);
  assert.throws(() => parseDeepInfraCatalog(list(unavailable), [], allowed), invalid);
  assert.deepEqual(parseDeepInfraCatalog(list(), [], allowed), { models: [], availability: [] });
});

test("DeepInfra upstream replacement preserves the selected ID even when missing from active inventory", () => {
  const alias = { ...prices("zai-org/GLM-5.1"), deprecated: 1790896957, replaced_by: "zai-org/GLM-5.3" };
  const result = parseDeepInfraCatalog(list(row()), [prices(), alias], allowed);
  assert.deepEqual(result.availability, [{ id: "zai-org/GLM-5.1", deprecatedAt: 1790896957, servingModel: "zai-org/GLM-5.3" }]);
  assert.deepEqual(result.models.map(model => model.id), [row().id]);
  assert.deepEqual(parseDeepInfraCatalog(list(), [alias], new Set()).availability, []);
  const selected = parseDeepInfraCatalog(list(row("zai-org/GLM-5.1")), [alias], allowed);
  assert.equal(selected.models[0].id, "zai-org/GLM-5.1");
  assert.equal(selected.models.some(model => model.id === "zai-org/GLM-5.3"), false);
});

test("DeepInfra deprecation without a replacement does not invent stopped status", () => {
  const result = parseDeepInfraCatalog(list(), [{ ...prices(), deprecated: 1790896957 }], allowed);
  assert.deepEqual(result.availability, [{ id: row().id, deprecatedAt: 1790896957, servingModel: null }]);
});

test("DeepInfra filters exact identities and never seeds an unadvertised model", () => {
  for (const policy of [new Set(), new Set(["*"]), new Set(["deepseek-ai/*"]), new Set(["zai-org/GLM-5.1"])]) {
    assert.deepEqual(parseDeepInfraCatalog(list(row()), [prices()], policy), { models: [], availability: [] });
  }
});

test("DeepInfra projects only named fields with stable order", () => {
  const a = row("a-model"), b = { ...row(), api_key: "synthetic-private", endpoint: "https://untrusted.example" };
  const result = parseDeepInfraCatalog(list(b, a), [prices()], new Set([a.id, b.id]));
  assert.deepEqual(result.models.map(model => model.id), [a.id, b.id]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted/);
});

test("DeepInfra rejects malformed or duplicate metadata identities and unbounded envelopes", () => {
  for (const metadata of [null, [], {}, { data: [] }, { object: "model", data: [] }, list(null), list(row(), row()),
    list({ ...row(), object: "embedding" }), list({ ...row(), id: " bad " }), list({ ...row(), id: "x".repeat(513) }),
    list({ ...row(), metadata: {} }), list({ ...row(), metadata: { tags: [null] } }),
    list({ ...row(), metadata: { tags: Array(65).fill("chat") } }), list(...Array(4097).fill(row()))]) {
    assert.throws(() => parseDeepInfraCatalog(metadata, [], allowed), invalid);
  }
});

test("DeepInfra rejects malformed native inventory and invalid availability rather than reactivating it", () => {
  for (const pricing of [null, {}, { data: [] }, [null], [prices(), prices()], [{ ...prices(), model_name: "bad id" }],
    [{ ...prices(), deprecated: "yesterday" }], [{ ...prices(), deprecated: -1 }], [{ ...prices(), deprecated: 1.2 }],
    [{ ...prices(), replaced_by: {} }], [{ ...prices(), replaced_by: row().id }], Array(4097).fill(prices())]) {
    assert.throws(() => parseDeepInfraCatalog(list(row()), pricing, allowed), invalid);
  }
});

test("DeepInfra unsupported or conditional prices remain unknown", () => {
  for (const patch of [{ type: "time" }, { cents_per_input_token: -1 }, { cents_per_output_token: Infinity },
    { cents_per_input_token: "0.1" }, { discount: 1.1 }, { discount: "0" }, { rate_per_input_token_cached: -1 },
    { full: "contact sales" }, { table: { rows: [] } }, { table: [] }, { discount_ends_at: 1893456000 },
    { rate_per_input_token_cache_write: 1.2 }]) {
    assert.equal(parseDeepInfraCatalog(list(row()), [{ ...prices(), pricing: { ...prices().pricing, ...patch } }], allowed).models[0].pricing, null);
  }
  for (const pricing of [null, undefined, {}]) {
    assert.equal(parseDeepInfraCatalog(list(row()), [{ ...prices(), pricing }], allowed).models[0].pricing, null);
  }
});

test("DeepInfra missing cache and discount fields remain unknown while explicit zero is preserved", () => {
  const pricing = { type: "tokens", cents_per_input_token: 0, cents_per_output_token: 0 };
  const model = parseDeepInfraCatalog(list(row()), [{ ...prices(), pricing }], allowed).models[0];
  assert.deepEqual(model.pricing, { currency: "USD", unit: "cents_per_token", input: 0, output: 0, discount: null, cachedInputRatio: null });
});

test("DeepInfra bounded readers project both native responses", async () => {
  assert.deepEqual(await readDeepInfraCatalog({ metadata: json(list(row())), pricing: json([prices()]) }, signal(), allowed),
    parseDeepInfraCatalog(list(row()), [prices()], allowed));
});

test("DeepInfra authoritative empty chat inventory survives failed pricing without seed fallback", async () => {
  const result = await readDeepInfraCatalog({ metadata: json(list()), pricing: new Response("synthetic-private", { status: 503 }) }, signal(), allowed);
  assert.deepEqual(result, { models: [], availability: [] });
});

test("DeepInfra metadata failure and nonempty pricing failure cannot become empty success", async () => {
  await assert.rejects(readDeepInfraCatalog({ metadata: json({}), pricing: json([prices()]) }, signal(), allowed), invalid);
  await assert.rejects(readDeepInfraCatalog({ metadata: json(list(row())), pricing: json({}) }, signal(), allowed), invalid);
  await assert.rejects(readDeepInfraCatalog({ metadata: json(list(row())), pricing: json({}) }, signal(), new Set()), invalid);
});

for (const [name, make] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 401 })],
  ["wrong MIME", () => new Response("{}", { headers: { "content-type": "text/html" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["truncated length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "20" } })],
  ["partial response", () => new Response("{}", { headers: { "content-type": "application/json", "content-range": "bytes 0-1/5" } })],
  ["declared oversize", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`DeepInfra readers reject ${name} on either source`, async () => {
  await assert.rejects(readDeepInfraCatalog({ metadata: make(), pricing: json([prices()]) }, signal(), allowed), invalid);
  await assert.rejects(readDeepInfraCatalog({ metadata: json(list(row())), pricing: make() }, signal(), allowed), invalid);
});

test("DeepInfra cancellation closes both readers and never publishes an empty success", async () => {
  const controller = new AbortController(); let canceled = 0;
  const pending = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); }, cancel() { canceled++; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readDeepInfraCatalog({ metadata: pending(), pricing: pending() }, controller.signal, allowed);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, 2);
  await assert.rejects(readDeepInfraCatalog({ metadata: json(list()), pricing: json([]) }, controller.signal, allowed), invalid);
});

test("DeepInfra publishes only after the second reader releases", async () => {
  let finish; let published = false;
  const delayed = new Response(new ReadableStream({ start(c) { finish = () => { c.enqueue(new TextEncoder().encode("[]")); c.close(); }; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readDeepInfraCatalog({ metadata: json(list()), pricing: delayed }, signal(), allowed).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  finish(); assert.deepEqual(await reading, { models: [], availability: [] });
});
