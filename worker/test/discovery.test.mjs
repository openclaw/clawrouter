import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const { catalogResponse, modelsResponse, sessionResponse, entitlementResponse } = await import("../discovery.ts");
const { sha256Hex } = await import("../utils.ts");

test("authorized model metadata preserves declared reasoning efforts without adding sibling metadata", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  const catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
  const models = catalog.providers.find(({ id }) => id === "openai").models;
  assert.deepEqual(models.find(({ id }) => id === "openai/gpt-5.6").supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(models.find(({ id }) => id === "openai/gpt-5.5").supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal("supportedReasoningEfforts" in models.find(({ id }) => id === "openai/gpt-4.1-mini"), false);
});

test("session catalog scope retains the verified caller after policies are disabled or removed", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  for (const state of ["enabled", "disabled", "empty"]) {
    fixture.policy.enabled = state !== "disabled";
    if (state === "empty") fixture.policies.length = 0;
    for (const [handler, project] of [
      [catalogResponse, (body) => body],
      [sessionResponse, (body) => body.entitlements.catalog],
      [entitlementResponse, (body) => body.catalog],
    ]) {
      const response = await handler(fixture.request("session"), fixture.env);
      assert.equal(response.status, 200, `${handler.name}: ${state}`);
      const catalog = project(await response.json());
      assert.deepEqual(catalog.scope, { authType: "access", credentialId: null, principalId: "fixture@example.com" }, `${handler.name}: ${state}`);
      if (state === "enabled") assert.ok(catalog.providers.some(({ id }) => id === "openai"));
      else assert.deepEqual(catalog.providers, [], `${handler.name}: ${state}`);
    }
  }
});

test("catalog and session preserve saved provider health independently of operation eligibility", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  const fresh = { providerId: "openai", status: "verified", checkedAt: new Date(Date.now() - 1_000).toISOString(), latencyMs: 42 };
  const stale = { ...fresh, checkedAt: new Date(Date.now() - 86_400_001).toISOString() };
  const failed = { ...fresh, status: "failed", latencyMs: 75, error: "Fixture probe failed." };
  for (const [health, verified] of [[fresh, true], [stale, false], [failed, false], [null, false]]) {
    if (health) fixture.records.set("health/providers/openai", health);
    else fixture.records.delete("health/providers/openai");
    for (const enabled of [true, false]) {
      fixture.connection.enabled = enabled;
      for (const [handler, mode] of [[catalogResponse, "key"], [sessionResponse, "session"]]) {
        fixture.calls.length = 0;
        const body = await (await handler(fixture.request(mode), fixture.env)).json();
        const catalog = body.entitlements?.catalog ?? body;
        const view = catalog.providers.find(({ id }) => id === "openai");
        assert.equal(view.readiness.verified, verified);
        assert.equal(view.readiness.lastCheckedAt, health?.checkedAt ?? null);
        assert.equal(view.readiness.latencyMs, health?.latencyMs ?? null);
        assert.equal(view.offers.some(({ eligible }) => eligible), enabled);
        if (body.entitlements) assert.deepEqual(body.entitlements.providers.find(({ provider }) => provider === "openai").readiness, view.readiness);
        assert.equal(fixture.calls.filter(({ path }) => path === "kv-list").length, 1);
      }
    }
  }
});

test("mandatory request fees have the same catalog admission for policy and provider budgets", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  fixture.policy.providers = ["perplexity"];
  fixture.env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
  const connection = { providerId: "perplexity", enabled: true, monthlyBudgetMicros: null };
  fixture.connections.splice(0, fixture.connections.length, connection);
  for (const [policyLimit, providerLimit, fixed, visible] of [
    [100_000_000, null, null, false], [null, 100_000_000, null, false],
    [null, null, null, true], [100_000_000, 100_000_000, 0, true],
  ]) {
    fixture.policy.monthlyBudgetMicros = policyLimit;
    fixture.policy.requestCostMicros = fixed;
    connection.monthlyBudgetMicros = providerLimit;
    for (const mode of ["key", "session"]) {
      const catalog = await (await catalogResponse(fixture.request(mode), fixture.env)).json();
      const view = catalog.providers.find(({ id }) => id === "perplexity");
      const models = await (await modelsResponse(fixture.request(mode), fixture.env)).json();
      assert.deepEqual(models.data.map(({ id }) => id), view.models.map(({ id }) => id));
      assert.equal(view.models.some(({ id }) => id === "perplexity/sonar-pro"), visible);
      const offers = view.offers.filter(({ modelId }) => modelId === "perplexity/sonar-pro");
      assert.ok(offers.length > 0);
      assert.ok(offers.every(({ eligible, reasonCode }) => eligible === visible && reasonCode === (visible ? undefined : "pricing_required")));
    }
  }
});

