import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeBedrockEmbedding } = await import("../native-bedrock-embeddings.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url), "utf8"));
const titan = wire.cases.find(item => item.model === "amazon.titan-embed-text-v2:0");
const cohere = wire.cases.find(item => item.model === "cohere.embed-english-v3");
const origin = "https://bedrock-runtime.us-east-1.amazonaws.com";
const requestLimit = 2 * 1024 * 1024, responseLimit = 8 * 1024 * 1024;
// Candidate embedding selection, not a production declaration. Common dispatch
// supplies the original resolved origin after credential/transport selection.
const endpoint = { id: "embed", method: "POST", path: "/model/${model}/invoke", path_params: ["model"],
  path_param_styles: { model: "opaque_segment" }, query: {}, streaming: null,
  request_format: "aws_bedrock.invoke", response_format: "aws_bedrock.invoke" };
const selection = (item = titan, body = structuredClone(item.body)) => ({ provider: { id: "aws-bedrock" }, endpoint,
  model: { id: "bedrock/" + item.model, upstream: item.model, capabilities: ["llm.embeddings"] },
  capability: "llm.embeddings", body, pathParams: { model: item.model }, method: "POST" });
const native = (selected = selection(), input = { origin }) => prepareNativeBedrockEmbedding(selected, input);
const response = (body = titan.response, headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("Bedrock wrapper preserves all ten native fixtures and exact profile identities", async () => {
  assert.equal(wire.cases.length, 10);
  for (const item of wire.cases) {
    const selected = selection(item), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before);
    assert.equal(prepared.origin, origin); assert.equal(prepared.path, "/model/" + encodeURIComponent(item.model) + "/invoke");
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(origin + prepared.path)));
    const result = await read(response(item.response, { "x-private-upstream": "synthetic" }), selected);
    assert.deepEqual(await result.response.json(), item.response);
    assert.equal(result.response.headers.get("x-private-upstream"), null);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.usage.requestCostReceipt, undefined);
  }
  const item = { ...titan, model: "us.amazon.titan-embed-text-v2:0:2:8k" };
  assert.equal(native(selection(item)).path, "/model/us.amazon.titan-embed-text-v2%3A0%3A2%3A8k/invoke");
});

