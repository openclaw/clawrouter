import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const { catalogResponse, modelsResponse, sessionResponse, entitlementResponse } = await import("../discovery.ts");
const { sha256Hex } = await import("../utils.ts");
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");

for (const mode of ["local", "cloudflare_access"]) test(`empty ${mode} discovery preserves authenticated scope without grants or budget activity`, async (t) => {
  const bindings = [], fixture = await fusionDiscoveryFixture(t, { bindings });
  let headers = fixture.request("session").headers;
  if (mode === "cloudflare_access") {
    const domain = "fixture.cloudflareaccess.com", audience = "fixture-audience", kid = "fixture-key";
    Object.assign(fixture.env, { CLAWROUTER_ACCESS_TEAM_DOMAIN: domain, CLAWROUTER_ACCESS_AUD: audience });
    fixture.userRecord.assignmentState = { version: 1, revision: "[]", assignments: {}, updatedAt: null };
    const list = fixture.env.POLICY_KV.list;
    fixture.env.POLICY_KV.list = (options) => options.prefix === "access/assignment-rules/" ? { keys: [], list_complete: true } : list(options);
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid };
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid })}.${encode({ aud: audience, iss: `https://${domain}`, email: "Fixture@Example.COM", exp: Math.floor(Date.now() / 1000) + 300 })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    headers = new Headers({ "cf-access-jwt-assertion": `${unsigned}.${Buffer.from(signature).toString("base64url")}` });
    t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(String(url), `https://${domain}/cdn-cgi/access/certs`, "only signature verification may fetch");
      return Response.json({ keys: [jwk] });
    });
  }
  fixture.env.BUDGET_LEDGER.get = () => { throw new Error("empty discovery must not observe or reserve a budget"); };
  const binding = { policyId: "fixture", priority: 0, enabled: true, principalType: "user", principalId: "fixture@example.com" };
  for (const [scenario, entries, enabled] of [
    ["no bindings", [], true], ["disabled binding", [{ ...binding, enabled: false }], true],
    ["missing policy", [{ ...binding, policyId: "missing" }], true], ["disabled policy", [binding], false],
    ["missing and disabled policies", [binding, { ...binding, policyId: "missing" }], false],
  ]) {
    bindings.splice(0, bindings.length, ...entries);
    fixture.policy.enabled = enabled;
    fixture.calls.length = 0;
    for (const path of ["/v1/catalog", "/v1/session", "/v1/entitlements", "/v1/models"]) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { headers }), fixture.env, {});
      assert.equal(response.status, 200, `${scenario}: ${path}`);
      const body = await response.json();
      if (path === "/v1/models") { assert.deepEqual(body.data, []); continue; }
      const catalog = body.entitlements?.catalog ?? body.catalog ?? body;
      assert.deepEqual(catalog.scope, { authType: "access", credentialId: null, principalId: "fixture@example.com" }, `${scenario}: ${path}`);
      assert.deepEqual(catalog.providers, []);
      if (path !== "/v1/catalog") {
        const session = body.session ?? body;
        assert.equal(session.auth, mode);
        assert.equal(session.email, catalog.scope.principalId);
        assert.ok((body.entitlements?.providers ?? body.providers).every((row) => !row.allowed));
      }
    }
    assert.equal(fixture.calls.some(({ path }) => path === "/grant-pools/resolve"), false);
  }
});

test("session catalog scope is independent of ordered multi-policy operation selection", async (t) => {
  const bindings = [
    { policyId: "fixture", priority: 20, enabled: true, principalType: "user", principalId: "fixture@example.com" },
    { policyId: "second", priority: 10, enabled: true, principalType: "user", principalId: "fixture@example.com" },
  ];
  const fixture = await fusionDiscoveryFixture(t, { bindings });
  fixture.policies.push({ policyId: "second", policy: { ...fixture.policy, generation: "second-generation", requestCostMicros: 0 } });
  for (const path of ["/v1/catalog", "/v1/session", "/v1/entitlements"]) {
    const response = await worker.fetch(new Request(`https://router.example${path}`, fixture.request("session")), fixture.env, {});
    assert.equal(response.status, 200);
    const body = await response.json(), catalog = body.entitlements?.catalog ?? body.catalog ?? body;
    assert.deepEqual(catalog.scope, { authType: "access", credentialId: null, principalId: "fixture@example.com" });
    const provider = catalog.providers.find(({ id }) => id === "openai");
    assert.deepEqual(provider.policies, ["second", "fixture"]);
    assert.ok(provider.offers.length > 0);
    assert.ok(provider.offers.every((offer) => offer.policyId === "second" && offer.policyGeneration === "second-generation" && offer.transport === "http" && offer.route.startsWith("/v1/playground/")));
    assert.equal(catalog.providers.find(({ id }) => id === "clawrouter").offers[0].policyId, "second");
  }
});

