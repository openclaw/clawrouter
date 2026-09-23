import assert from "node:assert/strict";
import test from "node:test";
import { assessModelRequest } from "../../shared/model-request-parameters.ts";
import { buildAdviserBody, normalizeFusionConfig, prepareAdviserBody } from "../fusion.ts";

const chat = { id: "chat_completions", request_format: "openai.chat_completions" };
const responses = { id: "responses", request_format: "openai.responses" };
const functionTool = { type: "function", function: { name: "lookup" } };
const facts = { sources: ["https://provider.example/models"], checkedAt: "2026-09-23" };
function model(rules, efforts = ["none", "low", "medium", "high"]) {
  return { supportedReasoningEfforts: efforts, requestParameters: { chat_completions: { ...facts, ...rules }, responses: { ...facts, ...rules } } };
}
const astra = model({ temperature: "unsupported", topP: "unsupported", logprobs: "unsupported", toolCalling: "unsupported" }, ["low", "medium", "high", "xhigh", "max"]);
astra.requestParameters.responses.toolCalling = "supported";
const gpt54 = model({ defaultReasoningEffort: "none", temperature: "requires_reasoning_none", topP: "requires_reasoning_none", logprobs: "requires_reasoning_none", toolCalling: "requires_reasoning_none" });

test("Astra detects documented field-presence restrictions without claiming inactive intent", () => {
  for (const body of [{ temperature: 0.2 }, { temperature: null }, { top_p: 0 }, { logprobs: false }, { logprobs: null }, { top_logprobs: 0 }]) {
    const before = structuredClone(body), result = assessModelRequest(astra, chat, body);
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0].message, /field presence/);
    assert.deepEqual(body, before);
  }
  assert.deepEqual(assessModelRequest(astra, chat, {}), { conflicts: [], unknown: [] });
});

test("inactive, empty, and unknown tool fields stay unqualified and untouched", () => {
  for (const body of [{ tools: [] }, { tools: null }, { functions: [] }, { tool_choice: "none" }, { tool_choice: "auto" }, { tool_choice: { type: "future" } }, { tool_choice: { type: "function", function: { name: "" } } }, { tools: [functionTool], tool_choice: null }, { tools: [functionTool], tool_choice: "none" }, { tools: [functionTool], tool_choice: { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [] } } }, { functions: [{ name: "lookup" }], function_call: "none" }]) {
    const before = structuredClone(body), result = assessModelRequest(astra, chat, body);
    assert.equal(result.conflicts.length, 0, JSON.stringify(body));
    assert.ok(result.unknown.length);
    assert.deepEqual(body, before);
  }
});

test("Chat recognizes enabled modern, legacy, named and allowed tool choices", () => {
  for (const body of [
    { tools: [functionTool] }, { tools: [functionTool], tool_choice: "auto" },
    { functions: [{ name: "lookup" }] }, { function_call: { name: "lookup" } },
    { tool_choice: "required" }, { tool_choice: { type: "function", function: { name: "lookup" } } },
    { tool_choice: { type: "custom", custom: { name: "lookup" } } },
    { tool_choice: { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [functionTool] } } },
    { tool_choice: { type: "allowed_tools", allowed_tools: { mode: "required", tools: [] } } },
  ]) assert.ok(assessModelRequest(astra, chat, body).conflicts.some(({ message }) => message.includes("tool calling")), JSON.stringify(body));
  assert.equal(assessModelRequest(astra, responses, { tools: [{ type: "function", name: "lookup" }] }).conflicts.length, 0);
});

test("GPT-5.4 assesses its documented default without injecting it or coercing null to none", () => {
  for (const body of [{ temperature: 0.2 }, { temperature: 0.2, reasoning_effort: "none" }]) {
    const before = structuredClone(body);
    assert.deepEqual(assessModelRequest(gpt54, chat, body), { conflicts: [], unknown: [] });
    assert.deepEqual(body, before);
  }
  assert.equal(assessModelRequest(gpt54, chat, { temperature: 0.2, reasoning_effort: "high" }).conflicts[0].field, "temperature");
  for (const effort of [null, {}, ""]) {
    const result = assessModelRequest(gpt54, chat, { temperature: 0.2, reasoning_effort: effort });
    assert.ok(result.unknown.length || result.conflicts.length);
  }
  assert.equal(assessModelRequest(gpt54, responses, { top_p: 0.8, reasoning: { effort: "high" } }).conflicts[0].field, "top_p");
  assert.equal(assessModelRequest(gpt54, responses, { top_p: 0.8, reasoning: { effort: null } }).conflicts.length, 0);
  assert.equal(assessModelRequest(gpt54, responses, { top_p: 0.8, reasoning: null }).unknown.length, 2);
});

test("GPT-5.5 and 5.6 default-medium tool restrictions do not infer sampling support", () => {
  const family = model({ defaultReasoningEffort: "medium", toolCalling: "requires_reasoning_none" });
  assert.equal(assessModelRequest(family, chat, { tools: [functionTool] }).conflicts[0].field, "tools");
  assert.deepEqual(assessModelRequest(family, chat, { tools: [functionTool], reasoning_effort: "none" }), { conflicts: [], unknown: [] });
  assert.equal(assessModelRequest(family, chat, { temperature: 0.2 }).unknown[0].field, "temperature");
});

test("logprob observation follows the exact Responses include selector", () => {
  assert.equal(assessModelRequest(astra, responses, { include: ["message.output_text.logprobs"] }).conflicts[0].field, "include");
  assert.deepEqual(assessModelRequest(astra, responses, { include: ["reasoning.encrypted_content", "message.output_text"] }), { conflicts: [], unknown: [] });
  assert.deepEqual(assessModelRequest(astra, chat, { include: ["message.output_text.logprobs"] }), { conflicts: [], unknown: [] });
});

test("facts never cross endpoints or infer local, dynamic, or ignored-field restrictions", () => {
  for (const unknown of [null, {}, { id: "local/default" }, { id: "deepseek/deepseek-v4-pro" }]) {
    const body = { temperature: 0.2, top_p: 0.9, reasoning_effort: "none", tools: [functionTool] };
    const result = assessModelRequest(unknown, chat, body);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.unknown.length, 4);
  }
  assert.equal(assessModelRequest(astra, { ...chat, id: "unknown" }, { temperature: 0.2 }).unknown.length, 1);
  assert.deepEqual(assessModelRequest(astra, { id: "native", request_format: "anthropic.messages" }, { temperature: 0.2 }), { conflicts: [], unknown: [] });
});

test("Fusion applies only a qualified adviser preference after model and endpoint resolution", () => {
  const config = normalizeFusionConfig({});
  const body = buildAdviserBody({ messages: [] }, "local/opaque", config, 0);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(prepareAdviserBody(body, null, chat, 0.2), body);
  assert.equal(prepareAdviserBody(body, astra, chat, 0.2), body);
  assert.equal(prepareAdviserBody(body, model({ temperature: "supported" }), chat, 0.2).temperature, 0.2);
  assert.equal(prepareAdviserBody(body, gpt54, chat, 0.2).temperature, 0.2);
  assert.equal(body.temperature, undefined);
});
