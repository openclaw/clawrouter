import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import { providerById } from "../providers.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL &&
      !extname(new URL(specifier, context.parentURL).pathname)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { estimateCost, prepareNativeRequest } = await import("../proxy.ts");

const google = providerById("google-gemini");
assert.ok(google);
const streamGenerate = google.endpoints.find((endpoint) => endpoint.id === "stream_generate_content");
assert.ok(streamGenerate);

test("Google native path models use manifest pricing under a budgeted policy", () => {
  const prepared = prepareNativeRequest(
    google,
    streamGenerate,
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    "/v1beta/models/gemini-3.5-flash:streamGenerateContent",
    {},
  );
  const policy = { monthlyBudgetMicros: 1_000_000, requestCostMicros: null };
  const cost = estimateCost(prepared.model, prepared.body, policy.requestCostMicros, "llm.stream");

  assert.equal(prepared.model?.id, "google/gemini-3.5-flash");
  assert.equal(prepared.body.model, undefined);
  assert.deepEqual(prepared.pathParams, { model: "gemini-3.5-flash" });
  assert.equal(cost.basis, "manifest_pricing");
  assert.ok(cost.reserveMicros > 1);
});

test("Anthropic native body models remain rewritten in the body", () => {
  const anthropic = providerById("anthropic");
  assert.ok(anthropic);
  const messages = anthropic.endpoints.find((endpoint) => endpoint.id === "messages");
  assert.ok(messages);

  const prepared = prepareNativeRequest(
    anthropic,
    messages,
    { model: "anthropic/claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
    "/v1/messages",
    {},
  );

  assert.equal(prepared.model?.id, "anthropic/claude-sonnet-4-6");
  assert.equal(prepared.body.model, "claude-sonnet-4-6");
  assert.deepEqual(prepared.pathParams, {});
});

test("native path models reject provider mismatches", () => {
  assert.throws(
    () => prepareNativeRequest(
      google,
      streamGenerate,
      {},
      "/v1beta/models/anthropic%2Fclaude-sonnet-4-6:streamGenerateContent",
      {},
    ),
    (error) => error?.code === "model_provider_mismatch",
  );
});

test("native path models reject body and path mismatches", () => {
  assert.throws(
    () => prepareNativeRequest(
      google,
      streamGenerate,
      { model: "google/gemini-3.5-flash" },
      "/v1beta/models/gemini-3.5-pro:streamGenerateContent",
      {},
    ),
    (error) => error?.code === "model_path_mismatch",
  );
});
