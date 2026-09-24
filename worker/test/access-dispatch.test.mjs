import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const origin = "https://router.example", email = "access@example.com";
const model = "openai/gpt-6-astra", tariff = 7;

test("existing and fresh local-backed Access sessions align omitted-tenant offers, accounts, and SQL charges", async (t) => {
  const fixture = await accessFixture(t);
  // This exercises the shared AccessSession authority chain, not Cloudflare JWT verification.
  const existing = await fixture.login(email);
  await fixture.denied(existing, 403, "access_policy_required");
  await fixture.bind(true);
  await fixture.executeOffer(existing);
  const fresh = await fixture.login(email);
  assert.notEqual(fresh, existing);
  await fixture.executeOffer(fresh);
  await fixture.assertCharges(2);

  const neighbor = await fixture.login("neighbor@example.com");
  await fixture.denied(neighbor, 403, "access_policy_required");
  await fixture.bind(false);
  for (const cookie of [existing, fresh]) await fixture.denied(cookie, 403, "access_policy_required");
  await fixture.bind(true);
  await authorityCall(fixture.env, "/users/put", { email, record: { ...fixture.user, enabled: false } });
  for (const cookie of [existing, fresh]) await fixture.denied(cookie, 401, "access_session_required");
  await authorityCall(fixture.env, "/users/put", { email, record: fixture.user });
  for (const { policyId } of fixture.policies) {
    const response = await fixture.request(`/v1/admin/policies/${policyId}/revoke`, undefined, {}, true);
    assert.equal(response.status, 200, await response.clone().text());
  }
  for (const cookie of [existing, fresh]) await fixture.denied(cookie, 403, "access_policy_required");
  await fixture.assertCharges(2);
});

