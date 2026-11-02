import assert from "node:assert/strict";
import { eventsCsv, reportCsv } from "../../admin/src/personal-usage.ts";

// Test-only setup/inspection. Actual proxy, accounting, queue and ledgers stay shipped.
export const costPolicies = {
 "proof_hard_cost": { enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "proof-tenant", monthlyBudgetMicros: 1000000, budgetScope: "principal", budgetMode: "reserve", retainRequestContent: false },
 "proof_soft_cost": { enabled: true, generation: "g1", providers: ["openai"], tenantId: "proof-tenant", monthlyBudgetMicros: 1000000, budgetScope: "principal", budgetMode: "soft", retainRequestContent: false },
};
export const costEvidenceLedgerRoute = `
 if (new URL(request.url).pathname === "/_proof/cost-evidence") {
  const rows = [...this.sql.exec("SELECT id, event_json FROM usage_events ORDER BY id")];
  const fields = ["provider", "model", "request_format", "status", "status_code", "reserved_cost_micros", "actual_cost_micros", "cost_basis", "reporting_known_cost_micros", "served_service_tier", "input_tokens", "output_tokens", "hosted_tool_calls_complete", "hosted_tool_cost_micros"];
  return Response.json({ rawCount: rows.length, rawDigest: await sha256Hex(JSON.stringify(rows)),
   projection: [...this.sql.exec("SELECT COUNT(*) AS n FROM usage_report_events")][0].n,
   evidence: rows.map(row => { const event = JSON.parse(row.event_json); return Object.fromEntries(fields.filter(field => Object.hasOwn(event, field)).map(field => [field, event[field]])); }) });
 }
`;
export const costRouterRoutes = `
 const costPolicies = ${JSON.stringify(costPolicies)};
 if (url.pathname === "/_proof/cost-setup") {
  for (const [policyId, policy] of Object.entries(costPolicies)) {
   await authorityCall(env, "/policies/put", { policyId, policy });
   const created = await authorityCall(env, "/credentials/mutate", { operation: "create", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "synthetic-setup" }, credentialId: policyId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-key"), policyId, policyGeneration: "g1", principalId: "owner@example.test" } });
   if (created.outcome !== "updated") throw new Error("synthetic cost credential setup failed");
  }
  await authorityCall(env, "/connections/put", { providerId: "anthropic", enabled: true, monthlyBudgetMicros: null });
  const user = { email: "owner@example.test", record: { role: "user", enabled: true, tenantId: "proof-tenant", groups: [] } };
  await authorityCall(env, "/users/put-bindings", { user, policyIds: ["proof", ...Object.keys(costPolicies)], seed: { principal: { principalType: "user", principalId: user.email }, bindings: [] } });
  return Response.json({ ok: true });
 }
 if (url.pathname === "/_proof/cost-state") {
  const state = {};
  for (const [policyId, policy] of Object.entries(costPolicies)) {
   state[policyId] = { ...await (await usageStub(env, "proof-tenant", policyId).fetch("https://ledger/_proof/cost-evidence")).json(),
    budget: await budgetStatus(env, policyId, policy, "owner@example.test") };
  }
  const config = await authorityCall(env, "/policies/list", {});
  const credentials = await authorityCall(env, "/credentials/list", {});
  const connections = await authorityCall(env, "/connections/resolve", { providerIds: ["openai", "anthropic"] });
  return Response.json({ state, shippedQueueConsumer: proofHandler.queue === handler.queue, settingsDigest: await sha256Hex(JSON.stringify([config, credentials, connections])) });
 }
`;

// Synthetic provider wire only. Validate actual outgoing route/model transforms
// without retaining headers, credentials, prompts or response content.
export const costUpstream = `
 const url = new URL(request.url);
 if (url.pathname === "/v1/messages") {
  const body = await request.json();
  if (request.method !== "POST" || body.model !== "claude-opus-5-5" || body.max_tokens !== 128) return new Response("synthetic transform check failed", { status: 500 });
  return Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "priority" } });
 }
 if (url.pathname === "/v1/responses") {
  const body = await request.clone().json();
  if (body.model === "gpt-4.1-mini") {
   if (request.method !== "POST" || !body.tools?.some(tool => tool.type === "web_search")) return new Response("synthetic transform check failed", { status: 500 });
   // One observed search plus an untyped output item: the shipped bounded
   // observer cannot establish completeness. No fabricated hosted-usage DTO.
   return Response.json({ id: "synthetic-partial", object: "response", status: "completed", service_tier: "default",
    output: [{ id: "synthetic-search", type: "web_search_call", action: { type: "search" } }, { id: "synthetic-unclassified" }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
  }
 }
`;

