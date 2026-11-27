import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { createBedrockEventStreamInspector } from "../bedrock-eventstream.ts";
import { usageInspectionLimit } from "../token-usage.ts";
import { chunk, eventFrame, novaFinal } from "./bedrock-eventstream-fixture.mjs";

function inspect(bytes, step = 1, ended = true) {
  const observer = createBedrockEventStreamInspector();
  for (let offset = 0; offset < bytes.length; offset += step) observer.push(bytes.subarray(offset, offset + step));
  return observer.result(ended);
}
const tokens = { input: 10, output: 2, total: 12, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };

test("Bedrock frame boundaries and native Nova final usage survive arbitrary fragmentation", () => {
  const wire = Buffer.concat([chunk({ contentBlockDelta: { delta: { text: "fixture 🦊" } } }), chunk({ messageStop: { stopReason: "end_turn" } }), chunk(novaFinal)]);
  for (const step of [1, 3, 11, 12, 27, wire.length]) assert.deepEqual(inspect(wire, step), { tokens, outcome: "success" });
  assert.deepEqual(inspect(wire, 13, false), { tokens: null, outcome: null });
});

test("Bedrock Anthropic terminal accounting uses cumulative Messages counters", () => {
  const frames = [
    { type: "message_start", message: { content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ].map(chunk);
  assert.deepEqual(inspect(Buffer.concat(frames)), { tokens, outcome: "success" });
  assert.deepEqual(inspect(Buffer.concat(frames.slice(0, 2))), { tokens: null, outcome: "provider_error" });
});

test("modeled and unmodeled errors remain visible under HTTP 200, including after usage", () => {
  for (const headers of [
    { ":message-type": "exception", ":exception-type": "modelStreamErrorException" },
    { ":message-type": "error", ":error-code": "InternalError" },
  ]) {
    const error = eventFrame({ message: "fixture failure" }, headers);
    assert.deepEqual(inspect(error), { tokens: null, outcome: "provider_error" });
    assert.deepEqual(inspect(Buffer.concat([chunk(novaFinal), error])), { tokens, outcome: "provider_error" });
  }
});

test("corrupt, truncated, malformed, and oversized frames cannot certify usage", () => {
  const wire = chunk(novaFinal);
  for (const position of [0, 8, 15, wire.length - 1]) {
    const corrupt = Buffer.from(wire); corrupt[position] ^= 1;
    assert.deepEqual(inspect(corrupt), { tokens: null, outcome: "provider_error" });
  }
  for (const length of [1, 8, 12, wire.length - 1]) assert.deepEqual(inspect(wire.subarray(0, length)), { tokens: null, outcome: "provider_error" });
  for (const payload of [{ bytes: "!bad!" }, { bytes: "e30" }, { bytes: "wA==" }, {}, "not json"]) assert.deepEqual(inspect(eventFrame(payload)), { tokens: null, outcome: "provider_error" });
  const prelude = Buffer.alloc(12); prelude.writeUInt32BE(usageInspectionLimit + 1); prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  assert.deepEqual(inspect(Buffer.concat([chunk(novaFinal), prelude])), { tokens: null, outcome: null });
  assert.equal(inspect(chunk({ metadata: { usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } } })).tokens, null);
  assert.deepEqual(inspect(chunk({ unsupportedModelData: {} })), { tokens: null, outcome: null });
});
