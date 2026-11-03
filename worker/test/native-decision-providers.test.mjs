import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { configuredUpstream, providerModel, upstreamPath } from "../providers.ts";
import { prepareSageRequest, decodeSageResponse } from "../provider-sage.ts";
import { prepareSystemOneRequest, decodeSystemOneResponse } from "../provider-systemone.ts";

const contracts = [
  ["levanto", "SAGE_API_KEY", "https://sage.levanto.ai/decide", "levanto-sage-2", "levanto.sage"],
  ["liquid-ai", "LIQUID_API_KEY", "https://api.liquid.ai/decisions/v1/systemone", "d1.1", "liquid.systemone"],
  ["typesafe", "TYPESAFE_API_KEY", "https://api.typesafe.ai/v1/systemone", "jev-latest", "typesafe.systemone"],
];
const { providers } = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));

for (const [id, key, url, modelId, format] of contracts) {
  test(`${id}: native wire, selected model and own credential compose a typed decision`, () => {
    const provider = providers.find(provider => provider.id === id), endpoint = provider.endpoints.find(endpoint => endpoint.id === "decisions");
    const foreign = Object.fromEntries(contracts.filter(([other]) => other !== id).map(([, binding]) => [binding, "synthetic-foreign"]));
    assert.throws(() => configuredUpstream(provider, null, foreign), error => error.code === "provider_not_configured");
    const auth = configuredUpstream(provider, null, { ...foreign, [key]: "synthetic-selected" });
    const selected = providerModel(provider, `${id}/${modelId}`, endpoint);
    assert.equal(selected.upstream, modelId);
    assert.equal(selected.pricing, null);
    assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, {}, auth), url);
    assert.equal(auth.headers.get("authorization"), "Bearer synthetic-selected");
    assert.equal(endpoint.request_format, format);
    assert.notEqual(endpoint.request_format, "openai.decisions");
    const facts = selected.nativeCapabilities.endpoints.decisions;
    assert.equal(facts.inference.decision.protocol, id === "levanto" ? "levanto-sage" : id === "liquid-ai" ? "liquid-ai-systemone" : "typesafe-systemone");
    assert.deepEqual(facts.input, ["text", "json"]);
    assert.equal(facts.inference.chat, false);
    assert.equal(facts.contextWindow, undefined);
    assert.equal(facts.inference.decision.questions.choice.probabilities, id === "typesafe" ? "provider-defined" : "categorical");
    if (id === "levanto") {
      const body = prepareSageRequest({ content: "synthetic evidence", question: { id: "gate", kind: "yesno", instructions: "evaluate" } });
      assert.equal(body.model, undefined);
      const decoded = decodeSageResponse({ id: "gate", kind: "yesno", result: { answer: null, probability: 0.48 }, meta: { usage: { input_tokens: 19, output_tokens: 2 } } }, body);
      assert.equal(decoded.response.result.answer, null);
      assert.equal(decoded.inspection.tokens.total, 21);
    } else {
      const body = prepareSystemOneRequest({ model: "alias", state: "synthetic evidence", questions: { gate: { type: "noul", instructions: "evaluate" } } }, selected.upstream, id);
      assert.equal(body.model, modelId);
      const decoded = decodeSystemOneResponse({ model: modelId, answers: { gate: { type: "noul", noul: 0.48 } }, usage: { input_tokens: 19, output_tokens: 0 } }, body, id);
      assert.equal(decoded.response.answers.gate.noul, 0.48);
      assert.equal(decoded.inspection.tokens.input, 19);
    }
  });
}

test("Sage batch has a distinct native route and observes aggregate usage once", () => {
  const provider = providers.find(provider => provider.id === "levanto"), endpoint = provider.endpoints.find(endpoint => endpoint.id === "decisions_batch");
  assert.equal(endpoint.request_format, "levanto.sage_batch");
  const auth = configuredUpstream(provider, null, { SAGE_API_KEY: "synthetic-selected" });
  assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, {}, auth), "https://sage.levanto.ai/decide/batch");
  const body = prepareSageRequest({ requests: [{ content: "synthetic evidence", questions: [{ id: "gate", kind: "yesno", instructions: "evaluate" }] }] }, true);
  const decoded = decodeSageResponse({ results: [{ answers: [{ ok: false, error: "synthetic failure" }] }], meta: { usage: { input_tokens: 19, output_tokens: 2 } } }, body);
  assert.equal(decoded.inspection.tokens.total, 21);
});
