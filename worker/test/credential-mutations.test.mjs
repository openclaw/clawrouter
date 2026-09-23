import assert from "node:assert/strict";
import test from "node:test";
import { adminActor, binding, credential, digest, fixture, policy, session, sha256 } from "./credential-fixture.mjs";

const nextDigest = "cd".repeat(32);
const payload = { policyId: "maintainer_access", secretSha256: digest };
const adminPath = "/v1/admin/credentials";
const personalPath = "/v1/session/credentials";

test("new admin keys require usable IDs while released PUT keeps its ID contract", async t => {
  const env = await fixture(t), secret = "fixture-id-secret", secretSha256 = await sha256(secret);
  for (const credentialId of ["c", "ci", "cli"]) {
    await error(await env.http(adminPath, "POST", { ...payload, credentialId, secretSha256 }), 400, "invalid_credential");
    assert.equal(env.credentials.has(credentialId), false);
  }
  for (const credentialId of ["test", "k".repeat(128)]) {
    assert.equal((await env.http(adminPath, "POST", { ...payload, credentialId, secretSha256 })).status, 201);
    const verified = await env.http("/v1/key/inspect", "GET", undefined, { headers: { authorization: `Bearer clawrouter-live-${credentialId}-${secret}` } });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
  }
  assert.equal((await env.http(`${adminPath}/ci`, "PUT", { ...payload, secretSha256 })).status, 200);
});

for (const scope of ["admin", "personal"]) {
  const path = scope === "admin" ? adminPath : personalPath;
  const options = { auth: scope === "admin" ? "admin" : "session" };
  test(`${scope} HTTP create admits only one of two clients choosing the same id`, async t => {
    const env = await fixture(t);
    const responses = await Promise.all([digest, nextDigest].map(secretSha256 => env.http(path, "POST", { ...payload, credentialId: "shared_key", secretSha256 }, options)));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    const winner = responses.findIndex(response => response.status === 201);
    assert.equal(env.credentials.get("shared_key").secretSha256, [digest, nextDigest][winner]);
    assert.equal((await responses[1 - winner].json()).error.code, "credential_exists");
    const body = await responses[winner].json();
    assert.deepEqual(Object.keys(body).sort(), ["active", "credentialId", "enabled", "generationMatches", "policyEnabled", "policyId", "principalEnabled", "principalId"]);
    assert.equal(body.active, true);
    assert.equal(responses[winner].headers.get("cache-control"), "no-store");
    assert.equal(env.credentials.size, 1);
  });

  test(`${scope} HTTP rotation then delayed revocation preserves the rotated hash`, async t => {
    const env = await fixture(t, [["owned_key", credential()]]);
    const pending = holdMutation(env);
    const revoke = env.http(`${path}/owned_key/revoke`, "POST", undefined, options);
    await pending.arrived;
    assert.equal((await env.http(`${path}/owned_key/rotate`, "POST", { secretSha256: nextDigest }, options)).status, 200);
    pending.release();
    assert.equal((await revoke).status, 200);
    assert.deepEqual(env.credentials.get("owned_key"), { ...credential(), secretSha256: nextDigest, enabled: false });
    assert.equal((await env.http(`${path}/owned_key/revoke`, "POST", undefined, options)).status, 200, "repeat revoke is idempotent");
  });

  test(`${scope} HTTP revocation prevents a delayed rotation from resurrecting the key`, async t => {
    const env = await fixture(t, [["owned_key", credential()]]);
    const pending = holdMutation(env);
    const rotate = env.http(`${path}/owned_key/rotate`, "POST", { secretSha256: nextDigest }, options);
    await pending.arrived;
    assert.equal((await env.http(`${path}/owned_key/revoke`, "POST", undefined, options)).status, 200);
    pending.release();
    await error(await rotate, 409, "credential_inactive");
    assert.deepEqual(env.credentials.get("owned_key"), { ...credential(), enabled: false });
  });
}

