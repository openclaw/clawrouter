import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderSmokePlan, runLiveProviderSmokes, summarizePlan } from "../scripts/provider-smoke-plan.mjs";
import catalog from "../worker/generated/provider-snapshot.json" with { type: "json" };

const { default: handler } = await import("../worker/index.ts");
const { snapshot } = await import("../worker/providers.ts");
const { sha256Hex } = await import("../worker/utils.ts");

function renamed(id) {
  const provider = structuredClone(catalog.providers.find(provider => provider.id === id));
  provider.id = `fixture-${id}`;
  provider.base_urls.default = "https://format-upstream.example";
  provider.routing.modelPrefixes = [`${provider.id}/`];
  const names = new Map(provider.endpoints.map((endpoint, index) => [endpoint.id, `operation_${index}`]));
  for (const endpoint of provider.endpoints) endpoint.id = names.get(endpoint.id);
  for (const capability of provider.capabilities) capability.endpoint = names.get(capability.endpoint);
  provider.models = provider.models.map((model, index) => ({ ...model, id: `${provider.id}/model_${index}` }));
  provider.models.unshift({ id: `${provider.id}/unrelated`, upstream: "unrelated", capabilities: ["fixture.unrelated"], pricing: null, pricing_ref: null });
  return provider;
}

test("bundled target selection is stable and unresolved prediction coverage stays visible", () => {
  const plan = buildProviderSmokePlan(catalog, {});
  const native = { anthropic: "count_tokens", "aws-bedrock": "invoke_model", "cloudflare-ai-gateway": "universal", cohere: "chat", firecrawl: "scrape", "google-gemini": "generate_content", replicate: "prediction", tavily: "search" };
  assert.equal(plan.providerCount, 22);
  assert.equal(plan.targetCount, 22);
  for (const { id, target } of plan.providers) {
    assert.equal(target.kind, native[id] ? "manifest_proxy" : "openai_chat", id);
    assert.equal(target.endpoint ?? target.route, native[id] ?? "/v1/chat/completions", id);
    assert.equal(!!target.unresolved, id === "replicate", id);
  }
  assert.match(summarizePlan(plan), /replicate.*unresolved=.*existing prediction ID/);
});