test("key catalog scope and rejection retain precedence over browser cookies", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  const headers = new Headers(fixture.request("key").headers);
  headers.set("cookie", fixture.request("session").headers.get("cookie"));
  for (const principalId of [null, "fixture@example.com"]) {
    fixture.credential.principalId = principalId;
    const response = await worker.fetch(new Request("https://router.example/v1/catalog", { headers }), fixture.env, {});
    assert.equal(response.status, 200);
    const catalog = await response.json(), provider = catalog.providers.find(({ id }) => id === "openai");
    assert.deepEqual(catalog.scope, { authType: "proxy_key", credentialId: "fixture", principalId });
    assert.equal(provider.nativeBaseUrl, "/v1/native/openai");
    assert.ok(provider.offers.some((offer) => offer.transport === "websocket"));
  }
  for (const [state, status, code] of [["invalid", 401, "invalid_proxy_key"], ["revoked", 403, "proxy_key_revoked"], ["stale", 403, "credential_policy_stale"]]) {
    fixture.credential.enabled = state !== "revoked";
    fixture.credential.policyGeneration = state === "stale" ? "old-generation" : "g1";
    headers.set("authorization", state === "invalid" ? "Bearer clawrouter-live-fixture-wrong" : fixture.request("key").headers.get("authorization"));
    for (const path of ["/v1/catalog", "/v1/models"]) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { headers }), fixture.env, {});
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
    for (const path of ["/v1/session", "/v1/entitlements"]) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { headers }), fixture.env, {});
      assert.equal(response.status, 200, "browser-only ingress ignores the proxy credential");
      const body = await response.json();
      assert.deepEqual((body.entitlements?.catalog ?? body.catalog).scope, { authType: "access", credentialId: null, principalId: "fixture@example.com" });
      assert.equal((await worker.fetch(new Request(`https://router.example${path}`, fixture.request("key")), fixture.env, {})).status, 401);
    }
  }
});

test("Worker catalog and session expose one exact HTTP Fusion offer and refresh its policy generation", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.policy.requestCostMicros = 0;
  for (const generation of ["g1", "g2"]) {
    fixture.policy.generation = generation;
    fixture.credential.policyGeneration = generation;
    for (const mode of ["key", "session"]) {
      for (const path of mode === "key" ? ["/v1/catalog"] : ["/v1/catalog", "/v1/session", "/v1/entitlements"]) {
        const request = new Request(`https://router.example${path}`, fixture.request(mode));
        const response = await worker.fetch(request, fixture.env, {});
        assert.equal(response.status, 200);
        const body = await response.json(), catalog = body.entitlements?.catalog ?? body.catalog ?? body;
        const fusion = catalog.providers.find(({ id }) => id === "clawrouter");
        assert.deepEqual(fusion.policies, ["fixture"]);
        assert.deepEqual(fusion.offers, [{
          endpoint: "chat_completions", modelId: "clawrouter/fusion", transport: "http", routeKind: "unified",
          route: mode === "key" ? "/v1/chat/completions" : "/v1/playground/v1/chat/completions",
          policyId: "fixture", policyGeneration: generation, eligible: true, affordability: "exact-covered",
        }]);
        assert.equal(catalog.scope.authType, mode === "key" ? "proxy_key" : "access");
      }
    }
  }
  fixture.userRecord.enabled = false;
  assert.equal((await worker.fetch(fixture.request("session"), fixture.env, {})).status, 401);
});

