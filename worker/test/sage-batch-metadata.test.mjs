import "../../test/helpers/typescript-resolver.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { sageBatchFacts } = await import("./sage-batch-metadata-fixture.ts");
const { prepareSageRequest } = await import("../provider-sage.ts");

function fixture() {
  return {
    schema: "clawrouter.service-provider.v1", id: "levanto", displayName: "Sage metadata fixture",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://sage.levanto.ai" },
    capabilities: [{ id: "llm.decisions.batch", endpoint: "decisions_batch", methods: ["POST"] }],
    endpoints: { decisions_batch: { path: "/decide/batch", method: "POST", pathParams: [], requestFormat: "levanto.sage_batch", responseFormat: "levanto.sage_batch" } },
    models: { entries: [{ id: "levanto/levanto-sage-2", upstream: "levanto-sage-2", capabilities: ["llm.decisions.batch"],
      nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { decisions_batch: structuredClone(sageBatchFacts) } } }] },
  };
}
const compile = m => compileProviderSnapshot([m]);
const row = m => m.models.entries[0];
const facts = m => row(m).nativeCapabilities.endpoints.decisions_batch;
const decision = m => facts(m).inference.decision;
const endpoint = m => m.endpoints.decisions_batch;
function rejects(changes, pattern = /invalid manifest|levanto\.sage_batch|decision|Decisions|upstreamPath/) {
  for (const change of changes) {
    const m = fixture(); change(m);
    assert.throws(() => compile(m), pattern, String(change));
  }
}

test("Sage batch compiles the existing closed profile without inventing batch limits, token facts or prices", () => {
  const m = fixture(), snapshot = compile(m), provider = snapshot.providers[0], compiled = snapshot.model_index[row(m).id];
  assert.deepEqual(compiled.nativeCapabilities, row(m).nativeCapabilities);
  assert.deepEqual(provider.models[0].nativeCapabilities, compiled.nativeCapabilities);
  assert.deepEqual(snapshot.capability_index["llm.decisions.batch"], [{ provider: "levanto", endpoint: "decisions_batch", methods: ["POST"] }]);
  const e = provider.endpoints[0];
  assert.equal(provider.base_urls.default + e.path, "https://sage.levanto.ai/decide/batch");
  assert.equal(e.request_format, "levanto.sage_batch"); assert.equal(e.response_format, "levanto.sage_batch");
  assert.equal(e.method, "POST"); assert.equal(e.streaming, null); assert.deepEqual(e.path_params, []);
  assert.equal(compiled.pricing, null); assert.equal(e.requestPricing, undefined);
  assert.equal(compiled.nativeCapabilities.endpoints.decisions_batch.inference.decision.limits, undefined);
  for (const field of ["contextWindow", "contextTokens", "maxOutputTokens"]) assert.equal(facts(m)[field], undefined);
  assert.equal(facts(m).inference.chat, false); assert.equal(decision(m).questions.sort.abstention, false);
});

test("Sage batch requires its exact paired format and does not alias singular Sage or SystemOne", () => {
  rejects([
    m => { endpoint(m).requestFormat = "levanto.sage"; },
    m => { endpoint(m).responseFormat = "levanto.sage"; },
    m => { endpoint(m).responseFormat = "liquid.systemone"; },
    m => { endpoint(m).requestFormat = endpoint(m).responseFormat = "levanto.sage_batch_stream"; },
    m => { decision(m).protocol = "liquid-ai-systemone"; },
    m => { decision(m).protocol = "levanto-sage-batch"; },
    m => { endpoint(m).requestFormat = endpoint(m).responseFormat = "levanto.sage"; },
  ]);
});

test("Sage batch rejects foreign provider, origin, endpoint, model and capability bindings", () => {
  rejects([
    m => { m.id = "liquid-ai"; },
    m => { m.baseUrls.default = "https://foreign.example"; },
    m => { m.baseUrls.other = "https://foreign.example"; },
    m => { endpoint(m).path = "/decide"; },
    m => { m.endpoints.other = endpoint(m); delete m.endpoints.decisions_batch; m.capabilities[0].endpoint = "other"; },
    m => { row(m).id = "levanto/other"; },
    m => { row(m).upstream = "other"; },
    m => { row(m).capabilities.push("llm.chat"); },
    m => { m.capabilities[0].id = row(m).capabilities[0] = "llm.decisions"; },
    m => { delete facts(m).inference.decision; },
    m => { facts(m).inference.chat = true; },
  ]);
});

