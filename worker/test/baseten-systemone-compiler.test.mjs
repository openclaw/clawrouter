import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { BASETEN_SYSTEMONE_FORMAT, BASETEN_SYSTEMONE_MODELS, prepareBasetenSystemOneRequest, decodeBasetenSystemOneResponse, readBasetenSystemOneResponse } = await import("../provider-baseten-systemone.ts");
const { basetenSystemOneRequest: request, basetenSystemOneResponse: response } = await import("./baseten-systemone-fixtures.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/baseten.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function decision() {
  return { protocol: "baseten-systemone", reasoning: { modes: ["auto"] }, confidence: "provider-specific", outputTokensPerQuestion: 1,
    questions: {
      boolean: { probabilities: "boolean", abstention: false },
      choice: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 255 },
      score: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 10 },
    }, limits: { maxTotalOptions: 512, maxStateAndQuestionTokens: 16384 } };
}
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "llm.decisions", endpoint: "systemone", methods: ["POST"] });
  manifest.endpoints.systemone = { path: "/systemone", requestFormat: "baseten.systemone", responseFormat: "baseten.systemone" };
  // Replace the exact fixture-owned decision rows, retaining every Chat card.
  manifest.models.entries = manifest.models.entries.filter(model => !BASETEN_SYSTEMONE_MODELS.includes(model.upstream));
  manifest.models.entries.push(...BASETEN_SYSTEMONE_MODELS.map(upstream => ({ id: `baseten/${upstream}`, upstream, capabilities: ["llm.decisions"],
    nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { systemone: {
      sources: ["https://docs.baseten.co/reference/inference-api/system-one", "https://docs.baseten.co/inference/model-apis/decision-models"],
      checkedAt: "2026-11-03", input: ["text", "json"], inference: { chat: false, decision: decision() },
    } } } })));
  return manifest;
}
const row = manifest => manifest.models.entries.find(model => model.upstream === BASETEN_SYSTEMONE_MODELS[0]);
const facts = manifest => row(manifest).nativeCapabilities.endpoints.systemone;

test("Baseten's exact three decision rows preserve Chat and compose the existing base with the native codec path", () => {
  const original = compile(existing), snapshot = compile(fixture()), provider = snapshot.providers[0];
  assert.deepEqual(snapshot.capability_index["llm.chat"], original.capability_index["llm.chat"]);
  assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "chat_completions"), original.providers[0].endpoints.find(endpoint => endpoint.id === "chat_completions"));
  for (const model of existing.models.entries.filter(model => !BASETEN_SYSTEMONE_MODELS.includes(model.upstream))) {
    assert.deepEqual(snapshot.model_index[model.id], original.model_index[model.id]);
  }
  assert.equal(provider.models.filter(model => BASETEN_SYSTEMONE_MODELS.includes(model.upstream)).length, 3);
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "systemone");
  assert.equal(provider.base_urls.default + endpoint.path, "https://inference.baseten.co/v1/systemone");
  assert.equal(endpoint.request_format, BASETEN_SYSTEMONE_FORMAT); assert.equal(endpoint.response_format, BASETEN_SYSTEMONE_FORMAT);
  assert.equal(endpoint.method, "POST"); assert.equal(endpoint.streaming, null); assert.equal(endpoint.requestPricing, undefined);
  for (const upstream of BASETEN_SYSTEMONE_MODELS) {
    const model = snapshot.model_index[`baseten/${upstream}`];
    assert.deepEqual(model.capabilities, ["llm.decisions"]); assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    assert.deepEqual(model.nativeCapabilities.endpoints.systemone.inference.decision, decision());
    const selected = prepareManifestRequest(provider, endpoint, { ...structuredClone(request), model: `baseten/${upstream}` }, {}, {});
    const encoded = prepareBasetenSystemOneRequest(selected.body, selected.model.upstream);
    assert.equal(selected.model.upstream, upstream); assert.equal(encoded.model, upstream);
    assert.deepEqual(encoded.questions, request.questions); assert.equal(encoded.state, request.state);
    assert.throws(() => prepareManifestRequest(provider, provider.endpoints.find(value => value.id === "chat_completions"), { model: upstream, messages: [] }, {}, {}, true), error => error.code === "model_capability_unsupported");
  }
});

test("Baseten metadata matches the actual 512-option codec bound, with Noul counting as two", () => {
  const d = compile(fixture()).model_index[`baseten/${BASETEN_SYSTEMONE_MODELS[0]}`].nativeCapabilities.endpoints.systemone.inference.decision;
  const choice = { type: "choice", criteria: Object.fromEntries(Array.from({ length: d.questions.choice.maxOptions }, (_, i) => [String(i), "synthetic"])) };
  const body = { ...request, questions: { first: choice, second: structuredClone(choice), last: { type: "noul" } } };
  assert.equal(Object.keys(choice.criteria).length * 2 + 2, d.limits.maxTotalOptions);
  assert.doesNotThrow(() => prepareBasetenSystemOneRequest(body, request.model));
  assert.throws(() => prepareBasetenSystemOneRequest({ ...body, questions: { ...body.questions, extra: { type: "noul" } } }, request.model), /option_budget/);
  assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { choice: { type: "choice", criteria: { only: "one" } } } }, request.model), /choice_criteria/);
  assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { score: { type: "score", criteria: Array(11).fill("synthetic") } } }, request.model), /score_criteria/);
});