test("create imports all legacy credentials before collision checks and never prunes on a collision", async t => {
  const entries = Array.from({ length: 100 }, (_, index) => [`old_${index}`, { ...credential(" OWNER@EXAMPLE.COM "), enabled: false }]);
  const env = await fixture(t, entries, { legacy: true });
  await error(await env.http(personalPath, "POST", { ...payload, credentialId: "old_0" }, { auth: "session" }), 409, "credential_exists");
  assert.equal(env.credentials.size, 100);
  assert.deepEqual(env.credentials.get("old_0"), entries[0][1]);
  const created = await env.http(personalPath, "POST", { ...payload, credentialId: "new_key" }, { auth: "session" });
  assert.equal(created.status, 201);
  assert.equal(env.credentials.size, 100, "normalized legacy ownership is used for retention");
  assert.equal(env.credentials.has("old_0"), false);
});

test("normalized migrated ownership governs listing, quota, rotation and revocation", async t => {
  const env = await fixture(t, Array.from({ length: 10 }, (_, index) => [`key_${index}`, credential(" OWNER@EXAMPLE.COM ")]), { legacy: true });
  const options = { auth: "session" };
  const listed = await env.http(personalPath, "GET", undefined, options);
  assert.equal((await listed.json()).credentials.length, 10);
  await error(await env.http(personalPath, "POST", { ...payload, credentialId: "new_key" }, options), 409, "credential_limit_reached");
  assert.equal((await env.http(`${personalPath}/key_0/rotate`, "POST", { secretSha256: nextDigest }, options)).status, 200, "rotation consumes no slot");
  assert.deepEqual(env.credentials.get("key_0"), { ...credential(" OWNER@EXAMPLE.COM "), secretSha256: nextDigest }, "rotate changes only the hash, including on legacy rows");
  assert.equal((await env.http(`${personalPath}/key_0/revoke`, "POST", undefined, options)).status, 200);
});

test("two personal clients cannot both claim the final enabled credential slot", async t => {
  const env = await fixture(t, Array.from({ length: 9 }, (_, index) => [`key_${index}`, credential()]));
  const responses = await Promise.all(["next_one", "next_two"].map(credentialId => env.http(personalPath, "POST", { ...payload, credentialId }, { auth: "session" })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal((await responses.find(response => response.status === 409).json()).error.code, "credential_limit_reached");
  assert.equal(env.credentials.size, 10);
});

const holdingLosses = {
  group: env => env.call("/users/put", { email: session.email, record: { enabled: true, groups: [] } }),
  binding: env => env.call("/mutate", { seed: { principal: binding, bindings: [] }, binding: { ...binding, enabled: false } }),
  policy: env => env.call("/policies/put", { policyId: "maintainer_access", policy: { ...policy, enabled: false } }),
  user: env => env.call("/users/put", { email: session.email, record: { enabled: false, groups: session.groups } }),
};
for (const [loss, mutate] of Object.entries(holdingLosses)) {
  for (const operation of ["create", "put", "rotate"]) {
    test(`personal ${operation} rechecks ${loss} loss after HTTP authentication`, async t => {
      const original = credential(), env = await fixture(t, operation === "create" ? [] : [["owned_key", original]]);
      env.beforeMutation = () => mutate(env);
      const path = operation === "create" ? personalPath : `${personalPath}/owned_key${operation === "rotate" ? "/rotate" : ""}`;
      const body = operation === "rotate" ? { secretSha256: nextDigest } : { ...payload, credentialId: "owned_key", secretSha256: nextDigest };
      const code = loss === "user" ? "access_user_disabled" : loss === "policy" && operation === "rotate" ? "credential_inactive" : "credential_policy_not_held";
      await error(await env.http(path, operation === "put" ? "PUT" : "POST", body, { auth: "session" }), code === "credential_inactive" ? 409 : 403, code);
      assert.deepEqual(env.credentials.get("owned_key"), operation === "create" ? undefined : original);
    });
  }
}

for (const [loss, mutate] of Object.entries(holdingLosses).filter(([loss]) => loss !== "user")) {
  test(`personal revoke remains available after ${loss} loss`, async t => {
    const env = await fixture(t, [["owned_key", credential()]]);
    env.beforeMutation = () => mutate(env);
    assert.equal((await env.http(`${personalPath}/owned_key/revoke`, "POST", undefined, { auth: "session" })).status, 200);
    assert.equal(env.credentials.get("owned_key").enabled, false);
  });
}

for (const state of ["disabled", "missing_policy", "disabled_policy", "generation", "disabled_owner"]) {
  test(`admin rotation rejects ${state} at the SQLite commit boundary`, async t => {
    const original = credential(), env = await fixture(t, [["owned_key", original]]);
    env.beforeMutation = async () => {
      if (state === "disabled") env.credentials.set("owned_key", { ...original, enabled: false });
      if (state === "missing_policy") env.credentials.set("owned_key", { ...original, policyId: "missing" });
      if (state === "disabled_policy") await holdingLosses.policy(env);
      if (state === "generation") await env.call("/policies/put", { policyId: "maintainer_access", policy: { ...policy, generation: "policy_v2" } });
      if (state === "disabled_owner") await holdingLosses.user(env);
    };
    await error(await env.http(`${adminPath}/owned_key/rotate`, "POST", { secretSha256: nextDigest }), 409, "credential_inactive");
    assert.equal(env.credentials.get("owned_key").secretSha256, digest);
    assert.equal(env.credentials.get("owned_key").policyGeneration, policy.generation);
  });
}

test("admin revocation reads the latest policy and owner after a delayed request", async t => {
  const env = await fixture(t, [["owned_key", credential()]]);
  const pending = holdMutation(env);
  const revoke = env.http("/v1/admin/keys/owned_key/revoke", "POST");
  await pending.arrived;
  await env.call("/policies/put", { policyId: "other_policy", policy: { ...policy, generation: "other_generation" } });
  assert.equal((await env.http(`${adminPath}/owned_key`, "PUT", { ...payload, policyId: "other_policy", principalId: "other@example.com", secretSha256: nextDigest })).status, 200);
  pending.release();
  const response = await revoke;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).policyId, "other_policy");
  assert.deepEqual(env.credentials.get("owned_key"), { enabled: false, secretSha256: nextDigest, policyId: "other_policy", policyGeneration: "other_generation", principalId: "other@example.com" });
});

