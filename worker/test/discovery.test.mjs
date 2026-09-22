import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { providerById } from "../providers.ts";

const { catalogModels } = await import("../discovery.ts");
const { catalogResponse, modelsResponse } = await import("../discovery.ts");
const { sha256Hex } = await import("../utils.ts");

const fireworks = providerById("fireworks");
assert.ok(fireworks);
const endpoints = fireworks.endpoints.map((endpoint) => endpoint.id);
const openai = providerById("openai");
assert.ok(openai);
const openaiEndpoints = openai.endpoints.map((endpoint) => endpoint.id);

test("catalog models preserve declared reasoning efforts without adding sibling metadata", () => {
  const models = catalogModels(openai, openaiEndpoints, null);
  const gpt56 = models.find((model) => model.id === "openai/gpt-5.6");
  const gpt55 = models.find((model) => model.id === "openai/gpt-5.5");

  assert.deepEqual(gpt56.supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal("supportedReasoningEfforts" in gpt55, false);
});

test("budgeted proxy-key catalogs omit unpriced models without fixed request pricing", () => {
  const models = catalogModels(fireworks, endpoints, {
    enabled: true,
    generation: "test",
    providers: ["fireworks"],
    monthlyBudgetMicros: 1_000_000,
    requestCostMicros: null,
  });

  assert.ok(models.some((model) => model.id === "fireworks/glm-5.2"));
  assert.ok(!models.some((model) => model.id === "fireworks/gpt-oss-120b"));
});

test("unpriced catalog models remain for unmetered, fixed-price, and Access scopes", () => {
  const policies = [
    { enabled: true, generation: "unmetered", providers: ["fireworks"], monthlyBudgetMicros: null, requestCostMicros: null },
    { enabled: true, generation: "fixed", providers: ["fireworks"], monthlyBudgetMicros: 1_000_000, requestCostMicros: 25 },
    null,
  ];

  for (const policy of policies) {
    const models = catalogModels(fireworks, endpoints, policy);
    assert.ok(models.some((model) => model.id === "fireworks/gpt-oss-120b"));
  }
});

test("provider budgets and the selected endpoint policy govern the same model projection", () => {
  const unmetered = { monthlyBudgetMicros: null, requestCostMicros: null };
  assert.ok(!catalogModels(fireworks, endpoints, unmetered, 100).some((model) => model.id === "fireworks/gpt-oss-120b"));
  assert.ok(catalogModels(fireworks, endpoints, { ...unmetered, requestCostMicros: 1 }, 100).some((model) => model.id === "fireworks/gpt-oss-120b"));
  const endpointPolicies = new Map([["chat_completions", { monthlyBudgetMicros: 100, requestCostMicros: null }]]);
  assert.ok(!catalogModels(fireworks, endpoints, unmetered, null, endpointPolicies).some((model) => model.id === "fireworks/gpt-oss-120b"));
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
  async function compare(expectedCapabilities) {
    const catalog = await (await catalogResponse(request(), env)).json();
    const view = catalog.providers.find((provider) => provider.id === "openai");
    const models = await (await modelsResponse(request(), env)).json();
    assert.deepEqual(models.data.map(({ id, capabilities }) => ({ id, capabilities })), view.models.map(({ id, capabilities }) => ({ id, capabilities })));
    assert.deepEqual(view.models.find((model) => model.id === "openai/gpt-6-astra")?.capabilities ?? [], expectedCapabilities);
    assert.ok(!paths.includes("/grant-pools/select"));
    return view;
  }
  await compare(["llm.responses", "llm.chat"]);
  const key = "oauth/fixture/subscription";
  grants.set(key, { provider: "openai", kind: "subscription", enabled: true, accessToken: "fixture-subscription", accountId: "fixture-account" });
  await compare(["llm.responses"]);
  grants.set("oauth/fixture/api", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  await compare(["llm.responses", "llm.chat"]);
  policy.grantRouting = { eligibleGrants: { openai: ["subscription"] } };
  await compare(["llm.responses"]);
  policy.grantRouting.eligibleGrants.openai = [];
  await compare([]);
  policy.grantRouting.eligibleGrants.openai = ["subscription"];
  states[key] = { grantRevision: null, status: "cooldown", cooldownUntil: new Date(Date.now() + 60000).toISOString(), windows: [] };
  await compare([]);
  delete states[key];
  policy.grantRouting = { staleState: "deny" };
  await compare([]);

  // Endpoint selection can choose a different policy for Chat and Responses.
  delete policy.grantRouting;
  grants.delete("oauth/fixture/api");
  policies.push({ policyId: "api", policy: { ...policy } });
  grants.set("oauth/api/openai", { provider: "openai", kind: "api_key", enabled: true, credential: "fixture-api" });
  const session = "a".repeat(64);
  grants.set(`local/sessions/${await sha256Hex(session)}`, { email: "fixture@example.com", role: "user", expiresAtMs: Date.now() + 60000 });
  env.CLAWROUTER_LOCAL_AUTH = "enabled";
  const catalog = await (await catalogResponse(new Request("https://router.example/v1/catalog", { headers: { cookie: `clawrouter_session=${session}` } }), env)).json();
  const view = catalog.providers.find(({ id }) => id === "openai");
  assert.deepEqual(view.models.find(({ id }) => id === "openai/gpt-6-astra").capabilities, ["llm.responses", "llm.chat"]);
  assert.ok(!paths.includes("/grant-pools/select"));
});

test("zero policy and provider budgets preserve canonical free token counting", () => {
  const provider = providerById("anthropic");
  for (const [policyLimit, providerLimit] of [[0, null], [null, 0]]) {
    const models = catalogModels(provider, provider.endpoints.map(({ id }) => id), { monthlyBudgetMicros: policyLimit, requestCostMicros: null }, providerLimit);
    assert.ok(models.length > 0);
    assert.ok(models.every((model) => model.capabilities.length === 1 && model.capabilities[0] === "llm.count_tokens"));
  }
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