test("Fusion cannot borrow Chat eligibility from a sibling Responses or native-only operation", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  const index = snapshot.providers.findIndex(({ id }) => id === "openai"), original = snapshot.providers[index];
  const provider = structuredClone(original);
  snapshot.providers[index] = provider;
  t.after(() => { snapshot.providers[index] = original; });
  fixture.policy.requestCostMicros = 0;
  provider.capabilities.push({ id: "llm.chat", endpoint: "responses" });
  fixture.records.set("oauth/fixture/subscription", { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  const view = async () => {
    const response = await worker.fetch(fixture.request("key"), fixture.env, {});
    assert.equal(response.status, 200);
    return (await response.json()).providers;
  };
  let providers = await view();
  assert.ok(providers.find(({ id }) => id === "openai").offers.some(({ endpoint, eligible }) => endpoint === "responses" && eligible));
  let fusion = providers.find(({ id }) => id === "clawrouter");
  assert.equal(fusion.executable, false);
  assert.equal(fusion.offers[0].eligible, false);
  assert.equal(fusion.offers[0].endpoint, "chat_completions");

  fixture.records.delete("oauth/fixture/subscription");
  provider.endpoints.find(({ id }) => id === "chat_completions").request_format = "fixture.native_chat";
  providers = await view();
  assert.ok(providers.find(({ id }) => id === "openai").offers.some(({ endpoint, eligible }) => endpoint === "chat_completions" && eligible));
  fusion = providers.find(({ id }) => id === "clawrouter");
  assert.equal(fusion, undefined, "the existing Fusion config validator rejects native-only Chat");
});

test("Fusion observes synthesis first without promising all fail-open advisers fit a shared balance", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.policy.requestCostMicros = 7;
  fixture.config.adviserModels = ["openai/gpt-4.1-mini", "openai/gpt-4.1"];
  fixture.connection.monthlyBudgetMicros = 100;
  let policyRemaining = 100, providerRemaining = 100;
  fixture.env.BUDGET_LEDGER = { idFromName: (name) => name, get: (name) => ({ fetch: async (url) => {
    assert.equal(new URL(url).pathname, "/status", "catalog must never reserve");
    return Response.json({ spentMicros: 0, remainingMicros: name.startsWith("provider:") ? providerRemaining : policyRemaining });
  } }) };
  for (const [policy, provider, eligible, affordability, ready] of [
    [21, 21, true, "exact-covered", 2], [14, 21, true, "request-dependent", 2],
    [21, 14, true, "request-dependent", 2], [7, 7, true, "exact-covered", 0],
    [6, 100, false, "exact-blocked", 0], [100, 6, false, "exact-blocked", 0],
  ]) {
    policyRemaining = policy; providerRemaining = provider;
    const response = await worker.fetch(fixture.request("key"), fixture.env, {});
    assert.equal(response.status, 200);
    const fusion = (await response.json()).providers.find(({ id }) => id === "clawrouter");
    assert.equal(fusion.offers[0].eligible, eligible);
    assert.equal(fusion.offers[0].affordability, affordability);
    assert.equal(fusion.readiness.reasons.some((reason) => reason.startsWith(`${ready}/2 advisers`)), ready !== 2);
  }
  fixture.policy.requestCostMicros = 0; policyRemaining = 0; providerRemaining = 0;
  let catalog = await (await worker.fetch(fixture.request("key"), fixture.env, {})).json();
  assert.equal(catalog.providers.find(({ id }) => id === "clawrouter").offers[0].affordability, "exact-covered");
  fixture.policy.requestCostMicros = null; policyRemaining = 100; providerRemaining = 100;
  catalog = await (await worker.fetch(fixture.request("key"), fixture.env, {})).json();
  assert.equal(catalog.providers.find(({ id }) => id === "clawrouter").offers[0].affordability, "request-dependent");
});

