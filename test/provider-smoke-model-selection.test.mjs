import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { buildProviderSmokePlan } from "../scripts/provider-smoke-plan.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
const {
  concreteOpenAiSelection,
  isSelectionFailure,
  manifestEnvelope,
  prepareManifestRequest,
} = await import("../worker/proxy-selection.ts");

test("an omitted or empty OpenAI smoke override keeps the first eligible model", () => {
  for (const env of [{}, { CLAWROUTER_SMOKE_MODEL_OPENAI: "" }]) {
    const { target } = buildProviderSmokePlan(snapshot, env).providers.find((entry) => entry.id === "openai");
    assert.equal(target.model, "openai/gpt-5.6");
    assert.equal(target.body.model, target.model);
  }
});

test("the Astra smoke override reaches the native Chat completion-token transform", () => {
  const { target } = buildProviderSmokePlan(snapshot, {
    CLAWROUTER_SMOKE_MODEL_OPENAI: "openai/gpt-6-astra",
  }).providers.find((entry) => entry.id === "openai");
  assert.equal(target.route, "/v1/chat/completions");
  assert.equal(target.method, "POST");
  assert.equal(target.model, "openai/gpt-6-astra");
  const selection = concreteOpenAiSelection(target.route, target.body, {});
  assert.equal(isSelectionFailure(selection), false);
  assert.equal(selection.model.id, target.model);
  assert.deepEqual(selection.body, {
    model: "gpt-6-astra",
    messages: [{ role: "user", content: "reply with ok" }],
    max_completion_tokens: 16,
  });
  assert.equal(Object.hasOwn(selection.body, "max_tokens"), false);
  assert.equal(target.body.model, target.model);
  assert.equal(target.body.max_tokens, 16);
});

test("OpenAI smoke overrides reject missing, empty, or foreign routing prefixes", () => {
  for (const model of ["gpt-6-astra", "openai/", "anthropic/claude-sonnet-4-6"]) {
    assert.throws(() => buildProviderSmokePlan(snapshot, {
      CLAWROUTER_SMOKE_MODEL_OPENAI: model,
    }), /must match a catalog id or provider model prefix/);
  }
});

test("bundled smoke models belong to the selected endpoint's catalog", () => {
  const plan = buildProviderSmokePlan(snapshot, {});
  for (const { id, target } of plan.providers) {
    const provider = snapshot.providers.find((entry) => entry.id === id);
    const capability = provider.capabilities.find((entry) => entry.id === "llm.chat");
    const endpointId = target.kind === "openai_chat" ? capability.endpoint : target.endpoint;
    const modelId = target.body?.model ?? target.envelope?.body.model ?? target.envelope?.pathParams.model;
    if (!modelId) continue; // Tool-only requests and the gateway's nested provider request have no model here.
    const model = provider.models.find((entry) => entry.id === modelId || entry.upstream === modelId);
    assert.ok(model, `${id}: ${modelId} must be declared`);
    assert.ok(provider.capabilities.some((entry) => entry.endpoint === endpointId && model.capabilities.includes(entry.id)), id);
  }
});

test("generated model requests pass the real router selection and envelope seams", () => {
  const env = { AZURE_OPENAI_DEPLOYMENT: "smoke-deployment" };
  const plan = buildProviderSmokePlan(snapshot, env);
  for (const { id, target } of plan.providers) {
    const provider = snapshot.providers.find((entry) => entry.id === id);
    if (target.kind === "openai_chat") {
      const selection = concreteOpenAiSelection(target.route, target.body, env);
      assert.equal(isSelectionFailure(selection), false, id);
      const model = provider.models.find((entry) => entry.id === target.model);
      assert.equal(selection.model.id, model.id, id);
      assert.equal(selection.body.model, id === "azure-openai" ? env.AZURE_OPENAI_DEPLOYMENT : model.upstream, id);
    } else if (["anthropic", "aws-bedrock", "cohere", "google-gemini"].includes(id)) {
      const envelope = manifestEnvelope(target.envelope);
      const endpoint = provider.endpoints.find((entry) => entry.id === target.endpoint);
      const selection = prepareManifestRequest(provider, endpoint, envelope.body, envelope.pathParams, env);
      assert.ok(provider.models.includes(selection.model), id);
      assert.equal(selection.body.model ?? selection.pathParams.model, selection.model.upstream, id);
    }
  }
});

