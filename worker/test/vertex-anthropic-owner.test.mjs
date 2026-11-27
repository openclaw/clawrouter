import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { vertexAuthorization } from "./vertex-runtime-fixture.mjs";
const { materializeGrantCredentials, putGrantCredentials, inspectGrantCredentials, revokeGrantCredentials, secretlessGrant } = await import("../grant-credentials.ts");
const { readVertexAnthropicBinding } = await import("../vertex-anthropic-binding.ts");
const { routingProjection } = await import("../grant-projection.ts");
const key = "oauth/fixture/vertex";
const grant = patch => ({ provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer", accessToken: "synthetic-vertex-access",
  expiresAt: new Date(Date.now() + 3600000).toISOString(), ...patch });
function setup() {
  const values = new Map();
  const env = attachGrantCredentialNamespace({ POLICY_KV: {
    async get(k, type) { const v = values.get(k) ?? null; return v === null ? null : type === "text" ? JSON.stringify(v) : structuredClone(v); },
    async put(k, value) { values.set(k, JSON.parse(value)); },
  } }, { kvValues: values });
  return { env, values, put: (g = grant(), binding = vertexAuthorization(), preserve = false) =>
    putGrantCredentials(env, key, g, preserve, undefined, undefined, undefined, undefined, binding),
    materialize: projection => materializeGrantCredentials(env, key, projection, "anthropic-vertex", null, false) };
}
test("Vertex binding is strict and reuses fixed resource grammar", () => {
  assert.deepEqual(readVertexAnthropicBinding(vertexAuthorization()), vertexAuthorization());
  for (const patch of [{ version: "future" }, { source: "service_account" }, { source: "api_key" }, { project: "../foreign" },
    { location: "us-east5.foreign.invalid" }, { project: "" }, { location: null }, { resource: "https://foreign.invalid" }, { model: "foreign" }, { allowed: true }])
    assert.equal(readVertexAnthropicBinding({ ...vertexAuthorization(), ...patch }), null);
});
test("Vertex legacy, OAuth completion and forged metadata never attest resource authority", async () => {
  const f = setup(), forged = grant({ vertexAnthropicBinding: vertexAuthorization() });
  const result = await putGrantCredentials(f.env, key, forged);
  assert.equal(result.vertexAnthropicBinding, null); assert.equal((await f.materialize(result)).vertexAnthropicBinding, null);
  assert.equal(secretlessGrant(forged).vertexAnthropicBinding, null); assert.equal(routingProjection(forged).vertexAnthropicBinding, null);
  await f.put();
  const imported = await putGrantCredentials(f.env, key, grant(), true, undefined, "clawrouter_oauth");
  assert.equal(imported.vertexAnthropicBinding, null);
});
test("Vertex omission preserves exact credential; removal, expiry and resource replacement invalidate", async () => {
  const f = setup(), original = await f.put();
  assert.equal(JSON.stringify(original).includes("synthetic-vertex-access"), false);
  assert.deepEqual(routingProjection(original).vertexAnthropicBinding, vertexAuthorization());
  const same = await putGrantCredentials(f.env, key, { ...original, label: "renamed" }, true);
  assert.deepEqual(same.vertexAnthropicBinding, vertexAuthorization()); assert.equal(same.credentialLineage, original.credentialLineage);
  const removed = await f.put(same, null, true); assert.equal(removed.vertexAnthropicBinding, null); assert.notEqual(removed.credentialLineage, same.credentialLineage);
  for (const edit of [{ accountId: "foreign" }, { accessToken: "synthetic-replacement" }, { expiresAt: new Date(Date.now() + 7200000).toISOString() }]) {
    const before = await f.put(), after = await putGrantCredentials(f.env, key, { ...before, ...edit }, true);
    assert.equal(after.vertexAnthropicBinding, null); assert.notEqual(after.credentialLineage, before.credentialLineage);
  }
  const before = await f.put(), changed = await f.put(before, vertexAuthorization("eu"), true);
  assert.notEqual(changed.credentialLineage, before.credentialLineage); assert.equal(changed.vertexAnthropicBinding.location, "eu");
});
for (const patch of [{ provider: "anthropic" }, { kind: "api_key" }, { credential: "synthetic-mixed" },
  { credentials: { arbitrary: "synthetic-map" } }, { refreshToken: "synthetic-refresh" }, { refresh: { tokenUrl: "https://oauth2.googleapis.com/token" } },
  { subscription: { subject: "plan" } }, { expiresAt: null }, { tokenType: "Basic" }, { accessToken: "invalid\r\nsecret" }])
  test(`Vertex rejects ambiguous or unqualified credential source ${Object.keys(patch)[0]}`, async () => {
    const f = setup(); await assert.rejects(f.put(grant(patch)), error => !String(error).includes("synthetic-mixed") && !String(error).includes("invalid\r\nsecret"));
  });
test("Vertex materializes original access token without refresh and owner revocation stays authoritative", async t => {
  const f = setup(); let calls = 0; t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("unexpected external call"); });
  const original = await f.put(), materialized = await f.materialize(original);
  assert.equal(materialized.accessToken, "synthetic-vertex-access"); assert.equal(materialized.refreshToken, undefined);
  assert.equal(materialized.credentialGeneration, original.credentialGeneration); assert.equal(calls, 0);
  await revokeGrantCredentials(f.env, key); await assert.rejects(f.materialize(original));
  const revoked = await inspectGrantCredentials(f.env, key); assert.equal(revoked.vertexAnthropicBinding, null); assert.equal(calls, 0);
});
