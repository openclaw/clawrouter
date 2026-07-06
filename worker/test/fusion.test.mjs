import assert from "node:assert/strict";
import test from "node:test";
import {
  FUSION_MODEL_ID,
  buildAdviserBody,
  buildAggregatorBody,
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
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(body), /base64|image_url|shell/);
  assert.match(JSON.stringify(body), /tool output/);
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

  const body = buildAggregatorBody({ model: FUSION_MODEL_ID, messages: [{ role: "user", content: "solve" }], tools: [{ type: "function" }] }, config, result.proposals);
  assert.equal(body.model, "openai/gpt-5.4");
  assert.deepEqual(body.tools, [{ type: "function" }]);
  const instruction = body.messages.find((message) => message.role === "system");
  assert.match(instruction.content, /untrusted evidence/);
  assert.match(instruction.content, /local proposal/);
});
