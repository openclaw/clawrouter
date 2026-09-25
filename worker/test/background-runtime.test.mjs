import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// All wrappers are test-only. The Worker, authority, scheduled alarm, ledgers
// and closed control dispatch run in workerd with explicit persistent storage.
const router = `
  import worker from "./worker/index.ts";
  import { PolicyBindingIndexObject as Authority } from "./worker/authority.ts";
  import { BudgetLedgerObject as Budget, UsageLedgerObject as Usage, usageStub } from "./worker/ledgers.ts";
  import { authenticateProxyKey } from "./worker/proxy-auth.ts";
  import { continuationScope } from "./worker/http-continuation.ts";
  import { putGrantCredentials } from "./worker/grant-credentials.ts";
  import { sha256Hex } from "./worker/utils.ts";
  export { GrantCredentialObject } from "./worker/grant-credentials.ts";
  export class PolicyBindingIndexObject extends Authority {
    constructor(state, env) { super(state, env); this.fixtureStorage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname, storage = this.fixtureStorage;
      if (path === "/fixture/inspect") {
        return Response.json({ jobs: [...storage.sql.exec("SELECT job_json FROM responses_background")].map(row => JSON.parse(row.job_json)),
          bindings: [...storage.sql.exec("SELECT * FROM http_continuations")], alarms: await storage.get("fixtureAlarms") ?? 0, nextAlarm: await storage.getAlarm() });
      }
      if (path === "/fixture/expiry") {
        const key = "a".repeat(64), owner = { providerId: "openai", endpointId: "responses", grantKey: null, lineage: null, routeSha256: "b".repeat(64), policyGeneration: "g1" };
        const registration = () => super.fetch(new Request("https://owner/http-continuations", { method: "POST", body: JSON.stringify({ action: "register", keys: [key], owner }) }));
        const response = await registration();
        if (!response.ok) return response;
        const deadline = Date.now() + 10_000;
        storage.sql.exec("UPDATE http_continuations SET expires_at_ms = ? WHERE binding_key = ?", deadline, key);
        // Shorten only the fixture's TTL. The ordinary owner mutation, not
        // this wrapper, must reconcile the one shared alarm afterward.
        return registration();
      }
      return super.fetch(request);
    }
    async alarm() { await this.fixtureStorage.put("fixtureAlarms", (await this.fixtureStorage.get("fixtureAlarms") ?? 0) + 1); await super.alarm(); }
  }
  export class BudgetLedgerObject extends Budget {
    constructor(state) { super(state); this.fixtureStorage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/fail") { await this.fixtureStorage.put("fail", await request.json()); return new Response("ok"); }
      if (path === "/fixture/rows") return Response.json([...this.fixtureStorage.sql.exec("SELECT * FROM budget_reservations")]);
      if (path === "/settle" && await this.fixtureStorage.get("fail")) return new Response("unavailable", { status: 503 });
      return super.fetch(request);
    }
  }
  export class UsageLedgerObject extends Usage {
    constructor(state) { super(state); this.fixtureStorage = state.storage; }
    async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/lose-ack") { await this.fixtureStorage.put("loseAck", true); return new Response("ok"); }
      const response = await super.fetch(request);
      if (new URL(request.url).pathname === "/ingest" && await this.fixtureStorage.get("loseAck")) { await this.fixtureStorage.delete("loseAck"); return new Response("lost ACK", { status: 503 }); }
      return response;
    }
  }
  export default { ...worker, async fetch(request, env, context) {
    const url = new URL(request.url);
    const call = (name, path, body) => env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(name)).fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) });
    if (url.pathname === "/fixture/setup") {
      for (const [path, body] of [
        ["/policies/initialize-all", [{ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 100000, requestCostMicros: 100, retainRequestContent: false } }]],
        ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1", principalId: null } }]],
        ["/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 100000 }]],
      ]) { const result = await call("policy-bindings", path, body); if (!result.ok) return result; }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/subscription") {
      await putGrantCredentials(env, "oauth/fixture/openai", { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/fixture/upstream/")) return fetch("https://fixture.example" + url.pathname, { method: request.method, body: request.body, duplex: "half" });
    if (url.pathname.startsWith("/fixture/")) {
      const auth = await authenticateProxyKey(request.headers, env);
      if (auth instanceof Response) return auth;
      const scope = await continuationScope(auth);
      if (["/fixture/inspect", "/fixture/expiry"].includes(url.pathname)) return call(scope, url.pathname, {});
      if (url.pathname.startsWith("/fixture/budget/")) {
        const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(url.searchParams.get("name")));
        return stub.fetch("https://budget/fixture/" + url.pathname.split("/").pop(), { method: "POST", body: request.body });
      }
      const stub = usageStub(env, "tenant", "fixture");
      if (url.pathname === "/fixture/usage-lose-ack") return stub.fetch("https://usage/fixture/lose-ack", { method: "POST" });
      if (url.pathname === "/fixture/usage") return stub.fetch("https://usage/snapshot?events=admin");
    }
    return worker.fetch(request, env, context);
  } };
`;
const upstream = `
  export class Upstream {
    constructor(state) { this.storage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/upstream/complete") { await this.storage.put("complete", true); return new Response("ok"); }
      const calls = await this.storage.get("calls") ?? [];
      if (path === "/fixture/upstream/calls") return Response.json(calls);
      calls.push({ method: request.method, url: request.url, accountId: request.headers.get("chatgpt-account-id"), body: await request.text() }); await this.storage.put("calls", calls);
      const terminal = request.method === "GET" && await this.storage.get("complete");
      return Response.json({ id: "runtime-response", object: "response", status: terminal ? "completed" : "queued", usage: terminal ? { input_tokens: 10, output_tokens: 15, total_tokens: 25 } : null });
    }
  }
  export default { fetch(request, env) { return env.UPSTREAM.get(env.UPSTREAM.idFromName("fixture")).fetch(request); } };
`;
const authorization = "Bearer clawrouter-live-fixture-fixture-key";
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-background-runtime-"));
  const options = { persistencePath: join(temporary, "resources"), upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } };
  let worker;
  const start = async () => { worker = await startWorkerdFixture(temporary, router, upstream, options); };
  t.after(async () => { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); });
  await start();
  const call = (path, body) => worker.dispatchFetch(`https://router.example${path}`, { headers: { authorization }, ...(body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) });
  assert.equal((await call("/fixture/setup", {})).status, 200);
  return { call, ready: () => worker.ready, inspect: async () => (await call("/fixture/inspect")).json(), async restart() { await worker.dispose(); worker = null; await start(); } };
}
async function until(read, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value;
  do { value = await read(); if (predicate(value)) return value; await delay(50); } while (Date.now() < deadline);
  assert.fail(`fixture condition timed out: ${JSON.stringify(value)}`);
}