test("actual Baseten observations keep backend model separate and require one observed output token per question", async () => {
  const snapshot = compile(fixture()), endpoint = snapshot.providers[0].endpoints.find(row => row.id === "systemone");
  for (const upstream of BASETEN_SYSTEMONE_MODELS) {
    const native = prepareBasetenSystemOneRequest(request, upstream), body = { ...structuredClone(response), model: "synthetic-backend" };
    const result = await readBasetenSystemOneResponse(Response.json(body), native, new AbortController().signal);
    assert.equal(result.body.model, "synthetic-backend"); assert.equal(native.model, upstream);
    assert.equal(result.usage.tokens.output, Object.keys(native.questions).length * decision().outputTokensPerQuestion);
    assert.equal(result.usage.tokens.input, response.usage.input_tokens);
    assert.equal(result.body.answers.route.confidence, 0.2); assert.equal(result.body.answers.route.probabilities.billing, 0.8);
    for (const output_tokens of [0, 2, 4]) assert.equal(decodeBasetenSystemOneResponse({ ...body, usage: { ...body.usage, output_tokens } }, native), null);
    const model = snapshot.model_index[`baseten/${upstream}`], estimate = estimateCost(model, native, null, "llm.decisions", endpoint);
    assert.throws(() => validateBudgetReservation("llm.decisions", estimate, 1000000), error => error.code === "pricing_required");
    assert.equal(estimateCost(model, native, 17, "llm.decisions", endpoint).basis, "policy_fixed");
  }
  await assert.rejects(readBasetenSystemOneResponse(new Response('{"answers":', { headers: { "content-type": "application/json" } }), request, new AbortController().signal));
});

test("Baseten schema rejects borrowed protocol semantics, images, zero output and fabricated context or option bounds", () => {
  for (const change of [
    f => { f.inference.decision.protocol = "typesafe-systemone"; }, f => { f.inference.decision.protocol = "liquid-ai-systemone"; },
    f => { f.inference.decision.protocol = "openai-decisions"; }, f => { f.inference.chat = true; },
    f => { f.input.push("image"); }, f => { f.maxOutputTokens = 0; }, f => { f.contextWindow = 16384; },
    f => { f.inference.decision.outputTokensPerQuestion = 0; }, f => { delete f.inference.decision.outputTokensPerQuestion; },
    f => { f.inference.decision.limits.maxTotalOptions = 513; }, f => { f.inference.decision.limits.maxStateAndQuestionTokens = 32768; },
    f => { f.inference.decision.limits.maxQuestions = 512; }, f => { f.inference.decision.reasoning.modes = ["on"]; },
    f => { f.inference.decision.questions.boolean.abstention = true; }, f => { f.inference.decision.questions.choice.probabilities = "categorical"; },
    f => { f.inference.decision.questions.choice.minOptions = 1; }, f => { f.inference.decision.questions.score.maxOptions = 11; },
    f => { f.inference.decision.questions.tags = { probabilities: "independent", abstention: false, minOptions: 1 }; },
  ]) { const manifest = fixture(); change(facts(manifest)); assert.throws(() => compile(manifest), /baseten\.systemone|invalid manifest/, String(change)); }
});

test("Baseten declarations reject incompatible native routes and original credential overrides", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.endpoints.systemone.path = "/v1/systemone"; },
    m => { m.endpoints.systemone.requestFormat = "openai.decisions"; }, m => { m.endpoints.systemone.responseFormat = "typesafe.systemone"; },
    m => { m.endpoints.systemone.method = "GET"; }, m => { m.endpoints.systemone.streaming = "sse"; },
    m => { m.endpoints.systemone.modelPassthrough = {}; }, m => { m.endpoints.systemone.nativeProxy = false; },
    m => { m.endpoints.systemone.pathParams = ["model"]; }, m => { m.endpoints.systemone.query = { model: "foreign" }; },
    m => { m.endpoints.systemone.upstreamPath = "/v1/systemone"; }, m => { m.endpoints.systemone.auth = "none"; },
    m => { m.endpoints.systemone.requestHeaders = ["Authorization"]; }, m => { m.endpoints.systemone.headers = { Authorization: "Bearer synthetic" }; },
    m => { m.baseUrls.default = "https://inference.baseten.co"; }, m => { m.baseUrls.other = "https://api.baseten.co/v1"; },
    m => { m.auth.schemes[0].format = "Api-Key ${secret}"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "Bearer synthetic" } } }; },
    m => { m.adapter.injectQuery = { api_key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["Authorization"]; },
    m => { m.capabilities.find(row => row.endpoint === "systemone").id = "llm.chat"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /baseten\.systemone|invalid manifest/, String(change)); }
});

test("Baseten finite decision models cannot become Chat cards, unknown aliases or fabricated token tariffs", () => {
  for (const change of [
    m => { row(m).upstream = "decision-models/unknown"; }, m => { row(m).capabilities.push("llm.chat"); },
    m => { row(m).capabilities = ["llm.chat"]; }, m => { delete row(m).nativeCapabilities; },
    m => { row(m).codexModel = "synthetic-code-model"; }, m => { row(m).supportedReasoningEfforts = ["low"]; },
    m => { row(m).pricingRef = "unqualified-rate"; },
    m => { row(m).pricing = { effectiveAt: "2026-11-03", source: "https://docs.baseten.co/inference/model-apis/decision-models",
      inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, maxInputTokens: 16384, defaultMaxOutputTokens: 0 }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /baseten\.systemone|invalid manifest/, String(change)); }
});
