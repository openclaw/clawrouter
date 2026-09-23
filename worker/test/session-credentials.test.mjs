import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";


const { budgetPrincipal } = await import("../budget-scope.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { sessionCredentialsRequest } = await import("../session-credentials.ts");

import { credential, digest, fixture, policy, session, sha256 } from "./credential-fixture.mjs";

test("session issuance forces ownership and authenticates with the session principal budget scope", async t => {
  const env = await fixture(t);
  const response = await put(env, "self_key", { policyId: "maintainer_access", secretSha256: digest, principalId: "victim@example.com", enabled: false });
  assert.equal(response.status, 200);
  assert.equal(env.credentials.get("self_key").principalId, session.email);
  assert.equal(env.credentials.get("self_key").enabled, true);
  assert.equal(env.credentials.get("self_key").policyGeneration, policy.generation);

  const keyMaterial = "12345678";
  env.credentials.set("self_key", { ...env.credentials.get("self_key"), secretSha256: await sha256(keyMaterial) });
  const auth = await authenticateProxyKey(new Headers({ authorization: `Bearer clawrouter-live-self_key-${keyMaterial}` }), env);
  assert.ok(!(auth instanceof Response));
  assert.equal(auth.principalId, session.email);
  assert.equal(budgetPrincipal(auth), session.email);
});

test("session issuance rejects foreign credential ids", async t => {
  const env = await fixture(t, [["self_key", credential("elsewhere@example.com")]]);
  const response = await put(env, "self_key", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "credential_owned_elsewhere");
  assert.equal(env.credentials.get("self_key").principalId, "elsewhere@example.com");
});

test("session issuance rejects policies outside the effective session bindings", async t => {
  const env = await fixture(t);
  const response = await put(env, "self_key", { policyId: "other_policy", secretSha256: digest });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "credential_policy_not_held");
});

test("session issuance caps enabled principal credentials while allowing rotation", async t => {
  const entries = Array.from({ length: 10 }, (_, index) => [`key_${index}`, credential(session.email)]);
  const env = await fixture(t, entries);
  const blocked = await put(env, "key_new", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "credential_limit_reached");

  const rotated = await put(env, "key_0", { policyId: "maintainer_access", secretSha256: "cd".repeat(32) });
  assert.equal(rotated.status, 200);
  assert.equal(env.credentials.get("key_0").secretSha256, "cd".repeat(32));
});

test("session issuance bounds retained revoked records without reducing the enabled limit", async t => {
  const entries = [
    ["live_key", credential(session.email)],
    ...Array.from({ length: 99 }, (_, index) => [`old_${String(index).padStart(3, "0")}`, { ...credential(session.email), enabled: false }]),
  ];
  const env = await fixture(t, entries);
  const response = await put(env, "key_new", { policyId: "maintainer_access", secretSha256: digest });
  assert.equal(response.status, 200);
  assert.equal(env.credentials.size, 100);
  assert.equal(env.credentials.has("old_000"), false);
  assert.equal(env.credentials.has("key_new"), true);
});

test("session revocation applies only to owned credentials", async t => {
  const env = await fixture(t, [
    ["own_key", credential(session.email)],
    ["other_key", credential("elsewhere@example.com")],
  ]);
  const own = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/own_key/revoke", { method: "POST" }), env, "/v1/session/credentials/own_key/revoke", session);
  assert.equal(own.status, 200);
  assert.equal(env.credentials.get("own_key").enabled, false);

  const foreign = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/other_key/revoke", { method: "POST" }), env, "/v1/session/credentials/other_key/revoke", session);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, "credential_owned_elsewhere");
  assert.equal(env.credentials.get("other_key").enabled, true);
});

test("session credential list returns only the caller's public credential shape", async t => {
  const env = await fixture(t, [
    ["own_key", credential(session.email)],
    ["other_key", credential("elsewhere@example.com")],
  ]);
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials"), env, "/v1/session/credentials", session);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credentials: [{ credentialId: "own_key", policyId: "maintainer_access", enabled: true, active: true }] });
});

test("session credential activity uses the canonical policy after a binding is removed", async t => {
  const env = await fixture(t, [["own_key", credential(session.email)]], { held: false });
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials"), env, "/v1/session/credentials", session);
  assert.deepEqual(await response.json(), { credentials: [{ credentialId: "own_key", policyId: "maintainer_access", enabled: true, active: true }] });
});

test("the revoke subresource rejects PUT without rotating the credential", async t => {
  const original = credential(session.email), env = await fixture(t, [["own_key", original]]);
  const response = await sessionCredentialsRequest(new Request("https://clawrouter.example/v1/session/credentials/own_key/revoke", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policyId: "maintainer_access", secretSha256: "cd".repeat(32) }) }), env, "/v1/session/credentials/own_key/revoke", session);
  assert.equal(response.status, 405);
  assert.deepEqual(env.credentials.get("own_key"), original);
});

function put(env, id, body) {
  return sessionCredentialsRequest(new Request(`https://clawrouter.example/v1/session/credentials/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, `/v1/session/credentials/${id}`, session);
}
