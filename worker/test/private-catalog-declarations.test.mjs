import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { revokeGrantCredentials } = await import("../grant-credentials.ts");
const bases = { baseten: "https://inference.baseten.co/v1", arcee: "https://api.arcee.ai/api/v1",
  novita: "https://api.novita.ai/openai/v1" };
const sources = Object.fromEntries(Object.keys(bases).map(id => [id,
  parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const compile = source => compileProviderSnapshot([source]);
const compiled = id => compile(sources[id]).providers[0];
const row = (provider, id) => provider === "arcee" ? { id, name: id, context_length: 1024, max_output_length: 512,
  input_modalities: ["text"], output_modalities: ["text"] }
  : provider === "novita" ? { id, object: "model", created: 1, context_size: 1024 } : { id };

async function setup(t, id) {
  const f = await fixture(t, { pooled: true, providerId: id, compiledProvider: true,
    configure: provider => Object.assign(provider, compiled(id)) });
  f.model = f.provider.models.find(model => model.capabilities.includes("llm.chat")); assert.ok(f.model);
  f.policy.models = [f.model.id];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  for (const name of f.provider.config_keys) f.env[name] = "synthetic-environment-cannot-replace-owner";
  f.reply = () => Response.json({ data: [f.model.upstream, "synthetic-unqualified-model"].map(upstream => row(id, upstream)) });
  f.upstream = request => f.reply(request);
  f.request = (manifest = false, query = "", body = null) => f.call(
    `${manifest ? `/v1/proxy/${id}/models_list` : `/v1/native/${id}/models`}${query}`, body,
    { headers: { "x-api-key": "synthetic-caller-key", "x-account": "foreign" } });
  t.after(f.drain); return f;
}

for (const id of Object.keys(bases)) {
  test(`${id} catalog declaration preserves all inference cards, prices, auth and Chat bytes in compilation`, () => {
    const source = sources[id], before = structuredClone(source);
    delete before.endpoints.models_list;
    before.capabilities = before.capabilities.filter(value => value.endpoint !== "models_list");
    const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
    assert.deepEqual(result.model_index, baseline.model_index); assert.deepEqual(provider.models, original.models);
    for (const key of ["auth", "adapter", "routing", "base_urls", "billing", "config_keys", "optional_config_keys"])
      assert.deepEqual(provider[key], original[key]);
    assert.deepEqual(provider.endpoints.filter(value => value.id !== "models_list"), original.endpoints);
    assert.deepEqual(provider.capabilities.filter(value => value.endpoint !== "models_list"), original.capabilities);
    const endpoint = provider.endpoints.find(value => value.id === "models_list");
    assert.equal(endpoint.path, "/models"); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
    assert.equal(endpoint.request_format, `${id}.models`); assert.equal(endpoint.response_format, `${id}.models`);
    assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.upstreamPath, undefined);
    assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
    assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
    assert.ok(provider.models.every(model => !model.capabilities.includes("models.list")));
  });

  for (const manifest of [false, true]) test(`${id} compiled ${manifest ? "manifest" : "native"} catalog uses the original owner key and native filtered envelope`, async t => {
    const f = await setup(t, id), response = await f.request(manifest);
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    assert.deepEqual(await response.json(), { data: [row(id, f.model.upstream)] });
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(f.sent.length, 1); const request = f.sent[0];
    assert.equal(request.url, `${bases[id]}/models`); assert.equal(request.method, "GET"); assert.equal(request.body, null);
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-account"), null);
    assert.equal(request.redirect, "manual");
    await f.drain(); const events = await f.events(); assert.ok(events.length >= 1);
    assert.ok(events.every(event => event.actual_cost_micros === 0 && event.reserved_cost_micros === 0));
  });

  test(`${id} compiled empty native inventory remains empty without seed or price fallback`, async t => {
    const f = await setup(t, id); f.reply = () => Response.json({ data: [] });
    for (const manifest of [false, true]) {
      const response = await f.request(manifest); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
      assert.deepEqual(await response.json(), { data: [] });
    }
    assert.equal(f.sent.length, 2);
  });

  test(`${id} compiled catalog rejects caller query, body and method substitutions before egress`, async t => {
    const f = await setup(t, id);
    for (const manifest of [false, true]) for (const query of ["?page=2", "?url=https://other.example", "?api_key=synthetic"]) {
      const response = await f.request(manifest, query); assert.ok(response.status >= 400, await response.text());
    }
    const nativePost = await f.request(false, "", { model: f.model.upstream });
    assert.ok(nativePost.status >= 400, await nativePost.text());
    for (const body of [{ body: { account: "other" } }, { method: "POST", body: {} }, { query: { page: "2" } }]) {
      const response = await f.request(true, "", body); assert.ok(response.status >= 400, await response.text());
    }
    assert.equal(f.sent.length, 0);
  });

  test(`${id} compiled catalog cannot replace a revoked owner with the configured environment key`, async t => {
    const f = await setup(t, id), warm = await f.request();
    assert.equal(warm.status, 200, warm.ok ? undefined : await warm.text()); await warm.json(); await f.drain();
    await revokeGrantCredentials(f.env, grantKey);
    const denied = await f.request(true); assert.ok([403, 503].includes(denied.status), await denied.text());
    assert.equal(f.sent.length, 1);
  });
}

test("compiled Baseten catalog excludes every decision-models row even under unrestricted caller model policy", async t => {
  const f = await setup(t, "baseten"); f.policy.models = null;
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const decisionIds = f.provider.models.filter(model => model.upstream.startsWith("decision-models/")).map(model => model.upstream);
  assert.ok(decisionIds.length);
  f.reply = () => Response.json({ data: [f.model.upstream, ...decisionIds, "decision-models/synthetic-unknown"].map(id => ({ id })) });
  const response = await f.request(); assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  assert.deepEqual(await response.json(), { data: [{ id: f.model.upstream }] }); assert.equal(f.sent.length, 1);
});
