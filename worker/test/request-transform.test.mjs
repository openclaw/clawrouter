import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { providerById, transformRequestBody } from "../providers.ts";

test("request renames preserve frozen prompt/tool data and do not mutate the caller", () => {
  const messages = Object.freeze([Object.freeze({ role: "user", content: "x".repeat(262144) })]);
  const tools = Object.freeze([Object.freeze({ type: "function", function: Object.freeze({ name: "fixture" }) })]);
  const body = Object.freeze({ model: "fixture", messages, tools, max_tokens: 16 });
  const base = providerById("openai");
  const provider = { ...base, adapter: { ...base.adapter, requestTransforms: { renameFields: [{ from: "max_tokens", to: "max_completion_tokens", paths: [], upstreams: [] }] } } };
  const transformed = transformRequestBody(provider, "/v1/chat/completions", body.model, body, {});
  assert.equal(transformed.max_completion_tokens, 16);
  assert.equal(transformed.max_tokens, undefined);
  assert.equal(body.max_tokens, 16);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(transformed.messages, messages);
  assert.equal(transformed.tools, tools);
  const native = transformRequestBody(providerById("anthropic"), "/v1/messages", "claude-sonnet-5", body, {});
  assert.notEqual(native, body);
  assert.deepEqual(native, body);
  assert.equal(native.messages, messages);
});
