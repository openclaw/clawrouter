import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { NOVITA_MODELS_FORMAT, novitaCatalogRequest, filterNovitaModels, readNovitaModels } = await import("../novita-model-catalog.ts");
const ids = ["moonshotai/kimi-k3", "moonshotai/kimi-k2.7-code", "minimax/minimax-m3", "zai-org/glm-5.2",
  "deepseek/deepseek-v4-pro", "qwen/qwen3.7-max", "minimax/minimax-m2.7"];
const signal = () => new AbortController().signal;
const row = (id = ids[0]) => ({ id, object: "model", created: 1733560109, context_size: 131072 });
const list = (...data) => ({ data });
const allows = id => ids.includes(id);
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Novita model catalog is invalid or exceeds the discovery bound";

test("Novita documented keyed catalog preserves the original credential and bodyless canonical request", () => {
  assert.equal(NOVITA_MODELS_FORMAT, "novita.models");
  for (const base of ["https://api.novita.ai/openai/v1", "https://api.novita.ai/openai/v1/"]) {
    const controller = new AbortController(), r = novitaCatalogRequest(base, "synthetic-selected-novita", controller.signal);
    assert.equal(r.url, "https://api.novita.ai/openai/v1/models"); assert.equal(r.method, "GET"); assert.equal(r.body, null);
    assert.deepEqual([...r.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-selected-novita"], ["content-type", "application/json"]]);
    assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "manual"); controller.abort(); assert.equal(r.signal.aborted, true);
  }
});

test("Novita catalog refuses alternate prefixes, control-plane services and malformed keys", () => {
  for (const base of ["https://api.novita.ai/openai", "https://api.novita.ai/v3/openai", "https://api.novita.ai/v3/openai/v1",
    "https://api.novita.ai/v3/models", "https://api.novita.ai/v1", "https://api.novita.ai/openai/v1?key=synthetic-private",
    "https://api.novita.ai/openai/v1#fragment", "https://synthetic-private@api.novita.ai/openai/v1", "https://api.novita.ai:444/openai/v1",
    "https://proxy.example/openai/v1", "http://api.novita.ai/openai/v1", "https://api.novita.ai/x/../openai/v1", null]) {
    assert.throws(() => novitaCatalogRequest(base, "synthetic-selected", signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
  for (const key of ["", " synthetic-private", "synthetic-private\r\nx: y", "é", "x".repeat(8193), null]) {
    assert.throws(() => novitaCatalogRequest("https://api.novita.ai/openai/v1", key, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

for (const id of ids) test(`Novita native catalog preserves exact frozen identity ${id}`, () => {
  assert.deepEqual(filterNovitaModels(list(row(id)), allows), list(row(id)));
});

test("Novita data-only native contract neither accepts nor fabricates another provider's list marker", () => {
  assert.deepEqual(filterNovitaModels(list(), allows), list());
  for (const payload of [{ object: "list", data: [] }, { object: "model", data: [] }, { data: [], has_more: false },
    { data: [], next: "cursor" }, { data: [], error: "synthetic-private" }, { models: [] }]) assert.throws(() => filterNovitaModels(payload, allows), invalid);
});

test("Novita original grant filtering preserves literal case and never merges model families or refills empty inventory", () => {
  for (const permitted of ["novita/" + ids[0], "moonshotai/Kimi-K3", "*", "moonshotai/*"]) {
    assert.deepEqual(filterNovitaModels(list(row()), id => id === permitted), list());
  }
  assert.deepEqual(filterNovitaModels(list(row("synthetic-ungranted")), allows), list());
  assert.deepEqual(filterNovitaModels(list(row("synthetic-configured")), id => id === "synthetic-configured"), list(row("synthetic-configured")));
});

test("Novita strict identities and scan bounds reject malformed or duplicate native rows", () => {
  for (const payload of [null, [], {}, { data: {} }, list(null), list({}), list({ ...row(), object: "embedding" }),
    list({ ...row(), id: "" }), list({ ...row(), id: "bad id" }), list({ ...row(), id: "bad\0id" }), list({ ...row(), id: "x".repeat(513) }),
    list(row(), row()), list(...Array(4097).fill(null))]) assert.throws(() => filterNovitaModels(payload, allows), invalid);
});

test("Novita required timestamp and native context cannot become hardcoded fallback facts", () => {
  for (const field of ["created", "context_size"]) for (const value of [undefined, null, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => filterNovitaModels(list({ ...row(), [field]: value }), allows), invalid);
  }
  assert.throws(() => filterNovitaModels(list({ ...row(), context_size: 0 }), allows), invalid);
  assert.deepEqual(filterNovitaModels(list({ ...row(), created: 0, context_size: 262144 }), allows), list({ ...row(), created: 0, context_size: 262144 }));
});

test("Novita price observations remain independent raw integers without currency conversion or cache defaults", () => {
  for (const prices of [{ input_token_price_per_m: 3900, output_token_price_per_m: 3900 }, { output_token_price_per_m: 0 }, {}]) {
    assert.deepEqual(filterNovitaModels(list({ ...row(), ...prices }), allows), list({ ...row(), ...prices }));
  }
  for (const value of [undefined, null, "3900", 0.1, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(filterNovitaModels(list({ ...row(), input_token_price_per_m: value }), allows), list(row()));
  }
});

test("Novita projection strips arbitrary metadata, private hints, endpoint URLs and unsupported capability guesses", () => {
  const native = { ...row(ids[6]), title: "reasoning vision", description: "synthetic-private", endpoint: "https://untrusted.example",
    api_key: "synthetic-private", pricing: { prompt: "0" }, max_tokens: 4096, input_modalities: ["image"], tools: true };
  const result = filterNovitaModels(list(row(), native), allows);
  assert.deepEqual(result, list(row(ids[6]), row())); assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted|vision/);
});

test("Novita complete reader handles fragmented data-only JSON", async () => {
  const body = list(row()), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const r = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readNovitaModels(r, signal(), allows), body);
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
]) test(`Novita reader rejects ${name} without exposing upstream content or replacing the credential`, async () => {
  await assert.rejects(readNovitaModels(make(), signal(), allows), invalid);
});

test("Novita complete reader waits for EOF and aborts incomplete delivery", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const r = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readNovitaModels(r, controller.signal, allows).then(value => { published = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false); controller.abort();
  await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Novita native catalog imports without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/novita-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
