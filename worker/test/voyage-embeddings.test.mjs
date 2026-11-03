import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractVoyageEmbeddingUsage } from "../voyage-embeddings.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/voyage/embeddings.json", import.meta.url), "utf8"));

test("Voyage native total tokens describe input without inventing output or cache charges", () => {
  const before = structuredClone(wire.response);
  assert.deepEqual(extractVoyageEmbeddingUsage(wire.response), {
    input: 12, output: 0, total: 12,
    cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
  });
  assert.deepEqual(wire.response, before);
  assert.equal(extractVoyageEmbeddingUsage({ ...wire.response, usage: { total_tokens: 0 } }).input, 0);
});

test("Voyage missing, malformed, unsafe and error-envelope usage stays unknown", () => {
  for (const total_tokens of [undefined, null, -1, 1.5, "12", true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(extractVoyageEmbeddingUsage({ ...wire.response, usage: { total_tokens } }), null);
  }
  for (const value of [null, [], {}, { usage: { total_tokens: 12 } }, { ...wire.response, error: { message: "synthetic" } }]) {
    assert.equal(extractVoyageEmbeddingUsage(value), null);
  }
});
