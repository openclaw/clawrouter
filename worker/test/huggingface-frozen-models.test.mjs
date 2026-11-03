import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");

const manifest = parse(readFileSync(new URL("../../providers/huggingface.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const identities = ["deepseek-ai/DeepSeek-R1", "deepseek-ai/DeepSeek-V3.1", "openai/gpt-oss-120b"];

test("Hugging Face frozen identities preserve the existing default and exact native Chat names", () => {
  assert.equal(provider.models[0].upstream, "openai/gpt-oss-120b:fastest");
  assert.deepEqual(provider.models.slice(1).map(model => model.upstream), identities);
  for (const upstream of identities) {
    const body = { model: `huggingface/${upstream}`, messages: [{ role: "user", content: "fixture" }], stream: true };
    const before = structuredClone(body), prepared = prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.deepEqual(prepared.body, { ...body, model: upstream });
    assert.deepEqual(body, before);
    assert.deepEqual(prepared.model.capabilities, ["llm.chat"]);
    const facts = prepared.model.nativeCapabilities.endpoints.chat_completions;
    assert.deepEqual(facts.input, ["text"]);
    assert.equal(facts.contextWindow, undefined);
    assert.equal(facts.maxOutputTokens, undefined);
    assert.equal(prepared.model.supportedReasoningEfforts, undefined);
    assert.equal(prepared.model.requestParameters, undefined);
  }
});

test("Hugging Face selected-provider costs remain unknown under caller and provider hard budgets", () => {
  for (const upstream of identities) {
    const model = provider.models.find(model => model.upstream === upstream);
    assert.equal(model.pricing_ref, "huggingface-router-dynamic");
    assert.equal(model.pricing, null);
    assert.equal(snapshot.model_index[model.id].pricing, null);
    const cost = estimateCost(model, { messages: [], max_tokens: 1 }, null, "llm.chat", endpoint);
    assert.equal(cost.basis, "flat_fallback");
    for (const [policyLimit, providerLimit] of [[1000, null], [null, 1000]]) {
      const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
      assert.throws(() => validateBudgetReservation("llm.chat", cost, policyLimit, connection), error => error.code === "pricing_required");
      const fixed = estimateCost(model, {}, 25, "llm.chat", endpoint);
      assert.equal(fixed.basis, "policy_fixed");
      assert.equal(validateBudgetReservation("llm.chat", fixed, policyLimit, connection), true);
    }
  }
});

test("Hugging Face native policy and provider suffixes survive without borrowing declared model prices", () => {
  for (const upstream of identities) {
    for (const suffix of ["fastest", "cheapest", "preferred", "novita"]) {
      const nativeModel = `${upstream}:${suffix}`;
      const prepared = prepareManifestRequest(provider, endpoint, { model: `huggingface/${nativeModel}`, messages: [] }, {}, {});
      assert.equal(prepared.body.model, nativeModel);
      assert.equal(prepared.model.pricing, null);
    }
  }
});
