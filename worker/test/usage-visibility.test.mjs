import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../../scripts/grant-pool-recovery.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { BudgetLedgerObject, UsageLedgerObject, ingestUsage, providerBudgetStatus } = await import("../ledgers.ts");
const { normalizeEmail, sha256Hex } = await import("../utils.ts");

for (const budgetScope of ["policy", "principal"]) {
  test(`${budgetScope} budgets keep shared totals but both personal HTTP routes return only owned events`, async (t) => {
    const f = await fixture(t, budgetScope);
    await f.ingest("alice-key", { principal_id: "alice@example.com", credential_id: "alice" });
    await f.ingest("alice-sibling", { principal_id: "alice@example.com", credential_id: "alice-other" });
    await f.ingest("alice-playground", { principal_id: "alice@example.com", credential_id: null, auth_type: "access" });
    const bob = await f.ingest("bob", { principal_id: "bob@example.com", credential_id: "bob", session_id: "bob-session", agent_id: "bob-agent", project_id: "bob-project", request_id: "bob-request", trace_id: "bob-trace", content_ref: "bob-content", content_retained: true });
    await f.ingest("legacy", { key_id: "alice" });
    const admin = await f.read("/v1/admin/usage", f.admin);
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.usage.events.find(event => event.id === "bob"), bob);
    for (const [path, headers] of [["/v1/usage", f.key("alice")], ["/v1/session/usage", await f.login("alice@example.com")]]) {
      const { status, body } = await f.read(`${path}?events=admin&event_owner=bob@example.com`, headers);
      assert.equal(status, 200);
      assert.deepEqual(ids(body.usage), ["alice-key", "alice-playground", "alice-sibling"]);
      assert.deepEqual(totals(body.usage), totals(admin.body.usage));
      assert.equal(JSON.stringify(body).includes("bob"), false);
      const budget = body.budget ?? body.policies[0].budget;
      assert.equal(budget.windowKey.includes("alice@example.com"), budgetScope === "principal");
    }
    assert.equal((await f.read("/v1/admin/usage", f.key("alice"))).status, 401);
    const cookie = await f.login("alice@example.com");
    assert.equal((await f.read("/v1/admin/usage", cookie)).status, 403);
    assert.equal((await f.read("/v1/admin/content?tenant=tenant&ref=bob-content", cookie)).status, 403);
  });
}

