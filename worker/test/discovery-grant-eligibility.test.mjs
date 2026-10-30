import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
const { catalogResponse, modelsResponse, sessionResponse, entitlementResponse } = await import("../discovery.ts");
const { sha256Hex } = await import("../utils.ts");

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
      if (path === "/admission/resolve") return Response.json({ credential: { credentialId: "fixture", credential }, policy: policies[0], owner: null, connections: [connection], pools: Object.fromEntries(JSON.parse(init.body).providers.filter(({ id }) => !policy.providers.length || policy.providers.includes(id)).map(({ id }) => [id, { keys: [...grants.keys()].filter(key => key.startsWith("oauth/fixture/")), states }])) });
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
  await compare(["llm.responses", "llm.chat", "llm.responses.compact", "llm.count_tokens"], true);
  const key = "oauth/fixture/subscription";
  grants.set(key, { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  delete env.OPENAI_API_KEY;
  const subscribed = await compare(["llm.responses"], false);
  assert.equal(subscribed.readiness.configPresent, true);
  assert.deepEqual(subscribed.readiness.missingConfig, []);
  assert.equal(subscribed.readiness.upstreamGrantCount, 1);
  assert.equal(subscribed.readiness.oauthGrantRequired, false);
  assert.equal(subscribed.models.some(({ id }) => id === "openai/tts-1"), false);
  assert.equal(subscribed.models.some(({ id }) => id === "openai/gpt-4o-transcribe"), false);
  assert.equal(subscribed.offers.some(({ modelId, eligible }) => modelId === "openai/tts-1" && eligible), false);
  assert.equal(subscribed.models.some(({ capabilities }) => capabilities.includes("image.generation")), false);
  assert.equal(subscribed.offers.some(({ modelId, eligible }) => modelId?.includes("gpt-image-2.5") && eligible), false);
  env.OPENAI_API_KEY = "fixture-environment-key";
  grants.set("oauth/fixture/api", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  await compare(["llm.responses", "llm.chat", "llm.responses.compact", "llm.count_tokens"], true);
  policy.grantRouting = { eligibleGrants: { openai: ["subscription"] } };
  await compare(["llm.responses"], false);
  policy.grantRouting.eligibleGrants.openai = [];
  await compare([], false);
  policy.grantRouting.eligibleGrants.openai = ["subscription"];
  states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60000).toISOString(), windows: [] };
  const cooling = await compare(["llm.responses"], false);
  assert.ok(cooling.offers.every(offer => !offer.eligible));
  assert.equal(cooling.models.some(({ id }) => id === "openai/tts-1"), false);
  assert.equal(cooling.models.some(({ capabilities }) => capabilities.includes("llm.chat")), false);
  assert.ok(cooling.routes.every(({ endpoint }) => endpoint === "responses"), "cooldown cannot add unsupported sibling routes");
  states[key].lastSignal = "authentication";
  await compare([], false);
  delete states[key].lastSignal;
  policy.grantRouting.staleState = "deny";
  await compare([], false);
  delete policy.grantRouting.staleState;
  policy.grantRouting.eligibleGrants.openai = [];
  await compare([], false);
  policy.grantRouting.eligibleGrants.openai = ["subscription"];
  delete grants.get(key).accountId;
  await compare([], false);
  grants.get(key).accountId = "fixture-account";
  grants.get(key).enabled = false;
  await compare([], false);
  grants.get(key).enabled = true;
  policy.monthlyBudgetMicros = 0;
  await compare([], false);
  policy.monthlyBudgetMicros = null;
  connection.enabled = false;
  await compare([], false);
  connection.enabled = true;
  states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: null, lastSignal: "quota", windows: [{ id: "week", kind: "requests", remaining: 0, limit: 100, resetAt: null }] };
  await compare([], false);
  states[key].windows[0].resetAt = new Date(Date.now() + 60_000).toISOString();
  await compare(["llm.responses"], false);
  delete states[key];
  policy.grantRouting = { staleState: "deny" };
  await compare([], false);

  // A session's first policy owns subscription Responses, while its second
  // owns Chat/Decisions/embedding/speech API auth. Neither grants a WS route.
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
    assert.deepEqual([...new Set(view.offers.filter((offer) => offer.routeKind === "unified").map((offer) => offer.route))].sort(), ["/v1/playground/v1/audio/speech", "/v1/playground/v1/audio/transcriptions", "/v1/playground/v1/chat/completions", "/v1/playground/v1/decisions", "/v1/playground/v1/embeddings", "/v1/playground/v1/images/generations", "/v1/playground/v1/moderations", "/v1/playground/v1/responses", "/v1/playground/v1/responses/compact", "/v1/playground/v1/responses/input_tokens"]);
    const moderationOffers = view.offers.filter(({ endpoint }) => endpoint === "moderations");
    assert.ok(moderationOffers.length > 0);
    assert.ok(moderationOffers.every(({ eligible, policyId, transport, affordability }) => eligible && policyId === "api" && transport === "http" && affordability === "exact-covered"));
    const imageOffers = view.offers.filter(({ modelId }) => modelId?.includes("gpt-image-2.5"));
    assert.ok(imageOffers.length > 0);
    assert.ok(imageOffers.every(({ eligible, policyId, transport }) => eligible && policyId === "api" && transport === "http"));
    const transcriptionOffers = view.offers.filter(({ modelId }) => modelId === "openai/gpt-4o-transcribe");
    assert.ok(transcriptionOffers.length > 0);
    assert.ok(transcriptionOffers.every(({ eligible, policyId, transport }) => eligible && policyId === "api" && transport === "http"));
    const decisionOffers = view.offers.filter(({ endpoint, modelId }) => endpoint === "decisions" && modelId);
    assert.ok(decisionOffers.length > 0 && decisionOffers.every(({ modelId, eligible, policyId }) => modelId === "openai/gpt-6-luna" && eligible && policyId === "api"));
    assert.equal(view.models.find(({ id }) => id === "openai/gpt-6-luna").endpointPricing.decisions.pricing.outputMicrosPerMillion, 0);
    const speechOffers = view.offers.filter(({ modelId }) => modelId === "openai/tts-1");
    assert.ok(speechOffers.length > 0);
    assert.ok(speechOffers.every(({ eligible, policyId, transport }) => eligible && policyId === "api" && transport === "http"));
    assert.deepEqual(view.models.find(({ id }) => id === "openai/gpt-6-astra").capabilities, ["llm.responses", "llm.chat", "llm.responses.compact", "llm.count_tokens"]);
    assert.ok(!paths.includes("/grant-pools/select"));
  }
});

