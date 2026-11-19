import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { accountingReceipt } = await import("../proxy-accounting.ts");
import { reportingCost } from "../usage-report-cost.ts";
const { anthropicHardBudgetGuardReceipt, softHostedToolReceipt } = await import("./usage-report-cost-fixture.mjs");

for (const stream of [false, true]) test(
  "actual hard-budget Anthropic served-tier guard retains reservation, never known partial: " + (stream ? "SSE" : "JSON"), async () => {
    const { event, reservation, settlements, response } = await anthropicHardBudgetGuardReceipt(stream);
    assert.equal(response.status, stream ? 200 : 502);
    assert.equal(event.status, "provider_error"); assert.equal(event.status_code, 502);
    assert.equal(event.cost_basis, "unpriced_usage");
    assert.equal(event.reserved_cost_micros, reservation.reservedMicros);
    assert.equal(event.actual_cost_micros, reservation.reservedMicros);
    assert.equal(event.reporting_known_cost_micros, null);
    assert.equal(event.reporting_estimated_cost_micros, undefined);
    assert.deepEqual(settlements, [{ path: "/settle", reservationId: "reservation-fixture", actualCostMicros: reservation.reservedMicros }]);
    assert.deepEqual(reportingCost(event), { lane: "api", costClass: "unknown", amount: null });
  });

test("genuine soft hosted-tool token component is partial; missing tool fees stay missing", async () => {
  const event = await softHostedToolReceipt();
  assert.equal(event.actual_cost_micros, 56); assert.equal(event.cost_basis, "unpriced_usage");
  assert.equal(event.reporting_known_cost_micros, 56);
  assert.equal(event.hosted_tool_calls_complete, false); assert.equal(event.hosted_tool_cost_micros, null);
  assert.equal(event.cache_write_input_tokens, null); assert.equal(event.reasoning_output_tokens, null);
  assert.deepEqual(reportingCost(event), { lane: "api", costClass: "partial", amount: 56 });
  const legacy = { ...event }; delete legacy.reporting_known_cost_micros;
  assert.deepEqual(reportingCost(legacy), { lane: "api", costClass: "unknown", amount: null });
});

test("observed hosted-tool fee joins measured token component but does not erase unknown remainder", async () => {
  const event = await softHostedToolReceipt({ complete: true });
  assert.equal(event.actual_cost_micros, 10056); assert.equal(event.cost_basis, "unpriced_usage");
  assert.equal(event.reporting_known_cost_micros, 10056); assert.equal(event.hosted_tool_cost_micros, 10000);
  assert.deepEqual(reportingCost(event), { lane: "api", costClass: "partial", amount: 10056 });
});

test("fixed tariffs, fallback costs and nonbillable outcomes never emit measured partial markers", async () => {
  const fixed = await softHostedToolReceipt({ fixed: 123 });
  assert.equal(fixed.actual_cost_micros, 123); assert.equal(fixed.cost_basis, "policy_fixed");
  assert.equal(fixed.reporting_known_cost_micros, null);
  const facts = { event: { reporting_known_cost_micros: 999 }, model: null, fixed: null,
    cost: { basis: "flat_fallback", reserveMicros: 1 }, requestFormat: "openai.responses", startedAtMs: 0 };
  const outcome = { occurredAtMs: 1, statusCode: 200, status: "success", billable: true, tokens: { input: 10, output: 1 },
    reservation: { reservations: [], reservedMicros: 1 }, contentRef: null };
  const fallback = accountingReceipt(facts, outcome);
  assert.equal(fallback.actual_cost_micros, 1); assert.equal(fallback.reporting_known_cost_micros, null);
  for (const requestFormat of ["openai.responses", "openai.moderations"]) {
    const free = accountingReceipt({ ...facts, requestFormat }, { ...outcome, billable: false });
    assert.equal(free.actual_cost_micros, 0); assert.equal(free.cost_basis, "none"); assert.equal(free.reporting_known_cost_micros, null);
  }
});


test("published rate upper bounds cannot establish a known measured partial component",()=>{
 const event=accountingReceipt({event:{capability:"llm.responses"},model:{pricing:{inputMicrosPerMillion:1000000,outputMicrosPerMillion:2000000,settlementBasis:"published_upper_bound"}},fixed:null,cost:{basis:"unpriced_request",reserveMicros:0,pricingGap:"hosted_tool_fee"},requestFormat:"openai.responses",startedAtMs:0},{occurredAtMs:1,statusCode:200,status:"success",billable:true,tokens:{input:10,output:1,cached:null,cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null},reservation:{reservations:[],reservedMicros:0,charges:[]},contentRef:null});
 assert.equal(event.actual_cost_micros,12);assert.equal(event.cost_basis,"unpriced_usage");assert.equal(event.reporting_known_cost_micros,null);assert.equal(reportingCost(event).costClass,"unknown");
});
