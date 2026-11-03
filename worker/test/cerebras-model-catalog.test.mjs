import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { cerebrasPublicCatalogRequest, parseCerebrasPublicCatalog, readCerebrasPublicCatalog } = await import("../cerebras-model-catalog.ts");

const signal = () => new AbortController().signal;
const allowed = new Set(["gpt-oss-120b"]);
const row = () => ({ id: "gpt-oss-120b", object: "model", name: "Synthetic public model", deprecated: false,
  limits: { max_context_length: 131072, max_completion_tokens: 40960 },
  capabilities: { reasoning: true, tools: true, vision: false }, preview: false,
  pricing: { prompt: "0.000001", completion: "0.000002" } });
const list = (...data) => ({ object: "list", data });
const invalid = e => e.status === 502 && e.code === "provider_catalog_invalid" && e.message === "Cerebras public model catalog is invalid";

test("Cerebras public request has no inference credentials and refuses redirects", () => {
  for (const base of ["https://api.cerebras.ai/v1", "https://api.cerebras.ai/v1/"]) {
    const r = cerebrasPublicCatalogRequest(base, signal());
    assert.equal(r.url, "https://api.cerebras.ai/public/v1/models");
    assert.equal(r.method, "GET"); assert.equal(r.body, null);
    assert.deepEqual([...r.headers], [["accept", "application/json"]]);
    assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "error");
  }
});

test("Cerebras public metadata cannot describe a custom proxy or another resource", () => {
  for (const base of ["https://proxy.example/v1", "http://api.cerebras.ai/v1", "https://api.cerebras.ai:444/v1",
    "https://api.cerebras.ai/v1?key=synthetic-private", "https://synthetic-private@api.cerebras.ai/v1",
    "https://api.cerebras.ai/v1#synthetic-private", "https://api.cerebras.ai/public/v1", "invalid"]) {
    assert.throws(() => cerebrasPublicCatalogRequest(base, signal()), e =>
      e.status === 503 && e.code === "provider_catalog_not_supported" && !e.message.includes("synthetic-private"));
  }
});

test("Cerebras projection preserves native limits and exact price observations", () => {
  assert.deepEqual(parseCerebrasPublicCatalog(list(row()), allowed), [{
    id: "gpt-oss-120b", name: "Synthetic public model", contextWindow: 131072, maxOutputTokens: 40960,
    reasoning: true, tools: true, vision: false, preview: false,
    pricing: { currency: "USD", inputPerToken: "0.000001", outputPerToken: "0.000002" },
  }]);
});

test("Cerebras empty catalog is authoritative and allowed IDs are exact", () => {
  assert.deepEqual(parseCerebrasPublicCatalog(list(), allowed), []);
  assert.deepEqual(parseCerebrasPublicCatalog(list(row()), new Set()), []);
  assert.deepEqual(parseCerebrasPublicCatalog(list(row()), new Set(["*"])), []);
  assert.deepEqual(parseCerebrasPublicCatalog(list(row(), { ...row(), id: "unpermitted" }), allowed).map(m => m.id), [...allowed]);
});

test("Cerebras filters deprecated and malformed rows without seeding missing models", () => {
  const bad = [null, [], { ...row(), id: "bad id" }, { ...row(), id: "x".repeat(513) },
    { ...row(), object: "embedding" }, { ...row(), deprecated: true }, { ...row(), deprecated: "false" },
    { ...row(), limits: { max_context_length: 0, max_completion_tokens: 1 } },
    { ...row(), limits: { max_context_length: 10, max_completion_tokens: 1.5 } },
    { ...row(), limits: { max_context_length: Number.MAX_SAFE_INTEGER + 1, max_completion_tokens: 1 } }];
  assert.deepEqual(parseCerebrasPublicCatalog(list(...bad), allowed), []);
});

test("Cerebras malformed envelopes and duplicate authorized identities fail closed", () => {
  for (const payload of [null, [], {}, { data: [] }, { object: "model", data: [] }, list(row(), row()),
    { object: "list", data: Array(4097).fill(null) }]) {
    assert.throws(() => parseCerebrasPublicCatalog(payload, allowed), invalid);
  }
});

test("Cerebras unknown flags and incomplete prices do not become free or unsupported", () => {
  for (const pricing of [undefined, {}, { prompt: "0.1" }, { prompt: "-1", completion: "1" },
    { prompt: 1, completion: 2 }, { prompt: "NaN", completion: "1" }, { prompt: "1e-999", completion: "1" }]) {
    const [m] = parseCerebrasPublicCatalog(list({ ...row(), capabilities: { tools: "yes" }, preview: undefined, pricing }), allowed);
    assert.equal(m.pricing, null); assert.equal(m.reasoning, null); assert.equal(m.tools, null); assert.equal(m.vision, null); assert.equal(m.preview, null);
  }
  const [zero] = parseCerebrasPublicCatalog(list({ ...row(), pricing: { prompt: "0", completion: "0.0" } }), allowed);
  assert.deepEqual(zero.pricing, { currency: "USD", inputPerToken: "0", outputPerToken: "0.0" });
});

test("Cerebras projects only named metadata and produces stable order", () => {
  const rows = [row(), { ...row(), id: "a-model", name: "bad\nname", api_key: "synthetic-private", endpoint: "https://untrusted.example" }];
  const result = parseCerebrasPublicCatalog(list(...rows), new Set(["gpt-oss-120b", "a-model"]));
  assert.deepEqual(result.map(m => m.id), ["a-model", "gpt-oss-120b"]); assert.equal(result[0].name, "a-model");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|untrusted/);
});

test("Cerebras bounded reader handles fragmented UTF-8 before projecting", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(list({ ...row(), name: "Synthetic 模型" })));
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) {
    if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset));
  } }), { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.equal((await readCerebrasPublicCatalog(response, signal(), allowed))[0].name, "Synthetic 模型");
});

for (const [name, make] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 403 })],
  ["wrong MIME", () => new Response(JSON.stringify(list(row())), { headers: { "content-type": "text/html" } })],
  ["truncated length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "20" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`Cerebras reader rejects ${name} without leaking the response`, async () => {
  await assert.rejects(readCerebrasPublicCatalog(make(), signal(), allowed), invalid);
});

test("Cerebras reader cancellation closes the upstream stream", async () => {
  const controller = new AbortController(); let canceled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"object":')); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readCerebrasPublicCatalog(response, controller.signal, allowed);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Cerebras catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/cerebras-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
