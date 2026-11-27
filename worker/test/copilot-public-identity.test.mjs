import assert from "node:assert/strict";
import test from "node:test";
import { credential, digest, fixture, policy, session } from "./credential-fixture.mjs";
const { normalizeCopilotPublicIdentity, readCopilotPublicIdentity } = await import("../copilot-public-identity.ts");

const profile = { integrationId: "fixture-agent", editorVersion: "fixture/1", editorPluginVersion: "fixture-plugin/1",
  userAgent: "fixture-runtime/1", initiator: "agent" };
const adminPath = "/v1/admin/credentials", personalPath = "/v1/session/credentials";
const payload = { credentialId: "copilot_key", policyId: "maintainer_access", principalId: session.email, secretSha256: digest };
async function create(env) {
  const response = await env.http(adminPath, "POST", { ...payload, copilotPublicIdentity: profile });
  assert.equal(response.status, 201, await response.clone().text());
  const publicValue = await response.json();
  assert.doesNotMatch(JSON.stringify(publicValue), /copilotPublicIdentity|integrationId|revision|fixture-agent/);
  return env.credentials.get(payload.credentialId).copilotPublicIdentity;
}

test("Copilot profile is closed, bounded, explicit and never invents runtime fields", () => {
  assert.deepEqual(normalizeCopilotPublicIdentity(profile), profile);
  for (const key of Object.keys(profile)) {
    const missing = { ...profile }; delete missing[key];
    assert.throws(() => normalizeCopilotPublicIdentity(missing));
  }
  for (const value of [null, [], {}, { ...profile, ownerBinding: "a".repeat(64) }, { ...profile, initiator: "auto" },
    { ...profile, integrationId: "a/b" }, { ...profile, editorVersion: " leading" }, { ...profile, userAgent: "trailing " },
    { ...profile, editorPluginVersion: "line\nbreak" }, { ...profile, userAgent: "é" }, { ...profile, userAgent: "x".repeat(513) }]) {
    assert.throws(() => normalizeCopilotPublicIdentity(value));
  }
  assert.equal(normalizeCopilotPublicIdentity({ ...profile, userAgent: "x".repeat(512) }).userAgent.length, 512);
  assert.equal(readCopilotPublicIdentity({ revision: "caller-revision", profile }), null);
});

test("admin-only HTTP attestation generates private revision and rejects personal injection", async t => {
  const env = await fixture(t), installed = await create(env);
  assert.deepEqual(installed.profile, profile);
  assert.match(installed.revision, /^[a-f0-9-]{36}$/);
  const denied = await env.http(`${personalPath}/copilot_key`, "PUT", { ...payload, copilotPublicIdentity: profile }, { auth: "session" });
  assert.equal(denied.status, 403); await denied.arrayBuffer();
  assert.deepEqual(env.credentials.get("copilot_key").copilotPublicIdentity, installed);
  const forged = await env.http(`${adminPath}/copilot_key`, "PUT", { ...payload, copilotPublicIdentity: { revision: installed.revision, profile } });
  assert.equal(forged.status, 403); await forged.arrayBuffer();
  assert.deepEqual(env.credentials.get("copilot_key").copilotPublicIdentity, installed);
});

test("credential owner rejects personal attestation even when HTTP normalization is bypassed", async t => {
  const env = await fixture(t);
  const result = await env.call("/credentials/mutate", { operation: "create", scope: "personal", credentialId: "copilot_key",
    actor: { auth: "cloudflare_access", role: "user", email: session.email }, credential: credential(), copilotPublicIdentity: profile });
  assert.equal(result.outcome, "admin_required");
  assert.equal(env.credentials.has("copilot_key"), false);
});

test("legacy KV metadata cannot import a Copilot administrator attestation", async t => {
  const env = await fixture(t, [["legacy_key", { ...credential(), copilotPublicIdentity: { revision: crypto.randomUUID(), profile } }]], { legacy: true });
  const response = await env.http(adminPath);
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(env.credentials.get("legacy_key").copilotPublicIdentity, undefined);
});

test("rename and same-identity omission preserve attestation; explicit replacement changes revision", async t => {
  const env = await fixture(t), installed = await create(env);
  const renamed = await env.http(`${adminPath}/copilot_key/rename`, "POST", { name: "Renamed" });
  assert.equal(renamed.status, 200); await renamed.arrayBuffer();
  assert.deepEqual(env.credentials.get("copilot_key").copilotPublicIdentity, installed);
  const same = await env.http(`${adminPath}/copilot_key`, "PUT", payload);
  assert.equal(same.status, 200); await same.arrayBuffer();
  assert.deepEqual(env.credentials.get("copilot_key").copilotPublicIdentity, installed);
  const replaced = await env.http(`${adminPath}/copilot_key`, "PUT", { ...payload, copilotPublicIdentity: { ...profile, initiator: "user" } });
  assert.equal(replaced.status, 200); await replaced.arrayBuffer();
  assert.notEqual(env.credentials.get("copilot_key").copilotPublicIdentity.revision, installed.revision);
  assert.equal(env.credentials.get("copilot_key").copilotPublicIdentity.profile.initiator, "user");
});

for (const change of ["rotate", "revoke", "principal", "policy", "generation", "clear", "secret-put"]) {
  test(`Copilot attestation is invalidated by ${change}`, async t => {
    const env = await fixture(t); await create(env);
    let path = `${adminPath}/copilot_key`, method = "PUT", body = { ...payload };
    if (change === "rotate") { path += "/rotate"; method = "POST"; body = { secretSha256: "cd".repeat(32) }; }
    if (change === "revoke") { path += "/revoke"; method = "POST"; body = undefined; }
    if (change === "principal") body.principalId = "other@example.com";
    if (change === "secret-put") body.secretSha256 = "cd".repeat(32);
    if (change === "clear") body.copilotPublicIdentity = null;
    if (change === "policy" || change === "generation") {
      const policyId = change === "policy" ? "other_policy" : payload.policyId;
      await env.call("/policies/put", { policyId, policy: { ...policy, generation: "policy_v2" } });
      body.policyId = policyId;
    }
    const response = await env.http(path, method, body);
    assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
    assert.equal(env.credentials.get("copilot_key").copilotPublicIdentity, undefined);
  });
}

test("disabled administrator cannot install an attestation after the HTTP-to-owner wait", async t => {
  const env = await fixture(t);
  await env.call("/users/put", { email: session.email, record: { enabled: true, role: "admin", groups: session.groups } });
  env.beforeMutation = () => env.call("/users/put", { email: session.email, record: { enabled: false, role: "admin", groups: session.groups } });
  const response = await env.http(adminPath, "POST", { ...payload, copilotPublicIdentity: profile }, { auth: "session" });
  assert.equal(response.status, 403); await response.arrayBuffer();
  assert.equal(env.credentials.has("copilot_key"), false);
});