test("personal revocation cannot reclaim a key reassigned after authentication", async t => {
  const env = await fixture(t, [["owned_key", credential()]]);
  env.beforeMutation = () => env.http(`${adminPath}/owned_key`, "PUT", { ...payload, principalId: "other@example.com", secretSha256: nextDigest });
  await error(await env.http(`${personalPath}/owned_key/revoke`, "POST", undefined, { auth: "session" }), 403, "credential_owned_elsewhere");
  assert.deepEqual(env.credentials.get("owned_key"), { ...credential("other@example.com"), secretSha256: nextDigest });
});

for (const change of ["demoted", "disabled"]) {
  test(`local administrator ${change} after authentication cannot commit a credential write`, async t => {
    const env = await fixture(t);
    await env.call("/users/put", { email: session.email, record: { enabled: true, role: "admin" } });
    env.beforeMutation = () => env.call("/users/put", { email: session.email, record: { enabled: change !== "disabled", role: change === "demoted" ? "user" : "admin" } });
    await error(await env.http(adminPath, "POST", { ...payload, credentialId: "new_key" }, { auth: "session" }), 403, change === "disabled" ? "access_user_disabled" : "access_admin_required");
    assert.equal(env.credentials.size, 0);
  });
}

test("Cloudflare administrator provenance survives the ordinary canonical user role", async t => {
  const env = await fixture(t);
  const actor = { auth: "cloudflare_access", email: session.email, role: "admin" };
  const mutation = { operation: "create", credentialId: "admin_key", credential: credential(), scope: "admin", actor };
  assert.equal((await env.call("/credentials/mutate", mutation)).outcome, "updated");
  await holdingLosses.user(env);
  assert.equal((await env.call("/credentials/mutate", { ...mutation, credentialId: "disabled_key" })).outcome, "actor_disabled");
  assert.equal(env.credentials.has("disabled_key"), false);
});

test("a successful HTTP response describes its own committed record, not a later write", async t => {
  const env = await fixture(t);
  const stub = env.ACCESS_CONTROL.get();
  let afterCommit = true;
  env.ACCESS_CONTROL.get = () => ({ fetch: async (url, init) => {
    const response = await stub.fetch(url, init);
    if (afterCommit && new URL(url).pathname === "/credentials/mutate") {
      afterCommit = false;
      await env.call("/credentials/mutate", { operation: "revoke", credentialId: "new_key", scope: "admin", actor: adminActor });
    }
    return response;
  } });
  const response = await env.http(adminPath, "POST", { ...payload, credentialId: "new_key" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).enabled, true, "canonical create result is not replaced by a subsequent read");
  assert.equal(env.credentials.get("new_key").enabled, false);
});

