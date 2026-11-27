import assert from "node:assert/strict";
import test from "node:test";
import { chooseGrantKey, normalizedChoiceCandidates } from "../grant-selection-strategies.ts";

test("threshold routing stays on the active grant until the cutoff", () => {
  const candidates = [{ key: "active", remainingRatio: 0.11 }, { key: "reserve", remainingRatio: 0.95 }];
  assert.equal(choose(candidates), "active");
});

test("threshold routing switches at the cutoff only to a materially healthier grant", () => {
  assert.equal(choose([{ key: "active", remainingRatio: 0.1 }, { key: "reserve", remainingRatio: 0.19 }]), "active");
  assert.equal(choose([{ key: "active", remainingRatio: 0.1 }, { key: "reserve", remainingRatio: 0.2 }, { key: "best", remainingRatio: 0.8 }]), "best");
});

test("threshold routing chooses the healthiest grant when the previous choice is unavailable", () => {
  assert.equal(choose([{ key: "a", remainingRatio: null }, { key: "b", remainingRatio: 0.6 }], "missing"), "b");
});

const choose = (candidates, cursorKey = "active") => chooseGrantKey(request(candidates), normalizedChoiceCandidates(candidates), cursorKey, () => undefined).selectedKey;
const request = candidates => ({ strategy: "threshold", switchAtUsedPercent: 90, hysteresisPercent: 10, candidates });
const grant = (key, remainingRatio) => ({ key, remainingRatio });

test(`an active grant at the cutoff yields to a grant with no quota reading`, () => {
  assert.equal(choose([grant("active", 0.1), grant("unseen", null)]), "unseen");
  assert.equal(choose([grant("active", 0.11), grant("unseen", null)]), "active");
});

test(`measured headroom beats an unmeasured grant, and unmeasured grants order by key`, () => {
  assert.equal(choose([grant("active", 0.1), grant("a-unseen", null), grant("measured", 0.2)]), "measured");
  assert.equal(choose([grant("active", 0.1), grant("z-unseen", null), grant("near", 0.19), grant("b-unseen", null)]), "b-unseen");
});

test(`a grant measured at or past the cutoff never replaces the active grant`, () => {
  assert.equal(choose([grant("active", 0.08), grant("worse", 0.05), grant("level", 0.1)]), "active");
});

test("canonical selection preserves strategy, tie, cursor and missing-count outcomes without mutation", () => {
  const raw = [{ key: "z", weight: 3, remainingRatio: 0.1 }, { key: "a", weight: 1, remainingRatio: 0.8 }, { key: "m", weight: 2, remainingRatio: null }];
  const candidates = normalizedChoiceCandidates(raw), before = structuredClone(candidates);
  for (const [strategy, cursor, counts, expected] of [
    ["priority", null, {}, { selectedKey: "a" }],
    ["unknown", null, {}, { selectedKey: "a" }],
    ["most_remaining", null, {}, { selectedKey: "a" }],
    ["round_robin", "a", {}, { selectedKey: "m", cursorKey: "m" }],
    ["round_robin", "z", {}, { selectedKey: "a", cursorKey: "a" }],
    ["least_used", null, { a: { count: 2, lastMs: 7 }, m: { count: 2, lastMs: 6 } }, { selectedKey: "z" }],
    ["least_used", null, { a: { count: 2, lastMs: 7 }, m: { count: 2, lastMs: 6 }, z: { count: 2, lastMs: 6 } }, { selectedKey: "m" }],
    ["threshold", "z", {}, { selectedKey: "a", cursorKey: "a" }],
  ]) {
    const original = structuredClone(counts);
    assert.deepEqual(chooseGrantKey({ strategy }, candidates, cursor, key => counts[key]), expected);
    assert.deepEqual(candidates, before); assert.deepEqual(counts, original);
  }
});

test("weighted selection draws once and nonrandom strategies do not draw", t => {
  let draw = 0, calls = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", array => { calls++; array[0] = draw; return array; });
  const candidates = normalizedChoiceCandidates([{ key: "z", weight: 3 }, { key: "a", weight: 1 }, { key: "m", weight: 2 }]);
  for (const [value, selectedKey] of [[0, "a"], [0x80000000, "z"], [0xffffffff, "z"]]) {
    draw = value; const before = calls;
    assert.deepEqual(chooseGrantKey({ strategy: "weighted_random" }, candidates, null, () => undefined), { selectedKey });
    assert.equal(calls, before + 1);
  }
  for (const strategy of ["priority", "round_robin", "least_used", "most_remaining", "threshold", "unknown"]) {
    chooseGrantKey({ strategy }, candidates, null, () => undefined);
  }
  const before = calls;
  chooseGrantKey({ strategy: "weighted_random", stickyHash: "f".repeat(64) }, candidates, null, () => undefined);
  assert.equal(calls, before);
  assert.equal(calls, 3);
});
