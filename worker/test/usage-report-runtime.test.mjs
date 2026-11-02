import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

test("workerd: real session gates, owner/tenant/policy isolation, fractional zones, DST and stable shard cursor", { timeout: 60_000 }, async () => {
  const scratch = join(process.cwd(), ".openclaw/tmp"); await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(join(scratch, "usage-report-runtime-")); let worker;
  try {
    worker = await startWorkerdFixture(temporary,       `
export * from "./worker/index.ts";
import handler from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { ingestUsage, usageStub } from "./worker/ledgers.ts";
import { migrateUsageReportShard } from "./worker/usage-report.ts";
import { sha256Hex } from "./worker/utils.ts";
import { usageDateTools, parseUsageReportRange } from "./worker/usage-report-range.ts";
export default { async fetch(request, env, context) {
 const url = new URL(request.url); env = { ...env, CLAWROUTER_LOCAL_AUTH: "enabled" };
 if (url.pathname === "/fixture/setup") {
  const user = { email: "alice@example.com", record: { role: "user", enabled: true, tenantId: "user-tenant", groups: [] } };
  await authorityCall(env, "/users/put", user);
  for (const policyId of ["p1", "p2"]) await authorityCall(env, "/policies/put", { policyId, policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant" } });
  await authorityCall(env, "/users/put-bindings", { user, policyIds: ["p1", "p2"], seed: { principal: { principalType: "user", principalId: user.email }, bindings: [] } });
  await env.POLICY_KV.put("local/sessions/" + await sha256Hex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), JSON.stringify({ email: user.email, role: "user", createdAt: new Date().toISOString(), expiresAtMs: Date.now() + 3600000 }));
  const event = { type: "clawrouter.usage.v1", occurred_at_ms: Date.now() - 1000, tenant_id: "tenant", policy_id: "p1", principal_id: user.email, key_id: "p1", credential_id: "key-a", provider: "openai", model: "model-a", capability: "llm.responses", request_format: "openai.responses", status: "success", status_code: 200, input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_input_tokens: null, cache_write_input_tokens: 0, reasoning_output_tokens: 10, actual_cost_micros: 5, cost_basis: "policy_fixed", grant_lane: "api_key", content_ref: "private-content", session_id: "private-session" };
  for (const [id, policy_id] of [["same-id", "p1"], ["same-id", "p2"], ["astral-😀", "p1"], ["last", "p2"]]) await ingestUsage(env, { ...event, id, policy_id });
  await ingestUsage(env, { ...event, id: "bob-private", principal_id: "bob@example.com" });
  await usageStub(env, "tenant", "p1").fetch("https://ledger/ingest", { method: "POST", body: JSON.stringify({ ...event, id: "wrong-tenant", tenant_id: "other" }) });
  return Response.json({ ok: true });
 }
 if (url.pathname === "/fixture/migrate") { const options = await request.json(); return Response.json(await Promise.all(["p1", "p2"].map(policyId => migrateUsageReportShard(env, { tenantId: "tenant", policyId }, options)))); }
 if (url.pathname === "/fixture/dates") return Response.json({ kathmandu: usageDateTools("Asia/Kathmandu").midnight("2026-11-01"), ny: parseUsageReportRange(new URLSearchParams({ timezone: "America/New_York", from: "2026-10-31", to: "2026-11-02" }), Date.parse("2026-11-03T12:00:00Z")), spring: usageDateTools("America/New_York").midnight("2026-03-09") - usageDateTools("America/New_York").midnight("2026-03-08"), halfHour: usageDateTools("Australia/Lord_Howe").midnight("2026-10-05") - usageDateTools("Australia/Lord_Howe").midnight("2026-10-04") });
 return handler.fetch(request, env, context);
} };
    `, 'export default { fetch() { throw new Error("unexpected upstream request"); } };');
    const read = (path, headers = {}) => worker.dispatchFetch("https://router.example" + path, { headers });
    assert.equal((await read("/v1/session/usage/report")).status, 401);
    assert.equal((await read("/v1/session/usage/events", { authorization: "Bearer fixture-key" })).status, 401);
    assert.equal((await read("/fixture/setup")).status, 200);
    const headers = { cookie: "clawrouter_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const response = await read("/v1/session/usage/report?timezone=Asia%2FKathmandu", headers);
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
    const report = await response.json(); assert.equal(report.metrics.calls, 4); assert.equal(report.metrics.inputTokens, 400); assert.equal(report.metrics.reasoningOutputTokens, 40);
    assert.equal(report.historyComplete, true); assert.equal(report.groupsTruncated, false); assert.equal(report.costs[0].amountMicros, 20); assert.equal(report.costs[0].lane, "api");
    assert.equal("events" in report, false); assert.ok(!JSON.stringify(report).includes("private"));
    const ids = []; let cursor;
    do { const pageResponse = await read("/v1/session/usage/events?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), headers); assert.equal(pageResponse.status, 200); const page = await pageResponse.json(); ids.push(...page.events.map(e => e.id)); assert.ok(!JSON.stringify(page.events).includes("private")); cursor = page.nextCursor; } while (cursor && ids.length < 10);
    assert.deepEqual(ids, ["same-id", "same-id", "last", "astral-😀"]);
    for (const suffix of ["principal=bob%40example.com", "tenant=other", "policy=p2", "events=admin"]) assert.equal((await read("/v1/session/usage/report?" + suffix, headers)).status, 400);
    assert.equal((await read("/v1/session/usage/report?key=key-b", headers)).status, 200);
    assert.equal((await (await read("/v1/session/usage/report?key=key-b", headers)).json()).metrics.calls, 0);
    const dates = await (await read("/fixture/dates")).json();
    assert.equal(dates.kathmandu, Date.parse("2026-10-31T18:15:00Z")); assert.deepEqual(dates.ny.buckets.map(b => (b.end - b.start) / 3600000), [24, 25]); assert.equal(dates.spring / 3600000, 23); assert.equal(dates.halfHour / 3600000, 23.5);
    assert.equal((await worker.dispatchFetch("https://router.example/v1/session/usage/report", { method: "POST", headers })).status, 404);
    assert.equal((await worker.dispatchFetch("https://router.example/reporting-migration", { method: "POST", headers, body: "{}" })).status, 404);
    const migrate = options => worker.dispatchFetch("https://router.example/fixture/migrate", { method: "POST", body: JSON.stringify(options) });
    const dry = await (await migrate({})).json(); assert.ok(dry.every(r => r.dryRun));
    assert.equal((await (await read("/v1/session/usage/report", headers)).json()).historyComplete, true);
    const applied = await (await migrate({ apply: true, batchSize: 1 })).json(); assert.ok(applied.every(r => !r.dryRun && r.complete));
    const completed = await (await read("/v1/session/usage/report", headers)).json(); assert.equal(completed.historyComplete, true); assert.equal(completed.metrics.calls, 4);
  } finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
