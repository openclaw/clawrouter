import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { modelRoute, providerById, providerReadinessFromState, routeCatalog } from "../providers.ts";

const { prepareNativeRequest, prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");

const google = providerById("google-gemini");
assert.ok(google);
const streamGenerate = google.endpoints.find((endpoint) => endpoint.id === "stream_generate_content");
assert.ok(streamGenerate);

test("native model parameters reject malformed percent-encoded UTF-8 as client errors", () => {
  for (const model of ["%", "%2", "%ZZ", "%E0%A4", "%ED%A0%80"]) {
    assert.throws(
      () => prepareNativeRequest(google, streamGenerate, {}, `/v1beta/models/${model}:streamGenerateContent`, {}),
      (error) => error?.status === 400 && error?.code === "invalid_path_encoding",
    );
  }
  const valid = prepareNativeRequest(google, streamGenerate, {}, "/v1beta/models/percent%252Fmodel:streamGenerateContent", {});
  assert.equal(valid.pathParams.model, "percent%2Fmodel", "valid path parameters are decoded exactly once");
});

test("Google native path models use manifest pricing under a budgeted policy", () => {
  const prepared = prepareNativeRequest(
    google,
    streamGenerate,
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    "/v1beta/models/gemini-3.5-flash:streamGenerateContent",
    {},
  );
  const policy = { monthlyBudgetMicros: 1_000_000, requestCostMicros: null };
  const cost = estimateCost(prepared.model, prepared.body, policy.requestCostMicros, "llm.stream", streamGenerate);

  assert.equal(prepared.model?.id, "google/gemini-3.5-flash");
  assert.equal(prepared.body.model, undefined);
  assert.deepEqual(prepared.pathParams, { model: "gemini-3.5-flash" });
  assert.equal(cost.basis, "manifest_pricing");
  assert.ok(cost.reserveMicros > 1);
});

test("current Anthropic native models retain routing and budget pricing", () => {
  const anthropic = providerById("anthropic");
  assert.ok(anthropic);
  const messages = anthropic.endpoints.find((endpoint) => endpoint.id === "messages");
  assert.ok(messages);

  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-4-6"]) {
    const prepared = prepareNativeRequest(
      anthropic,
      messages,
      { model: `anthropic/${model}`, max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
      "/v1/messages",
      {},
    );
    assert.equal(prepared.model?.id, `anthropic/${model}`);
    assert.equal(prepared.body.model, model);
    assert.deepEqual(prepared.pathParams, {});
    assert.equal(estimateCost(prepared.model, prepared.body, null, "llm.messages", messages).basis, "manifest_pricing");
  }
});

test("native namespaces preserve upstream identifiers while manifest envelopes reject cross-provider routes", () => {
  const upstream = "anthropic/claude-sonnet-4-6";
  const native = prepareNativeRequest(google, streamGenerate, {}, `/v1beta/models/${encodeURIComponent(upstream)}:streamGenerateContent`, {});
  assert.equal(native.pathParams.model, upstream);
  assert.equal(native.model.pricing, null);
  const ownPrefix = prepareNativeRequest(google, streamGenerate, {}, "/v1beta/models/google%2Ffixture-model:streamGenerateContent", {});
  assert.equal(ownPrefix.pathParams.model, "google/fixture-model");
  assert.throws(() => prepareManifestRequest(google, streamGenerate, {}, { model: upstream }, {}), (error) => error.code === "model_provider_mismatch");
  const openrouter = providerById("openrouter");
  const responses = openrouter.endpoints.find((endpoint) => endpoint.id === "responses");
  const routed = prepareNativeRequest(openrouter, responses, { model: "openai/gpt-6-astra", input: "fixture" }, responses.path, {});
  assert.equal(routed.body.model, "openai/gpt-6-astra");
  assert.equal(routed.model.pricing, null);
  assert.equal(estimateCost(routed.model, routed.body, null, "llm.responses", responses).basis, "flat_fallback");
});

test("native path models reject body and path mismatches", () => {
  assert.throws(
    () => prepareNativeRequest(
      google,
      streamGenerate,
      { model: "google/gemini-3.5-flash" },
      "/v1beta/models/gemini-3.5-pro:streamGenerateContent",
      {},
    ),
    (error) => error?.code === "model_path_mismatch",
  );
});

test("pricing completeness retains known model metadata and assesses opaque requests by endpoint", () => {
  const sonar = providerById("perplexity"), chat = sonar.endpoints.find(endpoint => endpoint.id === "chat_completions");
  for (const model of ["sonar-pro", "perplexity/sonar-pro"]) {
    const prepared = prepareNativeRequest(sonar, chat, { model, messages: [] }, chat.path, {});
    assert.equal(estimateCost(prepared.model, prepared.body, null, "llm.chat", chat).pricingGap, "model_request_fee");
  }
  const opaque = prepareNativeRequest(sonar, chat, { model: "sonar-unlisted", messages: [] }, chat.path, {});
  assert.equal(opaque.model.pricing, null);
  assert.equal(estimateCost(opaque.model, opaque.body, null, "llm.chat", chat).basis, "flat_fallback");
  for (const model of ["gemini-3.5-flash", "google/gemini-3.5-flash", "gemini-unlisted"]) {
    const prepared = prepareManifestRequest(google, streamGenerate, { tools: [{ url_context: {} }] }, { model }, {});
    const cost = estimateCost(prepared.model, prepared.body, null, "llm.stream", streamGenerate);
    assert.equal(cost.pricingGap, "hosted_tool_usage");
    assert.equal(cost.reserveMicros, 0);
  }
});

test("native Azure Responses keeps v1 URL, API-key auth, explicit deployment, and JSON or SSE bodies", async (t) => {
  const fixture = await nativeFixture("azure-openai");
  Object.assign(fixture.env, { AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com/", AZURE_OPENAI_API_KEY: "fixture-azure-key" });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: new URL(url), ...init });
    return JSON.parse(init.body).stream
      ? new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  for (const legacyConfig of [false, true]) {
    if (legacyConfig) Object.assign(fixture.env, { AZURE_OPENAI_API_VERSION: "2024-10-21", AZURE_OPENAI_DEPLOYMENT: "different-default" });
    for (const stream of [false, true]) {
      const body = { model: "fixture-deployment", input: "fixture", max_output_tokens: 16, stream };
      const response = await fixture.call("/openai/v1/responses", body);
      assert.equal(response.status, 200);
      const output = await response.text();
      assert.match(output, stream ? /response.completed/ : /usage/);
      await fixture.drain();
      const request = sent.at(-1);
      assert.equal(request.method, "POST");
      assert.equal(request.url.href, "https://fixture.openai.azure.com/openai/v1/responses");
      assert.equal(request.headers.get("api-key"), "fixture-azure-key");
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(request.body), body);
    }
  }
  for (const [suffix, body] of [
    ["chat/completions", { model: "fixture-deployment", messages: [{ role: "user", content: "fixture" }] }],
    ["embeddings", { model: "fixture-deployment", input: "fixture" }],
  ]) {
    const response = await fixture.call(`/openai/deployments/fixture-deployment/${suffix}`, body);
    assert.equal(response.status, 200);
    await response.text(); await fixture.drain();
    const request = sent.at(-1), { model: _, ...expectedBody } = body;
    assert.equal(request.url.href, `https://fixture.openai.azure.com/openai/deployments/fixture-deployment/${suffix}?api-version=2024-10-21`);
    assert.equal(request.headers.get("api-key"), "fixture-azure-key");
    assert.deepEqual(JSON.parse(request.body), expectedBody);
    const unified = await fixture.call(`/v1/${suffix}`, { ...body, model: "azure-openai/fixture-deployment" }, true);
    assert.equal(unified.status, 200);
    await unified.text(); await fixture.drain();
    assert.equal(sent.at(-1).url.href, request.url.href);
    assert.deepEqual(JSON.parse(sent.at(-1).body), body, "AzureOpenAI-style unified requests retain body.model while resolving the deployment path");
  }
  const unified = await fixture.call("/v1/responses", { model: "azure-openai/fixture-deployment", input: "fixture" }, true);
  assert.equal(unified.status, 200);
  await unified.text(); await fixture.drain();
  assert.equal(sent.at(-1).url.pathname, "/openai/v1/responses");
  assert.equal(JSON.parse(sent.at(-1).body).model, "fixture-deployment");
  delete fixture.env.AZURE_OPENAI_API_VERSION;
  const before = sent.length;
  const unavailable = await fixture.call("/openai/deployments/fixture-deployment/chat/completions", { messages: [] });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "provider_not_configured");
  await fixture.drain();
  assert.equal(sent.length, before);
});

test("Azure readiness checks endpoint-specific configuration without requiring a default deployment", () => {
  const env = { AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com/", AZURE_OPENAI_API_KEY: "fixture-azure-key" };
  const endpoints = () => providerReadinessFromState(env, [], [], new Map()).find(({ id }) => id === "azure-openai").executableEndpoints;
  assert.deepEqual(endpoints(), ["responses"]);
  env.AZURE_OPENAI_API_VERSION = "2024-10-21";
  assert.deepEqual(endpoints(), ["chat_completions", "embeddings", "responses"]);
  delete env.AZURE_OPENAI_API_KEY;
  assert.deepEqual(endpoints(), []);
  env.AZURE_OPENAI_API_KEY = "fixture-azure-key";
  delete env.AZURE_OPENAI_ENDPOINT;
  assert.deepEqual(endpoints(), []);
});

test("provider readiness keeps control-plane configuration and probe precedence", () => {
  const configured = { OPENAI_API_KEY: "fixture-openai-key" };
  const fresh = { providerId: "openai", status: "verified", checkedAt: new Date(Date.now() - 1_000).toISOString(), latencyMs: 42 };
  const stale = { ...fresh, checkedAt: new Date(Date.now() - 86_400_001).toISOString() };
  const failed = { ...fresh, status: "failed", error: "Fixture probe failed." };
  const unverified = "Configured but not recently verified by a live smoke test.";
  for (const [env, enabled, health, status, executable, reasons] of [
    [configured, true, fresh, "verified", true, []],
    [configured, true, stale, "unverified", true, [unverified]],
    [configured, true, failed, "failed", true, [unverified, failed.error]],
    [{}, true, failed, "missing_config", false, ["Missing OPENAI_API_KEY.", failed.error]],
    [configured, false, failed, "disabled", false, ["Provider connection is disabled.", failed.error]],
  ]) {
    const readiness = providerReadinessFromState(env, [], [{ providerId: "openai", enabled }], new Map([["openai", health]])).find(({ id }) => id === "openai");
    assert.equal(readiness.status, status);
    assert.equal(readiness.executable, executable);
    assert.deepEqual(readiness.reasons, reasons);
    assert.equal(readiness.lastCheckedAt, health.checkedAt);
    assert.equal(readiness.latencyMs, health.latencyMs);
  }
});

test("native OpenRouter Responses preserves provider namespaces and rejects unpriced budgeted calls", async (t) => {
  const fixture = await nativeFixture("openrouter");
  fixture.env.OPENROUTER_API_KEY = "fixture-openrouter-key";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: new URL(url), ...init });
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  const body = { model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 16 };
  for (const siteUrl of [undefined, " ", "https://client.example"]) {
    fixture.env.OPENROUTER_SITE_URL = siteUrl;
    const readiness = providerReadinessFromState(fixture.env, [], [], new Map()).find(({ id }) => id === "openrouter");
    assert.deepEqual(readiness.requiredConfig, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(readiness.optionalConfig, ["OPENROUTER_SITE_URL"]);
    assert.deepEqual(readiness.executableEndpoints, ["chat_completions", "responses"]);
    const response = await fixture.call("/v1/responses", body);
    assert.equal(response.status, 200);
    await response.text(); await fixture.drain();
    const request = sent.at(-1);
    assert.equal(request.url.href, "https://openrouter.ai/api/v1/responses");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-openrouter-key");
    assert.equal(request.headers.get("http-referer"), siteUrl?.trim() || null);
    assert.equal(request.headers.get("x-title"), "ClawRouter");
    assert.deepEqual(JSON.parse(request.body), body);
  }
  const unified = await fixture.call("/v1/responses", { ...body, model: "openrouter/openai/gpt-6-astra" }, true);
  assert.equal(unified.status, 200);
  await unified.text(); await fixture.drain();
  assert.deepEqual(JSON.parse(sent.at(-1).body), body);
  for (const owner of [fixture.policy, fixture.connection]) {
    owner.monthlyBudgetMicros = 1000;
    const denied = await fixture.call("/v1/responses", body);
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, "pricing_required");
    await fixture.drain();
    owner.monthlyBudgetMicros = null;
  }
  assert.equal(sent.length, 4);
  delete fixture.env.OPENROUTER_API_KEY;
  assert.deepEqual(providerReadinessFromState(fixture.env, [], [], new Map()).find(({ id }) => id === "openrouter").executableEndpoints, []);
  const missingKey = await fixture.call("/v1/responses", body);
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).error.code, "provider_not_configured");
  await fixture.drain();
  assert.equal(sent.length, 4);
});

