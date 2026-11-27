import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { prepareNativeBedrockConverse } = await import("../native-bedrock-converse.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const origin = "https://bedrock-runtime.us-east-1.amazonaws.com", limit = 2 * 1024 * 1024;
const model = "anthropic.claude-sonnet-4-5-20250929-v1:0";
// Explicit candidate Converse binding; existing Invoke cards are not activated.
const endpoint = { id: "converse", method: "POST", path: "/model/${model}/converse", path_params: ["model"],
  path_param_styles: { model: "opaque_segment" }, query: {}, streaming: null,
  request_format: "aws_bedrock.converse", response_format: "aws_bedrock.converse" };
const request = () => ({ messages: [{ role: "user", content: [{ text: "synthetic prompt" }] }] });
const selection = (upstream = model, body = request()) => ({ provider: { id: "aws-bedrock",
  capabilities: [{ id: "llm.chat", endpoint: "converse" }] }, endpoint: structuredClone(endpoint),
  model: { id: "bedrock/" + upstream, upstream, capabilities: ["llm.chat"] }, capability: "llm.chat",
  body, pathParams: { model: upstream }, method: "POST" });
const native = (selected = selection(), input = { origin }) => prepareNativeBedrockConverse(selected, input);
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 30, cacheWriteInputTokens: 20,
  cacheDetails: [{ ttl: "5m", inputTokens: 7 }, { ttl: "1h", inputTokens: 13 }] };
const tokens = { input: 60, output: 5, total: 65, cached: 30, cacheWrite: 20, cacheWrite5m: 7, cacheWrite1h: 13 };
const envelope = (fields = {}) => ({ output: { message: { role: "assistant", content: [{ text: "synthetic answer" }] } },
  stopReason: "end_turn", usage: structuredClone(usage), ...fields });
const response = (body = envelope(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = native(), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}
function nested(depth) { let value = "leaf"; while (depth--) value = { next: value }; return value; }

test("Converse prepares only the body before signing and binds the exact selected model/ARN", () => {
  for (const upstream of [model, "us." + model, "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic"]) {
    const body = { ...request(), modelId: "caller-override", stream: false, inferenceConfig: { maxTokens: 16 } };
    const selected = selection(upstream, body), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(body, before.body);
    assert.deepEqual(selected, { ...before, body: { messages: body.messages, inferenceConfig: body.inferenceConfig } });
    assert.equal(prepared.path, "/model/" + encodeURIComponent(upstream) + "/converse");
    assert.equal(prepared.origin, origin);
    for (const field of ["query", "tariff", "headers", "body"]) assert.equal(prepared[field], undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(origin + prepared.path)));
    for (const url of [origin + prepared.path + "?trace=ENABLED", origin + "/model/other/converse",
      "https://bedrock-runtime.eu-west-1.amazonaws.com" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
    assert.throws(() => native({ ...selection(upstream), pathParams: { model: "caller-override" } }), /route/);
  }
});

test("Converse leaves unrelated formats alone and requires explicit llm.chat selection", () => {
  for (const format of ["aws_bedrock.invoke", "aws_bedrock.converse_stream", "openai.chat"])
    assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: format } }), undefined);
  for (const change of [{ provider: { ...selection().provider, id: "other" } }, { provider: { id: "aws-bedrock", capabilities: [] } },
    { provider: { id: "aws-bedrock", capabilities: [{ id: "llm.chat", endpoint: "invoke" }] } },
    { model: null }, { model: { ...selection().model, capabilities: ["llm.invoke"] } }, { capability: "llm.invoke" },
    { method: "GET" }, { pathParams: {} }, { pathParams: { model, region: "us-east-1" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }), /route/);
  for (const change of [{ method: "GET" }, { path: "/model/${model}/converse-stream" }, { upstreamPath: endpoint.path },
    { response_format: "aws_bedrock.eventstream" }, { path_params: [] }, { path_params: ["model", "region"] },
    { path_param_styles: { model: "segment" } }, { query: { trace: "ENABLED" } }, { streaming: "aws_eventstream" },
    { websocket: "openai.realtime" }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }), /route/);
});