test("models and catalog share read-only grant eligibility, transport support, and provider budget filtering", async (t) => {
  const secret = "fixture-discovery-secret";
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const policies = [{ policyId: "fixture", policy }];
  const connection = { providerId: "openai", enabled: true, monthlyBudgetMicros: null };
  const grants = new Map(), states = {};
  const paths = [];
  const env = {
    OPENAI_API_KEY: "fixture-environment-key",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map((item) => [item, grants.get(item) ?? null])) : grants.get(key) ?? null; },
      async list({ prefix }) { return { keys: [...grants.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname; paths.push(path);
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies, missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [{ email: "fixture@example.com", record: { enabled: true, role: "user", tenantId: "default", groups: [] } }], missingEmails: [] });
      if (path === "/resolve") return Response.json({ initialized: true, bindings: policies.map(({ policyId }, priority) => ({ policyId, priority, enabled: true, principalType: "user", principalId: "fixture@example.com" })), missingPrincipals: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") {
        const { policyId } = JSON.parse(init.body);
        return Response.json({ keys: [...grants.keys()].filter((key) => key.startsWith(`oauth/${policyId}/`)), states });
      }
      throw new Error(`discovery unexpectedly mutated authority: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("discovery must not refresh credentials or probe upstream"); });
  const request = () => new Request("https://router.example/v1/catalog", { headers: { authorization: `Bearer clawrouter-live-fixture-${secret}` } });
  async function compare(expectedCapabilities, websocket) {
    const catalog = await (await catalogResponse(request(), env)).json();
    const view = catalog.providers.find((provider) => provider.id === "openai");
    const models = await (await modelsResponse(request(), env)).json();
    assert.deepEqual(models.data.map(({ id, capabilities }) => ({ id, capabilities })), view.models.map(({ id, capabilities }) => ({ id, capabilities })));
    assert.deepEqual(view.models.find((model) => model.id === "openai/gpt-6-astra")?.capabilities ?? [], expectedCapabilities);
    assert.equal(view.routes.some((route) => route.websocket === "openai.responses"), websocket);
    assert.ok(view.offers.filter((offer) => offer.transport === "websocket").every((offer) => offer.modelId !== null && ["native", "unified"].includes(offer.routeKind)));
    assert.ok(!paths.includes("/grant-pools/select"));
    return view;
  }
  await compare(["llm.responses", "llm.chat"], true);
  const key = "oauth/fixture/subscription";
  grants.set(key, { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  delete env.OPENAI_API_KEY;
  const subscribed = await compare(["llm.responses"], false);
  assert.equal(subscribed.readiness.configPresent, true);
  assert.deepEqual(subscribed.readiness.missingConfig, []);
  assert.equal(subscribed.readiness.upstreamGrantCount, 1);
  assert.equal(subscribed.readiness.oauthGrantRequired, false);
  env.OPENAI_API_KEY = "fixture-environment-key";
  grants.set("oauth/fixture/api", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  await compare(["llm.responses", "llm.chat"], true);
  policy.grantRouting = { eligibleGrants: { openai: ["subscription"] } };
  await compare(["llm.responses"], false);
  policy.grantRouting.eligibleGrants.openai = [];
  await compare([], false);
  policy.grantRouting.eligibleGrants.openai = ["subscription"];
  states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60000).toISOString(), windows: [] };
  await compare([], false);
  delete states[key];
  policy.grantRouting = { staleState: "deny" };
  await compare([], false);

  // A session's first policy owns subscription Responses, while its second
  // owns Chat/embedding API auth. Neither grants this session a WS route.
  delete policy.grantRouting;
  grants.delete("oauth/fixture/api");
  policies.push({ policyId: "api", policy: { ...policy } });
  grants.set("oauth/api/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  const session = "a".repeat(64);
  grants.set(`local/sessions/${await sha256Hex(session)}`, { email: "fixture@example.com", role: "user", expiresAtMs: Date.now() + 60000 });
  env.CLAWROUTER_LOCAL_AUTH = "enabled";
  const catalog = await (await catalogResponse(new Request("https://router.example/v1/catalog", { headers: { cookie: `clawrouter_session=${session}` } }), env)).json();
  const view = catalog.providers.find(({ id }) => id === "openai");
  assert.equal(view.routes.find(({ endpoint }) => endpoint === "responses").websocket, undefined);
  assert.equal(view.nativeBaseUrl, null);
  assert.ok(view.offers.every((offer) => offer.transport === "http" && ["playground", "unified"].includes(offer.routeKind)));
  assert.ok(view.offers.every((offer) => offer.route.startsWith("/v1/playground/")));
  assert.deepEqual([...new Set(view.offers.filter((offer) => offer.routeKind === "unified").map((offer) => offer.route))].sort(), ["/v1/playground/v1/chat/completions", "/v1/playground/v1/embeddings", "/v1/playground/v1/responses"]);
  assert.deepEqual(view.models.find(({ id }) => id === "openai/gpt-6-astra").capabilities, ["llm.responses", "llm.chat"]);
  assert.ok(!paths.includes("/grant-pools/select"));
});

test("zero policy and provider budgets preserve canonical free token counting", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.policy.providers = ["anthropic"];
  fixture.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
  fixture.config.enabled = false;
  const connection = { providerId: "anthropic", enabled: true };
  fixture.connections.push(connection);
  for (const [policyLimit, providerLimit] of [[0, null], [null, 0]]) {
    fixture.policy.monthlyBudgetMicros = policyLimit;
    connection.monthlyBudgetMicros = providerLimit;
    const catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
    const models = catalog.providers.find(({ id }) => id === "anthropic").models;
    assert.ok(models.length > 0);
    assert.ok(models.every((model) => model.capabilities.length === 1 && model.capabilities[0] === "llm.count_tokens"));
  }
});

test("model selection forms remain request-dependent when a declared model can be priced", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  fixture.policy.providers = ["openai", "openrouter"];
  fixture.connections[1].providerId = "openrouter";
  fixture.env.OPENROUTER_API_KEY = "fixture-openrouter-key";
  const form = async (id) => {
    const catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
    return catalog.providers.find((provider) => provider.id === id).offers.find(({ modelId, endpoint, transport }) => modelId === null && endpoint === "chat_completions" && transport === "http");
  };
  const priced = await form("openai");
  assert.equal(priced.eligible, true);
  assert.equal(priced.affordability, "request-dependent");
  assert.equal(priced.reasonCode, undefined);
  const unpriced = await form("openrouter");
  assert.equal(unpriced.eligible, false);
  assert.equal(unpriced.reasonCode, "pricing_required");
  fixture.policy.monthlyBudgetMicros = 0;
  assert.equal((await form("openai")).reasonCode, "budget_exhausted");
  fixture.policy.monthlyBudgetMicros = 100;
  fixture.policy.requestCostMicros = 7;
  assert.equal((await form("openrouter")).affordability, "exact-covered");
});

test("Azure discovery keeps explicit native routes while hiding an unresolved default model", async (t) => {
  const secret = "fixture-azure-discovery";
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const policy = { enabled: true, generation: "g1", providers: ["azure-openai"], monthlyBudgetMicros: null, requestCostMicros: null };
  const env = {
    AZURE_OPENAI_API_KEY: "fixture-key", AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com", AZURE_OPENAI_API_VERSION: "2024-10-21",
    POLICY_KV: { async get(key) { return Array.isArray(key) ? new Map(key.map((item) => [item, null])) : null; }, async list() { return { keys: [], list_complete: true }; } },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: "azure-openai", enabled: true, monthlyBudgetMicros: null }], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`discovery unexpectedly mutated authority: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("discovery must not call upstream"); });
  const request = () => new Request("https://router.example/v1/catalog", { headers: { authorization: `Bearer clawrouter-live-fixture-${secret}` } });
  for (const configured of [false, true]) {
    if (configured) env.AZURE_OPENAI_DEPLOYMENT = "fixture-deployment";
    const catalog = await (await catalogResponse(request(), env)).json();
    const view = catalog.providers.find(({ id }) => id === "azure-openai");
    const models = await (await modelsResponse(request(), env)).json();
    assert.deepEqual(view.routes.map(({ endpoint }) => endpoint), ["chat_completions", "embeddings", "responses"]);
    assert.deepEqual(view.models.map(({ id }) => id), configured ? ["azure-openai/deployment"] : []);
    assert.deepEqual(models.data.map(({ id }) => id), view.models.map(({ id }) => id));
  }
});