test("native OpenRouter Chat preserves opaque upstream IDs matching its routing prefix", async (t) => {
  const fixture = await nativeFixture("openrouter");
  Object.assign(fixture.env, { OPENROUTER_API_KEY: "fixture-openrouter-key", OPENROUTER_SITE_URL: "https://client.example" });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  for (const [model, unified, upstream] of [
    ["openrouter/free", false, "openrouter/free"],
    ["openrouter/openrouter/free", true, "openrouter/free"],
    ["openrouter/auto", false, "openrouter/auto"],
    ["openrouter/auto", true, "openrouter/auto"],
  ]) {
    const response = await fixture.call("/v1/chat/completions", { model, messages: [] }, unified);
    assert.equal(response.status, 200);
    await response.text(); await fixture.drain();
    assert.equal(sent.at(-1).model, upstream);
  }
});

test("opaque OpenAI models route through the requested unified and native operation without inherited pricing", async (t) => {
  const fixture = await nativeFixture("openai");
  fixture.env.OPENAI_API_KEY = "fixture-openai-key";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: new URL(url), body: JSON.parse(init.body) });
    return Response.json({ usage: { prompt_tokens: 1, total_tokens: 1 } });
  });
  for (const [path, model, input] of [
    ["/v1/embeddings", "text-embedding-3-small", { input: "fixture" }],
    ["/v1/chat/completions", "fixture-chat", { messages: [] }],
    ["/v1/responses", "fixture-responses", { input: "fixture" }],
  ]) {
    for (const unified of [false, true]) {
      const response = await fixture.call(path, { ...input, model: unified ? `openai/${model}` : model }, unified);
      assert.equal(response.status, 200, `${path} unified=${unified}`);
      await response.text(); await fixture.drain();
      assert.equal(sent.at(-1).url.pathname, path);
      assert.deepEqual(sent.at(-1).body, { ...input, model });
    }
  }
  fixture.policy.monthlyBudgetMicros = 1_000_000;
  const denied = await fixture.call("/v1/embeddings", { model: "openai/text-embedding-3-small", input: "fixture" }, true);
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, "pricing_required");
  await fixture.drain();
  assert.equal(sent.length, 6);
  assert.equal(modelRoute("openai/fixture-chat"), null, "an opaque model needs operation context");
});

