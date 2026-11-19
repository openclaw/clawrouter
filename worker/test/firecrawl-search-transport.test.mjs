import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/firecrawl/search.json", import.meta.url), "utf8"));

async function fixture(t, body = wire.response, status = 200) {
  // Test the proposed endpoint through the real Worker. Activation belongs to the
  // existing Firecrawl manifest owner; this is not a bundled-catalog assertion.
  const original = snapshot.providers;
  const provider = structuredClone(original.find(row => row.id === "firecrawl"));
  provider.endpoints.push({ ...provider.endpoints[0], id: "search", path: wire.transport.path,
    request_format: wire.transport.requestFormat, response_format: wire.transport.responseFormat });
  provider.capabilities.push({ id: wire.transport.capability, endpoint: "search", methods: ["POST"] });
  snapshot.providers = original.map(row => row.id === provider.id ? provider : row);
  t.after(() => { snapshot.providers = original; });
  const base = { enabled: true, generation: "v1", providers: ["firecrawl"], models: null, tenantId: "fixture",
    monthlyBudgetMicros: 1000000, requestCostMicros: null, retainRequestContent: false };
  const policies = { fixed: { ...base, requestCostMicros: wire.billing.policyFixedMicros },
    reserve: base, denied: { ...base, providers: ["openai"] } };
  const records = new Map(), events = [], pending = [], sent = [];
  const env = { FIRECRAWL_API_KEY: "synthetic-firecrawl-key", POLICY_KV: {
    async get(key, type) {
      const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null;
      return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value);
    },
    async put(key, value) { records.set(key, JSON.parse(value)); },
    async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => { events.push(event); } }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", Object.entries(policies).map(([policyId, policy]) => ({ policyId, policy })));
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(Object.keys(policies).map(async credentialId => ({
    credentialId, credential: { enabled: true, secretSha256: await sha256Hex("synthetic-" + credentialId), policyId: credentialId, policyGeneration: "v1" },
  }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "firecrawl", enabled: true }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json() });
    return Response.json(body, { status });
  });
  const request = (key = "fixed", native = true, authenticated = true) => worker.fetch(new Request(
    native ? "https://router.example/v1/native/firecrawl/v2/search" : "https://router.example/v1/proxy/firecrawl/search", {
      method: "POST", headers: { ...(authenticated ? { authorization: `Bearer clawrouter-live-${key}-synthetic-${key}` } : {}), "content-type": "application/json" },
      body: JSON.stringify(native ? wire.request : { body: wire.request }),
    }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, sent, events, pending };
}

test("Firecrawl candidate Search preserves v2 filters, scraped content and source groups", async t => {
  const f = await fixture(t);
  for (const native of [true, false]) {
    const response = await f.request("fixed", native);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), wire.response);
    assert.deepEqual(f.sent.at(-1).body, wire.request);
    assert.equal(f.sent.at(-1).url, wire.transport.origin + wire.transport.path);
    assert.equal(f.sent.at(-1).headers.get("authorization"), "Bearer synthetic-firecrawl-key");
  }
  await Promise.all(f.pending);
  assert.equal(f.events.length, 2);
  for (const event of f.events) {
    assert.equal(event.capability, "web.search");
    assert.equal(event.actual_cost_micros, wire.billing.policyFixedMicros);
    assert.equal(event.cost_basis, "policy_fixed");
    assert.equal(event.model, null);
    assert.equal(event.input_tokens, null);
    assert.equal(event.output_tokens, null);
  }
});

test("Firecrawl candidate Search preserves successful empty results", async t => {
  const f = await fixture(t, wire.emptyResponse);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), wire.emptyResponse);
  await Promise.all(f.pending);
  assert.equal(f.events[0].status, "success");
  assert.equal(f.events[0].actual_cost_micros, wire.billing.policyFixedMicros, "fixed policy charge is independent of reported provider credits");
});

test("Firecrawl candidate Search preserves native HTTP-200 and HTTP-429 failures", async t => {
  for (const status of [200, 429]) await t.test(String(status), async t => {
    const f = await fixture(t, wire.failure, status);
    const response = await f.request();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), wire.failure);
    await Promise.all(f.pending);
    // The shared accounting taxonomy records upstream HTTP 4xx as client_error.
    assert.equal(f.events[0].status, status === 429 ? "client_error" : "provider_error");
  });
});

test("Firecrawl candidate Search denies unpriced hard-budget, forbidden and unauthenticated requests before egress", async t => {
  const f = await fixture(t);
  for (const key of ["reserve", "denied"]) {
    const response = await f.request(key);
    assert.ok(response.status >= 400);
    assert.equal((await response.json()).error.code, key === "reserve" ? "pricing_required" : "provider_not_allowed");
  }
  assert.equal((await f.request("fixed", true, false)).status, 401);
  assert.equal(f.sent.length, 0);
});