test("Fusion shares selected-policy model eligibility across key and session discovery", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  const { env, policy, policies, connection, records, states, config, calls } = fixture;
  async function compare(expected, modes = ["key", "session"], readyAdvisers = 0) {
    for (const mode of modes) {
      for (const [handler, surface] of [[catalogResponse, "catalog"], [modelsResponse, "models"], ...(mode === "session" ? [[sessionResponse, "session"], [entitlementResponse, "entitlements"]] : [])]) {
        calls.length = 0;
        const response = await handler(fixture.request(mode), env);
        assert.equal(response.status, 200);
        const body = await response.json();
        const fusion = (body.entitlements?.providers ?? body.providers)?.find((row) => (row.id ?? row.provider) === "clawrouter");
        const visible = surface === "models" ? body.data.some(({ id }) => id === "clawrouter/fusion") : fusion?.readiness.executable;
        assert.equal(visible, expected, `${mode} ${surface}: ${config.aggregatorModel}`);
        if (fusion) {
          assert.equal(fusion.readiness.reasons.some((reason) => reason.includes("0/1 advisers")), readyAdvisers === 0);
          if (surface === "catalog") {
            assert.equal(fusion.models.length, expected ? 1 : 0);
            assert.equal(fusion.nativeBaseUrl, mode === "key" ? "/v1" : null);
          }
        }
        // One connection snapshot and one read-only pool resolution per eligible
        // provider/policy serve both concrete rows and every Fusion participant.
        assert.equal(calls.filter(({ path }) => path === "/connections/resolve").length, 1);
        const pools = calls.filter(({ path }) => path === "/grant-pools/resolve").map(({ body }) => `${body.policyId}/${body.providerId}`);
        assert.deepEqual(pools.sort(), (mode === "key" ? policies.slice(0, 1) : policies).flatMap(({ policyId, policy }) => policy.providers.map((provider) => `${policyId}/${provider}`)).sort());
      }
    }
  }
  await compare(true); // A missing adviser never hides a usable final route.
  config.adviserModels = ["fireworks/gpt-oss-120b"];
  env.FIREWORKS_API_KEY = "fixture-fireworks-key";
  await compare(true); // The same measured-pricing guard applies to advisers.
  policy.monthlyBudgetMicros = null;
  await compare(true, undefined, 1);
  fixture.connections[1].monthlyBudgetMicros = 100;
  await compare(true);
  policy.requestCostMicros = 7;
  await compare(true, undefined, 1);
  policy.requestCostMicros = null; fixture.connections[1].monthlyBudgetMicros = null;
  config.adviserModels = ["local/fixture-unavailable"];
  delete env.FIREWORKS_API_KEY;
  connection.enabled = false;
  await compare(false);
  connection.enabled = true;
  policy.monthlyBudgetMicros = 0;
  await compare(false);
  policy.monthlyBudgetMicros = null; connection.monthlyBudgetMicros = 0;
  await compare(false);
  connection.monthlyBudgetMicros = null;

  for (const model of ["openai/fixture-prefix-model", "fireworks/gpt-oss-120b"]) {
    config.aggregatorModel = model;
    if (model.startsWith("fireworks/")) env.FIREWORKS_API_KEY = "fixture-fireworks-key";
    for (const [policyLimit, providerLimit, fixed, expected] of [[100, null, null, false], [null, 100, null, false], [null, null, null, true], [100, 100, 7, true]]) {
      policy.monthlyBudgetMicros = policyLimit; policy.requestCostMicros = fixed;
      fixture.connections.find(({ providerId }) => model.startsWith(`${providerId}/`)).monthlyBudgetMicros = providerLimit;
      await compare(expected);
    }
    delete env.FIREWORKS_API_KEY;
    for (const item of fixture.connections) item.monthlyBudgetMicros = null;
  }
  config.aggregatorModel = "openai/gpt-6-astra";
  policy.monthlyBudgetMicros = 100; policy.requestCostMicros = null;
  const grantKey = "oauth/fixture/subscription";
  records.set(grantKey, { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  await compare(false); // Responses-only subscription must not reopen environment auth.
  const apiKey = "oauth/fixture/api";
  records.set(apiKey, { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  await compare(true);
  policy.grantRouting = { eligibleGrants: { openai: ["subscription"] } };
  await compare(false);
  policy.grantRouting.eligibleGrants.openai = [];
  await compare(false);
  policy.grantRouting.eligibleGrants.openai = ["api"];
  states[apiKey] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), windows: [] };
  await compare(false);
  delete states[apiKey]; policy.grantRouting = { staleState: "deny" };
  await compare(false);
  delete policy.grantRouting; records.delete(apiKey);

  // Session routing skips the first policy's incompatible subscription and uses
  // the second policy's Chat grant and budget, just as concrete dispatch does.
  policy.monthlyBudgetMicros = 0;
  policies.push({ policyId: "second", policy: { ...policy, providers: ["openai"], monthlyBudgetMicros: 100 } });
  records.set("oauth/second/api", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-second-api" });
  await compare(false, ["key"]);
  await compare(true, ["session"]);
});

test("catalog balances are principal scoped, fresh, and use the dispatch default tenant", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  Object.assign(fixture.policy, { tenantId: null, budgetScope: "principal", requestCostMicros: 20 });
  fixture.connection.monthlyBudgetMicros = 100;
  fixture.config.enabled = false;
  const observations = [];
  const remaining = new Map([["default:fixture:alpha@example.com", 10], ["default:fixture:beta@example.com", 50], ["provider:openai", 100], ["default:fixture:fixture@example.com", 50]]);
  fixture.env.BUDGET_LEDGER = { idFromName: (name) => name, get: (name) => ({ fetch: async (url) => {
    assert.equal(new URL(url).pathname, "/status");
    observations.push(name);
    return Response.json({ spentMicros: 0, remainingMicros: remaining.get(name) ?? 100 });
  } }) };
  for (const [principalId, eligible] of [["alpha@example.com", false], ["beta@example.com", true], ["alpha@example.com", true]]) {
    if (observations.length && principalId === "alpha@example.com") remaining.set("default:fixture:alpha@example.com", 25);
    fixture.credential.principalId = principalId;
    observations.length = 0;
    const catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
    assert.deepEqual(catalog.scope, { authType: "proxy_key", credentialId: "fixture", principalId });
    const offer = catalog.providers.find(({ id }) => id === "openai").offers.find(({ modelId, routeKind, transport }) => modelId === "openai/gpt-6-astra" && routeKind === "unified" && transport === "http");
    assert.equal(offer.eligible, eligible);
    assert.equal(offer.affordability, eligible ? "exact-covered" : "exact-blocked");
    assert.equal(observations.filter((name) => name === `default:fixture:${principalId}`).length, 1);
    assert.equal(observations.filter((name) => name === "provider:openai").length, 1);
  }
  fixture.userRecord.tenantId = "organization";
  delete fixture.env.OPENAI_API_KEY;
  fixture.records.set("oauth/tenants/default/openai", { provider: "openai", kind: "api_key", credential: "fixture-default-tenant", enabled: true });
  fixture.calls.length = 0;
  const session = await (await catalogResponse(fixture.request("session"), fixture.env)).json();
  assert.ok(session.providers.find(({ id }) => id === "openai").models.length > 0);
  assert.ok(fixture.calls.filter(({ path }) => path === "/grant-pools/resolve").every(({ body }) => body.tenantId === "default"));
  assert.ok(observations.includes("default:fixture:fixture@example.com"));
});

test("ordered policy selection does not shop for a richer budget", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  fixture.policy.monthlyBudgetMicros = 0;
  fixture.policies.push({ policyId: "second", policy: { ...fixture.policy, monthlyBudgetMicros: 100, requestCostMicros: 1 } });
  for (const policyId of ["fixture", "second"]) fixture.records.set(`oauth/${policyId}/api`, { provider: "openai", kind: "api_key", credential: `fixture-${policyId}`, enabled: true });
  for (const [cooldown, expectedPolicy, eligible] of [[false, "fixture", false], [true, "second", true]]) {
    if (cooldown) fixture.states["oauth/fixture/api"] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), windows: [] };
    const catalog = await (await catalogResponse(fixture.request("session"), fixture.env)).json();
    const offers = catalog.providers.find(({ id }) => id === "openai").offers;
    assert.ok(offers.length > 0);
    assert.ok(offers.every((offer) => offer.policyId === expectedPolicy));
    assert.equal(offers.some((offer) => offer.eligible), eligible);
  }
});

