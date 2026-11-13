import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startWorkerdFixture } from "./workerd.mjs";
import { costEvidenceLedgerRoute, costRouterRoutes, costUpstream, exercisePersonalUsageCosts } from "./personal-usage-cost-runtime.mjs";

export const personalUsageBaseline = "6fceb88d4d165ba66281c931b74c3047772a2ef5";
const sessionCookie = "clawrouter_session=" + "a".repeat(64);
const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "proof-tenant", monthlyBudgetMicros: 1000000, requestCostMicros: 17, budgetScope: "principal", budgetMode: "reserve", retainRequestContent: false };
export function router(source, candidate, proofOffset) { return `
 export * from "${source}/worker/index.ts";
 import handler from "${source}/worker/index.ts";
 import { UsageLedgerObject as Ledger, budgetStatus, usageStub } from "${source}/worker/ledgers.ts";
 import { authorityCall } from "${source}/worker/authority.ts";
 import { sha256Hex } from "${source}/worker/utils.ts";
 ${candidate ? 'import { migrateUsageReportShard } from "' + source + '/worker/usage-report.ts"; import { usageReportProjectionComplete } from "' + source + '/worker/usage-report-store.ts";' : ''}
 const policy = ${JSON.stringify(policy)};
 // A fixed offset keeps the fixture near UTC noon across restart while time
 // continues advancing, preserving half-open report boundary semantics.
 const wallClockNow = Date.now.bind(Date);
 Date.now = () => wallClockNow() + ${proofOffset};
 export class UsageLedgerObject extends Ledger {
  async fetch(request) {
   ${candidate ? costEvidenceLedgerRoute : ""}
   if (new URL(request.url).pathname !== "/_proof/state") return super.fetch(request);
   const rows = [...this.sql.exec("SELECT id, event_json FROM usage_events ORDER BY id")];
   const exists = [...this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_report_events'")].length > 0;
   const projection = exists ? [...this.sql.exec("SELECT COUNT(*) AS n FROM usage_report_events")][0].n : 0;
   return Response.json({ rawCount: rows.length, rawDigest: await sha256Hex(JSON.stringify(rows)), projection, ${candidate ? 'projectionComplete: usageReportProjectionComplete(this.sql)' : 'projectionComplete: false'} });
  }
 }
 const proofHandler = { ...handler, async fetch(request, env, context) {
  env = { ...env, CLAWROUTER_LOCAL_AUTH: "enabled" };
  const url = new URL(request.url);
  ${candidate ? costRouterRoutes : ""}
  if (url.pathname === "/_proof/setup") {
   await authorityCall(env, "/policies/initialize-all", [{ policyId: "proof", policy }]);
   await authorityCall(env, "/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: null }]);
   await authorityCall(env, "/credentials/initialize-all", await Promise.all(["owner", "other"].map(async id => ({ credentialId: id, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-key"), policyId: "proof", policyGeneration: "g1", principalId: id + "@example.test" } }))));
   for (const id of ["owner", "other"]) {
    const user = { email: id + "@example.test", record: { role: "user", enabled: true, tenantId: "proof-tenant", groups: [] } };
    await authorityCall(env, "/users/put", user);
    await authorityCall(env, "/users/put-bindings", { user, policyIds: ["proof"], seed: { principal: { principalType: "user", principalId: user.email }, bindings: [] } });
   }
   await env.POLICY_KV.put("local/sessions/" + await sha256Hex("a".repeat(64)), JSON.stringify({ email: "owner@example.test", role: "user", createdAt: new Date().toISOString(), expiresAtMs: Date.now() + 3600000 }));
   return Response.json({ ok: true });
  }
  if (url.pathname === "/_proof/state") {
   const raw = await (await usageStub(env, "proof-tenant", "proof").fetch("https://ledger/_proof/state")).json();
   const config = await authorityCall(env, "/policies/list", {});
   const credentials = await authorityCall(env, "/credentials/list", {});
   const connections = await authorityCall(env, "/connections/resolve", { providerIds: ["openai"] });
   const settingsDigest = await sha256Hex(JSON.stringify([config, credentials, connections]));
   return Response.json({ ...raw, config, settingsDigest, budget: await budgetStatus(env, "proof", policy, "owner@example.test") });
  }
  if (url.pathname === "/_proof/policy") {
   await authorityCall(env, "/policies/put", { policyId: "proof", policy: { ...policy, enabled: (await request.json()).enabled } });
   return Response.json({ ok: true });
  }
  if (url.pathname === "/_proof/binding") {
   const enabled = (await request.json()).enabled;
   const user = { email: "owner@example.test", record: { role: "user", enabled: true, tenantId: "proof-tenant", groups: [] } };
   await authorityCall(env, "/users/put-bindings", { user, policyIds: enabled ? ["proof"] : [], seed: { principal: { principalType: "user", principalId: user.email }, bindings: [] } });
   return Response.json({ ok: true });
  }
  ${candidate ? 'if (url.pathname === "/_proof/migrate") return Response.json(await migrateUsageReportShard(env, { tenantId: "proof-tenant", policyId: "proof" }, await request.json()));' : ''}
  return handler.fetch(request, env, context);
 }};
 export default proofHandler;
`; }
export const upstream = `export default { async fetch(request) {
 ${costUpstream}
 if (request.method !== "POST") return new Response("unexpected", { status: 500 });
 return Response.json({ id: "synthetic-" + crypto.randomUUID(), object: "response", status: "completed", service_tier: "default", output: [], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } } });
}};`;
const summarize = values => { const sorted = [...values].sort((a,b)=>a-b); return { samplesMs: values, medianMs: sorted[Math.floor(sorted.length/2)], p95Ms: sorted[Math.ceil(sorted.length*.95)-1] }; };