for (const [name, tenantField, tenant] of [["omitted", {}, "default"], ["null", { tenantId: null }, "default"], ["explicit", { tenantId: "policy-team" }, "policy-team"]]) {
  test(`${name} policy tenant keeps charged session usage visible across a user tenant change`, async (t) => {
    let dispatched = 0;
    const f = await fixture(t, "principal", (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-upstream-key");
      assert.equal(JSON.parse(init.body).model, "gpt-4.1-mini");
      dispatched++;
      return Promise.resolve(Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
    });
    await authorityCall(f.env, "/policies/put", { policyId: "shared", policy: { enabled: true, generation: "g1", providers: ["openai"], monthlyBudgetMicros: 100, requestCostMicros: 7, budgetScope: "principal", retainRequestContent: false, ...tenantField } });
    await authorityCall(f.env, "/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: 100 });
    f.env.OPENAI_API_KEY = "fixture-upstream-key";
    await f.activateAccounts();
    const emitted = [];
    f.env.USAGE_QUEUE = { async send(event) { emitted.push(event); } };
    const cookies = [];
    for (const who of ["alice", "bob"]) {
      await f.setUser(`${who}@example.com`, { tenantId: "organization" });
      const cookie = await f.login(`${who}@example.com`);
      cookies.push(cookie);
      const pending = [];
      const response = await worker.fetch(new Request("https://router.example/v1/playground/v1/chat/completions", {
        method: "POST", headers: { ...cookie, origin: "https://router.example", "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-4.1-mini", messages: [{ role: "user", content: "hello" }], max_tokens: 16 }),
      }), f.env, { waitUntil(promise) { pending.push(promise); } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, "ok");
      await Promise.all(pending);
    }
    assert.equal(dispatched, 2);
    assert.equal(emitted.length, 2);
    assert.equal(new Set(emitted.map(event => event.id)).size, 2);
    for (const [index, event] of emitted.entries()) {
      assert.equal(event.tenant_id, tenant);
      assert.equal(event.policy_id, "shared");
      assert.equal(event.principal_id, `${index === 0 ? "alice" : "bob"}@example.com`);
      assert.equal(event.credential_id, null);
      assert.equal(event.auth_type, "access");
      assert.equal(event.status, "success");
      assert.equal(event.cost_basis, "policy_fixed");
      assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.reserved_cost_micros, 7);
    }
    let acknowledged = 0;
    await worker.queue({ messages: emitted.map(body => ({ body, ack() { acknowledged++; }, retry() { assert.fail("emitted usage must persist"); } })) }, f.env);
    assert.equal(acknowledged, 2);
    for (const [index, cookie] of cookies.entries()) {
      const { status, body } = await f.read("/v1/session/usage", cookie);
      assert.equal(status, 200);
      assert.equal(body.session.tenantId, "organization");
      assert.equal(body.policies[0].tenantId, tenant);
      assert.equal(body.policies[0].budget.spentMicros, 7);
      assert.equal(body.policies[0].budget.windowKey.startsWith(`${tenant}/shared/${emitted[index].principal_id}/`), true);
      assert.equal(body.usage.summary.requestCount, 2);
      assert.equal(body.usage.summary.actualCostMicros, 14);
      assert.deepEqual(body.usage.events, [emitted[index]]);
    }
    const providerBudget = await providerBudgetStatus(f.env, "openai", 100);
    assert.equal(providerBudget.spentMicros, 14);
    assert.equal(providerBudget.remainingMicros, 86);
    const before = (await f.read("/v1/session/usage", cookies[0])).body;
    assert.deepEqual((await f.read("/v1/usage", f.key("alice"))).body.usage, before.usage);
    await f.setUser("alice@example.com", { tenantId: "moved-organization" });
    const after = await f.read("/v1/session/usage", cookies[0]);
    assert.equal(after.status, 200);
    assert.equal(after.body.session.tenantId, "moved-organization");
    assert.deepEqual(after.body.policies, before.policies);
    assert.deepEqual(after.body.usage, before.usage);
    assert.equal(dispatched, 2);
  });
}

test("service keys see only exact credential events with no attributed principal", async (t) => {
  const f = await fixture(t);
  await f.setCredential("service", null);
  await f.setCredential("other_service", null);
  await f.ingest("service-null", { principal_id: null, credential_id: "service" });
  await f.ingest("service-missing", { credential_id: "service" });
  await f.ingest("other-service", { principal_id: null, credential_id: "other_service" });
  await f.ingest("former-owner", { principal_id: "bob@example.com", credential_id: "service" });
  await f.ingest("invalid-owner", { principal_id: "", credential_id: "service" });
  await f.ingest("legacy-key-only", { key_id: "service" });
  const service = await f.read("/v1/usage", f.key("service"));
  assert.equal(service.status, 200);
  assert.deepEqual(ids(service.body.usage), ["service-missing", "service-null"]);
  assert.deepEqual(ids((await f.read("/v1/usage", f.key("other_service"))).body.usage), ["other-service"]);
  assert.deepEqual(totals(service.body.usage), totals((await f.read("/v1/admin/usage", f.admin)).body.usage));
});

test("Unicode and legacy ID normalization survives credential reassignment without transferring history", async (t) => {
  const f = await fixture(t), legacyId = "\u2003İDA@ExAmPlE.COM\u00a0", principal = normalizeEmail(legacyId);
  assert.equal(principal, "i\u0307da@example.com");
  await f.setUser(principal);
  await f.setCredential("alice", legacyId);
  await f.bind(principal, ["shared"]);
  await f.ingest("legacy-case", { principal_id: legacyId, credential_id: "alice" });
  await f.ingest("canonical", { principal_id: principal, credential_id: "sibling" });
  await f.ingest("different-id", { principal_id: "ida@example.com", credential_id: "alice" });
  await f.ingest("bob-history", { principal_id: "bob@example.com", credential_id: "alice" });
  await f.ingest("unattributed", { principal_id: null, credential_id: "alice" });
  await f.ingest("invalid", { principal_id: "invalid", credential_id: "alice" });
  for (const headers of [f.key("alice"), await f.login(principal)]) {
    const path = headers.cookie ? "/v1/session/usage" : "/v1/usage";
    assert.deepEqual(ids((await f.read(path, headers)).body.usage), ["canonical", "legacy-case"]);
  }
  await f.setCredential("alice", "bob@example.com");
  assert.deepEqual(ids((await f.read("/v1/usage", f.key("alice"))).body.usage), ["bob-history"]);
  await f.setCredential("alice", null);
  assert.deepEqual(ids((await f.read("/v1/usage", f.key("alice"))).body.usage), ["unattributed"]);
  for (const invalid of ["invalid", "", " \t "]) {
    await f.setCredential("alice", invalid);
    const response = await f.read("/v1/usage", f.key("alice"));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body.usage), []);
    assert.equal(response.body.usage.summary.requestCount, 6);
  }
  assert.equal((await f.read("/v1/admin/usage", f.admin)).body.usage.events.length, 6);
});

