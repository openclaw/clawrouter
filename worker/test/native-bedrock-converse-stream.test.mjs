import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import test from "node:test";
import { eventFrame } from "./bedrock-eventstream-fixture.mjs";
const { prepareNativeBedrockConverseStream } = await import("../native-bedrock-converse-stream.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { providerById, signSigV4 } = await import("../providers.ts");
const { prepareUpstreamRequest } = await import("../proxy-upstream-request.ts");
const origin = "https://bedrock-runtime.us-east-1.amazonaws.com", limit = 2 * 1024 * 1024;
const model = "anthropic.claude-sonnet-4-5-20250929-v1:0", format = "aws_bedrock.converse_stream";
const base = providerById("aws-bedrock");
// Candidate only: no production manifest, factory or compiler activation.
const endpoint = { ...base.endpoints.find(item => item.id === "invoke_model_stream"), id: "converse_stream",
  path: "/model/${model}/converse-stream", streaming: null, modelPassthrough: undefined,
  request_format: format, response_format: "aws_bedrock.converse_eventstream" };
const request = () => ({ messages: [{ role: "user", content: [{ text: "synthetic prompt" }] }] });
const selection = (upstream = model, body = request()) => ({ provider: { ...base,
  capabilities: [{ id: "llm.chat", endpoint: endpoint.id, methods: ["POST"] }] }, endpoint: structuredClone(endpoint),
  model: { id: "bedrock/" + upstream, upstream, capabilities: ["llm.chat"] }, capability: "llm.chat",
  body, pathParams: { model: upstream }, method: "POST" });
const native = (selected = selection(), input = { origin }) => prepareNativeBedrockConverseStream(selected, input);
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 30, cacheWriteInputTokens: 20,
  cacheDetails: [{ ttl: "5m", inputTokens: 7 }, { ttl: "1h", inputTokens: 13 }] };
const tokens = { input: 60, output: 5, total: 65, cached: 30, cacheWrite: 20, cacheWrite5m: 7, cacheWrite1h: 13 };
const event = (kind, value, extra = {}) => eventFrame(value,
  { ":message-type": "event", ":event-type": kind, ":content-type": "application/json", ...extra });
const exception = kind => eventFrame({ message: "synthetic private provider prose" },
  { ":message-type": "exception", ":exception-type": kind, ":content-type": "application/json" });
const start = () => event("messageStart", { role: "assistant" });
const delta = (text = "synthetic answer 🦊", index = 0) => event("contentBlockDelta", { contentBlockIndex: index, delta: { text } });
const stopBlock = (index = 0) => event("contentBlockStop", { contentBlockIndex: index });
const stop = (stopReason = "end_turn") => event("messageStop", { stopReason });
const metadata = (value = usage) => event("metadata", { usage: value });
const wire = (text, stopReason) => Buffer.concat([start(), delta(text), stopBlock(), stop(stopReason), metadata()]);
const response = (bytes = wire(), headers = {}, status = 200) => new Response(bytes,
  { status, headers: { "content-type": "application/vnd.amazon.eventstream", ...headers } });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = native(), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}
const received = async result => Buffer.from(await result.response.arrayBuffer());
function nested(depth) { let value = "leaf"; while (depth--) value = { next: value }; return value; }
function resign(bytes) {
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4); return bytes;
}

test("ConverseStream binds explicit chat models, opaque ARNs and server-owned regional origins", () => {
  for (const upstream of [model, "us." + model, "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic"]) {
    const selected = selection(upstream), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, origin);
    assert.equal(prepared.path, "/model/" + encodeURIComponent(upstream) + "/converse-stream");
    for (const key of ["query", "tariff", "headers", "body"]) assert.equal(prepared[key], undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(origin + prepared.path)));
    assert.throws(() => native({ ...selected, pathParams: { model: "caller-override" } }), /route/);
    for (const url of [origin + prepared.path + "?x=1", origin + "/model/other/converse-stream",
      "https://bedrock-runtime.eu-west-1.amazonaws.com" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(native(selection(), { origin: "https://bedrock-runtime.eu-west-1.amazonaws.com" }).origin,
    "https://bedrock-runtime.eu-west-1.amazonaws.com");
  for (const value of [undefined, null, "", origin + "/", origin + ":443", origin + "?x=1", origin + "#x", origin + ".other.example",
    "http://bedrock-runtime.us-east-1.amazonaws.com", "https://synthetic@bedrock-runtime.us-east-1.amazonaws.com", "x".repeat(129)])
    assert.throws(() => native(selection(), { origin: value }), /route/);
});

test("ConverseStream refuses undeclared, passthrough, generic streaming and overridden routes", () => {
  for (const request_format of ["aws_bedrock.invoke", "aws_bedrock.converse", "openai.chat"])
    assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format } }), undefined);
  for (const fields of [{ model: null }, { capability: "llm.invoke" }, { model: { ...selection().model, capabilities: ["llm.invoke"] } },
    { provider: { ...base, id: "other" } }, { provider: { ...base, capabilities: [] } }, { method: "GET" },
    { pathParams: {} }, { pathParams: { model, region: "us-east-1" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...fields }), /route/);
  for (const fields of [{ method: "GET" }, { path: "/model/${model}/converse" }, { upstreamPath: endpoint.path },
    { path_params: [] }, { path_param_styles: { model: "segment" } }, { response_format: "aws_bedrock.eventstream" },
    { query: { trace: "ENABLED" } }, { streaming: "aws_eventstream" }, { websocket: "openai.realtime" },
    { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...fields } }), /route/);
});

