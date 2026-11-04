import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { VENICE_MODELS_FORMAT, veniceCatalogRequest, filterVeniceModels, readVeniceModels } = await import("../venice-model-catalog.ts");
const ids = ["zai-org-glm-5-2", "zai-org-glm-4.7", "venice-uncensored-1-2", "google-gemma-4-31b-it", "kimi-k2-6", "deepseek-v3.2",
  "qwen3-235b-a22b-thinking-2507", "qwen3-coder-480b-a35b-instruct-turbo", "qwen3-vl-235b-a22b", "grok-4-5", "qwen-3-7-max", "qwen-3-7-plus",
  "claude-fable-5", "claude-opus-5", "claude-sonnet-4-6", "openai-gpt-56-sol", "zai-org-glm-4.6", "google-gemma-3-27b-it", "kimi-k2-5"];
const row = (id = ids[0], spec) => ({ id, object: "model", type: "text", ...(spec ? { model_spec: spec } : {}) });
const list = (...data) => ({ object: "list", type: "text", data });
const allows = id => ids.includes(id);
const signal = () => new AbortController().signal;
const invalid = e => e.status === 502 && e.code === "invalid_model_discovery_response"
  && e.message === "Venice text model catalog is invalid or exceeds the discovery bound";

test("Venice documented public text discovery cannot receive inference or wallet credentials", () => {
  assert.equal(VENICE_MODELS_FORMAT, "venice.models");
  for (const base of ["https://api.venice.ai/api/v1", "https://api.venice.ai/api/v1/"]) {
    const controller = new AbortController(), r = veniceCatalogRequest(base, controller.signal);
    assert.equal(r.url, "https://api.venice.ai/api/v1/models?type=text"); assert.equal(r.method, "GET"); assert.equal(r.body, null);
    assert.deepEqual([...r.headers], [["accept", "application/json"]]); assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "manual");
    controller.abort(); assert.equal(r.signal.aborted, true);
  }
});

test("Venice discovery rejects media, control-plane, proxy and noncanonical destinations", () => {
  for (const base of ["https://api.venice.ai/v1", "https://venice.ai/api/v1", "https://proxy.example/api/v1", "http://api.venice.ai/api/v1",
    "https://api.venice.ai:444/api/v1", "https://api.venice.ai/api/v1?type=all", "https://api.venice.ai/api/v1/models?type=image",
    "https://api.venice.ai/api/v1/billing", "https://api.venice.ai/api/v1/x402", "https://api.venice.ai/api/v1#fragment",
    "https://synthetic-private@api.venice.ai/api/v1", "https://api.venice.ai/x/../api/v1", "https://api.venice.ai/%2e%2e/api/v1", null]) {
    assert.throws(() => veniceCatalogRequest(base, signal()), e => e.status === 503 && !e.message.includes("synthetic-private"));
  }
});

for (const id of ids) test(`Venice preserves frozen native Chat identity ${id} without provider substitution`, () => {
  assert.deepEqual(filterVeniceModels(list(row(id)), allows), list(row(id)));
});

test("Venice original grant filtering does not inherit public catalog entitlement or trait aliases", () => {
  for (const permitted of ["venice/" + ids[0], "*", "zai-org-*", "default", "function_calling_default"]) {
    assert.deepEqual(filterVeniceModels(list(row()), id => id === permitted), list());
  }
  assert.deepEqual(filterVeniceModels(list(row("synthetic-ungranted")), allows), list());
  assert.deepEqual(filterVeniceModels(list(row("synthetic-ungranted")), id => id === "synthetic-ungranted"), list(row("synthetic-ungranted")));
  assert.deepEqual(filterVeniceModels(list(), allows), list());
});

test("Venice strict text envelope excludes every other native model type", () => {
  for (const type of ["image", "video", "decision", "embedding", "tts", "asr", "music", "all", "code"]) {
    assert.throws(() => filterVeniceModels({ ...list(), type }, allows), invalid);
    assert.deepEqual(filterVeniceModels(list({ ...row(), type }), allows), list());
  }
});

