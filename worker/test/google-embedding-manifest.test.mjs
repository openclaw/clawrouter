import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");
const { snapshot } = await import("../providers.ts");
const manifest = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([manifest]);
const provider = compiled.providers[0];
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/embeddings.json", import.meta.url), "utf8"));
const endpoints = { unary: "embed_content", batch: "batch_embed_contents" };
const authorization = "Bearer clawrouter-live-embedding-synthetic-embedding";

async function fixture(t, mode, unpriced = false) {
  const original = { providers: snapshot.providers, model_index: snapshot.model_index };
  snapshot.providers = original.providers.map(row => row.id === provider.id ? structuredClone(provider) : row);
  snapshot.model_index = { ...original.model_index, ...compiled.model_index };
  t.after(() => Object.assign(snapshot, original));
  const records = new Map(), pending = [], sent = [], events = [];
  const env = { GOOGLE_API_KEY: "synthetic-google-key", POLICY_KV: {
    async get(key, type) { const value = Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value); },
    async put(key, value) { records.set(key, JSON.parse(value)); }, async list() { return { keys: [], list_complete: true }; },
  }, USAGE_QUEUE: { send: async event => events.push(event) }, BUDGET_LEDGER: sqlBudgetNamespace(t) };
  const policy = { enabled: true, generation: "v1", providers: [provider.id], models: [`google/${wire[mode].model}`], tenantId: "fixture",
    monthlyBudgetMicros: 10000, requestCostMicros: unpriced ? null : 17, retainRequestContent: false };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "embedding", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "embedding", credential: {
    enabled: true, secretSha256: await sha256Hex("synthetic-embedding"), policyId: "embedding", policyGeneration: "v1",
  } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: provider.id, enabled: true }]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).json(), redirect: init.redirect });
    return Response.json(wire[mode].response);
  });
  const request = (path, body) => worker.fetch(new Request(`https://router.example${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization, "content-type": "application/json", "x-goog-api-key": "synthetic-caller-key" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: promise => pending.push(promise) });
  t.after(async () => { await Promise.all(pending); });
  return { request, pending, sent, events };
}

test("Google manifest declares only qualified stable embedding identities with native facts and unknown prices", () => {
  const models = provider.models.filter(row => row.capabilities.includes("llm.embeddings"));
  assert.deepEqual(models.map(row => row.upstream), ["gemini-embedding-001", "gemini-embedding-2"]);
  for (const model of models) {
    assert.equal(model.id, `google/${model.upstream}`); assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    for (const id of Object.values(endpoints)) {
      const endpoint = provider.endpoints.find(row => row.id === id), facts = model.nativeCapabilities.endpoints[id];
      assert.equal(endpoint.request_format, `google.${id}`); assert.equal(endpoint.response_format, `google.${id}`);
      assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.timeout_ms, 60000);
      assert.equal(facts.contextWindow, model.upstream === "gemini-embedding-001" ? 2048 : 8192);
      assert.equal(facts.checkedAt, "2026-11-03"); assert.deepEqual(facts.sources, ["https://ai.google.dev/gemini-api/docs/embeddings", "https://ai.google.dev/gemini-api/docs/deprecations"]);
    }
  }
  assert.equal(provider.endpoints.find(row => row.id === "stream_generate_content").query.alt, "sse");
  assert.ok(provider.models.find(row => row.upstream === "gemini-3.5-flash").pricing);
});

for (const mode of ["unary", "batch"]) for (const proxy of [false, true]) test(`Google declared ${mode} follows scoped catalog to ${proxy ? "manifest" : "native"} dispatch`, async t => {
  const f = await fixture(t, mode), catalogResponse = await f.request("/v1/catalog");
  assert.equal(catalogResponse.status, 200, await catalogResponse.clone().text());
  const catalog = await catalogResponse.json(), view = catalog.providers.find(row => row.id === provider.id);
  assert.equal(catalog.scope.credentialId, "embedding"); assert.equal(f.sent.length, 0);
  const model = view.models.find(row => row.id === `google/${wire[mode].model}`);
  const endpoint = view.routes.find(row => row.endpoint === endpoints[mode]);
  const offer = view.offers.find(row => row.modelId === model.id && row.endpoint === endpoint.endpoint && row.routeKind === "native");
  assert.equal(endpoint.requestFormat, `google.${endpoints[mode]}`); assert.equal(offer.eligible, true);
  assert.deepEqual(view.models.map(row => row.id), [model.id], "the catalog respects the original model policy");
  const path = proxy ? `/v1/proxy/${provider.id}/${endpoint.endpoint}` : offer.route.replace("${model}", model.upstream);
  const response = await f.request(path, proxy ? { pathParams: { model: model.upstream }, body: wire[mode].request } : wire[mode].request);
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), wire[mode].response);
  await Promise.all(f.pending);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].body, wire[mode].request);
  assert.equal(f.sent[0].url, provider.base_urls.default + endpoint.path.replace("${model}", model.upstream));
  assert.equal(f.sent[0].headers.get("x-goog-api-key"), "synthetic-google-key"); assert.equal(f.sent[0].headers.get("authorization"), null);
  assert.equal(f.sent[0].redirect, "manual"); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].cost_basis, "policy_fixed"); assert.equal(f.events[0].actual_cost_micros, 17);
  assert.equal(f.events[0].input_tokens, wire[mode].response.usageMetadata.promptTokenCount); assert.equal(f.events[0].output_tokens, null);
});

test("Google declared embedding models cannot infer a dollar bound from context, dimensions or byte size", async t => {
  const f = await fixture(t, "unary", true);
  const response = await f.request("/v1/proxy/google-gemini/embed_content", { pathParams: { model: wire.unary.model }, body: wire.unary.request });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
  assert.equal(f.sent.length, 0);
});
