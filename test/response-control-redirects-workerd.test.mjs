import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// Real Worker routing, authentication, SQL authority/ledgers and grant-owner
// dispatch. Inspectors expose fixture state only; outboundService traps all hosts.
const router = `
  import worker from "./worker/index.ts";
  import { PolicyBindingIndexObject as Authority } from "./worker/authority.ts";
  import { BudgetLedgerObject as Budget, UsageLedgerObject, usageStub } from "./worker/ledgers.ts";
  import { authenticateProxyKey } from "./worker/proxy-auth.ts";
  import { continuationScope } from "./worker/http-continuation.ts";
  import { putGrantCredentials, GrantCredentialObject } from "./worker/grant-credentials.ts";
  import { sha256Hex } from "./worker/utils.ts";
  export { UsageLedgerObject, GrantCredentialObject };
  export class PolicyBindingIndexObject extends Authority {
    constructor(state, env) { super(state, env); this.storage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/inspect") return Response.json({
        jobs: [...this.storage.sql.exec("SELECT job_json FROM responses_background")].map(row => JSON.parse(row.job_json)),
        bindings: [...this.storage.sql.exec("SELECT * FROM http_continuations")],
      });
      if (path === "/fixture/flush") { await super.alarm(); return new Response("flushed"); }
      return super.fetch(request);
    }
  }
  export class BudgetLedgerObject extends Budget {
    constructor(state) { super(state); this.storage = state.storage; }
    async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/rows") return Response.json([...this.storage.sql.exec("SELECT * FROM budget_reservations")]);
      return super.fetch(request);
    }
  }
  export default { ...worker, async fetch(request, env, context) {
    const url = new URL(request.url), call = (name, path, body) => env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(name)).fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) });
    if (url.pathname === "/fixture/setup") {
      for (const [path, body] of [
        ["/policies/initialize-all", [{ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 10000, requestCostMicros: 100, retainRequestContent: false } }]],
        ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" } }]],
        ["/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 10000 }]],
      ]) { const response = await call("policy-bindings", path, body); if (!response.ok) return response; }
      if ((await request.json()).pooled) await putGrantCredentials(env, "oauth/fixture/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-grant-key" });
      return new Response("initialized");
    }
    if (url.pathname.startsWith("/fixture/")) {
      const auth = await authenticateProxyKey(request.headers, env); if (auth instanceof Response) return auth;
      if (["/fixture/inspect", "/fixture/flush"].includes(url.pathname)) return call(await continuationScope(auth), url.pathname, {});
      if (url.pathname === "/fixture/usage") return usageStub(env, "tenant", "fixture").fetch("https://usage/snapshot?events=admin");
      if (url.pathname === "/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(url.searchParams.get("name"))).fetch("https://budget/fixture/rows");
    }
    return worker.fetch(request, env, context);
  } };
`;
const upstream = `
  let config = {}, calls = [];
  export default { async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/config") { config = await request.json(); calls = []; return new Response("configured"); }
    if (url.pathname === "/fixture/calls") return Response.json(calls);
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    if (url.pathname === "/redirect-target") return Response.json({ error: "redirect-replay" }, { status: 400 });
    const queued = { id: "response-fixture", object: "response", status: "queued", usage: null };
    if (config.status) return new Response(config.status === 304 ? null : JSON.stringify({ ...queued, status: "completed", usage: { input_tokens: 999, output_tokens: 999 }, secret: "fixture-body-secret" }), {
      status: config.status, headers: { ...(config.noLocation ? {} : { location: config.crossOrigin ? "https://redirect.example/redirect-target?secret=fixture-location-secret" : "/redirect-target?secret=fixture-location-secret" }), "retry-after": "900" },
    });
    return Response.json(config.complete ? { ...queued, status: "completed", usage: { input_tokens: 10, output_tokens: 15 } } : queued);
  } };
`;
const authorization = "Bearer clawrouter-live-fixture-fixture-key";
async function fixture(t, pooled) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-control-redirects-"));
  let mf;
  t.after(async () => { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); });
  mf = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true });
  const outbound = await mf.getWorker("upstream");
  const call = (path, body, method = body === undefined ? "GET" : "POST", headers = {}) => mf.dispatchFetch("https://router.example" + path, {
    method, redirect: "manual", headers: { authorization, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await call("/fixture/setup", { pooled })).status, 200);
  return { call,
    inspect: async () => (await call("/fixture/inspect")).json(),
    usage: async () => (await call("/fixture/usage")).json(),
    rows: async name => (await call("/fixture/rows?name=" + encodeURIComponent(name))).json(),
    calls: async () => (await outbound.fetch("https://fixture/fixture/calls")).json(),
    async configure(config) { assert.equal((await outbound.fetch("https://fixture/fixture/config", { method: "POST", body: JSON.stringify(config) })).status, 200); },
  };
}
const redirects = [301, 302, 303, 307, 308].flatMap(status => [false, true].map(crossOrigin => ({ status, crossOrigin })));
redirects.push(...[300, 304, 399].map(status => ({ status, noLocation: true })));
for (const pooled of [false, true]) test(`workerd public controls refuse every redirect with ${pooled ? "grant-owner" : "environment"} credentials`, { timeout: 60000 }, async t => {
  const f = await fixture(t, pooled);
  const create = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true, stream: true });
  assert.equal(create.status, 200); assert.equal((await create.json()).status, "queued");
  const before = await f.inspect(), job = before.jobs[0];
  assert.equal(job.owner.grantKey, pooled ? "oauth/fixture/openai" : null);
  assert.equal(job.event, null); assert.equal(before.jobs.length, 1);
  const holds = await Promise.all(job.legs.map(leg => f.rows(leg.intent.objectName)));
  const usage = await f.usage(); assert.deepEqual(usage.events, []);
  const controls = [
    ["/v1/responses/response-fixture", "GET"],
    ["/v1/native/openai/v1/responses/response-fixture?stream=true&starting_after=0", "GET"],
    ["/v1/proxy/openai/responses_retrieve?response_id=response-fixture&include[]=one&include[]=two", "GET"],
    ["/v1/responses/response-fixture/cancel", "POST"],
    ["/v1/native/openai/v1/responses/response-fixture/cancel", "POST"],
    ["/v1/proxy/openai/responses_cancel", "POST", { pathParams: { response_id: "response-fixture" }, body: {} }],
  ];
  for (const config of redirects) await t.test(JSON.stringify(config), async () => {
    for (const [path, method, body] of controls) {
      await f.configure(config);
      const response = await f.call(path, body, method);
      assert.equal(response.status, 502, path + ": " + await response.clone().text()); assert.equal(response.headers.get("location"), null); assert.equal(response.headers.get("retry-after"), null);
      assert.deepEqual(await response.json(), { error: { code: "provider_unavailable", message: "upstream request to provider openai failed", type: "server_error", param: null } });
      const calls = await f.calls(); assert.equal(calls.length, 1, "redirect target receives zero traffic or secrets");
      assert.equal(new URL(calls[0].url).hostname, "api.openai.com");
      assert.equal(calls[0].headers.authorization, "Bearer " + (pooled ? "fixture-grant-key" : "fixture-upstream-key"));
      assert.equal(calls[0].method, method); assert.equal(calls[0].body, "");
    }
    assert.deepEqual(await f.inspect(), before, "redirect cannot observe terminal usage, alter owner binding or create accounting");
    assert.deepEqual(await Promise.all(job.legs.map(leg => f.rows(leg.intent.objectName))), holds);
    assert.deepEqual((await f.usage()).events, []);
  });
  // Rejections never steal ownership or end observation. A normal response can
  // still freeze and settle exactly the original generation's receipt.
  await f.configure({ complete: true });
  for (const [path, method, body] of controls) {
    const response = await f.call(path, body, method); assert.equal(response.status, 200, path + ": " + await response.clone().text()); assert.equal((await response.json()).id, "response-fixture");
  }
  assert.equal((await f.call("/fixture/flush", {})).status, 200);
  const final = await f.inspect(); assert.equal(final.jobs.length, 1); assert.equal(final.jobs[0].eventId, job.eventId);
  assert.equal(final.jobs[0].phase, "complete"); assert.equal(final.jobs[0].amount, 100);
  for (const [index, leg] of job.legs.entries()) {
    const rows = await f.rows(leg.intent.objectName); assert.equal(rows.length, 1); assert.equal(rows[0].reservation_id, holds[index][0].reservation_id);
    assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 100);
  }
  const events = (await f.usage()).events; assert.equal(events.length, 1); assert.equal(events[0].id, job.eventId); assert.equal(events[0].actual_cost_micros, 100);
  const calls = await f.calls(); assert.equal(calls.length, controls.length); assert.ok(calls.every(call => new URL(call.url).pathname !== "/v1/responses"));
});
