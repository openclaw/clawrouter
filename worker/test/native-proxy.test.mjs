import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { providerById, providerReadinessFromState } from "../providers.ts";
import { correlateIngressRequest } from "../correlation.ts";

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
  const cost = estimateCost(prepared.model, prepared.body, policy.requestCostMicros, "llm.stream");

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
    assert.equal(estimateCost(prepared.model, prepared.body, null, "llm.messages").basis, "manifest_pricing");
  }
});

test("native namespaces preserve upstream identifiers while manifest envelopes reject cross-provider routes", () => {
  const upstream = "anthropic/claude-sonnet-4-6";
  const native = prepareNativeRequest(google, streamGenerate, {}, `/v1beta/models/${encodeURIComponent(upstream)}:streamGenerateContent`, {});
  assert.equal(native.pathParams.model, upstream);
  assert.equal(native.model.pricing, null);
  assert.throws(() => prepareManifestRequest(google, streamGenerate, {}, { model: upstream }, {}), (error) => error.code === "model_provider_mismatch");
  const openrouter = providerById("openrouter");
  const responses = openrouter.endpoints.find((endpoint) => endpoint.id === "responses");
  const routed = prepareNativeRequest(openrouter, responses, { model: "openai/gpt-6-astra", input: "fixture" }, responses.path, {});
  assert.equal(routed.body.model, "openai/gpt-6-astra");
  assert.equal(routed.model.pricing, null);
  assert.equal(estimateCost(routed.model, routed.body, null, "llm.responses").basis, "flat_fallback");
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
  }
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
  for (const owner of [fixture.policy, fixture.connection]) {
    owner.monthlyBudgetMicros = 1000;
    const denied = await fixture.call("/v1/responses", body);
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, "pricing_required");
    await fixture.drain();
    owner.monthlyBudgetMicros = null;
  }
  assert.equal(sent.length, 3);
  delete fixture.env.OPENROUTER_API_KEY;
  assert.deepEqual(providerReadinessFromState(fixture.env, [], [], new Map()).find(({ id }) => id === "openrouter").executableEndpoints, []);
  const missingKey = await fixture.call("/v1/responses", body);
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).error.code, "provider_not_configured");
  await fixture.drain();
  assert.equal(sent.length, 3);
});

async function nativeFixture(providerId) {
  const { proxyNative } = await import("../proxy.ts");
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
    call(path, body) {
      const nativePath = `/v1/native/${providerId}${path}`;
      const request = correlateIngressRequest(new Request(`https://router.example${nativePath}`, { method: "POST", headers: { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) })).request;
      return proxyNative(request, env, { waitUntil: (promise) => pending.push(promise) }, nativePath);
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}
