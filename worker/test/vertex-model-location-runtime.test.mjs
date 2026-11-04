import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { configureVertex, vertexAuthorization, vertexBody, vertexJson, vertexModel, vertexModelId } from "./vertex-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { inspectGrantCredentials } = await import("../grant-credentials.ts");
const { grantSupports } = await import("../provider-auth.ts");
const { bodyBudgetCharged } = await import("../body-budget.ts");
const native = "/v1/native/anthropic-vertex/v1/messages", manifest = "/v1/proxy/anthropic-vertex/messages";
const unsupportedModel = "claude-opus-4-6", unsupportedId = "anthropic-vertex/" + unsupportedModel;

async function setup(t, location = "us-east5", nativeProxy = true) {
  const provider = structuredClone(snapshot.providers.find(p => p.id === "anthropic"));
  configureVertex(provider); provider.endpoints[0].native_proxy = nativeProxy;
  provider.models.push({ ...provider.models[0], id: unsupportedId, upstream: unsupportedModel });
  const f = await fixture(t, { providerId: "anthropic-vertex", configure(target) { Object.assign(target, provider); } });
  f.env.GOOGLE_API_KEY = "synthetic-forbidden-environment";
  f.env.ANTHROPIC_API_KEY = "synthetic-forbidden-anthropic";
  f.env.CLAWROUTER_ADMIN_TOKEN_SHA256 = await sha256Hex("synthetic-admin");
  f.put = async body => {
    const response = await f.call("/v1/admin/upstream-grants/policies/fixture/replicate", body,
      { method: "PUT", headers: { authorization: "Bearer synthetic-admin" } });
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
  };
  await f.put({ provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "synthetic-vertex-access",
    expiresAt: new Date(Date.now() + 3600000).toISOString(), vertexAnthropicAuthorization: vertexAuthorization(location) });
  f.policy.models = [vertexModelId, unsupportedId];
  f.policy.grantRouting = { eligibleGrants: { "anthropic-vertex": ["replicate"] }, environmentFallback: false };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.request = (envelope = false, upstream = vertexModel, id = vertexModelId) => f.call(envelope ? manifest : native,
    envelope ? { body: { ...vertexBody(), model: id } } : { ...vertexBody(), model: upstream });
  f.catalog = async () => {
    const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
    const provider = (await response.json()).providers.find(p => p.id === "anthropic-vertex"); assert.ok(provider); return provider;
  };
  f.upstream = () => Response.json(vertexJson());
  f.afterDispatch = change => {
    const get = f.env.BUDGET_LEDGER.get; let changed = false;
    f.env.BUDGET_LEDGER.get = id => { const stub = get(id); return { async fetch(url, init) {
      const response = await stub.fetch(url, init);
      if (new URL(url).pathname === "/dispatch" && !changed) { changed = true; await change(); }
      return response;
    } }; };
  };
  t.after(async () => { await f.drain(); assert.equal(bodyBudgetCharged(), 0); });
  return f;
}
async function denied(f, response) {
  assert.notEqual(response.status, 200, await response.clone().text());
  assert.doesNotMatch(await response.text(), /synthetic-(?:vertex-access|forbidden)/);
  await f.drain(); assert.equal(f.sent.length, 0);
  for (const event of await f.events()) assert.equal(event.actual_cost_micros, 0);
}

for (const location of ["global", "us-east5", "europe-west1", "asia-southeast1"]) for (const nativeProxy of [false, true])
  test(`Vertex ${nativeProxy ? "native" : "manifest"} catalog binds Sonnet support to original owner location ${location}`, async t => {
    const f = await setup(t, location, nativeProxy), catalog = await f.catalog();
    assert.deepEqual(catalog.models.map(m => m.id), [vertexModelId]);
    const offers = catalog.offers.filter(o => o.modelId === vertexModelId && o.eligible);
    assert.ok(offers.some(o => o.routeKind === (nativeProxy ? "native" : "manifest")));
    assert.ok(catalog.offers.filter(o => o.modelId === unsupportedId).every(o => !o.eligible));
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-project|vertexAnthropicBinding|synthetic-vertex-access/);
    assert.equal(f.sent.length, 0);
  });

for (const location of ["us", "eu", "us-central1", "europe-west4", "asia-east1"]) for (const envelope of [false, true])
  test(`Vertex unqualified location ${location} has no offer or ${envelope ? "manifest" : "native"} egress`, async t => {
    const f = await setup(t, location, !envelope), catalog = await f.catalog();
    assert.ok(!catalog.models.some(m => m.id === vertexModelId));
    assert.ok(catalog.offers.filter(o => o.modelId === vertexModelId).every(o => !o.eligible));
    await denied(f, await f.request(envelope));
  });

for (const envelope of [false, true])
  test(`Vertex known but unqualified model cannot inherit Sonnet ${envelope ? "manifest" : "native"} support`, async t => {
    const f = await setup(t, "us-east5", !envelope);
    await denied(f, await f.request(envelope, unsupportedModel, unsupportedId));
  });

test("Vertex grant support requires one exact registered model identity", async t => {
  const f = await setup(t), grant = await inspectGrantCredentials(f.env, grantKey);
  const requirement = { provider: f.provider, endpoint: f.provider.endpoints[0], mode: "http" };
  for (const model of [vertexModelId, vertexModel]) assert.equal(grantSupports({ ...requirement, model }, grant), true);
  for (const model of [undefined, null, unsupportedId, unsupportedModel, "claude-sonnet-4-6@20260101", "CLAUDE-SONNET-4-6", " claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"])
    assert.equal(grantSupports({ ...requirement, model }, grant), false);
  f.provider.models.push({ ...f.provider.models[0], id: "anthropic-vertex/ambiguous-fixture" });
  assert.equal(grantSupports({ ...requirement, model: vertexModel }, grant), false);
  f.provider.models = f.provider.models.filter(model => model.upstream !== vertexModel);
  assert.equal(grantSupports({ ...requirement, model: vertexModelId }, grant), false);
  assert.equal(f.sent.length, 0);
});

for (const envelope of [false, true]) for (const location of ["global", "eu"])
  test(`Vertex final ${envelope ? "manifest" : "native"} owner check cannot adopt changed location ${location}`, async t => {
    const f = await setup(t, "us-east5", !envelope); let changed = false;
    f.afterDispatch(async () => { await f.put({ vertexAnthropicAuthorization: vertexAuthorization(location) }); changed = true; });
    await denied(f, await f.request(envelope)); assert.equal(changed, true);
  });

test("Vertex discovery policy filtering does not turn a supported location into model authority", async t => {
  const f = await setup(t), catalog = await f.catalog();
  assert.ok(catalog.offers.some(o => o.modelId === vertexModelId && o.eligible));
  f.policy.models = [unsupportedId];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const deniedCatalog = await f.catalog();
  assert.ok(deniedCatalog.offers.every(o => !o.eligible));
  await denied(f, await f.request());
});

test("Vertex cannot borrow another grant's qualified location", async t => {
  const f = await setup(t, "us");
  const response = await f.call("/v1/admin/upstream-grants/policies/fixture/other", {
    provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "synthetic-other-access",
    expiresAt: new Date(Date.now() + 3600000).toISOString(), vertexAnthropicAuthorization: vertexAuthorization("global"),
  }, { method: "PUT", headers: { authorization: "Bearer synthetic-admin" } });
  assert.equal(response.status, 200, await response.clone().text()); await response.text();
  const catalog = await f.catalog(); assert.ok(catalog.offers.every(o => !o.eligible));
  await denied(f, await f.request());
});