test("Converse accepts only bounded exact regional origins supplied by common dispatch", () => {
  for (const region of ["us-east-1", "eu-west-1", "ap-southeast-2"])
    assert.equal(native(selection(), { origin: `https://bedrock-runtime.${region}.amazonaws.com` }).origin,
      `https://bedrock-runtime.${region}.amazonaws.com`);
  for (const value of [undefined, null, "", origin + "/", origin + ":443", origin + "?region=other", origin + "#fragment",
    origin + ".other.example", "http://bedrock-runtime.us-east-1.amazonaws.com", "https://synthetic@bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime.${region}.amazonaws.com", "https://other.example", "x".repeat(129)])
    assert.throws(() => native(selection(), { origin: value }), /route/);
});

test("Converse preserves native replay tools and signed reasoning without translation", () => {
  const body = { messages: [{ role: "assistant", content: [
    { reasoningContent: { reasoningText: { text: "synthetic reasoning", signature: "synthetic-signature" } } },
    { toolUse: { toolUseId: "call_1", name: "inspect", input: { value: 1 } } }] },
  { role: "user", content: [{ toolResult: { toolUseId: "call_1", content: [{ text: "synthetic result" }] } }] }],
  toolConfig: { tools: [{ toolSpec: { name: "inspect", inputSchema: { json: { type: "object" } } } }] } };
  const selected = selection(model, structuredClone(body)); native(selected); assert.deepEqual(selected.body, body);
});

test("Converse rejects malformed or streaming input before changing the selection", () => {
  for (const body of [[], {}, { messages: [] }, { messages: [{ role: "system", content: [{ text: "x" }] }] },
    { messages: [{ role: "user", content: [] }] }, ...[true, "true", null, 1].map(stream => ({ ...request(), stream }))]) {
    const selected = selection(model, body), before = structuredClone(selected);
    assert.throws(() => native(selected), /bounded native unary input/); assert.deepEqual(selected, before);
  }
  for (const upstream of ["", "x\n", "x".repeat(2049)]) assert.throws(() => native(selection(upstream)), /input/);
});

test("Converse enforces exact request bytes, depth 64 and 4096 aggregate content blocks", () => {
  const body = { ...request(), metadata: "" }, overhead = Buffer.byteLength(JSON.stringify(body));
  body.metadata = "x".repeat(limit - overhead); assert.ok(native(selection(model, body)));
  body.metadata += "x"; assert.throws(() => native(selection(model, body)), /input/);
  assert.ok(native(selection(model, { ...request(), metadata: nested(63) })));
  assert.throws(() => native(selection(model, { ...request(), metadata: nested(64) })), /input/);
  const blocks = Array.from({ length: 4096 }, () => ({ text: "x" }));
  assert.ok(native(selection(model, { messages: [{ role: "user", content: blocks }] })));
  assert.throws(() => native(selection(model, { messages: [{ role: "user", content: blocks }], system: [{ text: "x" }] })), /input/);
  const messages = Array.from({ length: 4096 }, () => ({ role: "user", content: [{ text: "x" }] }));
  assert.ok(native(selection(model, { messages })));
  assert.throws(() => native(selection(model, { messages: [...messages, messages[0]] })), /input/);
});