test("ConverseStream validates and strips route aliases before actual serialization and SigV4", async () => {
  const body = { ...request(), modelId: "caller-override", stream: true }, selected = selection(model, body);
  const before = structuredClone(selected), prepared = native(selected);
  assert.deepEqual(body, before.body); assert.deepEqual(selected, { ...before, body: request() });
  const env = { AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_REGION: "us-east-1" };
  const serialized = prepareUpstreamRequest(new Request("https://router.example/test"), env, selected, {},
    { baseUrl: origin, headers: new Headers(), query: new URLSearchParams(), transportPaths: {}, grant: null }, "http");
  assert.equal(serialized.url.href, origin + prepared.path);
  assert.equal(serialized.requestBody, JSON.stringify(request()));
  await signSigV4(selected.provider, serialized.url, "POST", serialized.requestBody, serialized.headers, env, null,
    new Date("2026-01-01T00:00:00Z"));
  assert.equal(serialized.headers.get("x-amz-content-sha256"), createHash("sha256").update(JSON.stringify(request())).digest("hex"));
  assert.match(serialized.headers.get("authorization"), /20260101\/us-east-1\/bedrock\/aws4_request/);
});

test("ConverseStream request bounds include 2 MiB, depth 64, 4096 blocks and native roles", () => {
  const body = { ...request(), metadata: "" }, overhead = Buffer.byteLength(JSON.stringify(body));
  body.metadata = "x".repeat(limit - overhead); assert.ok(native(selection(model, body)));
  body.metadata += "x"; assert.throws(() => native(selection(model, body)), /input/);
  assert.ok(native(selection(model, { ...request(), metadata: nested(63) })));
  assert.throws(() => native(selection(model, { ...request(), metadata: nested(64) })), /input/);
  const blocks = Array.from({ length: 4096 }, () => ({ text: "x" }));
  assert.ok(native(selection(model, { messages: [{ role: "user", content: blocks }] })));
  assert.throws(() => native(selection(model, { messages: [{ role: "user", content: blocks }], system: [{ text: "x" }] })), /input/);
  for (const body of [[], {}, { messages: [] }, { messages: [{ role: "system", content: [{ text: "x" }] }] },
    ...[false, "true", null].map(stream => ({ ...request(), stream }))]) {
    const selected = selection(model, body), before = structuredClone(selected);
    assert.throws(() => native(selected), /input/); assert.deepEqual(selected, before);
  }
});

test("ConverseStream preserves exact original concatenated wire bytes across arbitrary fragments", async () => {
  const bytes = wire();
  for (const width of [1, 3, 11, 12, 37, bytes.length]) {
    let offset = 0;
    const upstream = response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + width, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), { "x-private-upstream": "synthetic", "set-cookie": "synthetic" });
    const result = await read(upstream); assert.deepEqual(await received(result), bytes);
    assert.deepEqual(result.usage, { tokens, outcome: "success" }); assert.equal(result.usage.requestCostReceipt, undefined);
    assert.equal(result.response.headers.get("content-type"), "application/vnd.amazon.eventstream");
    assert.equal(result.response.headers.get("content-length"), String(bytes.length));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    for (const name of ["x-private-upstream", "set-cookie", "content-encoding"]) assert.equal(result.response.headers.get(name), null);
  }
});

