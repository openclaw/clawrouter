import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { ARCEE_MODELS_FORMAT, arceeCatalogRequest, filterArceeModels, readArceeModels } = await import("../arcee-model-catalog.ts");
const signal = () => new AbortController().signal;
const ids = ["trinity-mini", "trinity-large-preview", "trinity-large-thinking"];
const allows = id => ids.includes(id);
const row = (id = ids[0]) => ({ id, name: "Synthetic model", context_length: 4096, max_output_length: 1024,
  input_modalities: ["text"], output_modalities: ["text"] });
const list = (...data) => ({ data });
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Arcee model catalog is invalid or exceeds the discovery bound";

test("Arcee direct catalog preserves the original selected key without OpenRouter fallback", () => {
  assert.equal(ARCEE_MODELS_FORMAT, "arcee.models");
  for (const base of ["https://api.arcee.ai/api/v1", "https://api.arcee.ai/api/v1/"]) {
    const controller = new AbortController(), request = arceeCatalogRequest(base, "synthetic-selected-direct-key", controller.signal);
    assert.equal(request.url, "https://api.arcee.ai/api/v1/models");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-selected-direct-key"]]);
    assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
    controller.abort(); assert.equal(request.signal.aborted, true);
  }
});

test("Arcee catalog rejects alternate products, endpoint spellings and malformed credentials", () => {
  for (const base of ["https://openrouter.ai/api/v1", "https://openrouter.ai/v1", "https://api.arcee.ai/v1",
    "https://proxy.example/api/v1", "http://api.arcee.ai/api/v1", "https://api.arcee.ai:444/api/v1",
    "https://api.arcee.ai/api/v1?key=synthetic-private", "https://api.arcee.ai/api/v1#x",
    "https://synthetic-private@api.arcee.ai/api/v1", "https://api.arcee.ai/x/../api/v1", "https://api.arcee.ai/%2e%2e/api/v1", null]) {
    assert.throws(() => arceeCatalogRequest(base, "synthetic-direct-key", signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
  for (const key of ["", " synthetic-private", "synthetic-private\r\nx: y", "é", "x".repeat(8193), null]) {
    assert.throws(() => arceeCatalogRequest("https://api.arcee.ai/api/v1", key, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

for (const id of ids) test(`Arcee native data-only catalog preserves frozen identity ${id}`, () => {
  assert.deepEqual(filterArceeModels(list(row(id)), allows), list(row(id)));
  assert.deepEqual(filterArceeModels({ object: "list", data: [{ ...row(id), object: "model" }] }, allows),
    { object: "list", data: [{ ...row(id), object: "model" }] });
});

test("Arcee original-policy filter never rewrites IDs using OpenRouter or model-family metadata", () => {
  const native = { ...row(), openrouter: { slug: "arcee-ai/trinity-mini" }, hugging_face_id: "arcee-ai/Trinity-Mini" };
  assert.deepEqual(filterArceeModels(list(native), allows), list(row()));
  for (const permitted of ["arcee-ai/trinity-mini", "arcee/trinity-mini", "Trinity-Mini", "*", "trinity-*"]) {
    assert.deepEqual(filterArceeModels(list(native), id => id === permitted), list());
  }
  assert.deepEqual(filterArceeModels(list(native), () => false), list());
  assert.deepEqual(filterArceeModels(list(), allows), list());
});

test("Arcee native metadata is authoritative without synthesizing frozen or missing rows", () => {
  assert.deepEqual(filterArceeModels(list(row(ids[2])), allows), list(row(ids[2])));
  assert.deepEqual(filterArceeModels(list(row("synthetic-future")), allows), list());
  assert.deepEqual(filterArceeModels(list(row("synthetic-future")), id => id === "synthetic-future"), list(row("synthetic-future")));
});

test("Arcee discovery excludes non-text outputs and non-model rows from Chat", () => {
  for (const patch of [{ input_modalities: ["image"] }, { output_modalities: ["embedding"] }, { output_modalities: ["image"] }, { object: "embedding" }]) {
    assert.deepEqual(filterArceeModels(list({ ...row(), ...patch }), () => true), list());
  }
  const native = { ...row(), input_modalities: ["text", "image"] };
  assert.deepEqual(filterArceeModels(list(native), allows), list(native));
});

test("Arcee rejects malformed envelopes, pagination and duplicate exact identities", () => {
  for (const payload of [null, [], {}, { data: {} }, { object: "model", data: [] }, { data: [], error: "synthetic-private" },
    { data: [], has_more: true }, { data: [], next: "cursor" }, list(null), list({}), list({ ...row(), id: "bad id" }),
    list({ ...row(), id: "x".repeat(513) }), list({ ...row(), id: "bad\0id" }), list(row(), row()), list(...Array(4097).fill(null))]) {
    assert.throws(() => filterArceeModels(payload, allows), invalid);
  }
});

test("Arcee required native modalities and integer limits cannot become invented Chat facts", () => {
  for (const value of [undefined, null, [], ["bad value"], [null], Array(17).fill("text"), ["x".repeat(129)]]) {
    for (const field of ["input_modalities", "output_modalities"]) assert.throws(() => filterArceeModels(list({ ...row(), [field]: value }), allows), invalid);
  }
  for (const value of [undefined, null, 0, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["context_length", "max_output_length"]) assert.throws(() => filterArceeModels(list({ ...row(), [field]: value }), allows), invalid);
  }
  const native = { ...row(), max_output_length: 8192 };
  assert.deepEqual(filterArceeModels(list(native), allows), list(native));
});

test("Arcee missing feature and sampling observations stay absent, while explicit empty lists survive", () => {
  for (const value of [undefined, null, "tools", [null], ["bad feature"], Array(65).fill("tools")]) {
    assert.deepEqual(filterArceeModels(list({ ...row(), supported_features: value, supported_sampling_parameters: value }), allows), list(row()));
  }
  const native = { ...row(), supported_features: [], supported_sampling_parameters: [] };
  assert.deepEqual(filterArceeModels(list(native), allows), list(native));
});

test("Arcee price observations remain independent native strings without fixed or zero defaults", () => {
  const pricing = { prompt: "0.0000002", completion: "0.0000008", image: "0.000001", request: "0.01", input_cache_reads: "0", input_cache_writes: "0.0000001" };
  assert.deepEqual(filterArceeModels(list({ ...row(), pricing }), allows), list({ ...row(), pricing }));
  for (const prompt of [undefined, null, 0, 0.1, -1, "$0.1", "1e-999", "NaN", "-0.1", "1.1234567890123456789", {}]) {
    assert.deepEqual(filterArceeModels(list({ ...row(), pricing: { prompt } }), allows), list(row()));
  }
  assert.deepEqual(filterArceeModels(list({ ...row(), pricing: { request: "0" } }), allows), list({ ...row(), pricing: { request: "0" } }));
});

test("Arcee projects only named fields in stable order without copying credentials or routing hints", () => {
  const native = { ...row(ids[2]), name: "bad\nname", api_key: "synthetic-private", endpoint: "https://untrusted.example",
    supported_features: ["tools", "tools"], supported_sampling_parameters: ["temperature", "temperature"] };
  const result = filterArceeModels(list(row(), native), allows);
  assert.deepEqual(result.data.map(r => r.id), [ids[2], ids[0]]);
  assert.deepEqual(result.data[0], { ...row(ids[2]), name: ids[2], supported_features: ["tools"], supported_sampling_parameters: ["temperature"] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted/);
});

test("Arcee complete catalog reader handles fragmented UTF-8", async () => {
  const body = list({ ...row(), name: "Synthetic 模型" }), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readArceeModels(response, signal(), allows), body);
});

for (const [name, make] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 403 })],
  ["wrong MIME", () => new Response("{}", { headers: { "content-type": "text/html" } })],
  ["partial range", () => Response.json({}, { headers: { "content-range": "bytes 0-1/20" } })],
  ["truncated length", () => Response.json({}, { headers: { "content-length": "20" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => Response.json({}, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`Arcee reader rejects ${name} without exposing upstream content`, async () => {
  await assert.rejects(readArceeModels(make(), signal(), allows), invalid);
});

test("Arcee catalog reader requires EOF and cancels incomplete delivery", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readArceeModels(response, controller.signal, allows).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Arcee catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/arcee-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
