import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const [compiled] = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/requesty.provider.yaml", import.meta.url), "utf8"))]).providers;
const bare = "synthetic-policy", hosted = "hosting/synthetic-policy";
const observation = { id: bare, api: "chat", input_price: "2e-7", output_price: 0, supports_vision: false };
const allowed = [observation, { id: hosted, api: "chat" }];
const payload = { data: [
  { ...observation, id: ` ${bare} ` }, { id: bare, api: "chat", context_window: 999 },
  allowed[1], { id: "synthetic-hidden", api: "chat" }, { id: `${bare}@eu`, api: "chat" },
  { id: "synthetic-embedding", api: "embeddings" },
] };

async function setup(t, { pooled = true } = {}) {
  const f = await fixture(t, { providerId: "requesty", pooled, configure(provider) {
    Object.assign(provider, structuredClone(compiled));
  } });
  f.env.REQUESTY_API_KEY = "synthetic-environment-key";
  f.env.OPENAI_API_KEY = "synthetic-unrelated-key";
  f.policy.models = [bare, hosted].map(id => `requesty/${id}`);
  f.policy.grantRouting = { environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json(payload);
  f.route = manifest => manifest ? "/v1/proxy/requesty/models_managed" : "/v1/native/requesty/models/managed";
  f.request = (manifest, suffix = "", extra = {}) => f.call(f.route(manifest) + suffix, null, extra);
  return f;
}

test("Requesty declaration exposes only the paired managed list beside unchanged Chat and unknown model facts", () => {
  const endpoint = compiled.endpoints.find(value => value.id === "models_managed");
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
  assert.equal(endpoint.path, "/models/managed"); assert.deepEqual(endpoint.path_params, []);
  assert.equal(endpoint.request_format, "requesty.models_managed"); assert.equal(endpoint.response_format, "requesty.models_managed");
  assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.auth, null); assert.equal(endpoint.streaming, null);
  assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.headers, {}); assert.deepEqual(endpoint.request_headers, []);
  for (const key of ["upstreamPath", "lifecycle", "responsesLifecycle", "modelPassthrough", "requestPricing"]) assert.equal(endpoint[key], undefined);
  assert.equal(compiled.base_urls.default, "https://router.requesty.ai/v1");
  assert.deepEqual(compiled.config_keys, ["REQUESTY_API_KEY"]);
  assert.deepEqual(compiled.auth.schemes, [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key", required: true }]);
  const chat = compiled.endpoints.find(value => value.id === "chat_completions");
  assert.equal(chat.path, "/chat/completions"); assert.equal(chat.streaming, "sse");
  assert.deepEqual(chat.modelPassthrough, { pricing_ref: null, pricing: null });
  assert.equal(compiled.models.length, 1); assert.equal(compiled.models[0].id, "requesty/openai/gpt-6-luna");
  assert.equal(compiled.models[0].upstream, "openai/gpt-6-luna"); assert.equal(compiled.models[0].pricing, null);
  assert.deepEqual(compiled.models[0].capabilities, ["llm.chat"]);
  const offer = createRouteCatalog([compiled]).manifestProxy.find(value => value.endpoint === "models_managed");
  assert.equal(offer.route, "/v1/proxy/requesty/models_managed"); assert.deepEqual(offer.methods, ["GET"]);
  assert.deepEqual(offer.models, []); assert.equal(offer.sampleModel, null);
});

for (const manifest of [false, true]) {
  const mode = manifest ? "manifest" : "native";
  test(`Requesty declared ${mode} route preserves the original global key and native observations`, async t => {
    const f = await setup(t);
    const response = await f.request(manifest, "", { headers: { "x-api-key": "synthetic-caller-key", "x-upstream-url": "https://foreign.example" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { data: allowed }); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, "https://router.requesty.ai/v1/models/managed"); assert.equal(request.method, "GET");
    assert.equal(request.body, null); assert.equal(request.redirect, "manual");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]);
    assert.equal(f.provider.models.length, 1); assert.equal(f.provider.models[0].pricing, null);
    await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].cost_basis, "none");
  });

  test(`Requesty declared ${mode} route keeps empty inventory authoritative`, async t => {
    const f = await setup(t); f.upstream = () => Response.json({ data: [] });
    const response = await f.request(manifest); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [] }); assert.equal(f.sent.length, 1);
  });

  test(`Requesty declared ${mode} route denies caller query overrides before fetch`, async t => {
    const f = await setup(t);
    for (const query of ["?page=1", "?limit=1", "?model=synthetic-hidden", "?url=https://foreign.example", "?api_key=synthetic-caller-key"]) {
      const response = await f.request(manifest, query); assert.equal(response.status, 400); await response.text();
    }
    assert.equal(f.sent.length, 0);
  });

  for (const models of [[], null]) test(`Requesty declared ${mode} route intersects final ${models === null ? "broadened" : "narrowed"} policy`, async t => {
    const f = await setup(t); let parsed = false;
    f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
      f.policy.models = models; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
      parsed = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.equal(response.status, 200); assert.equal(parsed, true);
    assert.deepEqual(await response.json(), { data: models === null ? allowed : [] }); assert.equal(f.sent.length, 1);
  });

  test(`Requesty declared ${mode} route cannot substitute environment credentials for a missing owner`, async t => {
    const f = await setup(t, { pooled: false });
    const response = await f.request(manifest); assert.equal(response.status, 503, await response.clone().text());
    await response.text(); assert.equal(f.sent.length, 0);
  });

  test(`Requesty declared ${mode} route withholds metadata after original-owner revocation during parsing`, async t => {
    const f = await setup(t);
    f.upstream = () => new Response(new ReadableStream({ async pull(controller) {
      await revokeGrantCredentials(f.env, grantKey);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const response = await f.request(manifest); assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /synthetic-policy|synthetic-original-key/); assert.equal(f.sent.length, 1);
  });
}

test("Requesty declared manifest route rejects a caller body without catalog dispatch", async t => {
  const f = await setup(t), response = await f.call(f.route(true), { body: { model: bare } });
  assert.equal(response.status, 400); await response.text(); assert.equal(f.sent.length, 0);
});
