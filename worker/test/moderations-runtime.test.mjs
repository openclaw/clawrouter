import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
  import worker from "./worker/index.ts";
  export * from "./worker/index.ts";
  import { BudgetLedgerObject as Budget, usageStub, ingestUsage } from "./worker/ledgers.ts";
  import { sha256Hex } from "./worker/utils.ts";
  import { putGrantCredentials } from "./worker/grant-credentials.ts";
  export class BudgetLedgerObject extends Budget {
    constructor(state) { super(state); this.sql = state.storage.sql; }
    async fetch(request) { return new URL(request.url).pathname === "/rows" ? Response.json([...this.sql.exec("SELECT * FROM budget_reservations")]) : super.fetch(request); }
  }
  export default { ...worker, async fetch(request, env, context) {
    const url = new URL(request.url), authority = env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));
    if (url.pathname === "/fixture/setup") {
      for (const [path, body] of [
        ["/policies/initialize-all", [{ policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 1000, requestCostMicros: 99, retainRequestContent: false } }]],
        ["/credentials/initialize-all", [{ credentialId: "fixture", credential: { enabled: true, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" } }]],
        ["/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 1000 }]]
      ]) { const response = await authority.fetch("https://owner" + path, { method: "POST", body: JSON.stringify(body) }); if (!response.ok) return response; }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/grant") return Response.json(await putGrantCredentials(env, "oauth/fixture/moderation", { provider: "openai", enabled: true, ...await request.json() }, true));
    if (url.pathname === "/fixture/revoke") return authority.fetch("https://owner/credentials/mutate", { method: "POST", body: JSON.stringify({ scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "update", credentialId: "fixture", credential: { enabled: false, secretSha256: await sha256Hex("fixture-key"), policyId: "fixture", policyGeneration: "g1" } }) });
    if (url.pathname === "/fixture/trace") return fetch("https://fixture.example/trace");
    if (url.pathname === "/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(url.searchParams.get("name"))).fetch("https://budget/rows");
    if (url.pathname === "/fixture/usage") return usageStub(env, "tenant", "fixture").fetch("https://usage/snapshot?events=admin");
    return worker.fetch(request, { ...env, USAGE_QUEUE: { send: event => ingestUsage(env, event) } }, context);
  } };
`;
const upstream = `
  export class Upstream {
    constructor(state) { this.storage = state.storage; }
    async fetch(request) {
    const calls = await this.storage.get("calls") ?? [];
    if (request.url === "https://fixture.example/trace") return Response.json(calls);
    const credential = request.headers.get("authorization");
    calls.push({ method: request.method, path: new URL(request.url).pathname, credentialKind: credential === "Bearer synthetic-stored-api-key" ? "stored_api_key" : credential === "Bearer fixture-upstream-key" ? "environment_api_key" : "unrecognized" });
    await this.storage.put("calls", calls);
    if (request.url !== "https://api.openai.com/v1/moderations" || request.method !== "POST") throw Error("unexpected moderation URL/method");
    if (!["Bearer fixture-upstream-key", "Bearer synthetic-stored-api-key"].includes(credential)) throw Error("wrong selected credential");
    const body = await request.json();
    if (body.model !== "omni-moderation-latest" || Object.keys(body).sort().join(",") !== "input,model") throw Error("wrong native body");
    if (body.input === "reject") return Response.json({ error: { code: "synthetic_rate_limit" } }, { status: 429, headers: { "retry-after": "10" } });
    if (!Array.isArray(body.input) || body.input[0].text !== "synthetic runtime fixture" || body.input[1].image_url.url !== "data:image/png;base64,Zml4dHVyZQ==") throw Error("changed moderation input");
    return Response.json({ id: "modr_runtime", model: "omni-moderation-latest", results: [{ flagged: false }], synthetic_wire: body });
  } }
  export default { fetch(request, env) { return env.UPSTREAM.get(env.UPSTREAM.idFromName("one")).fetch(request); } };
`;
test("workerd moderation executes all routes and settles actual durable ledgers at zero", { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-moderations-")); let worker;
  try {
    worker = await startWorkerdFixture(temporary, router, upstream, { upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } });
    assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup")).status, 200);
    const input = [{ type: "text", text: "synthetic runtime fixture" }, { type: "image_url", image_url: { url: "data:image/png;base64,Zml4dHVyZQ==" } }];
    const routes = ["/v1/moderations", "/v1/native/openai/v1/moderations", "/v1/proxy/openai/moderations"];
    const send = (path, input, authenticated = true) => worker.dispatchFetch("https://router.example" + path, { method: "POST", headers: { ...(authenticated ? { authorization: "Bearer clawrouter-live-fixture-fixture-key" } : {}), "content-type": "application/json" }, body: JSON.stringify(path.includes("/proxy/") ? { body: { input } } : { input }) });
    for (const path of routes) {
      const response = await send(path, input); assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { id: "modr_runtime", model: "omni-moderation-latest", results: [{ flagged: false }], synthetic_wire: { model: "omni-moderation-latest", input } });
    }
    const rejected = await send(routes[0], "reject"); assert.equal(rejected.status, 429); assert.equal(rejected.headers.get("retry-after"), "10");
    assert.deepEqual(await rejected.json(), { error: { code: "synthetic_rate_limit" } });
    const unauthorized = await send(routes[0], input, false); assert.equal(unauthorized.status, 401); await unauthorized.text();
    const snapshot = await (await worker.dispatchFetch("https://router.example/fixture/usage")).json();
    assert.equal(snapshot.summary.requestCount, 4); assert.equal(snapshot.summary.actualCostMicros, 0);
    for (const event of snapshot.events) { assert.equal(event.actual_cost_micros, 0); assert.equal(event.cost_basis, "none"); assert.equal(event.content_ref, null); }
    for (const name of ["tenant:fixture", "provider:openai"]) {
      const rows = await (await worker.dispatchFetch("https://router.example/fixture/rows?name=" + name)).json();
      assert.equal(rows.length, 4); for (const row of rows) { assert.equal(row.settled, 1); assert.equal(row.reserved_micros, 0); assert.equal(row.dispatch_started, 1); }
    }
  } finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

// Final-effect proof: the real authority and credential owners decide admission;
// the independent synthetic upstream records every actual outbound request.
test("workerd moderation authority trace excludes forbidden grants and revoked callers", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-moderation-authority-")); let worker;
  try {
    worker = await startWorkerdFixture(temporary, router, upstream, { upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } });
    assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup")).status, 200);
    const input = [{ type: "text", text: "synthetic runtime fixture" }, { type: "image_url", image_url: { url: "data:image/png;base64,Zml4dHVyZQ==" } }];
    const setGrant = async kind => {
      const response = await worker.dispatchFetch("https://router.example/fixture/grant", { method: "POST", body: JSON.stringify(kind === "api_key" ? { kind, credential: "synthetic-stored-api-key" } : { kind, accessToken: "synthetic-forbidden-token", accountId: "fixture-account" }) });
      assert.equal(response.status, 200, await response.clone().text()); await response.text();
    };
    const trace = async () => (await worker.dispatchFetch("https://router.example/fixture/trace")).json();
    const send = () => worker.dispatchFetch("https://router.example/v1/moderations", { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-key", "content-type": "application/json" }, body: JSON.stringify({ input }) });
    await setGrant("api_key");
    let response = await send(); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).id, "modr_runtime");
    const allowed = [{ method: "POST", path: "/v1/moderations", credentialKind: "stored_api_key" }];
    assert.deepEqual(await trace(), allowed);
    t.diagnostic(JSON.stringify({ scenario: "authorized_api_key", status: 200, upstreamRequests: 1, transport: allowed[0] }));
    for (const kind of ["subscription", "oauth"]) {
      await setGrant(kind); response = await send(); assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "upstream_grant_pool_unavailable"); assert.deepEqual(await trace(), allowed);
      t.diagnostic(JSON.stringify({ scenario: kind, status: 503, additionalUpstreamRequests: 0 }));
    }
    await setGrant("api_key");
    const revoked = await worker.dispatchFetch("https://router.example/fixture/revoke", { method: "POST" }); assert.equal(revoked.status, 200); assert.equal((await revoked.json()).outcome, "updated");
    response = await send(); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "proxy_key_revoked"); assert.deepEqual(await trace(), allowed);
    t.diagnostic(JSON.stringify({ scenario: "revoked_caller", status: 403, additionalUpstreamRequests: 0 }));
    const usage = await (await worker.dispatchFetch("https://router.example/fixture/usage")).json();
    assert.equal(usage.summary.actualCostMicros, 0); assert.equal(usage.events.filter(event => event.status === "success").length, 1);
  } finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
