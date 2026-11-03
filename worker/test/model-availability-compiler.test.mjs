import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");

const proof = { version: "clawrouter.model-availability.v1", effectiveAt: "2026-10-09", checkedAt: "2026-11-03",
  sources: ["https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh"] };
const price = { effectiveAt: "2026-11-03", source: "https://provider.example/pricing", inputMicrosPerMillion: 1000000,
  outputMicrosPerMillion: 2000000, maxInputTokens: 1000, defaultMaxOutputTokens: 100 };
function fixture() {
  return {
    schema: "clawrouter.service-provider.v1", id: "availability-fixture", displayName: "Availability fixture", class: "openai_compatible",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://provider.example" }, routing: { modelPrefixes: ["availability-fixture/"] },
    capabilities: [{ id: "llm.chat", endpoint: "chat", methods: ["POST"] }],
    endpoints: { chat: { path: "/v1/chat/completions", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions", modelPassthrough: {} } },
    models: { entries: [
      { id: "availability-fixture/current", upstream: "current", capabilities: ["llm.chat"], pricingRef: "fixture-current", pricing: structuredClone(price) },
      { id: "availability-fixture/stopped", upstream: "stopped", capabilities: [], availability: { ...structuredClone(proof), status: "stopped" } },
      { id: "availability-fixture/deprecated", upstream: "deprecated", capabilities: ["llm.chat"], availability: { ...structuredClone(proof), status: "deprecated" } },
      { id: "availability-fixture/alias", upstream: "alias", capabilities: ["llm.chat"], availability: { ...structuredClone(proof), status: "upstream_alias", servingModel: "current" } },
    ] },
  };
}
const compile = manifest => compileProviderSnapshot([manifest]);

test("availability round-trips by selected identity without adding serving models, aliases or tariffs", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.deepEqual(manifest, before);
  assert.equal(provider.models.length, manifest.models.entries.length);
  for (const entry of manifest.models.entries) {
    const model = provider.models.find(row => row.id === entry.id), indexed = snapshot.model_index[entry.id];
    assert.equal(model.upstream, entry.upstream);
    assert.deepEqual(model.availability, entry.availability);
    assert.deepEqual(indexed.availability, entry.availability);
    if (entry.availability) { assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); }
  }
  manifest.models.entries[3].availability.servingModel = "changed";
  manifest.models.entries[3].availability.sources.push("https://provider.example/changed");
  assert.deepEqual(provider.models[3].availability, before.models.entries[3].availability);
  assert.deepEqual(snapshot.model_index[provider.models[3].id].availability, before.models.entries[3].availability);
  const omitted = fixture(); delete omitted.models.entries[1].capabilities;
  assert.deepEqual(compile(omitted).providers[0].models[1].capabilities, []);
});

test("stopped identities cannot escape through native or prefixed opaque-model selection", () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints[0];
  for (const native of [false, true]) for (const selected of ["stopped", "availability-fixture/stopped"]) {
    const model = providerModel(provider, selected, endpoint, native);
    assert.equal(model.id, "availability-fixture/stopped");
    assert.equal(modelSupportsEndpoint(provider, model, endpoint), false);
    assert.throws(() => prepareManifestRequest(provider, endpoint, { model: selected, messages: [] }, {}, {}, native), error => error.code === "model_capability_unsupported");
  }
  assert.equal(providerModel(provider, "unknown", endpoint, true).capabilities[0], "llm.chat", "only the explicitly stopped identity loses existing passthrough eligibility");
  assert.equal(prepareManifestRequest(provider, endpoint, { model: "availability-fixture/current", messages: [] }, {}, {}).model.upstream, "current");
});

test("explicit upstream aliases preserve native selection and do not inherit the serving model price", () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints[0];
  for (const native of [false, true]) for (const selected of ["alias", "availability-fixture/alias"]) {
    const request = prepareManifestRequest(provider, endpoint, { model: selected, messages: [{ role: "user", content: "fixture" }] }, {}, {}, native);
    assert.equal(request.model.id, "availability-fixture/alias");
    assert.equal(request.body.model, "alias");
    assert.equal(request.model.availability.servingModel, "current");
    assert.equal(request.model.pricing, null);
    const estimate = estimateCost(request.model, request.body, null, "llm.chat", endpoint);
    assert.throws(() => validateBudgetReservation("llm.chat", estimate, 1000000), error => error.code === "pricing_required");
    const fixed = estimateCost(request.model, request.body, 123, "llm.chat", endpoint);
    assert.equal(fixed.basis, "policy_fixed"); assert.equal(fixed.reserveMicros, 123);
  }
  const manifest = fixture(); manifest.models.entries[3].availability.servingModel = "unlisted-serving-model";
  const snapshot = compile(manifest);
  assert.equal(snapshot.providers[0].models.length, 4);
  assert.equal(snapshot.model_index["availability-fixture/unlisted-serving-model"], undefined);
});

test("deprecated metadata does not turn a still-qualified route into a stopped model or a new price", () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints[0];
  const request = prepareManifestRequest(provider, endpoint, { model: "deprecated", messages: [] }, {}, {}, true);
  assert.equal(request.body.model, "deprecated");
  assert.equal(request.model.availability.status, "deprecated");
  assert.equal(request.model.pricing, null);
  assert.equal(modelSupportsEndpoint(provider, request.model, endpoint), true);
});

test("availability rejects unknown states, unqualified aliases and invalid provenance", () => {
  for (const change of [
    row => { row.availability.version = "future"; }, row => { row.availability.status = "active"; },
    row => { delete row.availability.status; }, row => { delete row.availability.sources; },
    row => { row.availability.sources = []; }, row => { row.availability.sources.push(...row.availability.sources); },
    row => { row.availability.sources = ["http://provider.example/notice"]; },
    row => { row.availability.sources = ["https://fixture-user:fixture-password@provider.example/notice"]; },
    row => { row.availability.checkedAt = "2026-02-30"; }, row => { row.availability.effectiveAt = "2026-13-01"; },
    row => { row.availability.effectiveAt = "2026-11-04"; }, row => { row.availability.admitted = true; },
    row => { delete row.availability.servingModel; }, row => { row.availability.servingModel = row.upstream; },
    row => { row.availability.servingModel = row.id; }, row => { row.availability.servingModel = "https://provider.example/model"; },
    row => { row.availability.servingModel = "unknown model"; }, row => { row.availability.servingModel = "a".repeat(257); },
  ]) {
    const manifest = fixture(); change(manifest.models.entries[3]);
    assert.throws(() => compile(manifest), /invalid manifest|availability/, String(change));
  }
  for (const index of [1, 2]) {
    const manifest = fixture(); manifest.models.entries[index].availability.servingModel = "current";
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

test("stopped models reject live capabilities, request facts and every model tariff surface", () => {
  for (const extra of [
    { capabilities: ["llm.chat"] }, { pricing: price }, { pricingRef: "old-rate" },
    { endpointPricing: { chat: { pricingRef: "old-endpoint-rate", pricing: null } } },
    { nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { chat: { checkedAt: "2026-11-03", sources: proof.sources, input: ["text"] } } } },
    { requestParameters: { chat: { checkedAt: "2026-11-03", sources: proof.sources, toolCalling: "supported" } } },
    { supportedReasoningEfforts: ["low"] }, { codexModel: "replacement" },
  ]) {
    const manifest = fixture(); Object.assign(manifest.models.entries[1], extra);
    assert.throws(() => compile(manifest), /availability stopped/, JSON.stringify(extra));
  }
});
