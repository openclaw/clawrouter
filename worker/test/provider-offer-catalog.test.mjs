import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
const { catalogResponse, modelsResponse } = await import("../discovery.ts");
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");

async function fixture(t) {
  const originals = [...snapshot.providers];
  const provider = structuredClone(originals.find(provider => provider.id === "openai"));
  const model = provider.models.find(model => model.id === "openai/gpt-6-astra");
  assert.ok(model);
  provider.models = [model];
  const capability = "llm.responses", endpoint = "responses";
  provider.products = [
    { id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key",
      binding: { type: "provider-default" }, endpoints: [endpoint], offers: [{ endpoint, capability, models: [model.id] }] },
    { id: "membership", displayName: "Membership", commercialModel: "subscription", authenticationMethod: "oauth2",
      binding: { type: "grant-transport", grantKind: "subscription" }, endpoints: [endpoint], offers: [{ endpoint, capability, models: [model.id] }] },
  ];
  provider.offer_definitions = provider.products.map(product => ({ id: `offer:${product.id}`, providerId: provider.id,
    productId: product.id, endpoint, capability, model: { id: model.id, upstream: model.upstream }, qualification: "declared" }));
  snapshot.providers.splice(0, snapshot.providers.length, provider);
  t.after(() => snapshot.providers.splice(0, snapshot.providers.length, ...originals));
  const secret = "fixture-secret", session = "c".repeat(64);
  const policy = { enabled: true, generation: "g1", providers: [provider.id], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = [{ policyId: "fixture", policy }], states = {}, paths = [];
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const connection = { providerId: provider.id, enabled: true, monthlyBudgetMicros: null };
  const records = new Map([["config/fusion", { enabled: false }], [`local/sessions/${await sha256Hex(session)}`, { email: "fixture@example.com", role: "user", expiresAtMs: Date.now() + 60_000 }]]);
  const env = {
    OPENAI_API_KEY: "fixture-environment", CLAWROUTER_LOCAL_AUTH: "enabled",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(item => [item, records.get(item) ?? null])) : records.get(key) ?? null; },
    },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body); paths.push(path);
      const keys = policyId => [...records.keys()].filter(key => key.startsWith(`oauth/${policyId}/`));
      if (path === "/admission/resolve") return Response.json({ credential: { credentialId: "fixture", credential }, policy: policies[0], owner: null,
        connections: [connection], pools: { openai: { keys: keys("fixture"), states } } });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: policies.filter(entry => body.policyIds.includes(entry.policyId)), missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [{ email: "fixture@example.com", record: { enabled: true, role: "user", tenantId: "default", groups: [] } }], missingEmails: [] });
      if (path === "/resolve") return Response.json({ initialized: true, bindings: policies.map(({ policyId }, priority) => ({ policyId, priority, enabled: true, principalType: "user", principalId: "fixture@example.com" })), missingPrincipals: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: keys(body.policyId), states });
      throw new Error(`unexpected authority operation: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("no upstream I/O during discovery"); });
  const request = (sessionAuth = false) => new Request("https://router.example/v1/catalog", { headers: sessionAuth
    ? { cookie: `clawrouter_session=${session}` } : { authorization: `Bearer clawrouter-live-fixture-${secret}` } });
  const catalog = async (sessionAuth = false) => {
    const response = await catalogResponse(request(sessionAuth), env);
    assert.equal(response.status, 200);
    return (await response.json()).providers.find(row => row.id === provider.id);
  };
  const grant = (kind, extra = {}) => ({ provider: provider.id, kind, enabled: true, ...(kind === "subscription"
    ? { accessToken: "fixture-subscription", accountId: "fixture-account" } : { credential: "fixture-api" }), ...extra });
  return { provider, model, env, policy, policies, connection, records, states, paths, request, catalog, grant };
}

function references(view, transport = "http") {
  return view.offers.filter(offer => offer.endpoint === "responses" && offer.modelId && offer.transport === transport)
    .flatMap(offer => offer.productOffers ?? []);
}

test("catalog adds closed product metadata without changing legacy eligibility or model lists", async t => {
  const f = await fixture(t), declared = await f.catalog();
  assert.deepEqual(declared.products, [{ id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key" }]);
  assert.ok(references(declared).length > 0);
  assert.ok(references(declared).every(ref => ref.id === "offer:api" && ref.productId === "api"));
  assert.ok(references(declared).every(ref => Object.keys(ref).sort().join(",") === "id,productId"));
  assert.ok(references(declared, "websocket").every(ref => ref.productId === "api"));
  assert.ok(declared.offers.filter(offer => offer.modelId === null).every(offer => !Object.hasOwn(offer, "productOffers")), "model selection forms are not declared model-free offers");
  const strip = value => { const result = structuredClone(value); delete result.products; for (const offer of result.offers) delete offer.productOffers; return result; };
  delete f.provider.products; delete f.provider.offer_definitions;
  assert.deepEqual(await f.catalog(), strip(declared));
  const models = await (await modelsResponse(f.request(), f.env)).json();
  assert.deepEqual(models.data.map(row => row.id), declared.models.map(row => row.id));
  assert.ok(!f.paths.includes("/grant-pools/select"));
});

test("an explicit model-free declaration differs from a model selection form", async t => {
  const f = await fixture(t), endpoint = "models_list", capability = "models.list";
  f.provider.products[0].endpoints.push(endpoint);
  f.provider.products[0].offers.push({ endpoint, capability, models: null });
  f.provider.offer_definitions.push({ id: "offer:models", providerId: "openai", productId: "api", endpoint, capability, model: null, qualification: "declared" });
  f.records.set("oauth/fixture/api", f.grant("api_key"));
  const view = await f.catalog();
  const offers = view.offers.filter(offer => offer.endpoint === endpoint);
  assert.ok(offers.length > 0);
  assert.ok(offers.every(offer => offer.modelId === null && offer.eligible));
  assert.ok(offers.every(offer => JSON.stringify(offer.productOffers) === JSON.stringify([{ id: "offer:models", productId: "api" }])));
  assert.equal(JSON.stringify(view).includes("fixture-api"), false);
});

test("catalog products follow only the active policy and priority-selected grant pool", async t => {
  const f = await fixture(t);
  f.records.set("oauth/fixture/subscription", f.grant("subscription"));
  let view = await f.catalog();
  assert.deepEqual(view.products.map(product => product.id), ["membership"]);
  assert.ok(references(view).every(ref => ref.productId === "membership"));
  assert.deepEqual(references(view, "websocket"), []);
  f.records.set("oauth/fixture/api", f.grant("api_key"));
  view = await f.catalog();
  assert.deepEqual(view.products.map(product => product.id), ["api", "membership"]);
  f.records.get("oauth/fixture/api").priority = 0;
  view = await f.catalog();
  assert.deepEqual(view.products.map(product => product.id), ["api"]);
  f.policy.grantRouting = { eligibleGrants: { openai: ["subscription"] } };
  view = await f.catalog();
  assert.deepEqual(view.products.map(product => product.id), ["membership"]);
  f.policy.grantRouting.eligibleGrants.openai = [];
  view = await f.catalog();
  assert.equal(view.products, undefined, "configured empty pool cannot use environment credentials");
  assert.equal(references(view).length, 0);
});

test("blocked, unavailable and stale declarations publish no product reference", async t => {
  const f = await fixture(t);
  const original = structuredClone(f.provider.offer_definitions);
  for (const change of [
    () => { f.provider.offer_definitions[0].model.upstream = "unrelated"; },
    () => { f.policy.monthlyBudgetMicros = 0; },
    () => { f.connection.enabled = false; },
    () => { f.policy.models = []; },
    () => { f.records.set("oauth/fixture/subscription", f.grant("subscription", { accountId: undefined })); },
  ]) {
    change();
    const view = await f.catalog();
    assert.equal(view?.products, undefined);
    assert.equal(view ? references(view).length : 0, 0);
    f.provider.offer_definitions = structuredClone(original); f.policy.monthlyBudgetMicros = null;
    f.connection.enabled = true; delete f.policy.models; f.records.delete("oauth/fixture/subscription");
  }
  const key = "oauth/fixture/subscription";
  f.records.set(key, f.grant("subscription"));
  f.states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), windows: [] };
  const cooling = await f.catalog();
  assert.equal(cooling.products, undefined);
  assert.equal(references(cooling).length, 0);
  assert.ok(cooling.models.length > 0, "temporary unavailability still preserves legacy inventory");
});

test("session policy precedence cannot borrow another policy's product candidates", async t => {
  const f = await fixture(t);
  f.records.set("oauth/fixture/subscription", f.grant("subscription"));
  f.policies.push({ policyId: "second", policy: { ...f.policy } });
  f.records.set("oauth/second/api", f.grant("api_key"));
  const view = await f.catalog(true);
  assert.deepEqual(view.products.map(product => product.id), ["membership"]);
  assert.ok(references(view).every(ref => ref.productId === "membership"));
  assert.ok(view.offers.filter(offer => offer.productOffers).every(offer => offer.policyId === "fixture"));
});