test("Sage batch keeps query, path, stream, passthrough and native model-field injection closed", () => {
  rejects([
    m => { endpoint(m).method = "GET"; },
    m => { m.capabilities[0].methods.push("GET"); },
    m => { endpoint(m).nativeProxy = false; },
    m => { endpoint(m).query = { model: "levanto-sage-2" }; },
    m => { endpoint(m).pathParams = ["model"]; },
    m => { endpoint(m).upstreamPath = "/decide/batch"; },
    m => { endpoint(m).requestHeaders = ["X-Model"]; },
    m => { endpoint(m).auth = "none"; },
    m => { endpoint(m).streaming = "sse"; },
    m => { endpoint(m).modelPassthrough = {}; },
    m => { m.adapter = { injectQuery: { model: "levanto-sage-2" } }; },
    m => { m.adapter = { requestTransforms: { renameFields: [{ from: "selected", to: "model" }] } }; },
  ]);
});

test("Sage batch reuses closed question and reasoning validation without operational-cap claims", () => {
  rejects([
    m => { decision(m).batch = true; },
    m => { decision(m).questions.boolean.unknown = true; },
    m => { decision(m).questions = {}; },
    m => { decision(m).questions.choice.abstention = false; },
    m => { decision(m).questions.score.maxOptions = 27; },
    m => { decision(m).questions.sort.probabilities = "categorical"; },
    m => { decision(m).questions.tags.probabilities = "categorical"; },
    m => { decision(m).reasoning = { modes: ["auto"], default: "on" }; },
    m => { decision(m).reasoning.maxBatchBytes = 2097152; },
    m => { decision(m).limits = { operationalMaxGroups: 16 }; },
  ]);
});

test("the first Sage batch metadata qualification is text/list only", () => {
  rejects([
    m => { facts(m).input.push("image"); },
    m => { facts(m).input = ["text"]; },
    m => { decision(m).questions.choice.maxImageOptions = 20; },
    m => { decision(m).limits = { image: { maxBytes: 4194304, mimeTypes: ["image/png"], remoteUrls: false } }; },
  ]);
});

test("an existing declaration without support metadata stays unqualified and does not break singular fixtures", () => {
  const m = fixture();
  delete row(m).nativeCapabilities;
  m.capabilities.unshift({ id: "llm.decisions", endpoint: "decisions", methods: ["POST"] });
  m.endpoints.decisions = { method: "POST", path: "/decide", requestFormat: "levanto.sage", responseFormat: "levanto.sage" };
  row(m).capabilities.unshift("llm.decisions");
  const snapshot = compile(m);
  assert.equal(snapshot.model_index[row(m).id].nativeCapabilities, undefined);
  assert.equal(snapshot.providers[0].models[0].nativeCapabilities, undefined);
  assert.equal(snapshot.providers[0].endpoints.find(e => e.id === "decisions").request_format, "levanto.sage");
  assert.equal(snapshot.providers[0].endpoints.find(e => e.id === "decisions_batch").request_format, "levanto.sage_batch");
});

test("adding batch metadata leaves the singular model endpoint and capability unchanged", () => {
  const m = fixture();
  m.capabilities.unshift({ id: "llm.decisions", endpoint: "decisions", methods: ["POST"] });
  m.endpoints.decisions = { path: "/decide", requestFormat: "levanto.sage", responseFormat: "levanto.sage" };
  row(m).capabilities.unshift("llm.decisions");
  row(m).nativeCapabilities.endpoints.decisions = structuredClone(sageBatchFacts);
  row(m).nativeCapabilities.endpoints.decisions.inference.decision.limits = { maxQuestions: 1 };
  const singular = structuredClone(m);
  delete singular.endpoints.decisions_batch;
  delete row(singular).nativeCapabilities.endpoints.decisions_batch;
  singular.capabilities.pop(); row(singular).capabilities.pop();
  const before = compile(singular), after = compile(m);
  assert.deepEqual(after.providers[0].endpoints.find(e => e.id === "decisions"), before.providers[0].endpoints[0]);
  assert.deepEqual(after.capability_index["llm.decisions"], before.capability_index["llm.decisions"]);
  assert.deepEqual(after.model_index[row(m).id].nativeCapabilities.endpoints.decisions, before.model_index[row(m).id].nativeCapabilities.endpoints.decisions);
  assert.equal(after.model_index[row(m).id].nativeCapabilities.endpoints.decisions_batch.inference.decision.limits, undefined);
});

test("the declared pair matches the existing batch codec without injecting a native model field", () => {
  const compiled = compile(fixture()).providers[0].endpoints[0];
  const body = { requests: [
    { content: "synthetic text", questions: [{ id: "q1", kind: "yesno", instructions: "synthetic question" }] },
    { content: { kind: "list", value: [{ id: "a", content: "first" }, { id: "b", content: "second" }] },
      questions: [{ id: "q1", kind: "sort", instructions: "synthetic order" }] },
  ], reasoning: "off" };
  assert.equal(compiled.request_format, "levanto.sage_batch");
  assert.deepEqual(prepareSageRequest(body, true), body);
  assert.equal(Object.hasOwn(body, "model"), false);
  assert.throws(() => prepareSageRequest({ ...body, model: "levanto-sage-2" }, true), /sage_fields/);
  assert.throws(() => prepareSageRequest(body, false), /sage_fields/);
});