test("SQL visibility precedes the recent-event limit and preserves cross-shard totals and ordering", async (t) => {
  const f = await fixture(t), now = Date.now();
  await f.setPolicy("second", "second-tenant");
  await f.setPolicy("foreign", "foreign-tenant");
  await f.bind("alice@example.com", ["shared", "second"]);
  await f.ingest("alice-old", { principal_id: "alice@example.com", occurred_at_ms: now - 20_000 });
  await f.ingest("alice-new", { principal_id: "alice@example.com", occurred_at_ms: now - 10_000, policy_id: "second", tenant_id: "second-tenant" });
  await f.ingest("foreign", { principal_id: "alice@example.com", policy_id: "foreign", tenant_id: "foreign-tenant" });
  for (let index = 0; index < 105; index++) await f.ingest(`bob-${index}`, { principal_id: "bob@example.com", occurred_at_ms: now - index });
  assert.deepEqual(ids((await f.read("/v1/usage", f.key("alice"))).body.usage), ["alice-old"]);
  const body = (await f.read("/v1/session/usage", await f.login("alice@example.com"))).body;
  assert.deepEqual(body.usage.events.map(event => event.id), ["alice-new", "alice-old"]);
  assert.equal(body.usage.summary.requestCount, 107);
  assert.equal(body.usage.providers[0].requestCount, 107);
  assert.equal(body.usage.daily.reduce((count, day) => count + day.requestCount, 0), 107);
  assert.equal((await f.read("/v1/admin/usage", f.admin)).body.usage.summary.requestCount, 108);
});

test("current authorization gates personal reads and admin sessions still use personal event scope", async (t) => {
  const f = await fixture(t);
  await f.ingest("alice", { principal_id: "alice@example.com" });
  await f.ingest("bob", { principal_id: "bob@example.com" });
  await f.setUser("alice@example.com", { role: "admin" });
  const cookie = await f.login("alice@example.com");
  assert.deepEqual(ids((await f.read("/v1/session/usage", cookie)).body.usage), ["alice"]);
  assert.deepEqual(ids((await f.read("/v1/admin/usage", cookie)).body.usage), ["alice", "bob"]);
  await f.bind("alice@example.com", []);
  const noBindings = await f.read("/v1/session/usage", cookie);
  assert.deepEqual(ids(noBindings.body.usage), []);
  assert.equal(noBindings.body.usage.summary.requestCount, 0);
  assert.deepEqual(ids((await f.read("/v1/usage", f.key("alice"))).body.usage), ["alice"]);
  await f.setCredential("alice", "alice@example.com", false);
  assert.equal((await f.read("/v1/usage", f.key("alice"))).body.error.code, "proxy_key_revoked");
  await f.setUser("alice@example.com", { enabled: false });
  assert.equal((await f.read("/v1/session/usage", cookie)).status, 401);
});

test("the usage owner requires explicit event scope and does not change historical rows", async (t) => {
  const f = await fixture(t);
  const original = await f.ingest("legacy", { principal_id: " Alice@Example.com ", credential_id: "alice" });
  const stub = f.env.USAGE_LEDGER.get("policy:tenant:shared");
  for (const suffix of ["", "&events=principal", "&events=unknown", "&events=credential&event_owner="]) {
    assert.equal((await stub.fetch(`https://ledger/snapshot?policy_id=shared${suffix}`)).status, 400);
  }
  assert.deepEqual((await f.read("/v1/usage", f.key("alice"))).body.usage.events, [original]);
  assert.deepEqual((await f.read("/v1/admin/usage", f.admin)).body.usage.events, [original]);
});

function ids(snapshot) { return snapshot.events.map(event => event.id).sort(); }
function totals({ summary, providers, daily }) { return { summary, providers, daily }; }