/** All authority/report/proxy/queue/ledger code is shipped code. Only setup/state inspection and upstream are fixture adapters. */
export async function provePersonalUsageUpgrade({ eventsPerOwner = 12, artifactPath } = {}) {
 const root = resolve(".openclaw/tmp"); await mkdir(root, { recursive: true });
 const temporary = await mkdtemp(join(root, "authenticated-upgrade-")), baseline = join(temporary, "baseline");
 await mkdir(baseline);
 const archive = execFileSync("git", ["archive", personalUsageBaseline, "package.json", "worker", "shared"], { maxBuffer: 32 * 1024 * 1024 });
 execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
 const wallNow = Date.now(), calendar = new Date(wallNow);
 const proofOffset = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), 12) - wallNow;
 const options = { persistencePath: join(temporary, "resources"), preventEviction: true, bindings: { ANTHROPIC_API_KEY: "fixture-upstream-key" } };
 let worker;
 const read = async (path, init = {}) => worker.dispatchFetch("https://router.example" + path, { ...init, headers: { cookie: sessionCookie, ...init.headers } });
 const json = async path => { const response = await read(path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
 const complete = async path => { const outcome = await json(path); assert.equal(outcome.kind, "complete", JSON.stringify(outcome)); return outcome.value; };
 const until = async (fn, predicate) => { const end = Date.now() + 20000; for (;;) { const value = await fn(); if (predicate(value)) return value; if (Date.now() > end) throw new Error("accounting ingestion did not converge"); await new Promise(r => setTimeout(r, 20)); } };
 const send = async owner => { const response = await read("/v1/responses", { method: "POST", headers: { authorization: "Bearer clawrouter-live-" + owner + "-synthetic-key", "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6.1-sol", input: "synthetic fixture", max_output_tokens: 32 }) }); assert.equal(response.status, 200, await response.clone().text()); await response.text(); };
 const samples = async path => { const times=[]; let body; for(let i=0;i<12;i++){const start=performance.now();body=await complete(path);times.push(performance.now()-start);} return { ...summarize(times), payloadBytes: new TextEncoder().encode(JSON.stringify(body)).length, body }; };
 try {
  worker = await startWorkerdFixture(temporary, router(baseline, false, proofOffset), upstream, options);
  assert.equal((await read("/_proof/setup")).status, 200);
  for (let offset = 0; offset < eventsPerOwner; offset += 8) await Promise.all(Array.from({ length: Math.min(8, eventsPerOwner-offset) }, async () => { await send("owner"); await send("other"); }));
  await until(() => json("/_proof/state"), s => s.rawCount === eventsPerOwner * 2 && s.budget.spentMicros === eventsPerOwner * 17);
  const before = await json("/_proof/state"), legacy = await json("/v1/session/usage");
  assert.equal(legacy.usage.personal.summary.requestCount, eventsPerOwner);
  assert.equal(before.projection, 0);
  await worker.dispose(); worker = null;
  worker = await startWorkerdFixture(temporary, router(resolve("."), true, proofOffset), upstream, options);
  const after = await json("/_proof/state");
  assert.equal(after.rawDigest, before.rawDigest); assert.deepEqual(after.config, before.config); assert.equal(after.settingsDigest,before.settingsDigest); assert.equal(after.budget.spentMicros, before.budget.spentMicros); assert.equal(after.projection, 0);
  assert.equal((await worker.dispatchFetch("https://router.example/v1/session/usage/report")).status, 401);
  const transition = await samples("/v1/session/usage/report?days=7&intent=summary"), report = transition.body;
  assert.equal(report.metrics.calls, eventsPerOwner); assert.equal(report.metrics.inputTokens, eventsPerOwner*100);
  assert.equal(report.coverage.allDiscoveredSourcesAnswered, true); assert.equal(report.coverage.historicalLocations, "not_exhaustively_assessed"); assert.equal(after.projectionComplete, false);
  assert.equal(report.costs.find(c=>c.costClass==="fixed").amountMicros, eventsPerOwner*17);
  const futureCustom = new URLSearchParams({ intent: "summary", from: new Date(report.query.from).toISOString(), to: new Date(report.query.to + 60000).toISOString() });
  assert.equal((await read("/v1/session/usage/report?" + futureCustom)).status, 400);
  const anchored = new URLSearchParams({ from: new Date(report.query.from).toISOString(), to: new Date(report.query.to).toISOString(), timezone: report.query.timezone, limit: "100" });
  const browse = await complete("/v1/session/usage/report?" + new URLSearchParams({ from: new Date(report.query.from).toISOString(), to: new Date(report.query.to).toISOString(), timezone: report.query.timezone, intent: "browse" }));
  anchored.set("cut", browse.cut);
  const events = await complete("/v1/session/usage/events?" + anchored);
  assert.ok(events.events.every(e=>e.keyId==="owner")); assert.equal(events.coverage.retainedAttributionComplete,true);
  const afterRead = await json("/_proof/state"); assert.equal(afterRead.rawDigest,before.rawDigest); assert.equal(afterRead.projection,0); assert.deepEqual(afterRead.config,before.config); assert.equal(afterRead.settingsDigest,before.settingsDigest); assert.equal(afterRead.budget.spentMicros,before.budget.spentMicros);
  await send("owner"); await send("other");
  const withNew = await until(()=>json("/_proof/state"),s=>s.rawCount===(eventsPerOwner+1)*2 && s.budget.spentMicros===(eventsPerOwner+1)*17);
  assert.equal(withNew.projection,2);
  const beforeProjection = await samples("/v1/session/usage/report?days=7&intent=summary"), mixed = beforeProjection.body; assert.equal(mixed.metrics.calls,eventsPerOwner+1); assert.equal(mixed.metrics.reasoningReportedCalls,1); assert.equal(mixed.metrics.reasoningOutputTokens,10);
  await read("/_proof/binding",{method:"POST",body:JSON.stringify({enabled:false})});
  const revoked = await json("/v1/session/usage/report?days=7&intent=summary"); assert.equal(revoked.kind,"no_access");
  assert.equal((await json("/v1/session/usage/events?"+anchored)).kind,"no_access");
  if(events.nextCursor) assert.equal((await json("/v1/session/usage/events?"+anchored+"&cursor="+encodeURIComponent(events.nextCursor))).kind,"no_access");
  await read("/_proof/binding",{method:"POST",body:JSON.stringify({enabled:true})});
  await read("/_proof/policy",{method:"POST",body:JSON.stringify({enabled:false})});
  assert.equal((await json("/v1/session/usage/report?days=7&intent=summary")).kind,"no_access");
  assert.equal((await json("/v1/session/usage/events?"+anchored)).kind,"no_access");
  const denied=await read("/v1/responses",{method:"POST",headers:{authorization:"Bearer clawrouter-live-owner-synthetic-key","content-type":"application/json"},body:JSON.stringify({model:"openai/gpt-6.1-sol",input:"synthetic fixture"})});
  assert.equal(denied.status,403);
  await read("/_proof/policy",{method:"POST",body:JSON.stringify({enabled:true})});
  const release = await read("/v1/session/usage/report?" + new URLSearchParams({ cut: browse.cut }), { method: "DELETE", headers: { origin: "https://router.example" } });
  assert.equal(release.status,200,await release.clone().text());
  const migrate = async opts => {const r=await read("/_proof/migrate",{method:"POST",body:JSON.stringify(opts)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  const dry = await migrate({}); assert.equal(dry.dryRun,true); assert.equal((await json("/_proof/state")).projection,2);
  let applied; do { applied=await migrate({apply:true,batchSize:200}); } while(!applied.complete);
  const indexed=await samples("/v1/session/usage/report?days=7&intent=summary"), final=await json("/_proof/state");
  assert.equal(indexed.body.metrics.calls,eventsPerOwner+1); assert.equal(final.projectionComplete,true); assert.equal(indexed.body.coverage.allDiscoveredSourcesAnswered,true); assert.equal(final.rawDigest,withNew.rawDigest); assert.equal(final.budget.spentMicros,withNew.budget.spentMicros); assert.deepEqual(final.config,before.config);
  const candidateCostRuntime = await exercisePersonalUsageCosts({ read, json, until, restart: async () => {
   await worker.dispose(); worker = null;
   worker = await startWorkerdFixture(temporary, router(resolve("."), true, proofOffset), upstream, options);
  } });
  const fixedAfterCosts = await json("/_proof/state");
  assert.equal(fixedAfterCosts.rawDigest, final.rawDigest); assert.equal(fixedAfterCosts.budget.spentMicros, final.budget.spentMicros);
  const sourcePaths = ["worker/index.ts", "worker/access.ts", "worker/local-auth.ts", "worker/proxy.ts", "worker/proxy-auth.ts", "worker/proxy-selection.ts", "worker/providers.ts", "worker/generated/provider-snapshot.json", "providers/anthropic.provider.yaml", "providers/openai.provider.yaml", "worker/provider-auth.ts", "worker/authority.ts", "worker/authority-admission.ts", "worker/anthropic-price-response.ts", "worker/anthropic-pricing.ts", "worker/proxy-response.ts", "worker/responses-hosted-usage.ts", "worker/responses-tool-evidence.ts", "worker/token-usage.ts", "worker/pricing.ts", "worker/soft-budget.ts", "worker/budget-scope.ts", "worker/proxy-accounting.ts", "worker/accounting.ts", "worker/ledgers.ts", "worker/usage-report-cost.ts", "worker/usage-report-store.ts", "worker/usage-report-range.ts", "worker/usage-report.ts", "worker/usage-report-session.ts", "shared/usage-report.ts", "admin/src/personal-usage.ts", "test/helpers/personal-usage-upgrade.mjs", "test/helpers/personal-usage-cost-runtime.mjs", "test/helpers/workerd.mjs", "worker/test/usage-report-upgrade-runtime.test.mjs"];
  const candidateSourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  const proof={baseline:personalUsageBaseline,candidateCostRuntime,candidateSourceHashes,synthetic:true,liveProductionEvidence:false,eventsPerOwner,baselineAccountingEvents:eventsPerOwner*2,newAccountingEvents:2,newAccountingEventsScope:"original fixed-tariff preservation phase",candidateCostAccountingEvents:2,totalCandidateAccountingEvents:4,observed:{legacyPersonalCalls:legacy.usage.personal.summary.requestCount,immediateReportCalls:report.metrics.calls,rawRowsBefore:before.rawCount,rawRowsAfterRead:afterRead.rawCount,projectionRowsAfterRead:afterRead.projection,rawRowsAfterNewCall:withNew.rawCount,projectionRowsAfterNewCall:withNew.projection,reportCallsAfterNewCall:mixed.metrics.calls,projectionRowsAfterExplicitLocalApply:final.projection,historicalReasoningCoverage:report.metrics.reasoningReportedCalls,newReasoningCoverage:mixed.metrics.reasoningReportedCalls,newReasoningTokens:mixed.metrics.reasoningOutputTokens},actualShippedSessionAuthorization:true,strictFutureCustomRejected:true,actualProxyAccountingAndQueueIngestion:true,persistedBaselineToCandidateRestart:true,originalUsageSettingsAndDebitsPreserved:true,credentialAndConnectionSettingsPreserved:true,historyReadBeforeApplyWithoutWrites:true,otherOwnerExcluded:true,revokedPolicyFailClosed:true,disabledPolicyAndProxyKeyDenied:true,missingHistoricalReasoningNotInvented:true,localExplicitMigrationTestOnly:true,transitionReport:{...transition,body:undefined},comparableBeforeProjectionReport:{...beforeProjection,body:undefined},comparableOwnerCalls:eventsPerOwner+1,indexedReport:{...indexed,body:undefined},budgetBefore:before.budget.spentMicros,budgetAfterNewCall:final.budget.spentMicros,limits:["Local synthetic upstream and credential/session setup only; no production calls or credentials","Fixture Worker clock uses a fixed UTC-noon offset across restart to prevent calendar-month rollover while remaining monotonic; performance.now latency measurement remains live","Latency includes real local session/authority/report routes, not WAN/Cloudflare Access verification","Small authenticated upgrade corpus complements the separate large retained-volume benchmark"]};
  if(artifactPath)await writeFile(artifactPath,JSON.stringify(proof,null,2)+String.fromCharCode(10));
  return proof;
 } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
}
