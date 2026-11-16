import assert from "node:assert/strict";
import test from "node:test";
import { createNativeEventObserver } from "../native-events.ts";
import { createRadiusEventInspector } from "../provider-radius.ts";
import { usageInspectionLimit } from "../token-usage.ts";

const usage = { input: 5, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 11, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };
const terminal = { type: "done", reason: "toolUse", usage };
const wire = [
  ': fixture keepalive\r\n\r\n',
  'data: {"type":"start"}\r\n\r\n',
  'data: {"type":"toolcall_start","contentIndex":0,"id":"fixture","toolName":"forecast"}\r\n\r\n',
  'data: {"type":"toolcall_delta","contentIndex":0,"delta":"synthetic 🦊"}\r\n\r\n',
  'data: {"type":"toolcall_end","contentIndex":0,\r\ndata: "toolCall":{"type":"toolCall","id":"fixture","name":"forecast","arguments":{}}}\r\n\r\n',
  `data: ${JSON.stringify(terminal)}\r\n\r\n`,
].join('');
const tokens = { input: 9, output: 2, total: 11, cached: 3, cacheWrite: 1, cacheWrite5m: null, cacheWrite1h: null };
function inspect(bytes, step = bytes.length) {
  const observer = createNativeEventObserver(createRadiusEventInspector());
  for (let i = 0; i < bytes.length; i += step) observer.push(bytes.subarray(i, i + step));
  return observer.result();
}

test("shared native SSE framing handles CRLF, multiline JSON and every byte split", () => {
  const bytes = Buffer.from(wire);
  for (const step of [1, 2, 3, 17, bytes.length]) assert.deepEqual(inspect(bytes, step), { tokens, outcome: "success" });
  assert.equal(Buffer.from(bytes).toString(), wire);
});

test("malformed, oversized, invalid UTF-8 and incomplete frames cannot certify a native terminal", () => {
  const end = `data: ${JSON.stringify(terminal)}\n\n`, valid = Buffer.from(end);
  for (const bytes of [
    Buffer.from(wire + 'data: {'), Buffer.from(wire + 'data: [DONE]\n\n'),
    Buffer.from(wire + 'data: {broken}\n\n'), Buffer.from(wire + 'unsupported: field\n\n'),
    Buffer.from('data: ' + 'x'.repeat(usageInspectionLimit + 1) + '\n\n' + end),
    Buffer.concat([Buffer.from('data: {"type":"start","extra":"'), Buffer.from([0xff]), Buffer.from('"}\n\n'), valid]),
    valid.subarray(0, valid.length - 1),
  ]) assert.deepEqual(inspect(bytes), { tokens: null, outcome: null });
  assert.deepEqual(inspect(Buffer.from(wire + ': unfinished comment')), { tokens, outcome: "success" });
});

test("native error usage is retained and a complete terminal survives cancellation without a partial next frame", () => {
  const observer = createNativeEventObserver(createRadiusEventInspector());
  observer.push(Buffer.from(`data: ${JSON.stringify({ type: "error", reason: "aborted", usage })}\n\n`));
  assert.deepEqual(observer.result(), { tokens, outcome: "provider_error" });
  observer.push(Buffer.from('data: {broken}\n\n'));
  assert.deepEqual(observer.result(), { tokens, outcome: "provider_error" });
});
