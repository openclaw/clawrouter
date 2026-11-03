import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { BASETEN_MODELS_FORMAT, basetenCatalogRequest, filterBasetenModels, readBasetenModels } = await import("../baseten-model-catalog.ts");
const signal = () => new AbortController().signal;
const id = "deepseek-ai/DeepSeek-V4.1-Flash";
const allows = value => value === id;
const row = () => ({ id, object: "model", name: "Synthetic model", supported_features: ["tools", "reasoning"],
  context_length: 900000, max_completion_tokens: 120000,
  pricing: { prompt: "0.00000037", completion: "0.00000141", input_cache_read: "0.000000011" } });
const list = (...data) => ({ data });
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Baseten model catalog is invalid or exceeds the discovery bound";

test("Baseten catalog request binds only the original selected credential to its canonical origin", () => {
  assert.equal(BASETEN_MODELS_FORMAT, "baseten.models");
  for (const base of ["https://inference.baseten.co/v1", "https://inference.baseten.co/v1/"]) {
    const controller = new AbortController(), request = basetenCatalogRequest(base, "synthetic-selected-key", controller.signal);
    assert.equal(request.url, "https://inference.baseten.co/v1/models");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-selected-key"]]);
    assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
    controller.abort(); assert.equal(request.signal.aborted, true);
  }
});

