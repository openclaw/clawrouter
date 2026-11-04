import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
import { vertexAuthorization, vertexBody, vertexJson, vertexSse, vertexModel, vertexModelId } from "./vertex-runtime-fixture.mjs";
const { sha256Hex } = await import("../utils.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const { snapshot } = await import("../providers.ts");

const manifest = parse(readFileSync(new URL("../../providers/anthropic-vertex.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([manifest]), provider = compiled.providers[0];
const native = "/v1/native/anthropic-vertex/v1/messages", proxy = "/v1/proxy/anthropic-vertex/messages";

async function setup(t, { location = "us-east5", qualify = true, fixed = 700 } = {}) {
  const compiledProvider = snapshot.providers.some(candidate => candidate.id === provider.id);
  const f = await fixture(t, { providerId: provider.id, compiledProvider, fixed, configure(target) {
    if (compiledProvider) { assert.deepEqual(target, provider); return; }
    // Source-only qualification uses this exact compiled YAML. Once bundled,
    // consume and compare the actual snapshot without replacing its provider.
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(provider));
  } });
  f.env.GOOGLE_API_KEY = "synthetic-forbidden-google";
  f.env.ANTHROPIC_API_KEY = "synthetic-forbidden-anthropic";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  const response = await f.call("/v1/admin/upstream-grants/policies/fixture/replicate", {
    provider: provider.id, kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "synthetic-vertex-access",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...(qualify ? { vertexAnthropicAuthorization: vertexAuthorization(location) } : {}),
  }, { method: "PUT", headers: { authorization: "Bearer synthetic-admin" } });
  assert.equal(response.status, 200, await response.text());
  f.policy.models = [vertexModelId];
  f.policy.grantRouting = { eligibleGrants: { [provider.id]: ["replicate"] }, environmentFallback: false };
  if (fixed === null) delete f.policy.requestCostMicros;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (envelope = false, body = {}) => f.call(envelope ? proxy : native,
    envelope ? { body: { ...vertexBody(), model: vertexModelId, ...body } } : { ...vertexBody(), ...body });
  f.catalog = async () => {
    const response = await f.call("/v1/catalog", null);
    assert.equal(response.status, 200);
    const row = (await response.json()).providers.find(row => row.id === provider.id);
    assert.ok(row); return row;
  };
  f.upstream = async request => (await request.clone().json()).stream
    ? new Response(vertexSse(), { headers: { "content-type": "text/event-stream" } }) : Response.json(vertexJson());
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}

async function denied(f, response) {
  const text = await response.text();
  assert.notEqual(response.status, 200, text);
  assert.doesNotMatch(text, /synthetic-(?:vertex-access|forbidden)/);
  await f.drain(); assert.equal(f.sent.length, 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}

test("Vertex declaration keeps one exact Messages model, decimal limits and unknown prices", () => {
  assert.equal(provider.id, "anthropic-vertex");
  assert.equal(provider.class, "anthropic_compatible");
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream]), [[vertexModelId, vertexModel]]);
  assert.deepEqual(provider.capabilities, [
    { id: "llm.chat", endpoint: "messages", methods: ["POST"] },
    { id: "llm.messages", endpoint: "messages", methods: ["POST"] },
  ]);
  const model = provider.models[0], endpoint = provider.endpoints[0];
  assert.deepEqual(model.capabilities, ["llm.chat", "llm.messages"]);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  assert.equal(model.endpointPricing.messages.pricing, null);
  const facts = model.nativeCapabilities.endpoints.messages;
  assert.equal(facts.contextWindow, 1_000_000); assert.equal(facts.maxOutputTokens, 128_000);
  assert.deepEqual(facts.sources, ["https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-4-6"]);
  assert.deepEqual(compiled.model_index[vertexModelId].nativeCapabilities, model.nativeCapabilities);
  assert.equal(provider.endpoints.length, 1); assert.equal(endpoint.id, "messages");
  assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]);
  assert.equal(endpoint.path, "/v1/messages"); assert.deepEqual(endpoint.path_params, []);
  assert.equal(endpoint.request_format, "anthropic.messages"); assert.equal(endpoint.response_format, "anthropic.messages");
  assert.equal(endpoint.streaming, "sse"); assert.equal(endpoint.native_proxy, true);
  assert.deepEqual(provider.base_urls, { default: "https://aiplatform.googleapis.com" });
  assert.deepEqual(provider.config_keys, []);
  assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.request_headers, []);
  assert.equal(endpoint.auth, null); assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.upstreamPath, undefined);
  assert.deepEqual(provider.adapter.passthroughHeaders, []); assert.deepEqual(provider.adapter.injectHeaders, {});
});