test("ConverseStream holds every byte until complete EOF even after stop and usage", async () => {
  const bytes = wire(); let controller, settled = false;
  const upstream = response(new ReadableStream({ start(value) { controller = value; } }));
  const pending = read(upstream).then(value => { settled = true; return value; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await received(await pending), bytes);
  assert.equal(upstream.body.locked, false);
});

test("ConverseStream preserves signed reasoning and releases tools only after every sibling validates", async () => {
  const tool = (index, id) => event("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: id, name: "inspect" } } });
  const argument = (index, input) => event("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input } } });
  const prefix = [start(), event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "synthetic reasoning" } } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "synthetic-signature" } } }), stopBlock(),
    tool(1, "call_1"), argument(1, '{"value":'), argument(1, "1}"), stopBlock(1), tool(2, "call_2")];
  const bytes = Buffer.concat([...prefix, argument(2, "{}"), stopBlock(2), stop("tool_use"), metadata()]);
  assert.deepEqual(await received(await read(response(bytes))), bytes);
  for (const suffix of [[argument(2, "{"), stopBlock(2), stop("tool_use"), metadata()], [argument(2, "{}"), stop("tool_use"), metadata()]])
    await assert.rejects(read(response(Buffer.concat([...prefix, ...suffix]))), /invalid_native_bedrock_converse_stream_response/);
});

test("ConverseStream cache counters remain inclusive while unknown usage and TTLs stay unknown", async () => {
  for (const value of [null, {}, { ...usage, inputTokens: "10" }, { ...usage, outputTokens: -1 },
    { ...usage, cacheDetails: [{ ttl: "unknown", inputTokens: 1 }] }]) {
    const result = await read(response(Buffer.concat([start(), delta(), stopBlock(), stop(), metadata(value)])));
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  }
  const missing = await read(response(Buffer.concat([start(), delta(), stopBlock(), stop()])));
  assert.deepEqual(missing.usage, { tokens: null, outcome: "success" });
  const zero = await read(response(Buffer.concat([start(), stop(), metadata({ inputTokens: 0, outputTokens: 0 })])));
  assert.deepEqual(zero.usage.tokens, { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null });
});

test("ConverseStream maps only five modeled exceptions and sanitizes valid failures with usage", async () => {
  for (const kind of ["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"]) {
    const bytes = Buffer.concat([start(), delta("synthetic private answer"), exception(kind), metadata()]);
    const result = await read(response(bytes)); assert.equal(result.response.status, 502);
    assert.deepEqual(result.usage, { tokens, outcome: "provider_error" });
    assert.deepEqual(await result.response.json(), { error: { code: "bedrock_" + kind, message: "Bedrock ConverseStream did not complete successfully" } });
    const unknown = await read(response(exception(kind)));
    assert.deepEqual(unknown.usage, { tokens: null, outcome: "provider_error" });
  }
  for (const stopReason of ["refusal", "guardrail_intervened", "content_filtered"]) {
    const result = await read(response(wire("synthetic private answer", stopReason)));
    assert.deepEqual(result.usage, { tokens, outcome: "provider_error" }); assert.equal(result.response.status, 502);
    assert.deepEqual(await result.response.json(), { error: { code: stopReason === "refusal" ? "bedrock_refusal" : "bedrock_stop_reason",
      message: "Bedrock ConverseStream did not complete successfully" } });
  }
});

test("ConverseStream rejects unknown/error mappings and contradictory or wrapped event metadata", async () => {
  const mappings = [event("unknown", {}), event("chunk", { bytes: "e30=" }), event("internalServerException", {}),
    exception("unknownException"), event("messageStart", { messageStart: { role: "assistant" } }),
    event("messageStart", { role: "assistant" }, { ":exception-type": "validationException" }),
    event("messageStart", { role: "assistant" }, { ":exception-type": "" }),
    event("messageStart", { role: "assistant" }, { ":content-type": "text/plain" }),
    event("messageStart", { role: "assistant" }, { ":error-code": "synthetic" }),
    eventFrame({}, { ":message-type": "error", ":error-code": "InternalError", ":content-type": "application/json" }),
    eventFrame({}, { ":message-type": "exception", ":exception-type": "validationException", ":event-type": "", ":content-type": "application/json" }),
    eventFrame({}, { ":message-type": "event", ":event-type": "messageStart" })];
  for (const bytes of mappings) await assert.rejects(read(response(Buffer.concat([wire(), bytes]))));
  for (const extra of [{ ":exception-type": "" }, { ":content-type": "text/plain" }, { ":content-type": "" }])
    await assert.rejects(read(response(Buffer.concat([event("messageStart", { role: "assistant" }, extra), delta(), stopBlock(), stop(), metadata()]))));
});