test("zero-cost Fusion offers stay exact with unavailable observations but configured zero limits still block", async (t) => {
  const fixture = await fusionDiscoveryFixture(t);
  fixture.config.adviserModels = ["openai/gpt-4.1-mini"];
  fixture.connection.monthlyBudgetMicros = 100;
  let unavailable = "both";
  fixture.env.BUDGET_LEDGER = { idFromName: (name) => name, get: (name) => ({ fetch: async (url) => {
    assert.equal(new URL(url).pathname, "/status");
    const owner = name.startsWith("provider:") ? "provider" : "policy";
    return unavailable === "both" || unavailable === owner ? new Response(null, { status: 503 }) : Response.json({ spentMicros: 100, remainingMicros: 0 });
  } }) };
  for (const kind of ["fixed-zero", "zero-card"]) {
    fixture.policy.requestCostMicros = kind === "fixed-zero" ? 0 : null;
    if (kind === "zero-card") {
      fixture.policy.providers = ["local-openai"];
      fixture.connection.providerId = "local-openai";
      fixture.env.LOCAL_OPENAI_BASE_URL = "https://local-model.example";
      fixture.config.aggregatorModel = "local/final";
      fixture.config.adviserModels = ["local/adviser"];
    }
    for (const failure of ["policy", "provider", "both"]) {
      unavailable = failure;
      const catalog = await (await worker.fetch(fixture.request("key"), fixture.env, {})).json();
      const offer = catalog.providers.find(({ id }) => id === "clawrouter").offers[0];
      assert.equal(offer.eligible, true, `${kind}/${failure}`);
      assert.equal(offer.affordability, "exact-covered", `${kind}/${failure}`);
    }
    for (const owner of [fixture.policy, fixture.connection]) {
      owner.monthlyBudgetMicros = 0;
      const catalog = await (await worker.fetch(fixture.request("key"), fixture.env, {})).json();
      const offer = catalog.providers.find(({ id }) => id === "clawrouter").offers[0];
      assert.equal(offer.eligible, false, kind);
      assert.equal(offer.affordability, "exact-blocked", kind);
      owner.monthlyBudgetMicros = 100;
    }
  }
});

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
  fixture.policy.requestCostMicros = 1;
  const fresh = { providerId: "openai", status: "verified", checkedAt: new Date(Date.now() - 1_000).toISOString(), latencyMs: 42 };
  const stale = { ...fresh, checkedAt: new Date(Date.now() - 86_400_001).toISOString() };
  const failed = { ...fresh, status: "failed", latencyMs: 75, error: "Fixture probe failed." };
  for (const [health, verified, probeStatus, failure] of [
    [fresh, true, "verified", null], [stale, false, "unverified", null],
    [failed, false, "failed", failed.error], [{ ...failed, error: null }, false, "failed", "Latest provider smoke failed."],
    [null, false, "unverified", null],
  ]) {
    if (health) fixture.records.set("health/providers/openai", health);
    else fixture.records.delete("health/providers/openai");
    for (const [enabled, limit, blockedStatus, reasonCode] of [
      [true, 100, null, null], [false, 100, "disabled", "provider_disabled"],
      [true, 0, "unavailable", "budget_exhausted"],
    ]) {
      fixture.connection.enabled = enabled;
      fixture.policy.monthlyBudgetMicros = limit;
      // A disabled operation owns its blocker even when coarse config is missing.
      fixture.env.OPENAI_API_KEY = enabled ? "fixture-environment-key" : "";
      const executable = blockedStatus === null;
      for (const [handler, mode] of [[catalogResponse, "key"], [catalogResponse, "session"], [sessionResponse, "session"], [entitlementResponse, "session"]]) {
        fixture.calls.length = 0;
        const body = await (await handler(fixture.request(mode), fixture.env)).json();
        const catalog = body.entitlements?.catalog ?? body.catalog ?? body;
        const view = catalog.providers.find(({ id }) => id === "openai");
        assert.equal(view.readiness.verified, verified);
        assert.equal(view.readiness.lastCheckedAt, health?.checkedAt ?? null);
        assert.equal(view.readiness.latencyMs, health?.latencyMs ?? null);
        assert.equal(view.readiness.status, blockedStatus ?? probeStatus);
        assert.deepEqual(view.readiness.reasons, [
          ...(reasonCode ? [reasonCode] : []),
          ...(executable && !verified ? ["Configured but not recently verified by a live smoke test."] : []),
          ...(failure ? [failure] : []),
        ]);
        assert.equal(view.readiness.executable, executable);
        assert.equal(view.offers.some(({ eligible }) => eligible), executable);
        if (reasonCode) assert.ok(view.offers.every((offer) => !offer.eligible && offer.reasonCode === reasonCode));
        if (body.entitlements) assert.deepEqual(body.entitlements.providers.find(({ provider }) => provider === "openai").readiness, view.readiness);
        if (body.catalog) assert.deepEqual(body.providers.find(({ provider }) => provider === "openai").readiness, view.readiness);
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
    assert.equal(view.nativeBaseUrl, "/v1/native/openai");
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
  for (const handler of [catalogResponse, sessionResponse, entitlementResponse]) {
    const body = await (await handler(new Request("https://router.example/v1/catalog", { headers: { cookie: `clawrouter_session=${session}` } }), env)).json();
    const catalog = body.entitlements?.catalog ?? body.catalog ?? body;
    const view = catalog.providers.find(({ id }) => id === "openai");
    assert.equal(catalog.scope.authType, "access");
    assert.equal(view.routes.find(({ endpoint }) => endpoint === "responses").websocket, undefined);
    assert.equal(view.nativeBaseUrl, "/v1/native/openai");
    assert.ok(view.offers.every((offer) => offer.transport === "http" && ["playground", "unified"].includes(offer.routeKind)));
    assert.ok(view.offers.every((offer) => offer.route.startsWith("/v1/playground/")));
    assert.deepEqual([...new Set(view.offers.filter((offer) => offer.routeKind === "unified").map((offer) => offer.route))].sort(), ["/v1/playground/v1/chat/completions", "/v1/playground/v1/embeddings", "/v1/playground/v1/responses"]);
    assert.deepEqual(view.models.find(({ id }) => id === "openai/gpt-6-astra").capabilities, ["llm.responses", "llm.chat"]);
    assert.ok(!paths.includes("/grant-pools/select"));
  }
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
          const catalog = body.entitlements?.catalog ?? body.catalog ?? body;
          const projection = catalog.providers.find(({ id }) => id === "clawrouter");
          assert.equal(catalog.scope.authType, mode === "key" ? "proxy_key" : "access");
          assert.equal(projection.models.length, expected ? 1 : 0);
          assert.equal(projection.nativeBaseUrl, "/v1");
          if (mode === "session") assert.equal(projection.offers.some((offer) => offer.transport === "websocket" || offer.routeKind === "native"), false);
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
  const catalog = await (await catalogResponse(fixture.request("session"), env)).json();
  const offer = catalog.providers.find(({ id }) => id === "clawrouter").offers[0];
  assert.equal(offer.policyId, "second");
  assert.equal(offer.policyGeneration, policies[1].policy.generation);
  assert.equal(offer.transport, "http");
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

async function fusionDiscoveryFixture(t, { bindings } = {}) {
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
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: policies.filter(({ policyId }) => body.policyIds.includes(policyId)), missingPolicyIds: body.policyIds.filter((id) => !policies.some(({ policyId }) => policyId === id)) });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [{ email: "fixture@example.com", record: userRecord }], missingEmails: [] });
      if (path === "/resolve") return Response.json({ initialized: true, bindings: bindings ?? policies.map(({ policyId }, priority) => ({ policyId, priority, enabled: true, principalType: "user", principalId: "fixture@example.com" })), missingPrincipals: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections, missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [...records.keys()].filter((key) => key.startsWith(`oauth/${body.policyId}/`) && records.get(key).provider === body.providerId), states });
      throw new Error(`discovery unexpectedly mutated authority: ${path}`);
    } }) },
  };
  t.mock.method(globalThis, "fetch", () => { throw new Error("discovery must not refresh credentials or probe upstream"); });
  return { env, credential, userRecord, policy, policies, connection: connections[0], connections, records, states, config, calls, request: (mode) => new Request("https://router.example/v1/catalog", { headers: mode === "key" ? { authorization: `Bearer clawrouter-live-fixture-${secret}` } : { cookie: `clawrouter_session=${session}` } }) };
}
