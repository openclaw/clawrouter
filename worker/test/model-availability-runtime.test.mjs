import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const { createRouteCatalog, modelSupportsEndpoint, modelExecutable } = await import("../../shared/route-catalog.ts");
const id = "availability-runtime", full = name => `${id}/${name}`;
const proof = { version: "clawrouter.model-availability.v1", effectiveAt: "2026-10-09", checkedAt: "2026-11-03", sources: ["https://provider.example/notice"] };
function providerFixture() {
  return compileProviderSnapshot([{
    schema: "clawrouter.service-provider.v1", id, displayName: "Availability fixture", class: "openai_compatible",
    service: { platform: "fixture", kind: "model_provider", configKeys: ["FIXTURE_API_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://provider.example" }, routing: { nativePrefixes: [id], modelPrefixes: [`${id}/`] },
    capabilities: [
      { id: "llm.chat", endpoint: "chat", methods: ["POST"] }, { id: "llm.messages", endpoint: "messages", methods: ["POST"] },
      { id: "models.list", endpoint: "models_list", methods: ["GET"] }, { id: "models.retrieve", endpoint: "models_get", methods: ["GET"] },
    ],
    endpoints: {
      chat: { path: "/v1/chat/completions", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions", modelPassthrough: {} },
      messages: { path: "/v1/messages", requestFormat: "anthropic.messages", responseFormat: "anthropic.messages", modelPassthrough: {} },
      models_list: { path: "/v1/models", method: "GET", requestFormat: "openai.models", responseFormat: "openai.models" },
      models_get: { path: "/v1/models/${model_id}", method: "GET", pathParams: ["model_id"], requestFormat: "openai.models", responseFormat: "openai.models" },
    },
    models: { entries: [
      { id: full("current"), upstream: "current", capabilities: ["llm.chat", "llm.messages"] },
      { id: full("stopped"), upstream: "stopped", capabilities: [], availability: { ...proof, status: "stopped" } },
      { id: full("deprecated"), upstream: "deprecated", capabilities: ["llm.chat", "llm.messages"], availability: { ...proof, status: "deprecated" } },
      { id: full("alias"), upstream: "alias", capabilities: ["llm.chat", "llm.messages"], availability: { ...proof, status: "upstream_alias", servingModel: "current" } },
    ] },
  }]).providers[0];
}
async function fixture(t, { restricted = false, anthropic = false } = {}) {
  const provider = providerFixture();
  if (anthropic) for (const endpoint of provider.endpoints.filter(e => e.id.startsWith("models_"))) endpoint.request_format = endpoint.response_format = "anthropic.models";
  snapshot.providers.push(provider); t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(provider), 1));
  const values = new Map(), pending = [], responses = [], sent = [], events = [];
  const env = { FIXTURE_API_KEY: "synthetic-environment", POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env); attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: restricted ? [full("alias"), full("stopped")] : null,
    tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: 7, retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "fixture" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  await putGrantCredentials(env, `oauth/fixture/${id}`, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-original" });
  const f = { provider, env, sent, events,
    reply: () => Response.json({ object: "list", data: ["current", "stopped", "deprecated", "alias", "unlisted"].map(id => ({ id, object: "model" })) }),
    async call(path, body, headers = {}) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
      responses.push(response); return response;
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request, sent.length); });
  t.after(async () => { for (const response of responses) if (!response.bodyUsed) await response.body?.cancel(); await f.drain(); }, { timeout: 10_000 });
  return f;
}

test("legacy and manifest catalogs hide stopped identities even if a duplicate router row has capabilities", () => {
  const provider = providerFixture(), stopped = provider.models.find(m => m.upstream === "stopped");
  stopped.capabilities = ["llm.chat"];
  provider.models.push({ id: full("renamed-stopped"), upstream: "stopped", capabilities: ["llm.chat"], pricing: null, pricing_ref: null });
  const routes = createRouteCatalog([provider]);
  assert.ok(routes.openaiCompatible[0].models.every(m => !m.id.includes("stopped")));
  assert.ok(routes.manifestProxy.every(route => route.models.every(m => !m.id.includes("stopped"))));
  assert.equal(modelSupportsEndpoint(provider, stopped, provider.endpoints.find(e => e.id === "chat")), false);
  assert.equal(modelExecutable({ models: [] }, { id: "different-product/stopped", upstream: "stopped" }), true);
  assert.equal(modelExecutable(provider, { id: full("unknown"), upstream: "unknown" }), true);
  assert.equal(modelExecutable(provider, { ...provider.models[0], availability: { ...proof, version: "future", status: "deprecated" } }), false);
  const alias = routes.openaiCompatible[0].models.find(m => m.id === full("alias"));
  assert.deepEqual(alias.availability, { ...proof, status: "upstream_alias", servingModel: "current" });
});