for (const location of ["global", "us-east5", "europe-west1", "asia-southeast1"]) for (const envelope of [false, true]) for (const stream of [false, true])
  test(`compiled Vertex ${location} ${envelope ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} selects the original owner`, async t => {
    const f = await setup(t, { location }), response = await f.request(envelope, { stream });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), stream ? vertexSse() : JSON.stringify(vertexJson()));
    await f.drain(); assert.equal(f.sent.length, 1);
    const sent = f.sent[0], host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    assert.equal(sent.url, `https://${host}/v1/projects/fixture-project/locations/${location}/publishers/anthropic/models/${vertexModel}:${stream ? "streamRawPredict" : "rawPredict"}`);
    assert.equal(sent.redirect, "manual"); assert.equal(sent.headers.get("authorization"), "Bearer synthetic-vertex-access");
    assert.equal(sent.headers.has("x-api-key"), false); assert.equal(sent.headers.has("anthropic-version"), false);
    const body = await sent.json(); assert.equal(body.model, undefined); assert.equal(body.anthropic_version, "vertex-2023-10-16");
    assert.deepEqual(body.messages, vertexBody().messages);
    const events = await f.events(); assert.equal(events.length, 1);
    assert.equal(events[0].capability, "llm.chat"); assert.equal(events[0].cost_basis, "policy_fixed");
    assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].input_tokens, 4); assert.equal(events[0].output_tokens, 2);
  });

test("compiled Vertex catalog projects Messages facts without prices or private resource authority", async t => {
  const f = await setup(t), catalog = await f.catalog();
  assert.deepEqual(catalog.models.map(model => model.id), [vertexModelId]);
  const model = catalog.models[0];
  assert.equal(model.pricing, null); assert.equal(model.endpointPricing.messages.pricing, null);
  assert.equal(model.nativeCapabilities.endpoints.messages.contextWindow, 1_000_000);
  assert.equal(model.nativeCapabilities.endpoints.messages.maxOutputTokens, 128_000);
  assert.ok(catalog.offers.some(offer => offer.modelId === vertexModelId && offer.endpoint === "messages" && offer.route === native && offer.eligible));
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-project|vertexAnthropicBinding|synthetic-vertex-access/);
  const response = await f.call("/v1/models", null, { headers: { "anthropic-version": "2023-06-01" } });
  assert.equal(response.status, 200);
  const rows = (await response.json()).data;
  assert.deepEqual(rows.map(row => row.id), [vertexModelId]);
  // Legacy Models fields still derive from tariffs; catalog support facts
  // above carry the qualified limits without inventing a price card.
  assert.equal(rows[0].max_input_tokens, null); assert.equal(rows[0].max_tokens, null);
  assert.equal(f.sent.length, 0);
});

for (const envelope of [false, true]) {
  test(`compiled Vertex ${envelope ? "manifest" : "native"} unknown USD denies before materializing credentials`, async t => {
    const f = await setup(t, { fixed: null });
    const get = f.env.GRANT_CREDENTIALS.get; let materializations = 0;
    f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) {
      if (new URL(url).pathname === "/materialize") materializations++;
      return stub.fetch(url, init);
    } }; };
    await denied(f, await f.request(envelope)); assert.equal(materializations, 0);
  });
  test(`compiled Vertex ${envelope ? "manifest" : "native"} cannot borrow environment or unbound bearer authority`, async t => {
    const f = await setup(t, { qualify: false }), catalog = await f.catalog();
    assert.ok(catalog.offers.every(offer => !offer.eligible));
    await denied(f, await f.request(envelope));
  });
  test(`compiled Vertex ${envelope ? "manifest" : "native"} rejects an unqualified owner location`, async t => {
    const f = await setup(t, { location: "us-central1" }), catalog = await f.catalog();
    assert.ok(catalog.offers.every(offer => !offer.eligible));
    await denied(f, await f.request(envelope));
  });
  test(`compiled Vertex ${envelope ? "manifest" : "native"} has no date alias or model passthrough`, async t => {
    const f = await setup(t);
    await denied(f, await f.request(envelope, { model: "claude-sonnet-4-6@20260101" }));
    await denied(f, await f.request(envelope, { model: "anthropic/claude-sonnet-4-6" }));
  });
}
