import assert from "node:assert/strict";
import test from "node:test";
import { selectThresholdGrantKey } from "../authority.ts";

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