test("manifest model IDs skip earlier incompatible models and resolve upstream", () => {
  for (const id of ["anthropic", "aws-bedrock", "cohere", "google-gemini"]) {
    const provider = structuredClone(snapshot.providers.find((entry) => entry.id === id));
    provider.models.unshift({ id: `${id}/unrelated`, upstream: "unrelated", capabilities: ["llm.unrelated"] });
    const target = buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target;
    const { envelope } = target;
    assert.equal(envelope.body.model ?? envelope.pathParams.model, provider.models[1].id, id);
    const prepared = prepareManifestRequest(provider, provider.endpoints.find(endpoint => endpoint.id === target.endpoint), envelope.body, envelope.pathParams, {});
    assert.equal(prepared.body.model ?? prepared.pathParams.model, provider.models[1].upstream, id);
  }
});

test("Cohere body and path share the selected native name without stripping its namespace", () => {
  const provider = structuredClone(snapshot.providers.find((entry) => entry.id === "cohere"));
  provider.models[0].upstream = "cohere/native-model";
  provider.endpoints.find((entry) => entry.id === "chat").path_params = ["model"];
  for (const override of [undefined, provider.models[0].id, provider.models[0].upstream]) {
    const { envelope } = buildProviderSmokePlan({ providers: [provider] }, {
      CLAWROUTER_SMOKE_MODEL_COHERE: override,
    }).providers[0].target;
    assert.equal(envelope.body.model, provider.models[0].id);
    assert.equal(envelope.pathParams.model, envelope.body.model);
    const prepared = prepareManifestRequest(provider, provider.endpoints.find(endpoint => endpoint.id === "chat"), envelope.body, envelope.pathParams, {});
    assert.equal(prepared.pathParams.model, "cohere/native-model");
    assert.equal(prepared.body.model, undefined);
  }
});

test("declared overrides must support the selected endpoint", () => {
  for (const [providerId, modelId] of [
    ["cohere", "cohere/embed-v4.0"],
    ["cohere", "embed-v4.0"],
    ["openai", "openai/text-embedding-3-large"],
  ]) {
    assert.throws(() => buildProviderSmokePlan(snapshot, {
      [`CLAWROUTER_SMOKE_MODEL_${providerId.toUpperCase()}`]: modelId,
    }), /must support (chat|chat_completions)/);
  }
});

test("native model providers without an endpoint-compatible model have no smoke target", () => {
  const provider = structuredClone(snapshot.providers.find((entry) => entry.id === "cohere"));
  provider.models = provider.models.filter((entry) => entry.capabilities.includes("llm.embeddings"));
  assert.equal(buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target, null);
});

test("explicit Bedrock model and body overrides retain the operator-owned request contract", () => {
  const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: 8, messages: [] };
  for (const [override, upstream] of [
    ["bedrock/custom.model-v1:0", "custom.model-v1:0"],
    ["aws-bedrock/custom.model-v1:0", "custom.model-v1:0"],
    ["custom.model-v1:0", "custom.model-v1:0"],
  ]) {
    const provider = buildProviderSmokePlan(snapshot, {
      CLAWROUTER_SMOKE_MODEL_AWS_BEDROCK: override,
      CLAWROUTER_SMOKE_BODY_AWS_BEDROCK: JSON.stringify(body),
    }).providers.find((entry) => entry.id === "aws-bedrock");
    assert.equal(provider.target.envelope.pathParams.model, upstream);
    assert.deepEqual(provider.target.envelope.body, body);
  }
});