test("native catalog and dispatch use the same known model to endpoint relation", async (t) => {
  const routes = routeCatalog().manifestProxy.filter((route) => route.provider === "cohere");
  assert.deepEqual(routes.find((route) => route.endpoint === "chat").models.map((model) => model.id), ["cohere/command-a-plus-05-2026"]);
  assert.deepEqual(routes.find((route) => route.endpoint === "embed").models.map((model) => model.id), ["cohere/embed-v4.0"]);
  const fixture = await nativeFixture("cohere");
  fixture.env.COHERE_API_KEY = "fixture-cohere-key";
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: new URL(url), body: JSON.parse(init.body) });
    return Response.json({ embeddings: { float: [[0.1]] } });
  });
  const allowed = await fixture.call("/v2/embed", { model: "cohere/embed-v4.0", texts: ["fixture"], input_type: "search_document" });
  assert.equal(allowed.status, 200);
  await allowed.text(); await fixture.drain();
  assert.equal(sent[0].url.pathname, "/v2/embed");
  assert.equal(sent[0].body.model, "embed-v4.0");
  for (const [path, model] of [["/v2/chat", "embed-v4.0"], ["/v2/embed", "cohere/command-a-plus-05-2026"]]) {
    const denied = await fixture.call(path, { model });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, "model_capability_unsupported");
  }
  const unknown = await fixture.call("/v2/unknown", { model: "fixture" });
  assert.equal(unknown.status, 404);
  for (const model of ["cohere/embed-v4.0", "cohere/fixture-embedding"]) {
    const wrongFormat = await fixture.call("/v1/embeddings", { model, input: "fixture" }, true);
    assert.equal(wrongFormat.status, 400);
    assert.equal((await wrongFormat.json()).error.code, "model_capability_unsupported");
  }
  assert.equal(sent.length, 1, "incompatible and unknown operations never reach upstream");
});

