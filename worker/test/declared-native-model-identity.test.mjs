import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { providerById, providerModel } = await import("../providers.ts");
const { prepareNativeRequest } = await import("../proxy-selection.ts");
const publicId = "particle/particle-ai/particle-1", nativeId = "particle-ai/particle-1", physicalId = "particle-1";
const chat = { model: nativeId, messages: [{ role: "user", content: "Synthetic prompt." }] };
const completion = { model: physicalId, choices: [{ message: { role: "assistant", content: "Synthetic answer." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };

function source() { return structuredClone(providerById("particle")); }
function endpoint(provider) { return provider.endpoints.find(value => value.id === "chat_completions"); }
async function setup(t) {
  const provider = source(); assert.ok(provider);
  const f = await fixture(t, { providerId: "particle", pooled: true, configure(value) { Object.assign(value, provider); } });
  f.env.PARTICLE_API_KEY = "synthetic-unselected-key";
  f.policy.models = [publicId]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = () => Response.json(completion);
  return f;
}

test("Particle's exact declared native identity retains its public policy ID and physical wire alias", () => {
  const provider = source(), declared = provider.models.find(model => model.id === publicId), route = endpoint(provider);
  for (const value of [publicId, nativeId, physicalId]) {
    assert.deepEqual(providerModel(provider, value, route, true), declared);
    const prepared = prepareNativeRequest(provider, route, { ...chat, model: value }, route.path, {});
    assert.equal(prepared.model.id, publicId); assert.equal(prepared.model.upstream, physicalId);
    assert.deepEqual(prepared.body, { ...chat, model: physicalId });
  }
});

for (const route of ["native", "manifest", "unified"]) for (const stream of [false, true]) {
  test(`Particle ${route} ${stream ? "SSE" : "JSON"} honors the full public allowlist and original selected key`, async t => {
    const f = await setup(t), wire = `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [] })}\n\ndata: [DONE]\n\n`;
    f.upstream = async request => {
      assert.equal(request.url, "https://api.particle.ai/v1/chat/completions"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
      assert.deepEqual(await request.json(), { ...chat, model: physicalId, stream });
      return stream ? new Response(wire, { headers: { "content-type": "text/event-stream" } }) : Response.json(completion);
    };
    const body = { ...chat, model: route === "native" ? nativeId : publicId, stream };
    const response = await f.call(route === "native" ? "/v1/native/particle/chat/completions"
      : route === "manifest" ? "/v1/proxy/particle/chat_completions" : "/v1/chat/completions", route === "manifest" ? { body } : body);
    assert.equal(response.status, 200, await response.clone().text());
    if (stream) assert.equal(await response.text(), wire); else assert.deepEqual(await response.json(), completion);
    assert.equal(f.sent.length, 1); await f.drain(); const rows = await f.events(); assert.equal(rows.length, 1);
    assert.equal(rows[0].model, publicId);
    assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].actual_cost_micros], [7, 3, 700]);
  });
}

test("ambiguous registered native identities deny before opaque passthrough", async t => {
  const f = await setup(t), declared = f.provider.models.find(model => model.id === publicId);
  f.provider.routing.modelPrefixes.push("particle-alias/");
  f.provider.models.push({ ...declared, id: `particle-alias/${nativeId}`, upstream: "different-physical-model" });
  assert.equal(providerModel(f.provider, nativeId, endpoint(f.provider), true), null);
  const response = await f.call("/v1/native/particle/chat/completions", chat);
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "model_capability_unsupported");
  assert.equal(f.sent.length, 0);
});

test("the native identity lookup uses only this provider's declared prefixes", () => {
  const provider = source(), route = endpoint(provider);
  provider.models.find(model => model.id === publicId).id = `foreign/${nativeId}`;
  const opaque = providerModel(provider, nativeId, route, true);
  assert.equal(opaque.id, nativeId); assert.equal(opaque.upstream, nativeId); assert.equal(opaque.pricing, null);
  assert.equal(opaque.nativeCapabilities, undefined);
  assert.equal(providerModel(provider, nativeId, { ...route, modelPassthrough: undefined }, true), null);
});

