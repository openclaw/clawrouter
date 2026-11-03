import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { continuationAuthority } from "./continuation-authority.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { authorityCall } = await import("../authority.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const source = parse(readFileSync(new URL("../../providers/together.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([source]);
const stopped = "meta-llama/Llama-3.3-70B-Instruct-Turbo", selected = `together/${stopped}`;
const active = "together/glm-5.2";

async function fixture(t) {
  const provider = structuredClone(compiled.providers[0]);
  const index = snapshot.providers.findIndex(p => p.id === provider.id), previous = snapshot.providers[index];
  assert.notEqual(index, -1);
  snapshot.providers[index] = provider;
  t.after(() => { snapshot.providers[index] = previous; });
  const values = new Map(), pending = [], responses = [], sent = [], events = [];
  const env = { POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["together"], models: null,
    tenantId: "fixture", monthlyBudgetMicros: null, requestCostMicros: 17, retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: "fixture", policyGeneration: "fixture" } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "together", enabled: true }]);
  await putGrantCredentials(env, "oauth/fixture/together", { provider: "together", kind: "api_key", enabled: true, credential: "synthetic-original" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = new Request(url, init); sent.push(request);
    assert.equal(request.url, "https://api.together.xyz/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original");
    const body = await request.json(); assert.equal(body.model, "zai-org/GLM-5.2");
    return Response.json({ id: "fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
  });
  const f = { sent, events,
    async call(path, body) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
      responses.push(response); return response;
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.after(async () => { for (const response of responses) if (!response.bodyUsed) await response.body?.cancel(); await f.drain(); }, { timeout: 10_000 });
  return f;
}

test("Together preserves the frozen retired identity and primary evidence without a live card or replacement tariff", () => {
  const provider = compiled.providers[0], model = provider.models.find(row => row.id === selected);
  assert.equal(model.upstream, stopped);
  assert.deepEqual(model.availability, { version: "clawrouter.model-availability.v1", status: "stopped",
    effectiveAt: "2026-10-22", checkedAt: "2026-11-03",
    sources: ["https://docs.together.ai/docs/deprecations", "https://www.together.ai/models/llama-3-3-70b"] });
  assert.deepEqual(compiled.model_index[selected].availability, model.availability);
  assert.deepEqual(model.capabilities, []); assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  assert.equal(model.nativeCapabilities, undefined); assert.equal(model.availability.servingModel, undefined);
  assert.equal(provider.models[0].id, active);
  assert.equal(provider.endpoints.find(endpoint => endpoint.id === "chat_completions").modelPassthrough.pricing, null);
  const catalog = createRouteCatalog([provider]);
  assert.deepEqual(catalog.openaiCompatible[0].models.map(row => row.id), [active]);
  assert.ok(catalog.manifestProxy.every(route => route.models.every(row => row.id !== selected)));
});

test("actual Together catalogs omit the stopped row while retaining the existing eligible GLM offer", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const catalog = await f.call("/v1/catalog"); assert.equal(catalog.status, 200, await catalog.clone().text());
  const provider = (await catalog.json()).providers.find(row => row.id === "together");
  assert.deepEqual(provider.models.map(row => row.id), [active]);
  assert.ok(provider.offers.some(offer => offer.modelId === active));
  assert.ok(provider.offers.every(offer => offer.modelId !== selected));
  const models = await f.call("/v1/models"); assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map(row => row.id), [active]);
  assert.equal(f.sent.length, 0); await f.drain(); assert.deepEqual(f.events, []);
});

test("Together retirement rejects unified, native and manifest passthrough with zero egress and no charge", { timeout: 10_000 }, async t => {
  const f = await fixture(t), body = model => ({ model, messages: [{ role: "user", content: "fixture" }], max_tokens: 1 });
  const calls = [["/v1/chat/completions", body(selected)]];
  for (const model of [selected, stopped]) {
    calls.push(["/v1/native/together/v1/chat/completions", body(model)]);
    calls.push(["/v1/proxy/together/chat_completions", { body: body(model) }]);
  }
  for (const [path, request] of calls) {
    const response = await f.call(path, request);
    assert.equal(response.status, 400, `${path}: ${await response.clone().text()}`);
    assert.ok((await response.json()).error.code);
  }
  assert.equal(f.sent.length, 0); await f.drain(); assert.deepEqual(f.events, []);
  const response = await f.call("/v1/native/together/v1/chat/completions", body("zai-org/GLM-5.2"));
  assert.equal(response.status, 200, await response.clone().text()); await response.json(); await f.drain();
  assert.equal(f.sent.length, 1);
  const usage = f.events.filter(event => event.type === "clawrouter.usage.v1");
  assert.equal(usage.length, 1); assert.equal(usage[0].actual_cost_micros, 17); assert.equal(usage[0].cost_basis, "policy_fixed");
});
