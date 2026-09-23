import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesUsageInspector } from "../responses-usage.ts";
import { extractUsageTokens, responseOutcome } from "../token-usage.ts";
import { observeUsage } from "../proxy-response.ts";

const encode = value => new TextEncoder().encode(value);
const usage = { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 } };
const response = { object: "response", status: "completed", service_tier: "priority", usage };
const terminal = { type: "response.completed", response };
const frame = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const expected = value => ({ tokens: extractUsageTokens(value), outcome: responseOutcome(value) });
async function inspect(wire, sse = false, size = 4093) {
  const bytes = typeof wire === "string" ? encode(wire) : wire;
  const inspector = createResponsesUsageInspector(sse);
  for (let offset = 0; offset < bytes.length; offset += size) await inspector.push(bytes.subarray(offset, offset + size));
  await inspector.end();
  return inspector.result(true);
}

test("Responses observe late usage beyond 2 MiB in JSON and one terminal SSE event", async () => {
  const large = { output: [{ type: "message", content: [{ type: "output_text", text: "🦊".repeat(600_000) }] }], ...response };
  const json = JSON.stringify(large), sse = frame({ type: "response.created" }) + frame({ response: large, type: "response.completed" });
  assert.deepEqual(await inspect(json), expected(response));
  assert.deepEqual(await inspect(sse, true, encode(sse).length), expected(terminal));
});

test("escaped keys, Unicode, and number fragments match complete Responses at every split", async () => {
  const raw = '{"output":[{"text":"🦊\\n\\u0061"}],"object":"response","status":"completed","us\\u0061ge":{"input_tokens":1.2e2,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}}';
  const bytes = encode(raw), wanted = expected(JSON.parse(raw));
  for (let split = 0; split <= bytes.length; split++) {
    const inspector = createResponsesUsageInspector(false);
    await inspector.push(bytes.subarray(0, split)); await inspector.push(bytes.subarray(split)); await inspector.end();
    assert.deepEqual(inspector.result(true), wanted, `split ${split}`);
  }
});

test("duplicate ancestors replace descendants and preserve nullish normalization", async () => {
  const u = JSON.stringify(usage);
  for (const fields of [
    `"usage":${u},"usage":{"output_tokens":7}`,
    `"usage":${u},"usage":null,"response":{"usage":${u}}`,
    ...["false", "0", '""', "[]"].map(value => `"usage":${value},"response":{"usage":${u}}`),
    `"response":{"usage":${u},"service_tier":"priority"},"response":{}`,
    `"response":{"usage":${u}},"response":null,"usage":${u},"service_tier":"priority"`,
    `"response":[],"usage":${u},"service_tier":"priority"`,
    `"response":{},"usage":${u},"service_tier":"priority"`,
    '"usage":{"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":9},"input_tokens_details":{"cache_write_tokens":4}}',
    '"usage":{"input_tokens":12,"output_tokens":3,"prompt_tokens_details":null,"input_tokens_details":{"cached_tokens":9}}',
    '"usage":{"input_tokens":12,"output_tokens":3,"prompt_tokens_details":[],"input_tokens_details":{"cached_tokens":9}}',
    '"usage":{"input_tokens":12,"output_tokens":3,"cache_creation":{"ephemeral_5m_input_tokens":4},"cache_creation":{"ephemeral_1h_input_tokens":9}}',
    '"error":{"message":"first"},"error":false',
  ]) {
    const raw = `{"object":"response","status":"completed",${fields}}`;
    assert.deepEqual(await inspect(raw, false, 1), expected(JSON.parse(raw)), raw);
    const event = `{"type":"response.completed","response":${raw}}`;
    assert.deepEqual(await inspect(frame(event), true, 3), expected(JSON.parse(event)), event);
  }
});

test("error truthiness is exact without retaining error content", async () => {
  for (const error of [null, false, 0, "", true, 2, "x".repeat(2 * 1024 * 1024), {}, []]) {
    const value = { ...response, error };
    assert.deepEqual(await inspect(JSON.stringify(value)), expected(value));
    const event = { ...terminal, error };
    assert.deepEqual(await inspect(frame(event), true), expected(event));
  }
});

test("Responses only observe contract paths, not output or other wire dialects", async () => {
  const other = { meta: usage, message: { usage }, usageMetadata: { promptTokenCount: 900 }, output: [{ ...response, error: { message: "tool data" } }] };
  assert.deepEqual(await inspect(JSON.stringify(other)), { tokens: null, outcome: null });
  assert.deepEqual(await inspect(JSON.stringify({ ...other, ...response })), expected(response));
});

test("SSE framing keeps BOM, colonless data, last event field, multiline data and split CR/LF", async () => {
  const text = '\ufeff: heartbeat\ndata\ndata: {"type":"response.completed",\ndata: "response":' + JSON.stringify(response) + '}\n\n';
  for (const newline of ["\n", "\r", "\r\n"]) for (const size of [1, 2, 7, 4093]) {
    assert.deepEqual(await inspect(text.replaceAll("\n", newline), true, size), expected(terminal));
  }
  assert.deepEqual(await inspect("event:error\nevent:message\n" + frame(terminal), true, 1), expected(terminal));
  assert.deepEqual(await inspect("event:message\nevent:error\n" + frame(terminal), true), { tokens: null, outcome: "provider_error" });
  assert.deepEqual(await inspect("event:error\nevent\n" + frame(terminal), true), expected(terminal));
  assert.deepEqual(await inspect("ignored".repeat(400_000) + "\n" + frame(terminal), true), expected(terminal));
  assert.deepEqual(await inspect("event:" + "x".repeat(2 * 1024 * 1024) + "\n" + frame(terminal), true), expected(terminal));
});