for (const id of ["azure-openai", "microsoft-foundry"]) test(`${id} deployment templates keep the original opaque native identity`, () => {
  const provider = providerById(id), declared = provider.models.find(model => model.upstream === "${deployment}"); assert.ok(declared);
  const route = provider.endpoints.find(value => value.id === "chat_completions"); assert.ok(route);
  const opaque = providerModel(provider, "deployment", route, true);
  assert.equal(opaque.id, "deployment"); assert.equal(opaque.upstream, "deployment");
  assert.equal(opaque.pricing, route.modelPassthrough.pricing);
  assert.equal(opaque.nativeCapabilities, undefined);
  assert.equal(providerModel(provider, declared.id, route, true).id, declared.id);
  const prepared = prepareNativeRequest(provider, route, { ...chat, model: "deployment" }, route.path.replace("${deployment}", "deployment"), {});
  assert.equal(prepared.model.id, "deployment"); assert.equal(prepared.model.upstream, "deployment");
});

test("a templated public ID does not become a finite native model declaration", () => {
  const provider = source(), route = endpoint(provider);
  provider.models.find(model => model.id === publicId).id = "particle/${model}";
  const opaque = providerModel(provider, "${model}", route, true);
  assert.equal(opaque.id, "${model}"); assert.equal(opaque.upstream, "${model}"); assert.equal(opaque.pricing, null);
});

for (const value of ["foreign/particle-ai/particle-1", "particle/particle-ai/particle-unknown", "particle-ai/undeclared",
  "Particle-ai/particle-1", " particle-ai/particle-1", "particle-ai/particle-1\n", "particle-ai%2Fparticle-1",
  "particle-ai//particle-1", "particle/particle/particle-ai/particle-1", "", 7, null]) {
  test(`undeclared or malformed native identity cannot borrow the registered policy (${JSON.stringify(value)})`, async t => {
    const f = await setup(t);
    const response = await f.call("/v1/native/particle/chat/completions", { ...chat, model: value });
    assert.ok(response.status >= 400); assert.equal(f.sent.length, 0); await response.text();
    await f.drain(); assert.ok((await f.events()).every(row => row.actual_cost_micros === 0));
  });
}

test("an explicitly permitted opaque native ID remains unchanged and does not inherit registered facts", async t => {
  const f = await setup(t), value = "particle/synthetic-tenant-model";
  const opaque = providerModel(f.provider, value, endpoint(f.provider), true);
  assert.equal(opaque.id, value); assert.equal(opaque.upstream, value); assert.equal(opaque.pricing, null);
  assert.equal(opaque.nativeCapabilities, undefined);
  f.policy.models = [value]; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.upstream = async request => { assert.equal((await request.json()).model, value); return Response.json({ ...completion, model: value }); };
  const response = await f.call("/v1/native/particle/chat/completions", { ...chat, model: value });
  assert.equal(response.status, 200, await response.clone().text()); await response.text(); assert.equal(f.sent.length, 1);
});

test("native identity resolution does not widen endpoint capability or dollar admission", async t => {
  const f = await setup(t);
  delete f.policy.requestCostMicros; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const unpriced = await f.call("/v1/native/particle/chat/completions", chat);
  assert.equal(unpriced.status, 400); assert.equal((await unpriced.json()).error.code, "pricing_required"); assert.equal(f.sent.length, 0);
  f.provider.models.find(model => model.id === publicId).capabilities = ["llm.embeddings"];
  const incompatible = await f.call("/v1/native/particle/chat/completions", chat);
  assert.equal(incompatible.status, 400); assert.equal((await incompatible.json()).error.code, "model_capability_unsupported"); assert.equal(f.sent.length, 0);
});

for (const id of ["openai", "gmi", "deepinfra", "nvidia"]) test(`${id} retains literal registered native and unified model resolution`, () => {
  const provider = providerById(id), declared = provider.models.find(model => model.capabilities.includes("llm.chat"));
  assert.ok(declared);
  const route = provider.endpoints.find(value => value.request_format === "openai.chat_completions"); assert.ok(route);
  assert.equal(providerModel(provider, declared.id, route).id, declared.id);
  assert.equal(providerModel(provider, declared.id, route, true).id, declared.id);
  assert.equal(providerModel(provider, declared.upstream, route, true).upstream, declared.upstream);
});
