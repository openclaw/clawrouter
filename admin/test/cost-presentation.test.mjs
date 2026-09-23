import assert from "node:assert/strict";
import test from "node:test";
import { formatMicros, presentAccountedSpend, presentBudget, presentCost, presentPolicyBudget, presentProviderBudget } from "../src/cost-presentation.ts";

test("zero amounts retain their recorded accounting basis", () => {
  const cases = [
    ["none", "Accounted · no charge"],
    ["policy_fixed", "Fixed policy tariff"],
    ["manifest_pricing", "Token-based estimate"],
    ["manifest_reservation", "Retained reservation estimate"],
  ];
  for (const [basis, label] of cases) {
    assert.deepEqual(presentCost(0, basis), { value: "$0.00", label, unavailable: false });
  }
  assert.equal(presentCost(0, "unpriced_usage").value, "Price unavailable");
  assert.equal(presentCost(0, "unpriced_request", true).value, "Price unavailable");
  assert.equal(presentCost(1, "flat_fallback").value, "<$0.01");
  assert.equal(presentCost(1, "flat_fallback").label, "Fallback tariff");
});

test("estimates, published upper bounds and fixed tariffs are not invoice claims", () => {
  assert.equal(presentCost(2_000_000, "manifest_pricing").label, "Token-based estimate");
  assert.equal(presentCost(2_000_000, "manifest_pricing", true).label, "Token-based reservation estimate");
  assert.equal(presentCost(2_000_000, "manifest_rate_upper_bound").label, "Token-based estimate (rate upper bound)");
  assert.deepEqual(presentCost(2_000_000, "policy_fixed"), { value: "$2.00", label: "Fixed policy tariff", unavailable: false });
});

test("unknown and historical basis strings preserve amounts without reclassification", () => {
  for (const basis of [undefined, null, "model_pricing", "unpriced_service_tier", "future_basis"]) {
    assert.deepEqual(presentCost(2_000_000, basis), { value: "$2.00", label: "Accounting basis unavailable", unavailable: false });
  }
  assert.equal(formatMicros(null), "Unknown");
  assert.equal(formatMicros(undefined), "Unknown");
  assert.equal(formatMicros(0), "$0.00");
});

test("aggregates preserve accounted totals and unavailable counts without inventing a basis breakdown", () => {
  const summary = { requestCount: 1_000, actualCostMicros: 2_000_000, unpricedRequestCount: 0 };
  assert.deepEqual(presentAccountedSpend(summary), { label: "accounted spend", value: "$2.00", note: "May include estimates" });
  assert.equal(presentAccountedSpend({ ...summary, actualCostMicros: 0 }).value, "$0.00");
  assert.equal(presentAccountedSpend({ ...summary, unpricedRequestCount: 4 }).value, "$2.00 accounted; 4 unpriced");
  assert.match(presentAccountedSpend({ ...summary, unpricedRequestCount: 4 }).note, /4 unpriced calls excluded/);
  assert.equal(presentAccountedSpend({ ...summary, actualCostMicros: 0, unpricedRequestCount: 1_000 }).value, "Price unavailable");
  assert.match(presentAccountedSpend({ ...summary, unpricedRequestCount: undefined }).note, /price coverage unavailable/);
  assert.equal(presentAccountedSpend({ requestCount: 0, actualCostMicros: 0, unpricedRequestCount: 0 }).value, "$0.00");
});

test("partial Fusion totals remain lower bounds, including mixed unavailable calls", () => {
  const partial = presentAccountedSpend({ requestCount: 2, actualCostMicros: 2_000_000, unpricedRequestCount: 1 }, false);
  assert.equal(partial.value, "≥$2.00 accounted; 1 unpriced");
  assert.match(partial.note, /partial call history/);
  const unavailable = presentAccountedSpend({ requestCount: 2, actualCostMicros: 0, unpricedRequestCount: 2 }, false);
  assert.equal(unavailable.value, "Price unavailable");
  assert.match(unavailable.note, /partial call history/);
});

const balance = { configured: true, ledger: "durable_object", limitMicros: 10_000_000, spentMicros: 2_000_000, remainingMicros: 8_000_000 };

test("budget usage includes reservations and stays separate from remaining capacity", () => {
  const budget = presentBudget(balance, "policy");
  assert.equal(budget.used, "$2.00 used");
  assert.equal(budget.remaining, "$8.00 remaining");
  assert.equal(budget.limit, "$10.00 monthly limit");
  assert.equal(budget.percent, 20);
  assert.match(budget.note, /Shared policy pool · UTC calendar month · Used includes reservations/);
  assert.equal(presentBudget({ ...balance, spentMicros: 0, remainingMicros: 10_000_000 }, "policy").used, "$0.00 used");
  assert.equal(presentBudget({ ...balance, spentMicros: 12_000_000, remainingMicros: 0 }, "policy").percent, 100);
});

test("per-principal policy overviews do not fabricate one shared balance", () => {
  const row = { policyId: "team", monthlyBudgetMicros: 10_000_000, budgetScope: "principal", enabled: true, budget: { configured: true, ledger: "per_principal", spentMicros: null, remainingMicros: null } };
  const budget = presentPolicyBudget(row);
  assert.equal(budget.percent, null);
  assert.equal(budget.used, "Separate balance per principal");
  assert.equal(budget.remaining, "Per-principal balances");
  assert.equal(budget.scopeLabel, "Per principal");
  assert.equal(budget.limit, "$10.00 monthly limit");
  assert.equal(presentBudget(balance, "principal").percent, 20);
});

test("no cap at one scope does not promise unrestricted or free requests", () => {
  for (const scope of ["policy", "principal", "provider"]) {
    const budget = presentBudget({ ledger: "unmetered", limitMicros: null, spentMicros: null, remainingMicros: null }, scope);
    assert.equal(budget.remaining, "No cap at this scope");
    assert.equal(budget.used, "Used amount unavailable");
    assert.equal(budget.percent, null);
    assert.match(budget.note, /Other policy or provider limits still apply/);
  }
  const provider = presentProviderBudget({ providerId: "example", enabled: true, monthlyBudgetMicros: 10_000_000, spentMicros: 2_000_000, remainingMicros: 8_000_000 });
  assert.equal(provider.scopeLabel, "Provider-wide");
  assert.equal(provider.remaining, "$8.00 remaining");
});

test("missing or failed ledger observations never become a zero balance or healthy state", () => {
  for (const ledger of ["unavailable", "invalid_policy", "untracked"]) {
    const budget = presentBudget({ ...balance, ledger, spentMicros: null, remainingMicros: null }, "policy");
    assert.equal(budget.used, "Used amount unavailable");
    assert.equal(budget.remaining, "Remaining unavailable");
    assert.equal(budget.percent, null);
    assert.notEqual(budget.health.label, "healthy");
  }
  assert.equal(presentBudget({ ...balance, ledger: "unavailable" }, "policy").percent, null);
  const blocked = presentBudget({ ...balance, ledger: "blocked", limitMicros: 0, spentMicros: 0, remainingMicros: 0 }, "policy");
  assert.equal(blocked.health.label, "budget blocked");
  assert.equal(blocked.remaining, "$0.00 remaining");
  assert.equal(blocked.percent, 100);
});
