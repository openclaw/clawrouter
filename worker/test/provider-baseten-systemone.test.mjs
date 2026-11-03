import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { BASETEN_SYSTEMONE_MODELS, prepareBasetenSystemOneRequest, decodeBasetenSystemOneResponse, readBasetenSystemOneResponse } from "../provider-baseten-systemone.ts";
import { basetenSystemOneRequest as request, basetenSystemOneResponse as response } from "./baseten-systemone-fixtures.ts";
const signal = () => new AbortController().signal;
const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const invalid = e => e.status === 502 && e.code === "invalid_baseten_systemone_response" && !e.message.includes("synthetic-private");

for (const model of BASETEN_SYSTEMONE_MODELS) test(`Baseten SystemOne ${model} preserves the frozen encoded request and selected identity`, () => {
  const value = structuredClone(request), prepared = prepareBasetenSystemOneRequest(value, model);
  assert.deepEqual(prepared, { ...request, model }); assert.deepEqual(value, request);
});

test("Baseten SystemOne keeps native answers, served model and independently qualified token observations", () => {
  const result = decodeBasetenSystemOneResponse(response, request);
  assert.deepEqual(result.body, response); assert.notEqual(result.body.model, request.model);
  assert.equal(result.body.answers.refund.noul, 0.49); assert.equal(result.body.answers.refund.answer, undefined);
  assert.equal(result.body.answers.route.confidence, 0.2); assert.equal(result.body.answers.route.probabilities.billing, 0.8);
  assert.equal(result.body.answers.urgency.score, 0.7);
  assert.deepEqual(result.usage, { tokens: { input: 42, output: 3, total: 45, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, outcome: "success" });
});

test("Baseten SystemOne discards unqualified native cost and units instead of using another product's accounting", () => {
  const payload = { ...response, provider: "synthetic-private", usage: { ...response.usage, cost: 0.5, native_units: 3, cached_tokens: 5 } };
  const result = decodeBasetenSystemOneResponse(payload, request);
  assert.deepEqual(result.body, response); assert.deepEqual(result.usage.tokens.total, 45);
  assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.usage.tokens.cached, null);
});

test("Baseten SystemOne requires one observed output token per question, without synthesizing missing usage", () => {
  for (const usage of [undefined, {}, { input_tokens: 42 }, { input_tokens: 42, output_tokens: 0 },
    { input_tokens: 42, output_tokens: 2 }, { input_tokens: 42, output_tokens: 4 },
    { input_tokens: -1, output_tokens: 3 }, { input_tokens: 1.5, output_tokens: 3 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 3 }, { input_tokens: "42", output_tokens: 3 }]) {
    assert.equal(decodeBasetenSystemOneResponse({ ...response, usage }, request), null);
  }
});

test("Baseten SystemOne validates every answer, exact probability keys and encoded score legends", () => {
  for (const mutate of [
    r => { delete r.answers.refund; }, r => { r.answers.extra = r.answers.refund; },
    r => { r.answers.refund.type = "boolean"; }, r => { r.answers.refund.noul = 1.1; },
    r => { r.answers.route.choice = null; }, r => { r.answers.route.choice = "hidden"; },
    r => { delete r.answers.route.probabilities.support; }, r => { r.answers.route.probabilities.extra = 0; },
    r => { r.answers.route.probabilities.billing = Infinity; }, r => { r.answers.route.confidence = -0.1; },
    r => { r.answers.urgency.score = 1.01; }, r => { r.answers.urgency.score = -0.01; },
    r => { r.answers.urgency.probabilities = { low: 0.3, high: 0.7 }; },
    r => { r.answers.urgency.legend[0] = { level: "routine" }; },
    r => { r.answers.urgency.legend[0] = '{ "level": "routine" }'; },
    r => { r.answers.urgency.legend.extra = "extra"; }, r => { r.model = ""; }, r => { r.model = "x".repeat(257); },
  ]) {
    const payload = structuredClone(response); mutate(payload);
    assert.equal(decodeBasetenSystemOneResponse(payload, request), null);
  }
});

test("Baseten SystemOne does not renormalize native distributions or derive confidence from the chosen option", () => {
  const payload = structuredClone(response); payload.answers.route.probabilities = { billing: 0.6, support: 0.3 };
  const result = decodeBasetenSystemOneResponse(payload, request);
  assert.deepEqual(result.body.answers.route.probabilities, { billing: 0.6, support: 0.3 });
  assert.equal(result.body.answers.route.confidence, 0.2);
});

test("Baseten SystemOne admits 512 options and rejects one request beyond the shared bound", () => {
  const questions = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`q${i}`, { type: "noul", instructions: "synthetic" }]));
  assert.equal(Object.keys(prepareBasetenSystemOneRequest({ ...request, questions }, request.model).questions).length, 256);
  assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { ...questions, extra: { type: "noul" } } }, request.model), /option_budget/);
  const choices = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, "synthetic"]));
  const mixed = { a: { type: "choice", criteria: choices }, b: { type: "choice", criteria: choices }, c: { type: "noul" } };
  assert.ok(prepareBasetenSystemOneRequest({ ...request, questions: mixed }, request.model));
  assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { ...mixed, d: { type: "noul" } } }, request.model), /option_budget/);
});