test("local opaque Chat models retain explicitly declared zero pricing on unified and native routes", async (t) => {
  const fixture = await nativeFixture("local-openai");
  fixture.env.LOCAL_OPENAI_BASE_URL = "https://local-provider.example";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).pathname, "/v1/chat/completions");
    assert.equal(JSON.parse(init.body).model, "fixture-model");
    return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  for (const unified of [false, true]) {
    const response = await fixture.call("/v1/chat/completions", { model: unified ? "local/fixture-model" : "fixture-model", messages: [] }, unified);
    assert.equal(response.status, 200);
    await response.text(); await fixture.drain();
  }
  const route = modelRoute("local/fixture-model", "llm.chat");
  assert.equal(route.model.pricing_ref, "local-compute-zero-api-charge-v1");
  assert.equal(estimateCost(route.model, { messages: [] }, null, "llm.chat", route.provider.endpoints.find(endpoint => endpoint.id === "chat_completions")).reserveMicros, 0);
  assert.equal(modelRoute("local/fixture-model", "llm.embeddings"), null);
});

test("native resolution neither invents a default model nor copies opaque model metadata", () => {
  const openai = providerById("openai"), responses = openai.endpoints.find((endpoint) => endpoint.id === "responses");
  const absent = prepareNativeRequest(openai, responses, { input: "fixture" }, responses.path, {});
  assert.equal(absent.model, null);
  assert.deepEqual(absent.body, { input: "fixture" });
  const opaque = prepareNativeRequest(openai, responses, { model: "fixture-model", input: "fixture" }, responses.path, {});
  assert.deepEqual(opaque.model, { id: "fixture-model", upstream: "fixture-model", capabilities: ["llm.responses"], pricing_ref: null, pricing: null });
  assert.throws(() => prepareNativeRequest(openai, { ...responses, modelPassthrough: undefined }, { model: "fixture-model" }, responses.path, {}), (error) => error.code === "model_capability_unsupported");
  const embeddings = openai.endpoints.find((endpoint) => endpoint.id === "embeddings");
  assert.throws(() => prepareNativeRequest(openai, embeddings, { model: "openai/gpt-6-astra" }, embeddings.path, {}), (error) => error.code === "model_capability_unsupported");
});

async function nativeFixture(providerId) {
  const { default: worker } = await import("../index.ts");
  const { sha256Hex } = await import("../utils.ts");
  const secret = "fixture-native-secret", pending = [];
  const policy = { enabled: true, generation: "g1", providers: [providerId], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const connection = { providerId, enabled: true, monthlyBudgetMicros: null };
  const env = {
    POLICY_KV: { get: async (key) => Array.isArray(key) ? new Map(key.map((item) => [item, null])) : null },
    USAGE_QUEUE: { send: async () => {} },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`unexpected authority call ${path}`);
    } }) },
  };
  return {
    env, policy, connection,
    call(path, body, unified = false) {
      const nativePath = unified ? path : `/v1/native/${providerId}${path}`;
      const request = new Request(`https://router.example${nativePath}`, { method: "POST", headers: { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return worker.fetch(request, env, { waitUntil: (promise) => pending.push(promise) });
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}