function records(csv) {
 // Fixture fields contain no embedded newline; retain blank cells as strings.
 const rows = csv.split(String.fromCharCode(13, 10)).map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m => m[1].replaceAll('""', '"')));
 return rows.slice(1).map(values => Object.fromEntries(rows[0].map((key, i) => [key, values[i]])));
}

/** All outcomes below come from received HTTP DTOs and persisted ledger inspection. */
export async function exercisePersonalUsageCosts({ read, json, until, restart }) {
 assert.equal((await read("/_proof/cost-setup", { method: "POST" })).status, 200);
 const initial = await json("/_proof/cost-state");
 assert.equal(initial.shippedQueueConsumer, true);
 for (const state of Object.values(initial.state)) { assert.equal(state.rawCount, 0); assert.equal(state.budget.spentMicros, 0); }
 const send = async (key, path, body) => {
  const response = await read(path, { method: "POST", headers: { authorization: "Bearer clawrouter-live-" + key + "-synthetic-key", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
 };
 const hard = await send("proof_hard_cost", "/v1/messages", { model: "anthropic/claude-opus-5-5", messages: [{ role: "user", content: "synthetic fixture" }], max_tokens: 128 });
 assert.equal(hard.status, 502); assert.match(hard.body.error.message, /reservation is retained/);
 const soft = await send("proof_soft_cost", "/v1/responses", { model: "openai/gpt-4.1-mini", input: "synthetic fixture", max_output_tokens: 32, tools: [{ type: "web_search" }] });
 assert.equal(soft.status, 200);
 const settled = await until(() => json("/_proof/cost-state"), ({ state }) => Object.values(state).every(s => s.rawCount === 1 && s.budget.spentMicros > 0));
 assert.equal(settled.shippedQueueConsumer, true);
 const hardState = settled.state["proof_hard_cost"], softState = settled.state["proof_soft_cost"];
 const h = hardState.evidence[0], s = softState.evidence[0];
 assert.equal(h.provider, "anthropic"); assert.equal(h.request_format, "anthropic.messages"); assert.equal(h.served_service_tier, "priority");
 assert.equal(h.status_code, 502); assert.equal(h.status, "provider_error"); assert.ok(h.reserved_cost_micros > 0);
 assert.equal(h.actual_cost_micros, h.reserved_cost_micros); assert.equal(h.cost_basis, "unpriced_usage");
 assert.ok(Object.hasOwn(h, "reporting_known_cost_micros")); assert.equal(h.reporting_known_cost_micros, null);
 assert.equal(s.provider, "openai"); assert.equal(s.request_format, "openai.responses"); assert.equal(s.status_code, 200);
 assert.equal(s.cost_basis, "unpriced_usage"); assert.equal(s.served_service_tier, "default");
 assert.equal(s.input_tokens, 100); assert.equal(s.output_tokens, 10);
 assert.equal(s.hosted_tool_calls_complete, false); assert.equal(s.hosted_tool_cost_micros, null);
 assert.ok(s.reporting_known_cost_micros > 0); assert.equal(s.actual_cost_micros, s.reporting_known_cost_micros);
 assert.equal(s.reporting_known_cost_micros, 56); // stock measured rates, not an injected receipt
 assert.equal(hardState.budget.spentMicros, h.actual_cost_micros); assert.equal(softState.budget.spentMicros, s.actual_cost_micros);
 assert.equal(hardState.projection, 1); assert.equal(softState.projection, 1);

 const check = async () => {
  const result = {};
  for (const [key, expected, costClass] of [["proof_hard_cost", h, "unknown"], ["proof_soft_cost", s, "partial"]]) {
   const report = await json("/v1/session/usage/report?days=7&key=" + key);
   const range = new URLSearchParams({ from: new Date(report.range.from).toISOString(), to: new Date(report.range.to).toISOString(), timezone: report.range.timezone, key });
   const page = await json("/v1/session/usage/events?" + range);
   assert.equal(report.metrics.calls, 1); assert.equal(report.historyComplete, true); assert.equal(report.historySource, "projection");
   assert.equal(page.events.length, 1); const event = page.events[0];
   assert.equal(event.keyId, key); assert.equal(event.provider, expected.provider); assert.equal(event.model, expected.model);
   assert.equal(event.costBasis, "unpriced_usage"); assert.equal(event.costClass, costClass);
   assert.equal(event.reportingCostMicros, expected.reporting_known_cost_micros); assert.equal(event.recordedChargeMicros, expected.actual_cost_micros);
   const cost = report.costs.find(cost => cost.costClass === costClass);
   assert.equal(cost.calls, 1); assert.equal(cost.lane, "api");
   // Report summaries use 0 as an additive UNKNOWN sentinel, not a price.
   assert.equal(cost.amountMicros, costClass === "unknown" ? 0 : expected.reporting_known_cost_micros);
   const eventExport = records(eventsCsv(page.events))[0], reportExport = records(reportCsv(report))[0];
   assert.equal(eventExport.reportingCostMicros, costClass === "unknown" ? "" : String(expected.reporting_known_cost_micros));
   assert.equal(eventExport.recordedChargeMicros, String(expected.actual_cost_micros));
   assert.equal(eventExport.costClass, costClass); assert.equal(eventExport.costBasis, "unpriced_usage");
   assert.equal(reportExport["api_" + costClass + "_calls"], "1");
   assert.equal(reportExport["api_" + costClass + "_reporting_amount_usd"], costClass === "unknown" ? "" : String(expected.reporting_known_cost_micros / 1000000));
   result[key] = { endpoint: key === "proof_hard_cost" ? "/v1/messages" : "/v1/responses", provider: event.provider, model: event.model, httpStatus: event.statusCode, status: event.status,
    reservationMicros: expected.reserved_cost_micros, recordedChargeMicros: event.recordedChargeMicros, reportingKnownComponentMicros: expected.reporting_known_cost_micros,
    costBasis: event.costBasis, costClass: event.costClass, reportingAmountMicros: event.reportingCostMicros, reportSummaryAmountMicros: cost.amountMicros,
    budgetSpentMicros: settled.state[key].budget.spentMicros, eventCsvReportingAmount: eventExport.reportingCostMicros, eventCsvRecordedCharge: eventExport.recordedChargeMicros,
    reportCsvReportingAmountUsd: reportExport["api_" + costClass + "_reporting_amount_usd"],
    ...(key === "proof_soft_cost" ? { hostedToolCallsComplete: expected.hosted_tool_calls_complete, hostedToolCostMicros: expected.hosted_tool_cost_micros } : { servedTier: expected.served_service_tier }) };
  }
  return result;
 };
 const beforeRestart = await check();
 assert.deepEqual(await json("/_proof/cost-state"), settled, "report/event/CSV reads must not mutate usage, projection, settings or budget debit");
 await restart();
 assert.deepEqual(await json("/_proof/cost-state"), settled, "same candidate restart preserves exact persisted cost receipts and debits");
 assert.deepEqual(await check(), beforeRestart);
 assert.deepEqual(await json("/_proof/cost-state"), settled);
 return { phase: "candidate-only post-baseline-upgrade", cases: beforeRestart, shippedQueueConsumer: "unmodified handler.queue via spread handler; real USAGE_QUEUE producer/consumer and persisted ingest",
  actualShippedQueueConsumerIdentity: settled.shippedQueueConsumer, outboundProviderTransformsValidated: true,
  reportEventCsvReadOnly: true, sameCandidatePersistedRestart: true, noHistoricalProducerMarkerClaim: true,
  authScope: "shipped local-session KV and authority; not Cloudflare Access JWT verification",
  unknownSummarySentinelIsNotPrice: true, reportingDoesNotRepriceOrInferMissingFees: true,
  limits: ["Synthetic provider wire, credentials and owner only; no production traffic or real provider billing evidence", "OpenAI output includes an untyped item: real bounded observer marks hosted-search completeness unknown"] };
}