test("Baseten catalog rejects alternate products, origins, paths and malformed credentials", () => {
  for (const base of ["https://api.baseten.co/v1", "https://inference.baseten.co", "http://inference.baseten.co/v1",
    "https://inference.baseten.co:444/v1", "https://proxy.example/v1", "https://inference.baseten.co/v1?key=synthetic-private",
    "https://inference.baseten.co/v1#x", "https://synthetic-private@inference.baseten.co/v1",
    "https://inference.baseten.co/x/../v1", "https://inference.baseten.co/%2e%2e/v1", "invalid", null]) {
    assert.throws(() => basetenCatalogRequest(base, "synthetic-selected-key", signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
  for (const key of ["", " synthetic-private", "synthetic-private\r\nx: y", "é", "x".repeat(8193), null]) {
    assert.throws(() => basetenCatalogRequest("https://inference.baseten.co/v1", key, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

test("Baseten catalog preserves its native data-only envelope and optional object tags", () => {
  assert.deepEqual(filterBasetenModels(list(row()), allows), list(row()));
  assert.deepEqual(filterBasetenModels({ object: "list", data: [row()] }, allows), { object: "list", data: [row()] });
  assert.deepEqual(filterBasetenModels(list({ id }), allows), list({ id }));
});

test("Baseten catalog strictly rejects malformed, partial and ambiguous envelopes", () => {
  for (const payload of [null, [], {}, { object: "model", data: [] }, { data: {} }, { data: [], error: "synthetic-private" },
    { data: [], has_more: true }, { data: [], next_page: "cursor" }, list(null), list({}), list({ id: " bad " }),
    list({ id: "x".repeat(513) }), list({ id: "bad\0id" }), list(row(), row()), list(...Array(4097).fill(null))]) {
    assert.throws(() => filterBasetenModels(payload, allows), invalid);
  }
});

test("Baseten catalog enforces original-policy filtering without granting aliases or seeding empty results", () => {
  assert.deepEqual(filterBasetenModels(list(row()), () => false), list());
  assert.deepEqual(filterBasetenModels(list(), allows), list());
  for (const allowed of ["*", "deepseek-ai/*", "baseten/" + id, id.toLowerCase()]) {
    assert.deepEqual(filterBasetenModels(list(row()), value => value === allowed), list());
  }
  let calls = [];
  assert.deepEqual(filterBasetenModels(list(row(), { id: "another/model" }), value => { calls.push(value); return value === id; }), list(row()));
  assert.deepEqual(calls, [id, "another/model"]);
});

test("Baseten catalog excludes every decision-models identity even under an unrestricted caller predicate", () => {
  const decisions = ["baseten-elephant-9b-latest", "baseten-mammoth-27b-latest", "baseten-joey-2b-latest", "synthetic-future"];
  const data = decisions.map(name => ({ id: `decision-models/${name}`, object: "model", supported_features: ["tools"] }));
  assert.deepEqual(filterBasetenModels(list(...data, { id, object: "embedding" }), () => true), list());
  assert.deepEqual(filterBasetenModels(list(...data, row()), allows), list(row()));
});

test("Baseten catalog retains unknown limits, features and prices as absent", () => {
  assert.deepEqual(filterBasetenModels(list({ id }), allows), list({ id }));
  for (const value of [null, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "128K", "1.5", "-1", "9007199254740992", {}]) {
    assert.deepEqual(filterBasetenModels(list({ id, context_length: value, max_completion_tokens: value }), allows), list({ id }));
  }
  for (const supported_features of [null, "tools", [null], ["bad feature"], ["x".repeat(129)], Array(33).fill("tools")]) {
    assert.deepEqual(filterBasetenModels(list({ id, supported_features }), allows), list({ id }));
  }
});

test("Baseten catalog preserves observed limits independently without substituting serving maxima", () => {
  assert.deepEqual(filterBasetenModels(list({ id, context_length: "100", max_completion_tokens: "200" }), allows),
    list({ id, context_length: 100, max_completion_tokens: 200 }));
});

test("Baseten sparse feature lists do not borrow static vision or reasoning-effort facts", () => {
  const supported_features = ["tools", "reasoning", "json_mode", "structured_outputs"];
  const result = filterBasetenModels(list({ id, supported_features }), allows);
  assert.deepEqual(result, list({ id, supported_features }));
  assert.deepEqual(filterBasetenModels(list({ id, supported_features: [] }), allows), list({ id, supported_features: [] }));
});

test("Baseten catalog preserves independent price observations without conversion, defaults or invented cache rates", () => {
  for (const prompt of ["0", "0.000000000000000001", 0, 0.0000002]) {
    assert.deepEqual(filterBasetenModels(list({ id, pricing: { prompt } }), allows), list({ id, pricing: { prompt } }));
  }
  for (const prompt of [null, -1, Infinity, NaN, "NaN", "1e-999", "$0.1", "-0.1", "1.1234567890123456789", {}]) {
    assert.deepEqual(filterBasetenModels(list({ id, pricing: { prompt } }), allows), list({ id }));
  }
  assert.deepEqual(filterBasetenModels(list({ id, pricing: { completion: "0.1", input_cache_write: "0", native_units: 1 } }), allows),
    list({ id, pricing: { completion: "0.1" } }));
});

test("Baseten catalog projects only named fields and keeps stable exact identities", () => {
  const rows = [row(), { id: "a-model", name: "bad\nname", api_key: "synthetic-private", endpoint: "https://untrusted.example", supported_features: ["tools", "tools"] }];
  const result = filterBasetenModels(list(...rows), () => true);
  assert.deepEqual(result.data.map(model => model.id), ["a-model", id]);
  assert.deepEqual(result.data[0], { id: "a-model", supported_features: ["tools"] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted/);
});

test("Baseten catalog reader handles fragmented UTF-8 only after complete EOF", async () => {
  const body = list({ id, name: "Synthetic 模型" }), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readBasetenModels(response, signal(), allows), body);
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
]) test(`Baseten catalog reader rejects ${name} without revealing upstream content`, async () => {
  await assert.rejects(readBasetenModels(make(), signal(), allows), invalid);
});

test("Baseten catalog cancellation closes the source and cannot return an empty success", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readBasetenModels(response, controller.signal, allows).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
  await assert.rejects(readBasetenModels(Response.json(list()), controller.signal, allows), invalid);
});

test("Baseten catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/baseten-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
