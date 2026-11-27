import assert from "node:assert/strict";
import test from "node:test";
import { isQualifiedVertexModelLocation } from "../vertex-model-eligibility.ts";

const upstream = "claude-sonnet-4-6";
const locations = ["global", "us-east5", "europe-west1", "asia-southeast1"];

for (const location of locations) {
  test(`Vertex Sonnet 4.6 has explicit support in ${location}`, () => {
    assert.equal(isQualifiedVertexModelLocation(upstream, location), true);
  });
}

test("Vertex qualification does not inherit other frozen models or date aliases", () => {
  for (const model of [
    "claude-fable-5", "claude-opus-5", "claude-mythos-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-6",
    "claude-sonnet-4-6@20260217", "claude-sonnet-4-6-20260217", "claude-sonnet-4-6-latest", "claude-sonnet-4-6*", "",
  ]) for (const location of locations) assert.equal(isQualifiedVertexModelLocation(model, location), false);
});

test("Vertex qualification does not normalize case, whitespace or router model prefixes", () => {
  for (const model of [
    "Claude-Sonnet-4-6", "CLAUDE-SONNET-4-6", ` ${upstream}`, `${upstream} `, `${upstream}\n`, `${upstream}\0`,
    `anthropic-vertex/${upstream}`, `anthropic/${upstream}`, `publishers/anthropic/models/${upstream}`,
    "claude%2Dsonnet-4-6", "claude-sonnet-4-6/../other",
  ]) for (const location of locations) assert.equal(isQualifiedVertexModelLocation(model, location), false);
});

test("Vertex qualification defaults false for unqualified locations and location aliases", () => {
  for (const location of [
    "us", "eu", "us-east1", "us-central1", "europe-west4", "asia-southeast2", "", "*",
    "GLOBAL", "Global", " global", "global ", "global\n", "us-east5\0", "us%2Deast5",
    "https://us-east5-aiplatform.googleapis.com", "locations/us-east5", "us-east5/../global",
  ]) assert.equal(isQualifiedVertexModelLocation(upstream, location), false);
});

test("Vertex qualification fails closed for unknown JavaScript input types", () => {
  for (const value of [undefined, null, false, true, 0, 1, NaN, Infinity, 1n, Symbol("synthetic"), [], {}, [upstream], () => upstream]) {
    assert.equal(isQualifiedVertexModelLocation(value, "global"), false);
    assert.equal(isQualifiedVertexModelLocation(upstream, value), false);
    assert.equal(isQualifiedVertexModelLocation(value, value), false);
  }
});

test("Vertex qualification never coerces caller-controlled objects into an accepted identity", () => {
  const disguised = { [Symbol.toPrimitive]() { throw new Error("must not coerce"); }, toString() { throw new Error("must not stringify"); } };
  assert.equal(isQualifiedVertexModelLocation(disguised, "global"), false);
  assert.equal(isQualifiedVertexModelLocation(upstream, disguised), false);
  assert.equal(isQualifiedVertexModelLocation(new String(upstream), new String("global")), false);
});