test("configured unavailable providers stay inspectable and revoked scopes never reuse prior offers", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.enabled = false;
  fixture.connections.splice(1); // No saved connection or account for Fireworks.
  let catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
  assert.deepEqual(catalog.providers.map(({ id }) => id), ["openai"]);
  fixture.connection.enabled = false;
  catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
  assert.deepEqual(catalog.providers.map(({ id }) => id), ["openai"]);
  assert.ok(catalog.providers[0].offers.every((offer) => !offer.eligible && offer.reasonCode === "provider_disabled"));
  fixture.credential.enabled = false;
  assert.equal((await catalogResponse(fixture.request("key"), fixture.env)).status, 403);
  fixture.credential.enabled = true;
  fixture.policy.generation = "g2";
  assert.equal((await catalogResponse(fixture.request("key"), fixture.env)).status, 403);
  fixture.policy.enabled = false;
  const session = await (await sessionResponse(fixture.request("session"), fixture.env)).json();
  assert.deepEqual(session.entitlements.catalog.providers, []);
});

test("catalog and HTTP select only configured grants inside the already chosen policy", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.policy.monthlyBudgetMicros = null;
  fixture.config.enabled = false;
  const invalidKey = "oauth/fixture/subscription", validKey = "oauth/fixture/api";
  fixture.records.set(invalidKey, { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", priority: 10 });
  fixture.records.set(validKey, { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api", priority: 10 });
  const original = fixture.env.ACCESS_CONTROL.get;
  fixture.env.ACCESS_CONTROL.get = () => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === "/grant-pools/select") {
      const body = JSON.parse(init.body); fixture.calls.push({ path: "/grant-pools/select", body });
      return Response.json({ selectedKey: body.candidates[0].key });
    }
    return original().fetch(url, init);
  } });
  fixture.env.GRANT_CREDENTIALS = { idFromName: (name) => name, get: () => ({ fetch: async (_url, init) => {
    const { grant } = JSON.parse(init.body);
    return Response.json({ grant: { ...grant, credentialLineage: "fixture-lineage" }, projection: { credentialGeneration: grant.credentialGeneration, credentialLineage: "fixture-lineage" }, changed: false, migrated: false });
  } }) };
  fixture.env.USAGE_QUEUE = { send: async () => {} };
  fixture.env.BUDGET_LEDGER.get = () => { throw new Error("unmetered HTTP must not read budget status"); };
  const sent = [], pending = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), authorization: init.headers.get("authorization") });
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const { default: worker } = await import("../index.ts");
  async function compare(expected) {
    const catalog = await (await catalogResponse(fixture.request("key"), fixture.env)).json();
    const offer = catalog.providers.find(({ id }) => id === "openai").offers.find(({ modelId, routeKind, transport, endpoint }) => modelId === "openai/gpt-6-astra" && routeKind === "unified" && transport === "http" && endpoint === "responses");
    assert.equal(offer.eligible, expected);
    const response = await worker.fetch(new Request("https://router.example/v1/responses", { method: "POST", headers: fixture.request("key").headers, body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture" }) }), fixture.env, { waitUntil: (promise) => pending.push(promise) });
    const body = await response.json(); await Promise.all(pending.splice(0));
    assert.equal(response.status, expected ? 200 : 503, JSON.stringify(body));
    if (!expected) assert.equal(body.error.code, "upstream_grant_pool_unavailable");
  }
  await compare(true);
  assert.deepEqual(fixture.calls.find(({ path }) => path === "/grant-pools/select").body.candidates.map(({ key }) => key), [validKey]);
  assert.equal(sent.at(-1).authorization, "Bearer fixture-api");
  // Configuration qualification precedes priority, not the selected policy.
  fixture.records.get(validKey).priority = 100;
  await compare(true);
  fixture.states[validKey] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60_000).toISOString(), windows: [] };
  await compare(false);
  delete fixture.states[validKey];
  fixture.records.get(validKey).enabled = false;
  await compare(false);
  fixture.records.delete(validKey);
  await compare(false);
  assert.equal(sent.length, 2, "the environment key never replaces the unusable selected pool");
});

