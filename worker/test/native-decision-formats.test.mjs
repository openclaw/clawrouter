import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

const contracts = [
  ["levanto", "levanto-sage", "levanto.sage", "/decide/batch"],
  ["liquid-ai", "liquid-ai-systemone", "liquid.systemone", "/decisions/v1/systemone"],
  ["typesafe", "typesafe-systemone", "typesafe.systemone", "/v1/systemone"],
  ["subq", "subq-decisions", "subq.decisions", "/v1/systemone"],
];
const option = (probabilities = "categorical", maxOptions = 10) => ({ probabilities, abstention: false, minOptions: 2, maxOptions });
function fixture([provider, protocol, format, path]) {
  return {
    schema: "clawrouter.service-provider.v1", id: provider, displayName: "Decision fixture",
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://provider.example" }, capabilities: [{ id: "llm.decisions", endpoint: "evaluate", methods: ["POST"] }],
    endpoints: { evaluate: { path, requestFormat: format, responseFormat: format } },
    models: { entries: [{ id: `${provider}/fixture`, upstream: "fixture", capabilities: ["llm.decisions"], nativeCapabilities: {
      version: "clawrouter.native-capabilities.v1", endpoints: { evaluate: {
        sources: ["https://example.com/typed-decision-contract"], checkedAt: "2026-11-03", input: ["text", "image", "json"],
        inference: { chat: false, decision: { protocol, questions: {
          boolean: { probabilities: "boolean", abstention: provider === "levanto" },
          choice: { ...option(provider === "typesafe" ? "provider-defined" : "categorical"), abstention: provider === "levanto" },
          score: option(provider === "typesafe" ? "provider-defined" : "categorical"),
        } } },
      } },
    } }] },
  };
}
const facts = m => m.models.entries[0].nativeCapabilities.endpoints.evaluate;
const decision = m => facts(m).inference.decision;
const compile = m => compileProviderSnapshot([m]);

for (const contract of contracts) {
  test(`${contract[0]} metadata retains its own wire protocol without inventing bounds or prices`, () => {
    const m = fixture(contract), result = compile(m), row = result.model_index[m.models.entries[0].id];
    assert.deepEqual(row.nativeCapabilities, m.models.entries[0].nativeCapabilities);
    assert.equal(row.pricing, null);
    assert.equal(row.nativeCapabilities.endpoints.evaluate.contextWindow, undefined);
    assert.equal(row.nativeCapabilities.endpoints.evaluate.inference.decision.limits, undefined);
  });
  test(`${contract[0]} cannot acquire decision metadata through a mismatched provider or transport`, () => {
    for (const change of [
      m => { m.id = "unknown-provider"; },
      m => { decision(m).protocol = "arbitrary-protocol"; },
      m => { m.endpoints.evaluate.requestFormat = "openai.decisions"; },
      m => { m.endpoints.evaluate.responseFormat = "openai.responses"; },
      m => { m.endpoints.evaluate.method = "GET"; },
      m => { m.capabilities[0].methods.push("GET"); },
      m => { m.endpoints.evaluate.streaming = "sse"; },
      m => { m.endpoints.evaluate.nativeProxy = false; },
      m => { m.endpoints.evaluate.modelPassthrough = {}; },
      m => { decision(m).questions.choice.minOptions = 12; },
      m => { decision(m).limits = { maxStateAndQuestionTokens: 100, maxRequestTokens: 50 }; },
      m => { decision(m).reasoning = { modes: ["auto"], default: "off" }; },
      m => { decision(m).billing = { unit: "tokens", price: 0 }; },
    ]) {
      const m = fixture(contract); change(m);
      assert.throws(() => compile(m), /invalid manifest|decision|Decisions|minOptions/);
    }
  });
}

test("Sage retains abstention, sorting, independent tags and explicit reasoning modes", () => {
  const m = fixture(contracts[0]), d = decision(m);
  d.questions.boolean.abstention = true;
  d.questions.choice = { ...option("categorical", 120), abstention: true, maxImageOptions: 20 };
  d.questions.score = option("categorical", 26);
  d.questions.sort = option("none", 120);
  d.questions.tags = { ...option("independent", 120), minOptions: 1, abstention: true };
  d.reasoning = { modes: ["auto", "off", "on"], default: "off", metadata: true };
  assert.deepEqual(compile(m).model_index["levanto/fixture"].nativeCapabilities.endpoints.evaluate.inference.decision, d);
  for (const change of [d => { d.questions.score.maxOptions = 27; }, d => { d.questions.sort.abstention = true; }, d => { d.questions.tags.probabilities = "categorical"; }, d => { d.questions.choice.maxImageOptions = 21; }]) {
    const invalid = structuredClone(m); change(decision(invalid)); assert.throws(() => compile(invalid), /invalid manifest/);
  }
});

test("SystemOne and SubQ cannot inherit Sage questions, abstention or OpenAI probability semantics", () => {
  for (const contract of contracts.slice(1)) {
    for (const change of [
      d => { d.questions.sort = option("none"); },
      d => { d.questions.tags = option("independent"); },
      d => { d.questions.boolean.abstention = true; },
      d => { d.reasoning = { modes: ["on"] }; },
      d => { d.questions.choice.probabilities = contract[0] === "typesafe" ? "categorical" : "provider-defined"; },
    ]) {
      const m = fixture(contract); change(decision(m)); assert.throws(() => compile(m), /invalid manifest/);
    }
  }
  const liquid = fixture(contracts[1]);
  delete decision(liquid).questions.choice.maxOptions;
  delete decision(liquid).questions.score.maxOptions;
  assert.doesNotThrow(() => compile(liquid), "unknown provider limits stay absent");
});

test("SubQ image and question limits are typed separately from token pricing", () => {
  const m = fixture(contracts[3]), d = decision(m);
  d.limits = { maxQuestions: 128, maxRequestTokens: 393216, image: {
    maxBytes: 4194304, maxImages: 4, maxTotalBytes: 8388608, mimeTypes: ["image/png", "image/jpeg", "image/webp"], remoteUrls: false,
  } };
  assert.deepEqual(compile(m).model_index["subq/fixture"].nativeCapabilities.endpoints.evaluate.inference.decision.limits, d.limits);
  for (const change of [
    d => { d.limits.maxQuestions = 129; }, d => { d.questions.score.maxOptions = 11; },
    d => { d.limits.image.remoteUrls = true; }, d => { d.limits.image.maxImages = 5; },
  ]) {
    const invalid = structuredClone(m); change(decision(invalid)); assert.throws(() => compile(invalid), /invalid manifest/);
  }
  facts(m).input = ["text"];
  assert.throws(() => compile(m), /image limits require image input/);
});

// An omitted maximum must not admit a minimum beyond a known protocol bound.
test("known option ceilings also constrain minimum-only declarations", () => {
  for (const [contract, kind, tooMany] of [[contracts[0], "score", 27], [contracts[2], "choice", 256], [contracts[3], "score", 11]]) {
    const m = fixture(contract), question = decision(m).questions[kind];
    delete question.maxOptions;
    question.minOptions = tooMany;
    assert.throws(() => compile(m), /invalid manifest/);
  }
});