test("real workerd creation-only admission keeps ordinary settlement without a recovery job", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/fixture/subscription", {})).status, 200);
  const body = { model: "gpt-6-astra", input: "fixture", background: true, store: false };
  const response = await f.call("/v1/native/openai/v1/responses?fixture=value", body);
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "queued");
  assert.equal(response.headers.get("x-clawrouter-background-recovery"), null);
  const usage = await until(async () => (await f.call("/fixture/usage")).json(), value => value.events.length === 1);
  assert.equal(usage.events[0].actual_cost_micros, 100); assert.equal(usage.events[0].cost_basis, "policy_fixed");
  for (const name of ["tenant:fixture", "provider:openai"]) {
    const rows = await until(async () => (await f.call(`/fixture/budget/rows?name=${encodeURIComponent(name)}`)).json(), value => value.length === 1 && value[0].settled === 1);
    assert.equal(rows.length, 1); assert.equal(rows[0].dispatch_started, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 100);
  }
  const state = await f.inspect(); assert.deepEqual(state.jobs, []); assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].background_job_id, null); assert.equal(state.nextAlarm, state.bindings[0].expires_at_ms);
  assert.equal(state.alarms, 0, "ordinary continuation expiry does not introduce collection alarms");
  const calls = await (await f.call("/fixture/upstream/calls")).json(); assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST"); assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/responses?fixture=value");
  assert.equal(calls[0].accountId, "fixture-account"); assert.deepEqual(JSON.parse(calls[0].body), body);
});

for (const expiryFirst of [true, false]) test(`persistent workerd alarm owns cleanup and collection with expiry registered ${expiryFirst ? "first" : "last"}`, { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  if (expiryFirst) assert.equal((await f.call("/fixture/expiry")).status, 200);
  const response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true, store: false });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "queued");
  if (!expiryFirst) assert.equal((await f.call("/fixture/expiry")).status, 200);
  const shared = await f.inspect(), admitted = shared.jobs[0], expiry = shared.bindings.find(row => row.binding_key === "a".repeat(64));
  assert.equal(admitted.event, null); assert.equal(admitted.responseId, "runtime-response");
  assert.ok(expiry.expires_at_ms > Date.now(), "cleanup and observation deadlines coexist before restart");
  assert.ok(admitted.nextAttemptAt > Date.now()); assert.equal(shared.nextAlarm, Math.min(expiry.expires_at_ms, admitted.nextAttemptAt));
  await f.call("/fixture/upstream/complete", {});
  await f.restart();
  const final = await until(f.inspect, value => value.jobs[0]?.phase === "complete" && value.bindings.every(row => row.binding_key !== "a".repeat(64)));
  assert.ok(final.alarms >= 1); assert.equal(final.jobs[0].amount, 100); assert.equal(final.jobs[0].eventId, admitted.facts.event.id);
  for (const leg of admitted.legs) {
    const rows = await (await f.call(`/fixture/budget/rows?name=${encodeURIComponent(leg.intent.objectName)}`)).json();
    assert.equal(rows.length, 1); assert.equal(rows[0].reservation_id, leg.intent.request.reservationId); assert.equal(rows[0].reserved_micros, 100); assert.equal(rows[0].settled, 1);
  }
  const usage = await (await f.call("/fixture/usage")).json(); assert.equal(usage.events.length, 1); assert.equal(usage.events[0].id, final.jobs[0].eventId);
  const calls = await (await f.call("/fixture/upstream/calls")).json(); assert.equal(calls.filter(call => call.method === "POST").length, 1); assert.ok(calls.some(call => call.method === "GET"));
});

