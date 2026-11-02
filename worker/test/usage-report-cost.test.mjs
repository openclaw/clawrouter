import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { reportingCost, knownBasisClasses } from "../usage-report-cost.ts";

const event = (extra = {}) => ({ cost_basis: "unpriced_usage", actual_cost_micros: 50, grant_lane: "api_key", ...extra });
const unknown = { lane: "api", costClass: "unknown", amount: null };

test("positive unpriced debits are unknown without explicit measured evidence, including legacy labels", () => {
  for (const cost_basis of ["unpriced_usage", "unpriced_request", "unpriced_service_tier", "flat_fallback", "partial", "partial_usage", "future", "none"]) {
    assert.deepEqual(reportingCost(event({ cost_basis })), unknown, cost_basis);
  }
  for (const cost_basis of ["partial", "partial_usage", "future", "none"]) {
    assert.deepEqual(reportingCost(event({ cost_basis, reporting_known_cost_micros: 30 })), unknown);
  }
});

test("partial amount is exactly a validated measured component, never the entire recorded debit", () => {
  assert.deepEqual(reportingCost(event({ reporting_known_cost_micros: 30 })), { lane: "api", costClass: "partial", amount: 30 });
  assert.deepEqual(reportingCost(event({ reporting_known_cost_micros: 50 })), { lane: "api", costClass: "partial", amount: 50 });
  for (const reporting_known_cost_micros of [undefined, null, 0, -1, 0.5, 51, "30", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(reportingCost(event({ reporting_known_cost_micros })), unknown);
  }
  for (const actual_cost_micros of [undefined, null, -1, 0, 0.5, "50", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(reportingCost(event({ actual_cost_micros, reporting_known_cost_micros: 1 })), unknown);
  }
  assert.deepEqual(reportingCost(event({ actual_cost_micros: Number.MAX_SAFE_INTEGER, reporting_known_cost_micros: Number.MAX_SAFE_INTEGER })),
    { lane: "api", costClass: "partial", amount: Number.MAX_SAFE_INTEGER });
});

test("canonical basis mapping covers realtime, no-charge contradictions, and noncanonical object keys", () => {
  assert.equal(knownBasisClasses.realtime_modality_usage, "calculated");
  assert.equal(knownBasisClasses.realtime_input_transcription_usage, "calculated");
  assert.equal(knownBasisClasses.realtime_full_context_bound, "upper_bound");
  assert.equal(Object.hasOwn(knownBasisClasses, "partial_usage"), false);
  for (const [cost_basis, costClass] of Object.entries(knownBasisClasses)) {
    const actual_cost_micros = cost_basis === "none" ? 0 : 50;
    assert.deepEqual(reportingCost(event({ cost_basis, actual_cost_micros, reporting_known_cost_micros: 10 })), { lane: "api", costClass, amount: actual_cost_micros });
    assert.deepEqual(reportingCost(event({ cost_basis, actual_cost_micros: -1 })), unknown);
  }
  for (const cost_basis of ["constructor", "__proto__", "toString"]) assert.deepEqual(reportingCost(event({ cost_basis })), unknown);
  assert.deepEqual(reportingCost(event({ cost_basis: "none", actual_cost_micros: 0 })), { lane: "api", costClass: "no_charge", amount: 0 });
});

test("frozen reporting estimate only fills unknown evidence with an actual recorded zero", () => {
  const estimate = { reporting_estimated_cost_micros: 80, reporting_estimate_reason: "frozen-card-upper-allocation" };
  assert.deepEqual(reportingCost(event({ ...estimate, actual_cost_micros: 0 })), { lane: "api", costClass: "estimated", amount: 80 });
  assert.deepEqual(reportingCost(event(estimate)), unknown);
  assert.deepEqual(reportingCost(event({ ...estimate, reporting_known_cost_micros: 30 })), { lane: "api", costClass: "partial", amount: 30 });
  for (const reporting_estimated_cost_micros of [null, -1, 0.1, "80", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(reportingCost(event({ ...estimate, actual_cost_micros: 0, reporting_estimated_cost_micros })), unknown);
  }
  for (const reporting_estimate_reason of [null, "", 1]) assert.deepEqual(reportingCost(event({ ...estimate, actual_cost_micros: 0, reporting_estimate_reason })), unknown);
  assert.deepEqual(reportingCost(event({ ...estimate, cost_basis: "none", actual_cost_micros: 0 })), { lane: "api", costClass: "no_charge", amount: 0 });
});

test("lane derives only from retained grant lane and classification never mutates evidence", () => {
  for (const [grant_lane, lane] of [["api_key", "api"], ["environment", "api"], ["subscription", "subscription"], [null, "unattributed"], ["future", "unattributed"]]) {
    const value = event({ grant_lane, reporting_known_cost_micros: 30 }), original = structuredClone(value);
    assert.deepEqual(reportingCost(value), { lane, costClass: "partial", amount: 30 });
    assert.deepEqual(value, original);
  }
});