test("SSE accepts facts only at a completed event and preserves terminal/error precedence", async () => {
  const first = frame({ type: "response.created" });
  for (const ending of [frame(terminal).trimEnd(), 'data: {"type":"response.completed"', "data: [DONE]\n\n", "data: {broken}\n\n"]) {
    assert.deepEqual(await inspect(first + ending, true), { tokens: null, outcome: "provider_error" });
  }
  assert.deepEqual(await inspect(frame(terminal) + "data: [DONE]\n\ndata: {broken}\n\n", true), expected(terminal));
  assert.deepEqual(await inspect(frame(terminal) + "event:error\n\n", true), { ...expected(terminal), outcome: "provider_error" });
  assert.deepEqual(await inspect("data:   [DONE]  \n\n", true, 1), { tokens: null, outcome: "success" });
});

test("strict JSON EOF and UTF-8 errors never settle partial counts", async () => {
  const valid = JSON.stringify(response);
  for (const raw of [valid.slice(0, -1), valid + " false", valid + "!", '{"usage":{"input_tokens":01}}', '{"usage":1,"x":"\\uXX00"}']) {
    assert.deepEqual(await inspect(raw, false, 1), { tokens: null, outcome: "provider_error" });
  }
  const invalid = new Uint8Array([...encode('{"usage":'), 0xc3, ...encode(JSON.stringify(usage) + "}")]);
  assert.deepEqual(await inspect(invalid, false, 1), { tokens: null, outcome: "provider_error" });
  assert.deepEqual(await inspect(new Uint8Array([...encode(valid), 0xc3])), { tokens: null, outcome: "provider_error" });
});

test("inspection limits mean unknown, preserve later SSE evidence, and bound selected captures", async () => {
  const within = "[".repeat(127) + "0" + "]".repeat(127);
  assert.deepEqual(await inspect(`{"output":${within},"usage":${JSON.stringify(usage)}}`), { tokens: extractUsageTokens({ usage }), outcome: null });
  const tooDeep = "[".repeat(128) + "0" + "]".repeat(128);
  const cases = [
    `{"output":${tooDeep},"usage":${JSON.stringify(usage)}}`,
    JSON.stringify({ ...response, service_tier: "x".repeat(65) }),
    '{"usage":{"input_tokens":1e' + "0".repeat(64) + ',"output_tokens":3}}',
  ];
  for (const raw of cases) {
    assert.deepEqual(await inspect(raw), { tokens: null, outcome: null });
    const oversized = `data: {"type":"response.completed","response":${raw}}\n\n`;
    assert.deepEqual(await inspect(frame({ type: "response.created" }) + oversized, true), { tokens: null, outcome: null });
    assert.deepEqual(await inspect(oversized + frame(terminal), true), expected(terminal));
    assert.deepEqual(await inspect(frame({ type: "response.created" }) + oversized.trimEnd(), true), { tokens: null, outcome: null });
  }
  assert.deepEqual(await inspect(`{"${"x".repeat(100_000)}":0,"usage":${JSON.stringify(usage)}}`), { tokens: extractUsageTokens({ usage }), outcome: null });
});

test("selected format and MIME own incremental inspection while delivery bytes stay identical", async () => {
  const wire = JSON.stringify({ output: "x".repeat(2 * 1024 * 1024), ...response });
  for (const [format, contentType, observedTokens] of [
    ["openai.responses", "Application/JSON", true],
    ["openai.responses", "application/octet-stream", false],
    ["openai.chat_completions", "application/json", false],
    [undefined, "application/json", false],
  ]) {
    const observed = observeUsage(new Response(wire, { headers: { "content-type": contentType } }), undefined, undefined, format);
    assert.equal(await observed.response.text(), wire);
    assert.equal((await observed.result).tokens?.total ?? null, observedTokens ? 15 : null);
  }
});

test("cancel during an awaited feed cannot publish identities or late JSON facts", async t => {
  const abort = new AbortController();
  let decoded = 0, canceled = 0, published = 0, ended = 0;
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (bytes, options) {
    if (bytes?.byteLength === 4096 && ++decoded === 2) queueMicrotask(() => abort.abort(new Error("fixture parse abort")));
    return decode.call(this, bytes, options);
  });
  const wire = encode(JSON.stringify({ output: "x".repeat(32_000), ...response }));
  const upstream = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(wire); },
    cancel() { canceled++; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const observed = observeUsage(upstream, abort.signal, { async push() { published++; }, async end() { ended++; } }, "openai.responses");
  await assert.rejects(observed.response.text(), /fixture parse abort/);
  assert.deepEqual(await observed.result, { delivery: "canceled", tokens: null, outcome: null });
  assert.equal(decoded, 2); assert.equal(published, 0); assert.equal(ended, 0);
  assert.equal(canceled, 1);
  assert.equal(upstream.body.locked, false);
});
