import assert from "node:assert/strict";
import test from "node:test";
import { prepareSystemOneRequest, decodeSystemOneResponse } from "../provider-systemone.ts";
import { prepareSageRequest, decodeSageResponse } from "../provider-sage.ts";

import { systemRequest, systemResponse, sageQuestion, sageRequest, sageResponse } from "./provider-decision-fixtures.ts";

test("SystemOne request binds model and retains structured criteria without mutating input", () => {
  for (const product of ["liquid-ai", "typesafe"]) {
    const input = structuredClone(systemRequest);
    assert.deepEqual(prepareSystemOneRequest(input, "selected-model", product), { ...systemRequest, model: "selected-model" });
    assert.deepEqual(input, systemRequest);
  }
});

test("SystemOne preserves Noul probability, independent confidence and fractional score", () => {
  for (const product of ["liquid-ai", "typesafe"]) {
    const request = prepareSystemOneRequest(systemRequest, "selected", product);
    const decoded = decodeSystemOneResponse(systemResponse, request, product);
    assert.strictEqual(decoded.response, systemResponse);
    assert.equal(decoded.response.answers.gate.noul, 0.49);
    assert.equal(decoded.response.answers.gate.answer, undefined);
    assert.equal(decoded.response.answers.route.confidence, 0.23);
    assert.equal(decoded.response.answers.grade.score, 0.7);
    assert.deepEqual([decoded.inspection.tokens.input, decoded.inspection.tokens.output, decoded.inspection.tokens.total], [17, 0, 17]);
  }
});

test("TypeSafe output usage remains billable evidence; Liquid rejects unexpected generated output", () => {
  const response = { ...systemResponse, usage: { input_tokens: 17, output_tokens: 3 } };
  assert.equal(decodeSystemOneResponse(response, systemRequest, "typesafe").inspection.tokens.output, 3);
  assert.equal(decodeSystemOneResponse(response, systemRequest, "liquid-ai"), null);
});

test("structured score legends compare JSON meaning independently of object key order", () => {
  const request = structuredClone(systemRequest), response = structuredClone(systemResponse);
  request.questions.grade.criteria[0] = { explanation: "low", rules: ["a", "b"] };
  response.answers.grade.legend[0] = { rules: ["a", "b"], explanation: "low" };
  assert.ok(decodeSystemOneResponse(response, request, "typesafe"));
});

test("SystemOne rejects missing answers, wrong types, distributions and legends", () => {
  for (const mutate of [
    value => { delete value.answers.gate; },
    value => { value.answers.extra = value.answers.gate; },
    value => { value.answers.gate.type = "boolean"; },
    value => { value.answers.gate.noul = 1.1; },
    value => { value.answers.route.choice = "unknown"; },
    value => { delete value.answers.route.probabilities.right; },
    value => { value.answers.grade.probabilities.extra = 0; },
    value => { value.answers.grade.legend["0"] = "changed meaning"; },
    value => { value.answers.grade.score = -0.1; },
    value => { value.usage.input_tokens = -1; },
    value => { delete value.usage; },
  ]) {
    const response = structuredClone(systemResponse); mutate(response);
    assert.equal(decodeSystemOneResponse(response, systemRequest, "typesafe"), null);
  }
});

test("SystemOne refuses unqualified images, box questions, empty questions and invalid JSON", () => {
  for (const patch of [{ images: ["https://example.com/image"] }, { assets: {} }, { questions: {} }, { questions: { box: { type: "box" } } }, { state: 42 }, { state: { bad: Infinity } }, { questions: { gate: { type: "noul" } } }]) {
    assert.throws(() => prepareSystemOneRequest({ ...systemRequest, ...patch }, "selected", "typesafe"), /invalid_decision/);
  }
});

test("Sage abstention and reasoning metadata survive without forced binary thresholds", () => {
  const request = prepareSageRequest(sageRequest);
  assert.deepEqual(request, sageRequest);
  assert.equal(request.model, undefined);
  const decoded = decodeSageResponse(sageResponse, request);
  assert.strictEqual(decoded.response, sageResponse);
  assert.equal(decoded.response.result.answer, null);
  assert.equal(decoded.response.result.probability, 0.49);
  assert.deepEqual([decoded.inspection.tokens.input, decoded.inspection.tokens.output], [17, 3]);
});

test("Sage missing usage stays unknown; malformed counters and wrong question IDs are rejected", () => {
  const noUsage = { ...sageResponse, meta: { model: "levanto-sage-2" } };
  assert.deepEqual(decodeSageResponse(noUsage, sageRequest).inspection, { tokens: null, outcome: "success" });
  assert.equal(decodeSageResponse({ ...sageResponse, id: "another-question" }, sageRequest), null);
  assert.equal(decodeSageResponse({ ...sageResponse, meta: { usage: { input_tokens: 1.5, output_tokens: 0 } } }, sageRequest), null);
});