for (const restricted of [false, true]) test(`scoped catalogs preserve availability facts with ${restricted ? "restricted" : "unrestricted"} policy and no network probe`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { restricted });
  const response = await f.call("/v1/catalog"); assert.equal(response.status, 200, await response.clone().text());
  const provider = (await response.json()).providers.find(p => p.id === id);
  const expected = restricted ? [full("alias")] : ["alias", "current", "deprecated"].map(full);
  assert.deepEqual(provider.models.map(m => m.id).sort(), expected.sort());
  assert.ok(provider.offers.every(offer => offer.modelId !== full("stopped")));
  const alias = provider.models.find(m => m.id === full("alias"));
  assert.equal(alias.upstream, "alias"); assert.equal(alias.pricing, null); assert.equal(alias.pricing_ref, null);
  assert.deepEqual(alias.availability, { ...proof, status: "upstream_alias", servingModel: "current" });
  for (const headers of [{}, { "anthropic-version": "2023-06-01" }]) {
    const models = await f.call("/v1/models", undefined, headers); assert.equal(models.status, 200);
    const rows = (await models.json()).data;
    assert.deepEqual(rows.map(m => m.id).sort(), expected.sort());
    assert.deepEqual(rows.find(m => m.id === full("alias")).availability, alias.availability);
  }
  assert.equal(f.sent.length, 0); assert.deepEqual(f.events, []);
});

for (const manifest of [false, true]) test(`stopped ${manifest ? "manifest" : "native"} requests cannot revive through passthrough or model lookup`, { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const model of ["stopped", full("stopped")]) {
    const response = await f.call(manifest ? `/v1/proxy/${id}/chat` : `/v1/native/${id}/v1/chat/completions`,
      manifest ? { body: { model, messages: [] } } : { model, messages: [] });
    assert.equal(response.status, 400); await response.json();
  }
  const detail = await f.call(`/v1/native/${id}/v1/models/stopped`); assert.equal(detail.status, 400);
  assert.equal((await detail.json()).error.code, "model_unavailable"); assert.equal(f.sent.length, 0);
});

for (const restricted of [false, true]) test(`native discovery filters known stopped rows under ${restricted ? "restricted" : "unrestricted"} policy without inferring retirement from absence`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { restricted });
  for (const path of [`/v1/native/${id}/v1/models`, `/v1/proxy/${id}/models_list`]) {
    const response = await f.call(path); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).data.map(m => m.id), restricted ? ["alias"] : ["current", "deprecated", "alias", "unlisted"]);
  }
  f.reply = () => Response.json({ object: "list", data: [] });
  assert.deepEqual((await (await f.call(`/v1/native/${id}/v1/models`)).json()).data, []);
  const catalog = await (await f.call("/v1/catalog")).json();
  assert.ok(catalog.providers.find(p => p.id === id).models.some(m => m.id === full("alias")));
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original"));
  await f.drain(); assert.ok(f.events.filter(e => e.type === "clawrouter.usage.v1").every(e => e.actual_cost_micros === 0));
});

test("unrestricted Anthropic discovery skips a stopped-only page using the original grant and hides its cursors", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { anthropic: true });
  f.reply = (_request, count) => Response.json(count === 1
    ? { data: [{ id: "stopped" }], first_id: "stopped", last_id: "stopped", has_more: true }
    : { data: [{ id: "alias" }, { id: "stopped" }], first_id: "alias", last_id: "stopped", has_more: false });
  const response = await f.call(`/v1/native/${id}/v1/models`); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { data: [{ id: "alias" }], first_id: "alias", last_id: "alias", has_more: false });
  assert.equal(f.sent.length, 2); assert.equal(new URL(f.sent[1].url).searchParams.get("after_id"), "stopped");
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original"));
});

test("Synthetic data-only discovery applies the same stopped-identity filter after mapped dispatch", { timeout: 10_000 }, async t => {
  const f = await fixture(t), endpoint = f.provider.endpoints.find(e => e.id === "models_list");
  endpoint.request_format = endpoint.response_format = "synthetic.models";
  endpoint.upstreamPath = "/openai/v1/models";
  f.reply = () => Response.json({ data: ["stopped", "alias", "unlisted"].map(id => ({ id, name: id,
    context_length: 1024, input_modalities: ["text"], output_modalities: ["text"] })) });
  const response = await f.call(`/v1/native/${id}/v1/models`); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).data.map(row => row.id), ["alias", "unlisted"]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://provider.example/openai/v1/models");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-original");
});