test("persistent workerd replays one immutable receipt after a ledger precommit refusal and committed usage ACK loss", { timeout: 60_000 }, async t => {
  const f = await fixture(t), response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true });
  assert.equal(response.status, 200); await response.json(); const admitted = (await f.inspect()).jobs[0];
  await f.call(`/fixture/budget/fail?name=${encodeURIComponent(admitted.legs[1].intent.objectName)}`, true);
  await f.call("/fixture/usage-lose-ack", {}); await f.call("/fixture/upstream/complete", {});
  const partial = await until(f.inspect, value => value.jobs[0]?.event && value.jobs[0].settlements[0] === "settled" && value.jobs[0].settlements[1] === "unavailable" && value.jobs[0].usage === "unavailable");
  const event = partial.jobs[0].event;
  assert.equal((await (await f.call("/fixture/usage")).json()).events.length, 1);
  await f.restart();
  const restarted = (await f.inspect()).jobs[0]; assert.deepEqual(restarted.event, event); assert.equal(restarted.legs[1].intent.request.reservationId, admitted.legs[1].intent.request.reservationId);
  await f.call(`/fixture/budget/fail?name=${encodeURIComponent(admitted.legs[1].intent.objectName)}`, false);
  const final = await until(f.inspect, value => value.jobs[0]?.phase === "complete");
  assert.equal(final.jobs[0].eventId, event.id); assert.equal(final.jobs[0].usage, "duplicate");
  assert.deepEqual((await (await f.call("/fixture/usage")).json()).events, [event]);
  for (const leg of admitted.legs) {
    const rows = await (await f.call(`/fixture/budget/rows?name=${encodeURIComponent(leg.intent.objectName)}`)).json();
    assert.equal(rows.length, 1); assert.equal(rows[0].reservation_id, leg.intent.request.reservationId); assert.equal(rows[0].reserved_micros, event.actual_cost_micros); assert.equal(rows[0].settled, 1);
  }
  const calls = await (await f.call("/fixture/upstream/calls")).json(); assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

function wire(base, path, method, body = "") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, base), { method, headers: { authorization, "content-length": Buffer.byteLength(body) }, timeout: 5000 }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() })); response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("wire fixture timeout"))); request.on("error", reject); request.end(body);
  });
}
test("real workerd ingress accepts Content-Length zero cancel and refuses bytes on all raw control carriers", { timeout: 60_000 }, async t => {
  const f = await fixture(t), response = await f.call("/v1/responses", { model: "openai/gpt-6-astra", background: true });
  assert.equal(response.status, 200); await response.json();
  await f.call("/fixture/upstream/complete", {});
  const terminal = await f.call("/v1/responses/runtime-response"); assert.equal(terminal.status, 200); assert.equal((await terminal.json()).status, "completed");
  await until(f.inspect, value => value.jobs[0]?.phase === "complete");
  const base = await f.ready();
  for (const path of ["/v1/responses/runtime-response/cancel", "/v1/native/openai/v1/responses/runtime-response/cancel"]) assert.equal((await wire(base, path, "POST")).status, 200);
  const before = (await (await f.call("/fixture/upstream/calls")).json()).length;
  for (const [path, method] of [["/v1/responses/runtime-response", "GET"], ["/v1/native/openai/v1/responses/runtime-response", "GET"], ["/v1/proxy/openai/responses_retrieve?response_id=runtime-response", "GET"], ["/v1/playground/v1/responses/runtime-response", "GET"], ["/v1/responses/runtime-response/cancel", "POST"], ["/v1/native/openai/v1/responses/runtime-response/cancel", "POST"]]) {
    const result = await wire(base, path, method, "x"); assert.equal(result.status, 400, result.body); assert.equal(JSON.parse(result.body).error.code, "invalid_response_control");
  }
  assert.equal((await (await f.call("/fixture/upstream/calls")).json()).length, before);
});
