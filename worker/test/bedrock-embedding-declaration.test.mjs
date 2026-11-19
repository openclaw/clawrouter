import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest, nativeMatch, nativeModelEndpoint } = await import("../proxy-selection.ts");
const { prepareNativeBedrockEmbedding } = await import("../native-bedrock-embeddings.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const source = parse(readFileSync(new URL("../../providers/aws-bedrock.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url), "utf8"));
const qualified = wire.cases.filter(item => item.model !== "amazon.titan-embed-image-v1");
const provider = compileProviderSnapshot([source]).providers[0], endpoint = provider.endpoints.find(endpoint => endpoint.id === "embed_text");

test("bundled Bedrock declaration registers exactly the qualified frozen text embedding identities with primary provenance", () => {
  const rows = provider.models.filter(model => model.capabilities.includes("llm.embeddings"));
  assert.deepEqual(rows.map(model => model.upstream), qualified.map(item => item.model));
  for (const model of rows) {
    assert.equal(model.id, `bedrock/${model.upstream}`); assert.deepEqual(model.capabilities, ["llm.embeddings"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    const facts = model.nativeCapabilities.endpoints.embed_text;
    assert.deepEqual(facts.input, ["text"]); assert.equal(facts.checkedAt, "2026-11-04");
    assert.ok(facts.sources.every(source => source.startsWith("https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-")));
    for (const key of ["contextWindow", "contextTokens", "maxOutputTokens", "supportedServiceTiers"]) assert.equal(facts[key], undefined);
  }
  assert.equal(provider.models.some(model => model.upstream === "amazon.titan-embed-image-v1"), false);
  const catalog = createRouteCatalog([provider]); assert.deepEqual(catalog.openaiCompatible, []);
  assert.deepEqual(catalog.manifestProxy.find(offer => offer.endpoint === "embed_text").models.map(model => model.id), rows.map(model => model.id));
});

test("declared native and explicit manifest embedding routes consume actual family bytes and complete vector responses", async () => {
  for (const item of qualified) {
    const path = `/model/${encodeURIComponent(item.model)}/invoke`;
    assert.equal(nativeModelEndpoint(provider, provider.endpoints.filter(endpoint => nativeMatch(endpoint, path)), path, "POST").id, "embed_text");
    const prepared = prepareManifestRequest(provider, endpoint, item.body, { model: `bedrock/${item.model}` }, {});
    assert.equal(prepared.model.upstream, item.model); assert.deepEqual(prepared.body, item.body);
    const native = prepareNativeBedrockEmbedding({ provider, endpoint, ...prepared, capability: "llm.embeddings", method: "POST" },
      { origin: "https://bedrock-runtime.us-east-1.amazonaws.com" });
    const lease = native.acquire();
    try { assert.deepEqual(await (await native.read(Response.json(item.response), new AbortController().signal)).response.json(), item.response); }
    finally { lease.release(); }
  }
});

test("declared native cards deny both hard-dollar budgets without treating bytes or Titan usage as a tariff", () => {
  for (const item of qualified) {
    const { model, body } = prepareManifestRequest(provider, endpoint, item.body, { model: item.model }, {});
    const cost = estimateCost(model, body, null, "llm.embeddings", endpoint);
    for (const [caller, grant] of [[10000, null], [null, 10000]]) {
      assert.throws(() => validateBudgetReservation("llm.embeddings", cost, caller, { monthlyBudgetMicros: grant }), error => error.code === "pricing_required");
      for (const fixed of [0, 17]) {
        const explicit = estimateCost(model, body, fixed, "llm.embeddings", endpoint);
        assert.equal(explicit.basis, "policy_fixed"); assert.equal(explicit.reserveMicros, fixed);
        assert.doesNotThrow(() => validateBudgetReservation("llm.embeddings", explicit, caller, { monthlyBudgetMicros: grant }));
      }
    }
  }
});

test("declared embedding cards preserve original generic Invoke capability and do not admit unregistered profiles", () => {
  const original = provider.models.find(model => model.upstream === "amazon.nova-lite-v1:0");
  assert.deepEqual(original.capabilities, ["llm.invoke", "llm.stream"]);
  for (const id of ["invoke_model", "invoke_model_stream"]) assert.ok(provider.endpoints.find(endpoint => endpoint.id === id).modelPassthrough);
  for (const model of ["us.amazon.titan-embed-text-v2:0:2:8k", "amazon.titan-embed-image-v1", "twelvelabs.marengo-embed-2-7-v1:0",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/synthetic"]) {
    assert.throws(() => prepareManifestRequest(provider, endpoint, qualified[0].body, { model }, {}), error => error.code === "model_capability_unsupported");
  }
});
