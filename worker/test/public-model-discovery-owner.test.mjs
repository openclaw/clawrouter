import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot, upstreamAuth } = await import("../providers.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { preparePublicDiscoveryOwner } = await import("../public-model-discovery-owner.ts");

async function setup(t) {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === "chutes")); assert.ok(source);
  snapshot.providers = original.filter(provider => provider.id !== source.id); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { pooled: true, providerId: source.id, configure(provider) {
    Object.assign(provider, source);
    provider.models = ["one", "two"].map(id => ({ id: `chutes/${id}`, upstream: id, capabilities: [], pricing: null, pricing_ref: null }));
  } });
  f.policy.models = ["chutes/one", "chutes/two"];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const endpoint = { id: "models", method: "GET", methods: ["GET"], path: "/models", path_params: [], path_param_styles: {},
    query: {}, headers: {}, request_format: "chutes.models", response_format: "chutes.models", native_proxy: true };
  const request = new Request("https://router.example/v1/native/chutes/models", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } });
  const auth = await authenticateProxyKey(request.headers, f.env); assert.ok(!(auth instanceof Response));
  const selection = { provider: f.provider, endpoint, method: "GET", model: null, capability: "models.list", pathParams: {}, body: {} };
  const upstream = await upstreamAuth(f.provider, auth, f.env, new Set(), null, false, undefined, { provider: f.provider, endpoint, mode: "http" });
  Object.assign(f, { request, auth, selection, upstream });
  f.prepare = () => preparePublicDiscoveryOwner(request, f.env, auth, selection, upstream);
  t.after(f.drain); return f;
}

test("public catalog owner exposes no inference credentials and rechecks metadata without materialization", async t => {
  const f = await setup(t), prepared = await f.prepare(), paths = [], namespace = f.env.GRANT_CREDENTIALS;
  f.env.GRANT_CREDENTIALS = { ...namespace, get(id) {
    const owner = namespace.get(id); return { fetch(url, init) { paths.push(new URL(url).pathname); return owner.fetch(url, init); } };
  } };
  assert.deepEqual(Object.keys(prepared).sort(), ["allows", "inferenceBaseUrl", "permittedModelIds", "providerId", "revalidateAccount"]);
  assert.doesNotMatch(JSON.stringify(prepared), /synthetic-original-key|credential|authorization/);
  await prepared.revalidateAccount(new AbortController().signal);
  assert.deepEqual(paths, ["/inspect"]); assert.equal(f.sent.length, 0);
});

test("public catalog filtering tightens after current-policy authorization and never expands frozen IDs", async t => {
  const f = await setup(t), prepared = await f.prepare();
  await prepared.revalidateAccount(new AbortController().signal);
  assert.equal(prepared.allows("one"), true); assert.equal(prepared.allows("two"), true);
  f.policy.models = ["chutes/two", "chutes/three"];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await prepared.revalidateAccount(new AbortController().signal);
  assert.equal(prepared.allows("one"), false); assert.equal(prepared.allows("two"), true); assert.equal(prepared.allows("three"), false);
  assert.deepEqual([...prepared.permittedModelIds], ["one", "two"]); assert.equal(f.sent.length, 0);
});

for (const change of ["caller", "policy", "grant-disabled", "grant-replaced", "grant-policy"]) test(`public catalog revalidation denies changed ${change} authority`, async t => {
  const f = await setup(t), prepared = await f.prepare();
  await prepared.revalidateAccount(new AbortController().signal);
  if (change === "caller") await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "revoke", credentialId: "fixture" });
  if (change === "policy") { f.policy.enabled = false; await f.authority("/policies/put", { policyId: "fixture", policy: f.policy }); }
  if (change === "grant-policy") {
    f.policy.grantRouting = { eligibleGrants: { chutes: ["unrelated"] }, environmentFallback: true };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  if (change.startsWith("grant-") && change !== "grant-policy") await putGrantCredentials(f.env, grantKey,
    { provider: "chutes", kind: "api_key", enabled: change !== "grant-disabled", credential: "synthetic-replacement-key" });
  await assert.rejects(prepared.revalidateAccount(new AbortController().signal)); assert.equal(f.sent.length, 0);
});

test("public catalog ownership rejects forged caller proof and environment substitution", async t => {
  const f = await setup(t);
  await assert.rejects(preparePublicDiscoveryOwner(f.request, f.env, { ...f.auth }, f.selection, f.upstream));
  await assert.rejects(preparePublicDiscoveryOwner(f.request, f.env, f.auth, f.selection, { ...f.upstream, grant: null, grantKey: null }));
  assert.equal(f.sent.length, 0);
});