test("ConverseStream validates every CRC, declared length, header UTF-8 and header uniqueness", async () => {
  const good = start();
  for (const index of [0, 4, 8, 13, good.length - 5, good.length - 1]) {
    const bad = Buffer.from(good); bad[index] ^= 1; await assert.rejects(read(response(bad)));
  }
  for (const [length, headers] of [[15, 0], [good.length + 1, 0], [good.length, good.length], [0xffffffff, 0]]) {
    const bad = Buffer.from(good); bad.writeUInt32BE(length); bad.writeUInt32BE(headers, 4); resign(bad);
    await assert.rejects(read(response(bad)));
  }
  const invalidName = Buffer.from(good); invalidName[13] = 0xff; await assert.rejects(read(response(resign(invalidName))));
  const invalidValue = Buffer.from(good); invalidValue[invalidValue.indexOf("messageStart")] = 0xff;
  await assert.rejects(read(response(resign(invalidValue))));
  const headerLength = good.readUInt32BE(4), first = good.subarray(12, 12 + 1 + Buffer.byteLength(":message-type") + 1 + 2 + 5);
  const duplicate = Buffer.concat([good.subarray(0, 12 + headerLength), first, good.subarray(12 + headerLength)]);
  duplicate.writeUInt32BE(duplicate.length); duplicate.writeUInt32BE(headerLength + first.length, 4);
  await assert.rejects(read(response(resign(duplicate))));
});

test("ConverseStream rejects malformed JSON, fatal payload UTF-8 and late corrupt evidence", async () => {
  const badUtf8 = delta(); badUtf8[12 + badUtf8.readUInt32BE(4)] = 0xff; resign(badUtf8);
  const invalidText = delta("synthetic UTF8"); invalidText[invalidText.indexOf("synthetic UTF8")] = 0xff; resign(invalidText);
  await assert.rejects(read(response(Buffer.concat([start(), invalidText, stopBlock(), stop(), metadata()]))));
  for (const bytes of [badUtf8, event("metadata", "{"), event("metadata", "null"), event("metadata", "[]"),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { unsupported: true } })])
    await assert.rejects(read(response(Buffer.concat([wire(), bytes]))));
  await assert.rejects(read(response(Buffer.concat([start(), exception("validationException"), metadata(), badUtf8]))));
});

test("ConverseStream enforces the complete 2 MiB wire bound including an exact-boundary response", async () => {
  const overhead = wire("").length, exact = wire("x".repeat(limit - overhead)); assert.equal(exact.length, limit);
  assert.deepEqual(await received(await read(response(exact))), exact);
  await assert.rejects(read(response(Buffer.concat([exact, Buffer.from([0])]))));
  await assert.rejects(read(response(wire(), { "content-length": String(limit + 1) })));
});

test("ConverseStream independently bounds inflated decoded events, depth 64 and 4096 block indexes", async () => {
  const numeric = "[" + Array(60000).fill("1e15").join(",") + "]";
  const inflated = event("contentBlockDelta", '{"contentBlockIndex":0,"delta":{"text":"x"},"padding":' + numeric + "}");
  const extra = event("metadata", '{"padding":[' + Array(5000).fill("1e15").join(",") + "]}");
  const bytes = Buffer.concat([start(), inflated, inflated, stopBlock(), stop(), extra]);
  assert.ok(bytes.length < limit); await assert.rejects(read(response(bytes)));
  const prefix = [start(), delta(), stopBlock(), stop()];
  assert.ok(await read(response(Buffer.concat([...prefix, event("metadata", { extra: nested(62) })]))));
  await assert.rejects(read(response(Buffer.concat([...prefix, event("metadata", { extra: nested(63) })]))));
  const blocks = [start()];
  for (let index = 0; index < 4096; index++) blocks.push(delta("x", index), stopBlock(index));
  const valid = Buffer.concat([...blocks, stop(), metadata()]); assert.ok(valid.length < limit);
  assert.deepEqual(await received(await read(response(valid))), valid);
  await assert.rejects(read(response(Buffer.concat([...blocks, delta("x", 4096), stopBlock(4096), stop(), metadata()]))));
});