test("Venice absent native facts never synthesize limits, reasoning, tools, privacy or zero prices", () => {
  assert.deepEqual(filterVeniceModels(list({ ...row(ids[6]), name: "vision reasoning", context_length: 128000, model_spec: {} }), allows), list(row(ids[6])));
  for (const field of ["availableContextTokens", "maxCompletionTokens"]) {
    for (const value of [undefined, null, 0, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(filterVeniceModels(list(row(ids[0], { [field]: value })), allows), list(row()));
    }
  }
});

test("Venice context and completion limits remain independent without frozen or hardcoded clamping", () => {
  const native = list(row(ids[0], { availableContextTokens: 1000000, maxCompletionTokens: 131072 }));
  assert.deepEqual(filterVeniceModels(native, allows), native);
  const independent = list(row(ids[0], { maxCompletionTokens: 262144 }));
  assert.deepEqual(filterVeniceModels(independent, allows), independent);
});

test("Venice named boolean capabilities preserve explicit false without deriving an effort enum", () => {
  const native = list(row(ids[0], { capabilities: { supportsFunctionCalling: true, supportsReasoning: false,
    supportsReasoningEffort: true, supportsVision: false, supportsLogProbs: true, supportsResponseSchema: false } }));
  assert.deepEqual(filterVeniceModels(native, allows), native);
  assert.deepEqual(filterVeniceModels(list(row(ids[0], { capabilities: { supportsVision: "true", supportsFunctionCalling: 1,
    supportsTeeAttestation: true, supportsE2EE: true, optimizedForCode: true } })), allows), list(row()));
});

test("Venice public offline and declared privacy observations are not account access or cryptographic attestation", () => {
  assert.deepEqual(filterVeniceModels(list(row(ids[0], { offline: true })), allows), list());
  for (const privacy of ["private", "anonymized"]) {
    const native = list(row(ids[0], { offline: false, privacy }));
    assert.deepEqual(filterVeniceModels(native, allows), native);
  }
  for (const privacy of [null, "e2ee", "tee", "PRIVATE", true]) {
    assert.deepEqual(filterVeniceModels(list(row(ids[0], { privacy })), allows), list(row()));
  }
  for (const offline of [null, "false", 0]) assert.throws(() => filterVeniceModels(list(row(ids[0], { offline })), allows), invalid);
});

test("Venice dated deprecation is preserved without choosing a replacement or claiming shutdown", () => {
  for (const date of ["2025-03-01T00:00:00.000Z", "2099-03-01T00:00:00.000Z"]) {
    const native = list(row(ids[0], { deprecation: { date } }));
    assert.deepEqual(filterVeniceModels(native, allows), native);
    assert.deepEqual(filterVeniceModels(list(row(ids[0], { deprecation: { date, replacement: "synthetic-alias" } })), allows), native);
  }
  for (const deprecation of [null, {}, { date: "2026-02-30T00:00:00.000Z" }, { date: 0 }, { date: "tomorrow" }]) {
    assert.throws(() => filterVeniceModels(list(row(ids[0], { deprecation })), allows), invalid);
  }
});

test("Venice raw USD and DIEM rates stay separate, partial and unconverted without cache defaults", () => {
  const pricing = { input: { usd: 0.5, diem: 2 }, output: { usd: 1.5 }, cache_input: { diem: 0.1 }, cache_write: { usd: 0 } };
  assert.deepEqual(filterVeniceModels(list(row(ids[0], { pricing })), allows), list(row(ids[0], { pricing })));
  for (const value of [null, "0.5", -1, NaN, Infinity, 1_000_001]) {
    assert.deepEqual(filterVeniceModels(list(row(ids[0], { pricing: { input: { usd: value } } })), allows), list(row()));
  }
});

test("Venice whole-request extended observations preserve threshold and missing cache fields", () => {
  const pricing = { input: { usd: 3 }, cache_input: { usd: 0.3 }, extended: { context_token_threshold: 200000,
    input: { usd: 6 }, output: { usd: 12 } } };
  assert.deepEqual(filterVeniceModels(list(row(ids[0], { pricing })), allows), list(row(ids[0], { pricing })));
  for (const threshold of [null, -1, "200000", 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = { ...pricing, extended: { ...pricing.extended, context_token_threshold: threshold } };
    assert.deepEqual(filterVeniceModels(list(row(ids[0], { pricing: malformed })), allows), list(row()));
  }
  assert.deepEqual(filterVeniceModels(list(row(ids[0], { pricing: { input: { usd: 3 }, extended: null } })), allows), list(row()));
});

test("Venice root/model validation rejects duplicate IDs, pagination and malformed native envelopes", () => {
  for (const payload of [null, [], {}, { object: "list", data: [] }, { ...list(), data: {} }, { ...list(), next: "cursor" },
    { ...list(), has_more: false }, { ...list(), error: "synthetic-private" }, list(null), list({}), list({ ...row(), id: "" }),
    list({ ...row(), id: "bad id" }), list({ ...row(), id: "bad\0id" }), list({ ...row(), id: "x".repeat(513) }),
    list({ ...row(), object: "embedding" }), list({ ...row(), type: null }), list({ ...row(), model_spec: null }), list(row(), row()),
    list(...Array(4097).fill(null))]) assert.throws(() => filterVeniceModels(payload, allows), invalid);
});

test("Venice named projection strips model sources, traits, discounts, URLs and account information", () => {
  const native = list({ ...row(ids[0], { traits: ["default"], modelSource: "https://untrusted.example", name: "synthetic-private" }),
    discount_to_user: 0.2, api_key: "synthetic-private", endpoint: "https://untrusted.example" }, row(ids[1]));
  assert.deepEqual(filterVeniceModels(native, allows), list(row(ids[1]), row()));
});

test("Venice complete native reader preserves fragmented text lists", async () => {
  const body = list(row()), bytes = new TextEncoder().encode(JSON.stringify(body)); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual(await readVeniceModels(response, signal(), allows), body);
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
]) test(`Venice reader rejects ${name} without credential fallback or exposing content`, async () => {
  await assert.rejects(readVeniceModels(make(), signal(), allows), invalid);
});

test("Venice catalog reader requires EOF and cancels incomplete delivery", async () => {
  const controller = new AbortController(); let canceled = false, published = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(list(row())))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readVeniceModels(response, controller.signal, allows).then(result => { published = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(published, false);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, true);
});

test("Venice catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/venice-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