test("Sage choice abstention preserves request-ordered probabilities", () => {
  const request = prepareSageRequest({ content: "synthetic evidence", question: { id: "route", kind: "choice", instructions: "route", options: [{ option: "left" }, { option: "right" }] } });
  const response = { id: "route", kind: "choice", result: { chosen: null, probability: null, probabilities: [{ option: "left", probability: 0.5 }, { option: "right", probability: 0.5 }] }, meta: {} };
  assert.strictEqual(decodeSageResponse(response, request).response, response);
  assert.equal(decodeSageResponse({ ...response, result: { ...response.result, probability: 0.5 } }, request), null);
  assert.equal(decodeSageResponse({ ...response, result: { ...response.result, probabilities: [...response.result.probabilities].reverse() } }, request), null);
});

test("Sage scale keeps native rubric units and reported expectation", () => {
  const request = prepareSageRequest({ content: "synthetic evidence", question: { id: "grade", kind: "scale", instructions: "grade", levels: [{ level: 2 }, { level: 5 }] } });
  const response = { id: "grade", kind: "scale", result: { expectation: 3.2, confidence: 0.1, probabilities: [{ level: 2, probability: 0.6 }, { level: 5, probability: 0.4 }] }, meta: {} };
  assert.equal(decodeSageResponse(response, request).response.result.expectation, 3.2);
  assert.equal(decodeSageResponse({ ...response, result: { ...response.result, expectation: 0.4 } }, request), null);
});

test("Sage sort and tags validate native identifiers and nullable verdicts", () => {
  const content = { kind: "list", value: [{ id: "a", content: "first" }, { id: "b", content: "second" }] };
  const sort = prepareSageRequest({ content, question: { id: "order", kind: "sort", instructions: "rank" } });
  const sorted = { id: "order", kind: "sort", result: { sorted: ["b", "a"] }, meta: {} };
  assert.ok(decodeSageResponse(sorted, sort));
  assert.equal(decodeSageResponse({ ...sorted, result: { sorted: ["a", "a"] } }, sort), null);
  const tags = prepareSageRequest({ content: "synthetic evidence", question: { id: "labels", kind: "tags", tags: [{ id: "a" }, { id: "b" }] } });
  const tagged = { id: "labels", kind: "tags", result: { tags: [{ id: "a", probability: 0.49, applies: null }, { id: "b", probability: 0.9, applies: true }] }, meta: {} };
  assert.ok(decodeSageResponse(tagged, tags));
});

test("Sage batches correlate each group and bill aggregate usage once, including per-answer errors", () => {
  const request = prepareSageRequest({ requests: [{ content: "a", questions: [sageQuestion] }, { content: "b", questions: [{ ...sageQuestion, id: "other" }] }], reasoning: "on" }, true);
  const response = { results: [{ answers: [{ ok: true, result: sageResponse }] }, { answers: [{ ok: false, error: "synthetic provider error" }] }], meta: { request_count: 2, question_count: 2, usage: { input_tokens: 31, output_tokens: 5 } } };
  const result = decodeSageResponse(response, request);
  assert.strictEqual(result.response, response);
  assert.equal(result.inspection.tokens.total, 36);
  assert.equal(decodeSageResponse({ ...response, results: [...response.results].reverse() }, request), null);
  assert.equal(decodeSageResponse({ ...response, results: response.results.slice(0, 1) }, request), null);
});

test("Sage rejects duplicate question/option IDs, remote images and invalid native shapes", () => {
  for (const value of [{ ...sageRequest, model: "injected" }, { ...sageRequest, content: { kind: "image", media: "https://example.com/image" } }, { ...sageRequest, reasoning: true }, { ...sageRequest, question: { id: "sort", kind: "sort", instructions: "rank" } }, { ...sageRequest, question: { id: "choice", kind: "choice", instructions: "choose", options: [{ option: "a" }, { option: "a" }] } }]) {
    assert.throws(() => prepareSageRequest(value), /invalid_decision/);
  }
  assert.throws(() => prepareSageRequest({ requests: [{ content: "a", questions: [sageQuestion, sageQuestion] }] }, true), /invalid_decision/);
});

test("request byte bounds and finite JSON guard run before encoding", () => {
  assert.throws(() => prepareSageRequest({ ...sageRequest, content: "x".repeat(4 * 1024 * 1024) }), /body_limit/);
  assert.throws(() => prepareSystemOneRequest({ ...systemRequest, state: "x".repeat(4_500_000) }, "selected", "liquid-ai"), /body_limit/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => prepareSystemOneRequest({ ...systemRequest, state: cyclic }, "selected", "typesafe"), /invalid_decision_body/);
});