for (const [source, messagesOnly, manifestOnly, formatOnly, method] of [
  ["anthropic", false, false], ["anthropic", true, false], ["cohere", false, false],
  ["google-gemini", false, false], ["tavily", false, false], ["firecrawl", false, false],
  ["openai", false, false], ["openai", false, true],
  ["openai", false, false, "openai.responses"], ["openai", false, false, "openai.embeddings"],
  ["cohere", false, false, "cohere.embed"], ["tavily", false, false, "tavily.extract"],
  ["firecrawl", false, false, "fixture.status", "GET"], ["firecrawl", false, false, "fixture.status", "HEAD"],
  ["firecrawl", false, false, "fixture.graphql", "POST"],
]) {
  test(`renamed ${source}${messagesOnly ? " Messages" : ""}${manifestOnly ? " manifest" : ""}${formatOnly ? ` ${formatOnly}` : ""}${method ? ` ${method}` : ""} smoke reaches the real Worker with its native format`, async (t) => {
    const provider = renamed(source), original = { ...snapshot };
    if (messagesOnly) {
      const count = provider.capabilities.find(capability => capability.id === "llm.count_tokens").endpoint;
      provider.endpoints = provider.endpoints.filter(endpoint => endpoint.id !== count);
      provider.capabilities = provider.capabilities.filter(capability => capability.endpoint !== count);
    }
    if (method) {
      Object.assign(provider.endpoints[0], { request_format: formatOnly, method, methods: [method] });
    } else if (formatOnly) {
      provider.endpoints = provider.endpoints.filter(endpoint => endpoint.request_format === formatOnly);
      provider.capabilities = provider.capabilities.filter(capability => provider.endpoints.some(endpoint => endpoint.id === capability.endpoint));
    }
    if (manifestOnly) provider.class = "rest_json";
    const env = await smokeEnvironment(provider), pending = [], upstream = [], recorded = [];
    const plan = buildProviderSmokePlan({ providers: [provider] }, {}), target = plan.providers[0].target;
    assert.equal(target.unresolved, undefined);
    const endpoint = provider.endpoints.find(endpoint => endpoint.id === (target.endpoint ?? provider.capabilities.find(capability => capability.id === "llm.chat").endpoint));
    const expectedModel = provider.models.find(model => model.capabilities.some(capability => provider.capabilities.some(item => item.endpoint === endpoint.id && item.id === capability)));
    t.mock.method(globalThis, "fetch", async (url, init) => {
      if (new URL(url).origin === "https://smoke-router.example") return handler.fetch(new Request(url, init), env, { waitUntil: promise => pending.push(promise) });
      const native = new URL(url), headers = new Headers(init.headers), body = init.body === undefined ? undefined : JSON.parse(init.body);
      assert.equal(native.origin, "https://format-upstream.example");
      assert.equal(init.method, method ?? "POST");
      assert.equal(native.pathname, endpoint.path.replace(/\$\{([^}]+)\}/g, (_, name) => encodeURIComponent(target.envelope.pathParams[name])));
      for (const scheme of provider.auth.schemes) {
        if (scheme.type === "bearer") assert.equal(headers.get(scheme.header), "Bearer fixture-upstream-key");
        if (scheme.type === "api_key") assert.equal(headers.get(scheme.header), "fixture-upstream-key");
        if (scheme.type === "query_api_key") assert.equal(native.searchParams.get(scheme.param), "fixture-upstream-key");
      }
      assert.ok(!JSON.stringify(body ?? {}).includes("unrelated"));
      if (["GET", "HEAD"].includes(method)) {
        assert.equal(init.body, undefined);
        assert.deepEqual(target.envelope.body, {});
      } else if (endpoint.request_format === "fixture.graphql") {
        assert.deepEqual(body, { query: "{ viewer { id } }" });
      } else if (endpoint.request_format === "anthropic.messages") {
        assert.equal(body.model, expectedModel.upstream);
        assert.deepEqual(body.messages, [{ role: "user", content: "reply with ok" }]);
        assert.equal(body.max_tokens, messagesOnly ? 16 : undefined);
      } else if (["cohere.chat", "openai.chat_completions"].includes(endpoint.request_format)) {
        assert.equal(body.model, expectedModel.upstream);
        assert.deepEqual(body.messages, [{ role: "user", content: "reply with ok" }]);
      } else if (endpoint.request_format === "google.generate_content") {
        assert.deepEqual(body, { contents: [{ parts: [{ text: "reply with ok" }] }] });
      } else if (endpoint.request_format === "tavily.search") {
        assert.deepEqual(body, { query: "OpenClaw", max_results: 1 });
      } else if (endpoint.request_format === "tavily.extract") {
        assert.deepEqual(body, { urls: ["https://example.com"] });
      } else if (endpoint.request_format === "openai.responses") {
        assert.deepEqual(body, { model: expectedModel.upstream, input: "reply with ok", max_output_tokens: 16 });
      } else if (endpoint.request_format === "openai.embeddings") {
        assert.deepEqual(body, { model: expectedModel.upstream, input: "OpenClaw" });
      } else if (endpoint.request_format === "cohere.embed") {
        assert.deepEqual(body, { model: expectedModel.upstream, texts: ["OpenClaw"], input_type: "search_query", embedding_types: ["float"] });
      } else assert.deepEqual(body, { url: "https://example.com", formats: ["markdown"] });
      upstream.push(body);
      return method === "HEAD" ? new Response(null) : Response.json({ fixture: "synthetic upstream", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    try {
      Object.assign(snapshot, {
        providers: [provider], capability_index: {},
        model_index: Object.fromEntries(provider.models.map(model => [model.id, { provider: provider.id, ...model }])),
      });
      const results = await runLiveProviderSmokes({ baseUrl: "https://smoke-router.example", smokeKey: env.fixtureKey, plan, liveProviders: [provider.id], onResult: result => recorded.push(result) });
      await Promise.all(pending);
      assert.equal(upstream.length, 1);
      assert.deepEqual(results.map(result => [result.provider, result.status, result.providerAttempted]), [[provider.id, "verified", true]]);
      assert.deepEqual(recorded, results);
    } finally { Object.assign(snapshot, original); }
  });
}

test("native operator model overrides retain the renamed provider's own identity", () => {
  const provider = renamed("cohere"), model = provider.models[1];
  model.upstream = "native/owned-model";
  const envKey = `CLAWROUTER_SMOKE_MODEL_${provider.id.replaceAll("-", "_").toUpperCase()}`;
  for (const value of [model.id, model.upstream]) {
    const plan = buildProviderSmokePlan({ providers: [provider] }, { [envKey]: value, CLAWROUTER_SMOKE_MODEL_COHERE: "wrong-provider-model" });
    assert.equal(plan.providers[0].target.envelope.body.model, model.upstream);
  }
});

test("unified smoke eligibility uses the selected endpoint's wire contract", () => {
  const cohere = renamed("cohere");
  cohere.class = "openai_compatible";
  Object.assign(cohere.adapter, { request: "openai", response: "openai" });
  assert.equal(buildProviderSmokePlan({ providers: [cohere] }, {}).providers[0].target.kind, "manifest_proxy");
  const openai = renamed("openai");
  openai.endpoints.push({ id: "unrelated", path: "/${project}/${resource}", path_params: ["project", "resource"] });
  assert.equal(buildProviderSmokePlan({ providers: [openai] }, {}).providers[0].target.kind, "openai_chat");
  const chat = openai.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
  chat.path = "/${resource}/chat"; chat.path_params = ["resource"];
  assert.equal(buildProviderSmokePlan({ providers: [openai] }, {}).providers[0].target.kind, "manifest_proxy", "unified dispatch only fills model/deployment path parameters");
});

test("built-in AWS and Cloudflare overrides never cross into renamed manifests", () => {
  const env = {
    CLAWROUTER_SMOKE_BODY_AWS_BEDROCK: JSON.stringify({ fixture: "owned AWS body" }),
    CLOUDFLARE_ACCOUNT_ID: "owned-account", CLOUDFLARE_AI_GATEWAY_ID: "owned-gateway",
    CLOUDFLARE_AI_GATEWAY_SMOKE_MODEL: "owned-model", CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY: "fixture-private-inline-key",
  };
  const builtin = buildProviderSmokePlan(catalog, env);
  assert.deepEqual(builtin.providers.find(provider => provider.id === "aws-bedrock").target.envelope.body, { fixture: "owned AWS body" });
  assert.equal(builtin.providers.find(provider => provider.id === "cloudflare-ai-gateway").target.envelope.body[0].headers.Authorization, "Bearer fixture-private-inline-key");
  const plan = buildProviderSmokePlan({ providers: [renamed("aws-bedrock"), renamed("cloudflare-ai-gateway")] }, env);
  const wire = JSON.stringify(plan.providers.map(provider => provider.target));
  for (const value of ["owned AWS body", "owned-account", "owned-gateway", "owned-model", "fixture-private-inline-key"]) assert.ok(!wire.includes(value));
});

test("unknown and resource-dependent templates remain planned but cannot fake live verification", async (t) => {
  const unknown = renamed("firecrawl");
  unknown.endpoints[0].request_format = "fixture.unknown";
  const plan = buildProviderSmokePlan({ providers: [unknown, renamed("replicate")] }, {});
  assert.equal(plan.targetCount, 2);
  assert.ok(plan.providers.every(provider => provider.target.unresolved));
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("unresolved smoke must not dispatch"); });
  const recorded = [];
  await assert.rejects(runLiveProviderSmokes({ baseUrl: "https://smoke-router.example", smokeKey: "fixture", plan, liveProviders: ["all"], onResult: result => recorded.push(result) }), /no smoke request template.*existing prediction ID/);
  assert.equal(upstream.mock.callCount(), 0);
  assert.deepEqual(recorded, []);
});

test("bodyless resource parameters and GraphQL queries require explicit fixtures", () => {
  for (const method of ["GET", "HEAD", "POST"]) {
    const provider = renamed("firecrawl"), endpoint = provider.endpoints[0];
    Object.assign(endpoint, { method, methods: [method], path: "/records/${record}", path_params: ["record"] });
    assert.match(buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target.unresolved, /path parameters require a smoke fixture: record/);
  }
  const provider = renamed("firecrawl"), endpoint = provider.endpoints[0];
  Object.assign(endpoint, { method: "GET", methods: ["GET"], request_format: "fixture.graphql" });
  assert.match(buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target.unresolved, /no smoke request template/);
  endpoint.method = "POST"; endpoint.methods = ["POST"]; endpoint.request_format = "fixture.json";
  provider.adapter.request = "graphql";
  assert.deepEqual(buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target.envelope.body, { query: "{ viewer { id } }" });
});

test("additional model formats require an endpoint-compatible model or explicit override", () => {
  for (const [source, format] of [["openai", "openai.responses"], ["openai", "openai.embeddings"], ["cohere", "cohere.embed"]]) {
    const provider = renamed(source);
    provider.endpoints = provider.endpoints.filter(endpoint => endpoint.request_format === format);
    provider.capabilities = provider.capabilities.filter(capability => provider.endpoints.some(endpoint => endpoint.id === capability.endpoint));
    provider.models = [provider.models[0]];
    assert.equal(buildProviderSmokePlan({ providers: [provider] }, {}).providers[0].target, null);
    const envKey = `CLAWROUTER_SMOKE_MODEL_${provider.id.replaceAll("-", "_").toUpperCase()}`;
    const target = buildProviderSmokePlan({ providers: [provider] }, { [envKey]: "native-override" }).providers[0].target;
    assert.equal(target.envelope.body.model, "native-override");
  }
});

async function smokeEnvironment(provider) {
  const secret = "fixture-smoke-secret", policy = { enabled: true, generation: "g1", providers: [provider.id], monthlyBudgetMicros: null, requestCostMicros: 0, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  return {
    ...Object.fromEntries(provider.config_keys.map(key => [key, "fixture-upstream-key"])), fixtureKey: `clawrouter-live-fixture-${secret}`,
    POLICY_KV: { get: async keys => Array.isArray(keys) ? new Map() : null }, USAGE_QUEUE: { send: async () => {} },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: provider.id, enabled: true }], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`unexpected authority call: ${path}`);
    } }) },
  };
}