async function fusionDiscoveryFixture(t) {
  const secret = "fixture-fusion-discovery", session = "b".repeat(64);
  const policy = { enabled: true, generation: "g1", providers: ["openai", "fireworks"], tenantId: "default", monthlyBudgetMicros: 100, requestCostMicros: null, retainRequestContent: false };
  const policies = [{ policyId: "fixture", policy }], states = {}, calls = [];
  const userRecord = { enabled: true, role: "user", tenantId: "default", groups: [] };
  const connections = policy.providers.map((providerId) => ({ providerId, enabled: true, monthlyBudgetMicros: null }));
  const config = { enabled: true, aggregatorModel: "openai/gpt-6-astra", adviserModels: ["local/fixture-unavailable"] };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const records = new Map([["config/fusion", config], [`local/sessions/${await sha256Hex(session)}`, { email: "fixture@example.com", role: "user", expiresAtMs: Date.now() + 60_000 }]]);
  const env = {
    OPENAI_API_KEY: "fixture-environment-key", CLAWROUTER_LOCAL_AUTH: "enabled",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map((item) => [item, records.get(item) ?? null])) : records.get(key) ?? null; },
      async list({ prefix }) {
        assert.equal(prefix, "health/providers/", "discovery only lists saved provider health, never grant credentials");
        calls.push({ path: "kv-list", body: { prefix } });
        return { keys: [...records.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
    },
    BUDGET_LEDGER: { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
      assert.equal(new URL(url).pathname, "/status", "discovery only observes balances");
      return Response.json({ spentMicros: 0, remainingMicros: 100 });
    } }) },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body); calls.push({ path, body });
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: policies.filter(({ policyId }) => body.policyIds.includes(policyId)), missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [{ email: "fixture@example.com", record: userRecord }], missingEmails: [] });
      if (path === "/resolve") return Response.json({ initialized: true, bindings: policies.map(({ policyId }, priority) => ({ policyId, priority, enabled: true, principalType: "user", principalId: "fixture@example.com" })), missingPrincipals: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections, missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [...records.keys()].filter((key) => key.startsWith(`oauth/${body.policyId}/`) && records.get(key).provider === body.providerId), states });
      throw new Error(`discovery unexpectedly mutated authority: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("discovery must not refresh credentials or probe upstream"); });
  return { env, credential, userRecord, policy, policies, connection: connections[0], connections, records, states, config, calls, request: (mode) => new Request("https://router.example/v1/catalog", { headers: mode === "key" ? { authorization: `Bearer clawrouter-live-fixture-${secret}` } : { cookie: `clawrouter_session=${session}` } }) };
}
