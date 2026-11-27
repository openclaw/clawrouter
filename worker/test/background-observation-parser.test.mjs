import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesUsageInspector } from "../responses-usage.ts";

const encode = value => new TextEncoder().encode(value);
const completed = { id: "response-fixture", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 15 } };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

test("background facts require the complete JSON boundary across every byte split", async () => {
  const bytes = encode(JSON.stringify(completed));
  for (let split = 0; split <= bytes.length; split++) {
    const facts = [], inspector = createResponsesUsageInspector(false, undefined, async fact => { facts.push(fact); });
    await inspector.push(bytes.subarray(0, split)); await inspector.push(bytes.subarray(split));
    assert.deepEqual(facts, []); await inspector.end();
    assert.equal(facts.length, 1); assert.equal(facts[0].id, completed.id); assert.equal(facts[0].terminal, true); assert.equal(facts[0].tokens.total, 25);
  }
});

test("a fully delimited terminal is published before EOF and survives a later truncated frame", async () => {
  const facts = [], inspector = createResponsesUsageInspector(true, undefined, async fact => { facts.push(fact); });
  for (const character of frame({ type: "response.completed", response: completed })) await inspector.push(encode(character));
  assert.equal(facts.length, 1); assert.equal(facts[0].terminal, true);
  await inspector.push(encode('data: {"type":"response.failed","response":')); inspector.stop();
  assert.equal(facts.length, 1); assert.equal(facts[0].status, "completed");
});

test("queued EOF, DONE, malformed JSON and undelimited terminal cannot invent generation completion", async () => {
  for (const [sse, wire, count] of [
    [false, JSON.stringify({ ...completed, status: "queued", usage: null }), 1],
    [true, frame({ type: "response.in_progress", response: { ...completed, status: "in_progress", usage: null } }) + "data: [DONE]\n\n", 1],
    [false, JSON.stringify(completed).slice(0, -1), 0],
    [true, frame({ type: "response.completed", response: completed }).trimEnd(), 0],
  ]) {
    const facts = [], inspector = createResponsesUsageInspector(sse, undefined, async fact => { facts.push(fact); });
    await inspector.push(encode(wire)); await inspector.end();
    assert.equal(facts.length, count); assert.ok(facts.every(fact => !fact.terminal));
  }
});

test("last duplicate containers win and bounded identity inspection never buffers model output", async () => {
  for (const [wire, count] of [
    ['{"object":"response","id":"wrong","id":"response-fixture","status":"completed","status":"queued"}', 1],
    [`{"object":"response","id":"${"x".repeat(257)}","status":"completed"}`, 0],
    [JSON.stringify({ ...completed, output: [{ text: "x".repeat(2 * 1024 * 1024) }] }), 1],
    ['{"type":"response.completed","response":{"id":"old","status":"completed"},"response":null}', 0],
  ]) {
    const facts = [], inspector = createResponsesUsageInspector(false, undefined, async fact => { facts.push(fact); });
    await inspector.push(encode(wire)); await inspector.end();
    assert.equal(facts.length, count); if (count) assert.equal(facts[0].id, "response-fixture");
    if (wire.includes('"status":"queued"')) assert.equal(facts[0].terminal, false);
  }
});