test("ConverseStream bounds header allocation and pathological empty-chunk work", async () => {
  const oversizedHeaders = event("messageStart", { role: "assistant" }, { fixture: "x".repeat(4096) });
  await assert.rejects(read(response(oversizedHeaders)));
  const tinyFrames = Buffer.concat(Array(16385).fill(start())); assert.ok(tinyFrames.length < limit);
  const baseline = bodyBudgetCharged(); await assert.rejects(read(response(tinyFrames))); assert.equal(bodyBudgetCharged(), baseline);
  let pulls = 0, canceled = false;
  const upstream = response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } }));
  await assert.rejects(read(upstream)); assert.equal(canceled, true); assert.ok(pulls <= 65537); assert.equal(upstream.body.locked, false);
});

test("ConverseStream requires HTTP 200, binary MIME, exact identity length and non-range delivery", async () => {
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "application/vnd.amazon.eventstream; charset=utf-8" },
    { "content-encoding": "gzip" }, { "content-range": "bytes 0-3/10" }, { "content-length": "-1" }, { "content-length": "1.5" },
    { "content-length": "1" }, { "content-encoding": "identity", "content-length": "1" }]) await assert.rejects(read(response(wire(), headers)));
  for (const status of [201, 206, 302, 400, 429, 500]) await assert.rejects(read(response(wire(), {}, status)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  const bytes = wire(); assert.deepEqual(await received(await read(response(bytes,
    { "content-encoding": "identity", "content-length": String(bytes.length) }))), bytes);
});

test("ConverseStream incomplete terminals, truncated frames and interrupted bodies never release bytes", async () => {
  const bytes = wire();
  for (const prefix of [Buffer.alloc(0), start(), Buffer.concat([start(), delta(), metadata()]),
    bytes.subarray(0, 1), bytes.subarray(0, 11), bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.alloc(4)])])
    await assert.rejects(read(response(prefix)), /invalid_native_bedrock_converse_stream_response/);
  await assert.rejects(read(response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes); controller.error(new Error("synthetic interrupted transport"));
  } }))));
});

test("ConverseStream abort and deadline signals cancel quarantine and release reader/listener/capacity", async () => {
  for (const mode of ["before", "during", "deadline"]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false, listeners = 0;
    const signal = mode === "deadline" ? AbortSignal.timeout(5) : abort.signal;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { listeners++; return add(...args); };
    signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
    if (mode === "before") abort.abort();
    const upstream = response(new ReadableStream({ start(controller) { controller.enqueue(wire()); }, cancel() { canceled = true; } }));
    const pending = read(upstream, signal);
    if (mode === "during") { await new Promise(setImmediate); abort.abort(); }
    // Keep the test alive for Node's unref'ed AbortSignal.timeout timer.
    const keepAlive = setTimeout(() => {}, 100);
    try { await assert.rejects(pending, /invalid_native_bedrock_converse_stream_response/); } finally { clearTimeout(keepAlive); }
    assert.equal(canceled, true); assert.equal(upstream.body.locked, false); assert.equal(listeners, 0); assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("ConverseStream charges 64 MiB with ingress and refuses competing leases", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(limit), true);
  const lease = native().acquire();
  try { assert.equal(bodyBudgetCharged(), baseline + 68 * 1024 * 1024); assert.throws(() => native().acquire(), /capacity is busy/); }
  finally { lease.release(); input.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});
for (const mode of ["headers", "abort", "cleanup-rejection"]) test(`source retirement holds capacity through ${mode}, including reentrant cancellation`, { timeout: 5000 }, async t => {
  const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const abort = new AbortController(), baseline = bodyBudgetCharged();
  let cancels = 0, completed = false;
  const source = new ReadableStream({
    pull() { ready.resolve(); },
    cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const prepared = native(), lease = prepared.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = prepared.read(response(source, mode === "headers" ? { "content-type": "application/json" } : {}), abort.signal)
    .finally(() => { completed = true; lease.release(); });
  const rejected = assert.rejects(result);
  if (mode !== "headers") { await ready.promise; abort.abort(); }
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(cancels, 1); assert.equal(completed, false); assert.equal(source.locked, true);
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  const competing = new BodyLease();
  assert.equal(competing.grow(17 * 1024 * 1024), false); competing.release();
  if (mode === "cleanup-rejection") cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
  await rejected;
  assert.equal(cancels, 1); assert.equal(source.locked, false);
  assert.equal(bodyBudgetCharged(), baseline);
  lease.release(); assert.equal(bodyBudgetCharged(), baseline);
});
