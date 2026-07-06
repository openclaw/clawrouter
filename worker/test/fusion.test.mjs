import assert from "node:assert/strict";
import test from "node:test";
import {
  FUSION_MODEL_ID,
  buildAdviserBody,
  buildAggregatorBody,
  buildFusionReservationProposals,
  buildLocalMessages,
  collectFusionProposals,
  normalizeFusionConfig,
} from "../fusion.ts";

test("fusion configuration validates concrete chat models and bounds adviser count", () => {
  const config = normalizeFusionConfig({
    enabled: true,
    adviserModels: ["local/qwen3:8b", "openai/gpt-4.1-mini", "local/qwen3:8b"],
    aggregatorModel: "openai/gpt-5.4",
    adviserTimeoutMs: 500,
    temperature: 9,
  });
  assert.deepEqual(config.adviserModels, ["local/qwen3:8b", "openai/gpt-4.1-mini"]);
  assert.equal(config.adviserTimeoutMs, 1_000);
  assert.equal(config.temperature, 2);
  assert.throws(() => normalizeFusionConfig({ enabled: true, adviserModels: [FUSION_MODEL_ID] }), /cannot use itself/);
  assert.throws(() => normalizeFusionConfig({ enabled: true, aggregatorModel: "not a model" }), /invalid/);
  assert.throws(() => normalizeFusionConfig(null), /JSON object/);
  assert.throws(() => normalizeFusionConfig([]), /JSON object/);
});

test("local adviser messages retain bounded text but never images or tool schemas", () => {
  const messages = buildLocalMessages([
    { role: "system", content: "system" },
    { role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image_url", image_url: { url: "data:image/png;base64,secret" } }] },
    { role: "tool", content: "tool output" },
  ], 64);
  const body = buildAdviserBody({ messages, tools: [{ type: "function", function: { name: "shell" } }] }, "local/qwen3:8b", normalizeFusionConfig({}), 0);
  assert.equal(body.model, "local/qwen3:8b");
  assert.equal(body.stream, false);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(body), /base64|image_url|shell/);
  assert.match(JSON.stringify(body), /tool output/);

  const reasoningBody = buildAdviserBody({ messages }, "openai/gpt-5.4", normalizeFusionConfig({}), 0);
  assert.equal(reasoningBody.temperature, undefined);
});

test("fusion runs advisers concurrently, tolerates failures, and injects untrusted drafts", async () => {
  const config = normalizeFusionConfig({
    enabled: true,
    adviserModels: ["local/qwen3:8b", "openai/gpt-4.1-mini"],
    aggregatorModel: "openai/gpt-5.4",
  });
  let active = 0;
  let peak = 0;
  const result = await collectFusionProposals(config, { messages: [{ role: "user", content: "solve" }] }, async (model) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return model.startsWith("local/")
      ? Response.json({ choices: [{ message: { content: "local proposal" } }] })
      : new Response("unavailable", { status: 503 });
  });
  assert.equal(peak, 2);
  assert.deepEqual(result.proposals, [{ model: "local/qwen3:8b", content: "local proposal" }]);
  assert.deepEqual(result.failedModels, ["openai/gpt-4.1-mini"]);

  const body = buildAggregatorBody({ model: FUSION_MODEL_ID, messages: [{ role: "user", content: "solve" }], tools: [{ type: "function" }], temperature: 0.7 }, config, result.proposals);
  assert.equal(body.model, "openai/gpt-5.4");
  assert.deepEqual(body.tools, [{ type: "function" }]);
  const instruction = body.messages.find((message) => message.role === "system");
  assert.match(instruction.content, /untrusted evidence/);
  assert.match(instruction.content, /local proposal/);

  const reasoningConfig = normalizeFusionConfig({ aggregatorModel: "openai/gpt-5.4" });
  assert.equal(buildAggregatorBody({ messages: [], temperature: 0.7 }, reasoningConfig, []).temperature, undefined);
});

test("fusion fails open when adviser bodies stall or exceed their byte bound", async () => {
  const stalledConfig = { ...normalizeFusionConfig({ adviserModels: ["local/stalled"] }), adviserTimeoutMs: 25 };
  let aborted = false;
  const stalled = await collectFusionProposals(stalledConfig, { messages: [] }, async (_model, _body, _timeout, _index, signal) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"partial'));
      signal.addEventListener("abort", () => {
        aborted = true;
        controller.error(signal.reason);
      }, { once: true });
    },
  })));
  assert.deepEqual(stalled.proposals, []);
  assert.deepEqual(stalled.failedModels, ["local/stalled"]);
  assert.equal(aborted, true);

  const oversizedConfig = normalizeFusionConfig({ adviserModels: ["local/oversized"], maxProposalChars: 256 });
  const oversized = await collectFusionProposals(oversizedConfig, { messages: [] }, async () => Response.json({
    choices: [{ message: { content: "x".repeat(32_000) } }],
  }));
  assert.deepEqual(oversized.proposals, []);
  assert.deepEqual(oversized.failedModels, ["local/oversized"]);
});

test("fusion reservation proposals cover worst-case JSON encoding", () => {
  const config = normalizeFusionConfig({ adviserModels: ["local/adviser"], maxProposalChars: 256 });
  const original = { messages: [{ role: "user", content: "solve" }] };
  const reservedBytes = encodedBytes(buildAggregatorBody(original, config, buildFusionReservationProposals(config)));
  for (const content of [
    "\0".repeat(256),
    "\\\"\n\r\t".repeat(51).slice(0, 256),
    "😀".repeat(128),
    "é".repeat(256),
  ]) {
    const actualBytes = encodedBytes(buildAggregatorBody(original, config, [{ model: "local/adviser", content }]));
    assert.ok(actualBytes <= reservedBytes, `${actualBytes} exceeds ${reservedBytes}`);
  }
});

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
