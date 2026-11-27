import assert from "node:assert/strict";

// Only a local synthetic workerd fixture may export this SQL inspection route.
export async function checkSearchAccounting(mf, key, calls) {
  const billed = calls.filter(call => !call.directReplay), searches = billed.filter(call => call.commands).length;
  let usage;
  const deadline = Date.now() + 5_000;
  do {
    const response = await mf.dispatchFetch("https://router.example/v1/usage", { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    usage = await response.json();
    if (usage.usage.events.length === billed.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  const events = usage.usage.events;
  assert.equal(events.length, billed.length, "one usage receipt per routed upstream operation");
  assert.equal(new Set(events.map(event => event.request_id)).size, events.length);
  assert.equal(events.filter(event => event.capability === "search.web").length, searches);
  for (const event of events) {
    if (event.capability === "search.web") {
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.reserved_cost_micros, 1000);
      assert.equal(event.actual_cost_micros, 1000); assert.equal(event.input_tokens, null);
    } else {
      assert.equal(event.cost_basis, "manifest_pricing");
      assert.ok(event.input_tokens >= 0 && Number.isSafeInteger(event.input_tokens));
    }
    assert.equal(event.content_retained, false);
  }
  const spent = events.reduce((sum, event) => sum + event.actual_cost_micros, 0);
  assert.equal(usage.budget.spentMicros, spent); assert.equal(usage.usage.summary.actualCostMicros, spent);
  const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
  for (const name of ["default:fixture", "provider:openai"]) {
    const response = await budgets.get(budgets.idFromName(name)).fetch("https://budget/fixture-search-charges");
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.equal(rows.length, billed.length); assert.ok(rows.every(row => row.settled === 1));
    assert.equal(rows.reduce((sum, row) => sum + row.reserved_micros, 0), spent);
  }
  return { receipts: events.length, searches, searchCostMicros: searches * 1000, inferenceCostMicros: spent - searches * 1000, totalCostMicros: spent, policyAndProviderLedgersAgree: true };
}