async function fixture(t, budgetScope = "policy", upstream = () => assert.fail("usage reads must not contact an upstream")) {
  t.mock.method(globalThis, "fetch", upstream);
  function namespace(ObjectClass) {
    const objects = new Map();
    return { idFromName: name => name, get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:"); t.after(() => db.close());
        const sql = { exec(query, ...bindings) { const s = db.prepare(query); if (s.columns().length) return s.all(...bindings); s.run(...bindings); return []; } };
        const owner = new ObjectClass({ storage: { sql, getAlarm: async () => 1 } });
        objects.set(name, { fetch: (url, init) => owner.fetch(new Request(url, init)) });
      }
      return objects.get(name);
    } };
  }
  const kv = new Map(), adminToken = "fixture-admin-token", authority = createGrantAuthority();
  const env = {
    CLAWROUTER_LOCAL_AUTH: "enabled", CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(adminToken),
    ACCESS_CONTROL: { idFromName: name => name, get: () => authority }, USAGE_LEDGER: namespace(UsageLedgerObject), BUDGET_LEDGER: namespace(BudgetLedgerObject),
    POLICY_KV: { async get(key) { const read = key => kv.has(key) ? JSON.parse(kv.get(key)) : null; return Array.isArray(key) ? new Map(key.map(item => [item, read(item)])) : read(key); }, async put(key, value) { kv.set(key, value); }, async list() { return { keys: [], list_complete: true }; } },
    CONTENT_ARCHIVE: { get() { assert.fail("personal usage must not expose archived content"); } },
  };
  const setPolicy = (policyId, tenantId = "tenant") => authorityCall(env, "/policies/put", { policyId, policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId, monthlyBudgetMicros: 1000000, budgetScope } });
  const setUser = (email, record = {}) => authorityCall(env, "/users/put", { email, record: { role: "user", enabled: true, tenantId: "tenant", groups: [], ...record } });
  const setCredential = async (credentialId, principalId, enabled = true) => authorityCall(env, "/credentials/mutate", { credentialId, operation: "put", scope: "admin", actor: { auth: "admin_token", role: "admin", email: "token-admin" }, credential: { enabled, policyId: "shared", principalId, secretSha256: await sha256Hex(`fixture-secret-${credentialId}`) } });
  async function bind(email, policyIds) {
    const user = (await authorityCall(env, "/users/resolve", { emails: [email] })).users[0];
    await authorityCall(env, "/users/put-bindings", { user, policyIds, seed: { principal: { principalType: "user", principalId: email }, bindings: [] } });
  }
  async function ingest(id, fields = {}) {
    const event = { id, type: "clawrouter.usage.v1", occurred_at_ms: Date.now(), tenant_id: "tenant", policy_id: "shared", provider: "openai", status: "success", status_code: 200, input_tokens: 2, output_tokens: 1, total_tokens: 3, actual_cost_micros: 7, reserved_cost_micros: 7, ...fields };
    await ingestUsage(env, event);
    return event;
  }
  async function read(path, headers) {
    const response = await worker.fetch(new Request(`https://router.example${path}`, { headers }), env, {});
    return { status: response.status, body: await response.json() };
  }
  async function activateAccounts() {
    const request = async (path, { method = "GET", body } = {}) => {
      const response = await worker.fetch(new Request(`https://router.example${path}`, {
        method, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env, {});
      assert.equal(response.status, 200);
      return response.json();
    };
    // Only dispatch fixtures activate their new storage; usage reads remain
    // available without accepting an account inventory baseline.
    await acceptGrantPoolBaseline("fresh", { request });
    assert.ok((await recoverGrantPools({ request, maxPages: 4 })).activatedAt);
  }
  async function login(email) {
    env.CLAWROUTER_LOCAL_ADMIN_EMAIL = email;
    const response = await worker.fetch(new Request("https://router.example/v1/session/login", { method: "POST", headers: { origin: "https://router.example", "content-type": "application/json" }, body: JSON.stringify({ token: adminToken }) }), env, {});
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0] };
  }
  await setPolicy("shared");
  for (const who of ["alice", "bob"]) { await setUser(`${who}@example.com`); await setCredential(who, `${who}@example.com`); await bind(`${who}@example.com`, ["shared"]); }
  return { env, setPolicy, setUser, setCredential, bind, ingest, read, login, activateAccounts, admin: { authorization: `Bearer ${adminToken}` }, key: id => ({ authorization: `Bearer clawrouter-live-${id}-fixture-secret-${id}` }) };
}