test("Bedrock leaf leaves unrelated operations alone and rejects invalid embedding routes", () => {
  assert.equal(native({ ...selection(), provider: { id: "google-gemini" } }), undefined);
  assert.equal(native({ ...selection(), capability: "llm.invoke" }), undefined);
  for (const change of [{ model: null }, { model: { ...selection().model, capabilities: ["llm.invoke"] } }, { method: "GET" },
    { pathParams: { model: "amazon.titan-embed-text-v1" } }, { pathParams: { ...selection().pathParams, region: "us-east-1" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/model/${model}/invoke-with-response-stream" }, { upstreamPath: endpoint.path },
    { path_params: [] }, { path_params: ["model", "region"] }, { path_param_styles: { model: "segment" } },
    { request_format: "openai.embeddings" }, { response_format: "aws_bedrock.eventstream" }, { query: { trace: "ENABLED" } },
    { streaming: "aws_eventstream" }, { websocket: "openai.realtime" }, { lifecycle: {} }, { responsesLifecycle: {} },
    { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("Bedrock origin is a bounded regional destination, never a caller URL override", () => {
  assert.equal(native(selection(), { origin: "https://bedrock-runtime.eu-west-1.amazonaws.com" }).origin,
    "https://bedrock-runtime.eu-west-1.amazonaws.com");
  for (const value of [undefined, null, "", "http://bedrock-runtime.us-east-1.amazonaws.com", origin + "/", origin + ":443",
    origin + "/model/other/invoke", origin + "?token=synthetic", origin + "#fragment", origin + ".other.example",
    "https://synthetic@bedrock-runtime.us-east-1.amazonaws.com", "https://bedrock-runtime.${region}.amazonaws.com",
    "https://other.example", "x".repeat(129)]) assert.throws(() => native(selection(), { origin: value }));
  const prepared = native();
  for (const url of [origin + prepared.path + "?x=1", origin + "/model/other/invoke",
    "https://bedrock-runtime.eu-west-1.amazonaws.com" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
});

test("Bedrock request boundary reuses family validation and the 2 MiB JSON bound", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ inputText: "" }));
  assert.ok(native(selection(titan, { inputText: "x".repeat(requestLimit - overhead) })));
  assert.throws(() => native(selection(titan, { inputText: "x".repeat(requestLimit - overhead + 1) })));
  for (const model of ["amazon.titan-embed-text-v9", "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic", "bedrock/" + titan.model])
    assert.throws(() => native(selection({ ...titan, model })));
  for (const body of [{ inputText: "synthetic", inputImage: "AAAA" }, { inputText: "synthetic", stream: true },
    { inputText: "synthetic", s3Uri: "s3://synthetic/input" }, { inputText: "synthetic", embeddingTypes: ["binary"] }])
    assert.throws(() => native(selection(titan, body)));
  assert.throws(() => native(selection(cohere, { ...cohere.body, texts: Array(97).fill("synthetic") })));
  const marengo = wire.cases.find(item => item.model.includes("marengo-embed-2-7"));
  assert.throws(() => native(selection(marengo, { inputType: "text", text: { inputText: "synthetic" } })));
  const v4 = wire.cases.find(item => item.model === "cohere.embed-v4:0");
  for (const fields of [{ output_dimension: 384 }, { truncate: "END" }]) assert.throws(() => native(selection(v4, { ...v4.body, ...fields })));
});

test("Bedrock acquires 64 MiB before dispatch alongside existing request capacity", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(requestLimit), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 68 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(20 * 1024 * 1024), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("Bedrock usage exposes only Titan input counts, never fabricated totals or dollar receipts", async () => {
  for (const count of [0, 7, Number.MAX_SAFE_INTEGER]) {
    const result = await read(response({ ...titan.response, inputTextTokenCount: count }));
    assert.deepEqual(result.usage, { tokens: { input: count, output: null, total: null, cached: null,
      cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, outcome: "success" });
  }
  for (const count of [undefined, null, -1, "7", 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual((await read(response({ ...titan.response, inputTextTokenCount: count }))).usage, { tokens: null, outcome: "success" });
  const result = await read(response({ ...cohere.response, inputTextTokenCount: 999, usage: { total_tokens: 999 } }), selection(cohere));
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
});

test("Bedrock rejects a malformed later vector or native error without delivering a prefix", async () => {
  for (const body of [{ ...cohere.response, embeddings: cohere.response.embeddings.slice(0, 1) },
    { ...cohere.response, embeddings: [cohere.response.embeddings[0], []] },
    { ...cohere.response, embeddings: [cohere.response.embeddings[0], Array(1024).fill("0")] },
    { ...cohere.response, error: { message: "synthetic" } }, { ...cohere.response, __type: "SyntheticFailure" }])
    await assert.rejects(read(response(body), selection(cohere)));
  const nonfinite = JSON.stringify(titan.response).replace('"embedding":[1', '"embedding":[1e999');
  await assert.rejects(read(new Response(nonfinite, { headers: { "content-type": "application/json" } })));
});

test("Bedrock requires complete JSON MIME, HTTP 200, identity encoding and non-range delivery", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-range": "bytes 0-3/10" },
    { "content-encoding": "gzip" }, { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 400, 429, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(undefined, headers); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  const bytes = JSON.stringify(titan.response);
  const result = await read(new Response(bytes, { headers: { "content-type": "application/json; charset=\"UTF-8\"",
    "content-encoding": "identity", "content-length": String(Buffer.byteLength(bytes)) } }));
  assert.deepEqual(await result.response.json(), titan.response);
});

test("Bedrock response bytes are bounded at 8 MiB even without a declared length", async () => {
  const body = { ...titan.response, metadata: "" }, overhead = Buffer.byteLength(JSON.stringify(body));
  body.metadata = "x".repeat(responseLimit - overhead);
  const result = await read(response(body)); assert.equal((await result.response.json()).metadata.length, responseLimit - overhead);
  body.metadata += "x"; await assert.rejects(read(response(body)));
  await assert.rejects(read(response(titan.response, { "content-length": String(responseLimit + 1) })));
});

test("Bedrock waits for EOF and rejects truncated, invalid UTF-8 and interrupted JSON", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(titan.response)); let controller, settled = false;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "application/json" } });
  const pending = read(upstream).then(value => { settled = true; return value; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), titan.response);
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(new Response(new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic interruption")); } }),
    { headers: { "content-type": "application/json" } })));
});

test("Bedrock abort cancels a stalled response and releases capacity without successful observation", async () => {
  for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort();
    const upstream = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
    const pending = read(upstream, selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
