import assert from "node:assert/strict";
import test from "node:test";
import { chooseGrantKey, chooseOwnedGrantKey, consumeOwnedChoiceCandidates, normalizedChoiceCandidates, selectThresholdGrantKey } from "../grant-selection-strategies.ts";

test("threshold routing stays on the active grant until the cutoff", () => {
  const candidates = [{ key: "active", remainingRatio: 0.11 }, { key: "reserve", remainingRatio: 0.95 }];
  assert.equal(selectThresholdGrantKey(candidates, "active", 90, 10), "active");
});

test("threshold routing switches at the cutoff only to a materially healthier grant", () => {
  assert.equal(selectThresholdGrantKey([{ key: "active", remainingRatio: 0.1 }, { key: "reserve", remainingRatio: 0.19 }], "active", 90, 10), "active");
  assert.equal(selectThresholdGrantKey([{ key: "active", remainingRatio: 0.1 }, { key: "reserve", remainingRatio: 0.2 }, { key: "best", remainingRatio: 0.8 }], "active", 90, 10), "best");
});

test("threshold routing chooses the healthiest grant when the previous choice is unavailable", () => {
  assert.equal(selectThresholdGrantKey([{ key: "a", remainingRatio: null }, { key: "b", remainingRatio: 0.6 }], "missing", 90, 10), "b");
});

// The authority and the isolate-local snapshot path each fold candidates with
// their own implementation; every replacement rule must hold through all three.
const entryPoints = {
  selectThresholdGrantKey: candidates => selectThresholdGrantKey(candidates, "active", 90, 10),
  chooseGrantKey: candidates => chooseGrantKey(request(candidates), normalizedChoiceCandidates(candidates), { cursorKey: "active", counts: new Map() }).selectedKey,
  chooseOwnedGrantKey: candidates => chooseOwnedGrantKey(request(candidates), consumeOwnedChoiceCandidates(candidates.map(candidate => ({ ...candidate })), String), "active", () => undefined).selectedKey,
};
const request = candidates => ({ strategy: "threshold", switchAtUsedPercent: 90, hysteresisPercent: 10, candidates });
const grant = (key, remainingRatio) => ({ key, remainingRatio });

for (const [name, choose] of Object.entries(entryPoints)) {
  test(`${name}: an active grant at the cutoff yields to a grant with no quota reading`, () => {
    assert.equal(choose([grant("active", 0.1), grant("unseen", null)]), "unseen");
    assert.equal(choose([grant("active", 0.11), grant("unseen", null)]), "active");
  });

  test(`${name}: measured headroom beats an unmeasured grant, and unmeasured grants order by key`, () => {
    assert.equal(choose([grant("active", 0.1), grant("a-unseen", null), grant("measured", 0.2)]), "measured");
    assert.equal(choose([grant("active", 0.1), grant("z-unseen", null), grant("near", 0.19), grant("b-unseen", null)]), "b-unseen");
  });

  test(`${name}: a grant measured at or past the cutoff never replaces the active grant`, () => {
    assert.equal(choose([grant("active", 0.08), grant("worse", 0.05), grant("level", 0.1)]), "active");
  });
}