async function accessFixture(t) {
  const authority = createGrantAuthority(), ledger = sqlBudgetNamespace(t);
  const values = new Map(), ledgerNames = new Set(), ledgerCalls = [], events = [], sent = [], pending = [];
  const token = "fixture-access-login-token";
  const user = { enabled: true, role: "user", tenantId: "organization", groups: [], contentRetentionDisabled: true };
  const policies = ["subscription_policy", "api_policy"].map((policyId) => ({ policyId, policy: {
    enabled: true, generation: `${policyId}_v1`, providers: ["openai"], budgetScope: "principal",
    monthlyBudgetMicros: 100, requestCostMicros: tariff, retainRequestContent: false,
    ...(policyId === "subscription_policy" ? { grantRouting: { eligibleGrants: { openai: ["subscription"] } } } : {}),
  } }));
  assert.ok(policies.every(({ policy }) => !Object.hasOwn(policy, "tenantId")));
  const env = attachGrantCredentialNamespace({
    CLAWROUTER_LOCAL_AUTH: "enabled", CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex(token),
    POLICY_KV: {
      async get(key, type) {
        const read = (name) => values.has(name) ? type === "json" ? JSON.parse(values.get(name)) : values.get(name) : null;
        return Array.isArray(key) ? new Map(key.map((name) => [name, read(name)])) : read(key);
      },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async list({ prefix }) { return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: authority.fetch }) },
    BUDGET_LEDGER: { ...ledger, get(name) {
      ledgerNames.add(name);
      return { fetch(url, init) {
        ledgerCalls.push({ name, path: new URL(url).pathname });
        return ledger.get(name).fetch(url, init);
      } };
    } },
    USAGE_QUEUE: { send: async (event) => { events.push(event); } },
  }, { useExistingAuthority: true });
  await authorityCall(env, "/users/initialize-all", [email, "neighbor@example.com"].map((email) => ({ email, record: user })));
  await authorityCall(env, "/policies/initialize-all", policies);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 100 }]);
  await authorityCall(env, "/initialize-all", []);
  await putGrantCredentials(env, "oauth/subscription_policy/subscription", { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription-token", accountId: "fixture-subscription-account" });
  await putGrantCredentials(env, "oauth/tenants/default/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-default-api" });
  // Inheriting the session tenant would make the first policy appear Chat-capable.
  // Dispatch has always used default, where that policy has only a subscription.
  await putGrantCredentials(env, "oauth/tenants/organization/subscription", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-organization-decoy" });

  const policyLedger = `default:api_policy:${email}`, providerLedger = "provider:openai";
  const reservations = () => [...ledgerNames].flatMap((name) => ledger.get(name).reservations().map((row) => ({ name, ...row })));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    assert.equal(init.headers.get("authorization"), "Bearer fixture-default-api");
    assert.equal(JSON.parse(init.body).model, "gpt-6-astra");
    for (const name of [policyLedger, providerLedger]) {
      const active = ledger.get(name).reservations().filter(({ settled }) => settled === 0);
      assert.equal(active.length, 1, "each ledger must own one dispatched reservation before provider I/O");
      assert.equal(active[0].dispatch_started, 1);
      assert.equal(active[0].reserved_micros, tariff);
    }
    sent.push({ url: String(url), authorization: init.headers.get("authorization") });
    return Response.json({ choices: [{ message: { role: "assistant", content: "fixture answer" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  });

  async function request(path, cookie, body, admin = false) {
    return worker.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(admin ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { waitUntil: (promise) => pending.push(promise) });
  }
  async function login(principal) {
    env.CLAWROUTER_LOCAL_ADMIN_EMAIL = principal;
    const response = await request("/v1/session/login", undefined, { token });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.session.auth, "local");
    assert.equal(body.session.role, "user");
    assert.equal(body.session.tenantId, "organization");
    return response.headers.get("set-cookie").split(";")[0];
  }
  async function bind(enabled) {
    const principal = { principalType: "user", principalId: email };
    for (const [priority, { policyId }] of policies.entries()) await authorityCall(env, "/mutate", {
      seed: { principal, bindings: [] }, binding: { ...principal, policyId, enabled, priority },
    });
  }
  async function executeOffer(cookie) {
    const response = await request("/v1/catalog", cookie);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.scope, { authType: "access", credentialId: null, principalId: email });
    const offers = catalog.providers.find(({ id }) => id === "openai").offers;
    const offer = offers.find((item) => item.modelId === model && item.endpoint === "chat_completions" && item.routeKind === "unified" && item.transport === "http");
    assert.ok(offer?.eligible);
    assert.equal(offer.affordability, "exact-covered");
    assert.equal(offer.policyId, "api_policy");
    assert.equal(offer.policyGeneration, "api_policy_v1");
    assert.equal(offer.route, "/v1/playground/v1/chat/completions");
    assert.equal(offers.find((item) => item.modelId === model && item.endpoint === "responses" && item.routeKind === "unified" && item.transport === "http").policyId, "subscription_policy");
    const result = await request(offer.route, cookie, { model, messages: [{ role: "user", content: "fixture" }] });
    assert.equal(result.status, 200, await result.clone().text());
    await result.text();
    while (pending.length) await Promise.all(pending.splice(0));
    assert.equal(events.length, sent.length);
    const event = events.at(-1);
    assert.deepEqual([event.auth_type, event.credential_id, event.principal_id, event.policy_id, event.tenant_id], ["access", null, email, offer.policyId, "default"]);
    assert.equal(event.reserved_cost_micros, tariff);
    assert.equal(event.actual_cost_micros, tariff);
    assert.equal(event.cost_basis, "policy_fixed");
  }
  async function denied(cookie, status, code) {
    const before = { sent: sent.length, events: events.length, reservations: reservations(), reserves: ledgerCalls.filter(({ path }) => path === "/reserve").length };
    const response = await request("/v1/playground/v1/chat/completions", cookie, { model, messages: [{ role: "user", content: "fixture" }] });
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).error.code, code);
    while (pending.length) await Promise.all(pending.splice(0));
    const catalog = await request("/v1/catalog", cookie);
    if (status === 401) assert.equal(catalog.status, 401);
    else { assert.equal(catalog.status, 200); assert.deepEqual((await catalog.json()).providers, []); }
    assert.deepEqual({ sent: sent.length, events: events.length, reservations: reservations(), reserves: ledgerCalls.filter(({ path }) => path === "/reserve").length }, before);
  }
  async function assertCharges(count) {
    assert.equal(sent.length, count);
    assert.equal(reservations().length, count * 2, "no first-policy, organization, or neighboring-principal charge");
    for (const [name, policyId, scope] of [
      [policyLedger, `default/api_policy/${email}`, ["principal", "default", "api_policy", email]],
      [providerLedger, "provider/openai", ["provider", "openai"]],
    ]) {
      const rows = ledger.get(name).reservations();
      assert.equal(rows.length, count);
      for (const row of rows) {
        assert.equal(row.policy_id, policyId);
        assert.equal(row.window_key, `${policyId}/${new Date().toISOString().slice(0, 7)}`);
        assert.equal(row.budget_scope_key, JSON.stringify(scope));
        assert.equal(row.dispatch_started, 1); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, tariff);
      }
      const query = new URLSearchParams({ policy_id: policyId, window_key: rows[0].window_key, scope_key: JSON.stringify(scope), limit_micros: "100" });
      const status = await (await ledger.get(name).fetch(`https://clawrouter.internal/status?${query}`)).json();
      assert.equal(status.spentMicros, count * tariff);
      assert.equal(status.remainingMicros, 100 - count * tariff);
    }
  }
  return { env, user, policies, request, login, bind, executeOffer, denied, assertCharges };
}