test("tagged PUT remains an upsert and can explicitly reenable and bind the current generation", async t => {
  const env = await fixture(t);
  assert.equal((await env.http(`${adminPath}/owned_key`, "PUT", { ...payload, enabled: false })).status, 200);
  await env.call("/policies/put", { policyId: "maintainer_access", policy: { ...policy, generation: "policy_v2" } });
  assert.equal((await env.http(`${adminPath}/owned_key`, "PUT", { ...payload, principalId: session.email, secretSha256: nextDigest })).status, 200);
  assert.deepEqual(env.credentials.get("owned_key"), { ...credential(), secretSha256: nextDigest, policyGeneration: "policy_v2" });
  await env.http(`${personalPath}/owned_key/revoke`, "POST", undefined, { auth: "session" });
  assert.equal((await env.http(`${personalPath}/owned_key`, "PUT", { ...payload, enabled: false }, { auth: "session" })).status, 200);
  assert.equal(env.credentials.get("owned_key").enabled, true, "personal PUT keeps its existing forced-enabled contract");
});

test("admin writes return the committed disabled-owner status used by credential discovery", async t => {
  const env = await fixture(t);
  await holdingLosses.user(env);
  const response = await env.http(adminPath, "POST", { ...payload, credentialId: "owned_key", principalId: session.email });
  assert.equal(response.status, 201);
  const committed = await response.json();
  assert.equal(committed.principalEnabled, false);
  assert.equal(committed.active, false);
  assert.equal(committed.enabled, true);
  const listed = await (await env.http(adminPath)).json();
  assert.deepEqual(committed, listed.credentials[0]);
});

test("legacy CLI key upsert and revoke retain their public routes", async t => {
  const env = await fixture(t);
  const body = { secretSha256: digest, providers: ["openai"], monthlyBudgetMicros: 100_000_000, requestCostMicros: 1_000 };
  assert.equal((await env.http("/v1/admin/keys/cli_key", "PUT", body)).status, 200);
  assert.equal((await env.http("/v1/admin/keys/cli_key", "PUT", { ...body, secretSha256: nextDigest })).status, 200);
  assert.equal((await env.http("/v1/admin/keys/cli_key/revoke", "POST")).status, 200);
  assert.equal(env.credentials.get("cli_key").secretSha256, nextDigest);
  assert.equal(env.credentials.get("cli_key").enabled, false);
});

test("new operations validate payloads and preserve authentication and CSRF boundaries", async t => {
  const env = await fixture(t, [["owned_key", credential()]]);
  for (const body of [{ secretSha256: "invalid" }, { secretSha256: nextDigest, policyId: "other_policy" }, { secretSha256: nextDigest, enabled: true }]) {
    await error(await env.http(`${adminPath}/owned_key/rotate`, "POST", body), 400, "invalid_credential");
  }
  await error(await env.http(`${adminPath}/owned_key/revoke`, "PUT", payload), 405, "method_not_allowed");
  await error(await env.http(`${personalPath}/owned_key/rotate`, "PUT", payload, { auth: "session" }), 405, "method_not_allowed");
  await error(await env.http(`${adminPath}/missing_key/rotate`, "POST", { secretSha256: nextDigest }), 404, "unknown_credential");
  await error(await env.http(`${adminPath}/missing_key/revoke`, "POST"), 404, "unknown_credential");
  await error(await env.http(adminPath, "POST", { ...payload, credentialId: "new_key" }, { headers: { authorization: "Bearer invalid" } }), 401, "admin_unauthorized");
  await error(await env.http(personalPath, "POST", { ...payload, credentialId: "new_key" }, { auth: "session", headers: { origin: "https://other.example" } }), 403, "access_csrf_required");
  const forged = { ...payload, credentialId: "foreign_key", principalId: "other@example.com", scope: "admin", actor: adminActor };
  assert.equal((await env.http(personalPath, "POST", forged, { auth: "session" })).status, 201);
  assert.equal(env.credentials.get("foreign_key").principalId, session.email, "client body cannot select actor or scope");
  assert.deepEqual(env.credentials.get("owned_key"), credential());
});

function holdMutation(env) {
  const arrival = Promise.withResolvers(), released = Promise.withResolvers();
  env.beforeMutation = async () => { arrival.resolve(); await released.promise; };
  return { arrived: arrival.promise, release: released.resolve };
}

async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