test("Baseten SystemOne bounds frozen choice/score options and accepts empty native instructions", () => {
  assert.ok(prepareBasetenSystemOneRequest({ ...request, questions: { q: { type: "noul", instructions: "" } } }, request.model));
  for (const criteria of [{ only: "one" }, Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "x"]))]) {
    assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { q: { type: "choice", criteria } } }, request.model), /choice_criteria/);
  }
  for (const criteria of [["one"], Array(11).fill("x"), [null, "two"]]) {
    assert.throws(() => prepareBasetenSystemOneRequest({ ...request, questions: { q: { type: "score", criteria } } }, request.model), /score_criteria/);
  }
});

test("Baseten SystemOne rejects Chat models, unencoded structures, media and unfrozen controls", () => {
  for (const model of ["deepseek-ai/DeepSeek-V4.1-Flash", "elephant-1", "typesafe", "decision-models/new-model"]) {
    assert.throws(() => prepareBasetenSystemOneRequest(request, model), /baseten_model/);
  }
  for (const patch of [{ state: { ticket: "must be serialized by the native client" } }, { state: null }, { state: 1 },
    { images: [] }, { assets: {} }, { stream: true }, { reasoning: "on" }, { max_len: 123 }, { questions: {} },
    { questions: { q: { type: "boolean" } } }, { questions: { q: { type: "box" } } },
    { questions: { q: { type: "noul", instructions: {}, criteria: { true: "yes", false: "no" } } } },
    { questions: { q: { type: "choice", criteria: { a: {}, b: "b" } } } }]) {
    assert.throws(() => prepareBasetenSystemOneRequest({ ...request, ...patch }, request.model), /invalid_decision/);
  }
});

test("Baseten SystemOne enforces finite JSON and encoded request byte bounds before dispatch", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const state of [cyclic, { n: Infinity }, "x".repeat(4 * 1024 * 1024)]) {
    assert.throws(() => prepareBasetenSystemOneRequest({ ...request, state }, request.model), /invalid_decision/);
  }
});

test("Baseten SystemOne literal question and option keys do not change object prototypes", () => {
  const questions = JSON.parse('{"__proto__":{"type":"choice","criteria":{"__proto__":"first","constructor":"second"}}}');
  const prepared = prepareBasetenSystemOneRequest({ ...request, questions }, request.model);
  const payload = JSON.parse('{"model":"elephant-1","answers":{"__proto__":{"type":"choice","choice":"__proto__","confidence":0.5,"probabilities":{"__proto__":0.7,"constructor":0.3}}},"usage":{"input_tokens":1,"output_tokens":1}}');
  const result = decodeBasetenSystemOneResponse(payload, prepared);
  assert.ok(Object.hasOwn(result.body.answers, "__proto__")); assert.equal(result.body.answers.__proto__.choice, "__proto__");
  assert.equal(Object.getPrototypeOf(result.body.answers), Object.prototype);
});

test("Baseten SystemOne reader waits for complete fragmented native JSON", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(response)); let offset = 0;
  const upstream = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
    { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  assert.deepEqual((await readBasetenSystemOneResponse(upstream, request, signal())).body, response);
});

for (const [name, make] of [
  ["HTTP error", () => new Response("synthetic-private", { status: 429 })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } })],
  ["MIME", () => new Response(JSON.stringify(response), { headers: { "content-type": "text/html" } })],
  ["incomplete length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "20" } })],
  ["partial content", () => new Response("{}", { headers: { "content-type": "application/json", "content-range": "bytes 0-1/3" } })],
  ["JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["declared byte bound", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } })],
  ["streamed byte bound", () => new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
  ["native usage", () => json({ ...response, usage: { input_tokens: 42, output_tokens: 0 } })],
]) test(`Baseten SystemOne bounded reader rejects ${name} without publishing a synthetic answer`, async () => {
  await assert.rejects(readBasetenSystemOneResponse(make(), request, signal()), invalid);
});

test("Baseten SystemOne cancellation discards even valid JSON delivered before EOF", async () => {
  const controller = new AbortController(); let canceled = false;
  const upstream = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(response))); }, cancel() { canceled = true; } }),
    { headers: { "content-type": "application/json" } });
  const pending = readBasetenSystemOneResponse(upstream, request, controller.signal);
  controller.abort(); await assert.rejects(pending, invalid); assert.equal(canceled, true);
});

test("Baseten SystemOne codec imports without the test resolver hook", () => {
  execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const codec = await import(${JSON.stringify(new URL("../provider-baseten-systemone.ts", import.meta.url).href)}); if (typeof codec.readBasetenSystemOneResponse !== "function") throw new Error("missing Baseten codec export");`],
  { encoding: "utf8", timeout: 10000 });
});
