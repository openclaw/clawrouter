import assert from "node:assert/strict";
import test from "node:test";
import { createResponseIdentityInspector, responseEventIdentities } from "../response-identities.ts";

const encoder = new TextEncoder();
function inspect(text, sse, widths = [text.length * 4 + 1]) {
  const values = [], parser = createResponseIdentityInspector(sse, value => values.push(value));
  const bytes = encoder.encode(text);
  for (let offset = 0, index = 0; offset < bytes.length; index++) {
    const end = Math.min(bytes.length, offset + widths[index % widths.length]);
    parser.push(bytes.subarray(offset, end)); offset = end;
  }
  parser.end(); return values;
}

test("only response envelope identities survive escaped keys, values and every UTF-8 split", () => {
  const id = 'resp_é🦊"\\/\n';
  const body = JSON.stringify({ output: [{ id: "item", response: { id: "nested" }, text: JSON.stringify({ id: "tool" }) }], id });
  const escaped = body.replace('"id":' + JSON.stringify(id), '"\\u0069d":' + JSON.stringify(id).replace("é", "\\u00e9"));
  const expected = [{ kind: "response", value: id }];
  for (let split = 1; split < encoder.encode(escaped).length; split++) {
    assert.deepEqual(inspect(escaped, false, [split, 1]), expected);
  }
  assert.deepEqual(inspect(JSON.stringify([{ id: "array-item" }]), false, [1]), []);
});

test("SSE identity follows typed protocol paths, arbitrary field order and line endings", () => {
  const events = [
    { type: "response.created", response: { output: [{ id: "item" }], id: "resp_first" } },
    { headers: { "X-CoDeX-TuRn-StAtE": [["turn_first", "ignored"], "ignored"] }, type: "response.metadata" },
    { type: "tool.result", response: { id: "tool" }, headers: { "x-codex-turn-state": "tool" } },
    { type: "response.output_text.delta", delta: '{"response":{"id":"inside text"}}', response_id: "resp_first" },
  ];
  const expected = [{ kind: "response", value: "resp_first" }, { kind: "turn", value: "turn_first" }, { kind: "response", value: "resp_first" }];
  for (const newline of ["\n", "\r", "\r\n"]) {
    const text = "\uFEFF: comment" + newline + events.map(value => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`).join("") + `data: [DONE]${newline}${newline}`;
    for (const widths of [[1], [2, 7, 3], [8192]]) assert.deepEqual(inspect(text, true, widths), expected);
  }
  const multiline = 'data: {"response":\ndata: {"id":"resp_multi"},\n: heartbeat\ndata: "type":"response.completed"}\n\n';
  assert.deepEqual(inspect(multiline, true, [1]), [{ kind: "response", value: "resp_multi" }]);
});

test("identity evidence survives oversized frames and metadata after terminal output", () => {
  const output = "x".repeat(2 * 1024 * 1024 + 128);
  const completed = JSON.stringify({ response: { output, id: "resp_large" }, type: "response.completed" });
  const text = `data: ${completed}\n\ndata: {"type":"response.metadata","headers":{"x-codex-turn-state":"turn_late"}}\n\n`;
  assert.deepEqual(inspect(text, true, [127, 8192]), [{ kind: "response", value: "resp_large" }, { kind: "turn", value: "turn_late" }]);
  assert.deepEqual(inspect(JSON.stringify({ output, id: "resp_large" }), false, [8192]), [{ kind: "response", value: "resp_large" }]);
});

test("deep skipped output and long unrelated keys do not become identities", () => {
  const nested = "[".repeat(20_000) + '{"response":{"id":"nested"}}' + "]".repeat(20_000);
  const body = `{"${"k".repeat(4000)}":"ignored","output":${nested},"id":"resp_after_nested"}`;
  assert.deepEqual(inspect(body, false, [31]), [{ kind: "response", value: "resp_after_nested" }]);
  for (const value of [[], [null, "ignored"], [{ value: "ignored" }, "ignored"]]) {
    const event = { type: "response.metadata", headers: { "x-codex-turn-state": value } };
    assert.deepEqual(inspect(`data: ${JSON.stringify(event)}\n\n`, true, [1]), []);
  }
});

test("incomplete SSE does not publish an identity and scalar limits fail visibly", () => {
  assert.deepEqual(inspect('data: {"type":"response.created","response":{"id":"resp_partial"}}\n', true, [1]), []);
  assert.throws(() => inspect(JSON.stringify({ id: "x".repeat(257) }), false), /continuation identity/);
});

test("parsed WebSocket identity follows the HTTP metadata and response field contract", () => {
  for (const event of [
    { type: "response.metadata", response_id: "early", headers: { "X-CoDeX-TuRn-StAtE": [["turn", "ignored"]] } },
    { type: "response.created", response: { id: "created", output: [{ id: "ignored" }] } },
    { type: "response.completed", response: { id: "completed" } },
    { type: "tool.output", response: { id: "ignored" }, headers: { "x-codex-turn-state": "ignored" } },
    { type: "response.metadata", headers: { "x-codex-turn-state": [null, "ignored"] } },
  ]) assert.deepEqual(responseEventIdentities(event), inspect(`data: ${JSON.stringify(event)}\n\n`, true));
  assert.throws(() => responseEventIdentities({ type: "response.metadata", headers: { "x-codex-turn-state": "x".repeat(8193) } }), /continuation identity/);
});