test("Converse returns complete native text/tool/reasoning output and codec cache-inclusive usage", async () => {
  const content = [{ text: "synthetic answer" }, { toolUse: { toolUseId: "call_1", name: "inspect", input: { value: 1 } } },
    { reasoningContent: { reasoningText: { text: "synthetic reasoning", signature: "synthetic-signature" } } },
    { reasoningContent: { redactedContent: "AQID" } }];
  for (const stopReason of ["end_turn", "stop_sequence", "max_tokens", "model_context_window_exceeded", "tool_use"]) {
    const body = envelope({ output: { message: { role: "assistant", content } }, stopReason });
    const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(result.usage, { tokens, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined);
    for (const name of ["x-private-upstream", "set-cookie", "content-length"]) assert.equal(result.response.headers.get(name), null);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
  }
});

test("Converse retains unknown usage and TTL observations without inventing zero or a tariff", async () => {
  for (const value of [undefined, null, {}, { ...usage, inputTokens: "10" }, { ...usage, outputTokens: -1 },
    { ...usage, cacheReadInputTokens: 0.5 }, { ...usage, cacheDetails: [{ ttl: "unknown", inputTokens: 1 }] }])
    assert.deepEqual((await read(response(envelope({ usage: value })))).usage, { tokens: null, outcome: "success" });
  const result = await read(response(envelope({ usage: { inputTokens: 0, outputTokens: 0 } })));
  assert.deepEqual(result.usage.tokens, { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null });
});

test("Converse valid refusal/failure returns a content-free error with validated usage", async () => {
  for (const stopReason of ["refusal", "guardrail_intervened", "content_filtered", "synthetic failure detail"]) {
    const result = await read(response(envelope({ stopReason, stop_details: "synthetic private prose" })));
    assert.equal(result.response.status, 502); assert.deepEqual(result.usage, { tokens, outcome: "provider_error" });
    assert.deepEqual(await result.response.json(), { error: { code: stopReason === "refusal" ? "bedrock_refusal" : "bedrock_stop_reason",
      message: "Bedrock Converse did not complete successfully" } });
  }
  const unknown = await read(response(envelope({ stopReason: "refusal", usage: undefined })));
  assert.deepEqual(unknown.usage, { tokens: null, outcome: "provider_error" });
});

test("Converse malformed output throws even with valid usage or a refusal stop", async () => {
  for (const content of [[], [{ text: "x", toolUse: {} }], [{ toolUse: { toolUseId: "bad/id", name: "inspect", input: {} } }],
    [{ reasoningContent: { reasoningText: { text: "x" } } }], [{ unknownContent: "x" }]]) {
    for (const stopReason of ["end_turn", "refusal"])
      await assert.rejects(read(response(envelope({ output: { message: { role: "assistant", content } }, stopReason }))), /invalid_native_bedrock_converse_response/);
  }
  for (const body of [{ usage }, envelope({ output: {} }), envelope({ output: { message: { role: "user", content: [{ text: "x" }] } } })])
    await assert.rejects(read(response(body)), /invalid_native_bedrock_converse_response/);
});

test("Converse bounds complete response bytes, depth and blocks", async () => {
  const body = envelope({ metadata: "" }), overhead = Buffer.byteLength(JSON.stringify(body));
  body.metadata = "x".repeat(limit - overhead);
  assert.equal((await (await read(response(body))).response.json()).metadata.length, limit - overhead);
  body.metadata += "x"; await assert.rejects(read(response(body)));
  await assert.rejects(read(response(envelope(), { "content-length": String(limit + 1) })));
  assert.ok(await read(response(envelope({ metadata: nested(63) }))));
  await assert.rejects(read(response(envelope({ metadata: nested(64) }))));
  const content = Array.from({ length: 4096 }, () => ({ text: "x" }));
  assert.ok(await read(response(envelope({ output: { message: { role: "assistant", content } } }))));
  content.push({ text: "x" }); await assert.rejects(read(response(envelope({ output: { message: { role: "assistant", content } } }))));
});

test("Converse requires HTTP 200, JSON UTF-8, identity encoding and exact length", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-encoding": "gzip" }, { "content-range": "bytes 0-3/10" },
    { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "1" },
    { "content-encoding": "identity", "content-length": "1" }]) await assert.rejects(read(response(envelope(), headers)));
  for (const status of [201, 206, 302, 400, 429, 500]) await assert.rejects(read(response(envelope(), {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(envelope(), headers); Object.defineProperty(redirected, "redirected", { value: true });
    await assert.rejects(read(redirected));
  }
  const body = JSON.stringify(envelope());
  const result = await read(new Response(body, { headers: { "content-type": "application/json; charset=\"UTF-8\"",
    "content-encoding": "identity", "content-length": String(Buffer.byteLength(body)) } }));
  assert.deepEqual(await result.response.json(), envelope());
});

test("Converse waits for EOF, never exposes a valid prefix, and rejects corrupt/interrupted bodies", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope())); let controller, settled = false;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "application/json" } });
  const pending = read(upstream).then(value => { settled = true; return value; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), envelope());
  for (const body of [bytes.subarray(0, -1), new Uint8Array([0xff, 0xfe]), JSON.stringify(envelope()) + "{}"])
    await assert.rejects(read(new Response(body, { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(new Response(new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic interruption")); } }),
    { headers: { "content-type": "application/json" } })));
});

test("Converse reserves 64 MiB within the existing budget and refuses competing capacity", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(limit), true);
  const lease = native().acquire();
  try {
    assert.equal(bodyBudgetCharged(), baseline + 68 * 1024 * 1024);
    assert.throws(() => native().acquire(), /capacity is busy/);
  } finally { lease.release(); input.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("Converse abort cancels stalled reads without usage and the caller releases the lease", async () => {
  for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort();
    const upstream = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
    const pending = read(upstream, abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(); }
    await assert.rejects(pending, /invalid_native_bedrock_converse_response/);
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
