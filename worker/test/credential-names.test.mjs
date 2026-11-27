import assert from "node:assert/strict";
import test from "node:test";
import { adminActor, binding, credential, digest, fixture, policy, session, sha256 } from "./credential-fixture.mjs";

const payload = { credentialId: "named_key", policyId: "maintainer_access", secretSha256: digest };
const personalPath = "/v1/session/credentials";
const adminPath = "/v1/admin/credentials";
const personalOptions = { auth: "session" };

for (const scope of ["personal", "admin"]) {
  const path = scope === "personal" ? personalPath : adminPath;
  const options = { auth: scope === "personal" ? "session" : "admin" };

  test(`${scope} creation accepts optional names and returns public names on lists`, async t => {
    const env = await fixture(t);
    for (const [index, name, expected] of [[0, undefined, null], [1, "  Work laptop  ", "Work laptop"], [2, null, null], [3, "   ", null], [4, "x".repeat(80), "x".repeat(80)]]) {
      const credentialId = `named_${index}`;
      const response = await env.http(path, "POST", { ...payload, credentialId, ...(name === undefined ? {} : { name }) }, options);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.name, expected);
      assert.equal(env.credentials.get(credentialId).name ?? null, expected);
      assertPublic(body);
    }
    const response = await env.http(path, "GET", undefined, options);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const list = await response.json();
    assert.deepEqual(list.credentials.map(row => row.name), [null, "Work laptop", null, null, "x".repeat(80)]);
    assertPublic(list);
  });

  test(`${scope} create and rename reject invalid names and metadata-only rename rejects other fields`, async t => {
    const original = { ...credential(), name: "Original" };
    const env = await fixture(t, [["named_key", original]]);
    for (const name of [false, 0, {}, [], "x".repeat(81), "line\nbreak", "\ttrimmed", "trailing\r", "nul\u0000", "delete\u007f", "next\u0085line"]) {
      await error(await env.http(path, "POST", { ...payload, credentialId: "new_key", name }, options), 400, "invalid_credential");
      await error(await env.http(`${path}/named_key/rename`, "POST", { name }, options), 400, "invalid_credential");
    }
    for (const body of [null, [], "name", {}, { name: "New", secretSha256: "cd".repeat(32) }, { name: "New", enabled: true }, { name: "New", policyId: "other" }, { name: "New", principalId: "other@example.com" }, { name: "New", expiresAt: "2027-01-01T00:00:00Z" }, { name: "New", serviceTiers: [] }, { name: "New", extra: true }]) {
      await error(await env.http(`${path}/named_key/rename`, "POST", body, options), 400, "invalid_credential");
    }
    await error(await env.http(`${path}/named_key/rename`, "PUT", { name: "New" }, options), 405, "method_not_allowed");
    assert.deepEqual(env.credentials.get("named_key"), original);
    assert.equal(env.credentials.has("new_key"), false);
  });

  test(`${scope} rename trims, clears and changes only the latest name`, async t => {
    const original = { ...credential(), name: "Old", expiresAt: "2026-01-01T00:00:00Z", serviceTiers: ["default"], retainedMetadata: { version: 1 } };
    const env = await fixture(t, [["named_key", original]]);
    for (const [name, expected] of [["  Office desktop  ", "Office desktop"], ["x".repeat(80), "x".repeat(80)], ["  ", null], ["Again", "Again"], [null, null]]) {
      const response = await env.http(`${path}/named_key/rename`, "POST", { name }, options);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.name, expected);
      assert.equal(body.expired, true);
      assert.equal(body.active, false);
      assertPublic(body);
      assert.deepEqual(env.credentials.get("named_key"), { ...original, name: expected });
    }
  });

  test(`${scope} rename preserves intervening rotate and revoke writes`, async t => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z"));
    const env = await fixture(t, [["named_key", { ...credential(), name: "Old", serviceTiers: ["default"] }]]);
    const pending = holdMutation(env);
    const rename = env.http(`${path}/named_key/rename`, "POST", { name: "Renamed" }, options);
    await pending.arrived;
    assert.equal((await env.http(`${path}/named_key/rotate`, "POST", { secretSha256: "cd".repeat(32) }, options)).status, 200);
    assert.equal((await env.http(`${path}/named_key/revoke`, "POST", undefined, options)).status, 200);
    const latest = env.credentials.get("named_key");
    pending.release();
    const response = await rename;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.enabled, false);
    assertPublic(body);
    assert.deepEqual(env.credentials.get("named_key"), { ...latest, name: "Renamed" });
  });

  test(`${scope} rotation and revocation preserve the latest renamed label`, async t => {
    const env = await fixture(t, [["named_key", credential()]]);
    for (const operation of ["rotate", "revoke"]) {
      const pending = holdMutation(env);
      const operationRequest = env.http(`${path}/named_key/${operation}`, "POST", operation === "rotate" ? { secretSha256: "cd".repeat(32) } : undefined, options);
      await pending.arrived;
      assert.equal((await env.http(`${path}/named_key/rename`, "POST", { name: operation }, options)).status, 200);
      pending.release();
      assert.equal((await operationRequest).status, 200);
      assert.equal(env.credentials.get("named_key").name, operation);
    }
  });
}

for (const state of ["revoked", "expired", "group_removed", "binding_removed", "policy_disabled", "policy_missing", "generation_changed"]) {
  test(`personal rename remains available for ${state} without changing authorization`, async t => {
    let original = credential();
    if (state === "revoked") original.enabled = false;
    if (state === "expired") original.expiresAt = "2026-01-01T00:00:00Z";
    if (state === "policy_missing") original.policyId = "missing";
    const env = await fixture(t, [["named_key", original]]);
    env.beforeMutation = async () => {
      if (state === "group_removed") await env.call("/users/put", { email: session.email, record: { enabled: true, groups: [] } });
      if (state === "binding_removed") await env.call("/mutate", { seed: { principal: binding, bindings: [] }, binding: { ...binding, enabled: false } });
      if (state === "policy_disabled") await env.call("/policies/put", { policyId: "maintainer_access", policy: { ...policy, enabled: false } });
      if (state === "generation_changed") await env.call("/policies/put", { policyId: "maintainer_access", policy: { ...policy, generation: "policy_v2" } });
    };
    const response = await env.http(`${personalPath}/named_key/rename`, "POST", { name: "Archived laptop" }, personalOptions);
    assert.equal(response.status, 200);
    assert.deepEqual(env.credentials.get("named_key"), { ...original, name: "Archived laptop" });
    assertPublic(await response.json());
  });
}

test("rename requires an existing owned key and rechecks latest ownership", async t => {
  const original = credential("elsewhere@example.com"), env = await fixture(t, [["foreign_key", original], ["named_key", credential()]]);
  await error(await env.http(`${personalPath}/missing_key/rename`, "POST", { name: "No" }, personalOptions), 404, "unknown_credential");
  await error(await env.http(`${adminPath}/missing_key/rename`, "POST", { name: "No" }), 404, "unknown_credential");
  await error(await env.http(`${personalPath}/foreign_key/rename`, "POST", { name: "No" }, personalOptions), 403, "credential_owned_elsewhere");
  assert.deepEqual(env.credentials.get("foreign_key"), original);
  env.beforeMutation = () => env.http(`${adminPath}/named_key`, "PUT", { ...payload, principalId: "elsewhere@example.com", name: "New owner" });
  await error(await env.http(`${personalPath}/named_key/rename`, "POST", { name: "Stale owner" }, personalOptions), 403, "credential_owned_elsewhere");
  assert.equal(env.credentials.get("named_key").name, "New owner");
  assert.equal(env.credentials.get("named_key").principalId, "elsewhere@example.com");
});

for (const scope of ["personal", "admin"]) {
  test(`${scope} rename rechecks a disabled actor at the write boundary`, async t => {
    const env = await fixture(t, [["named_key", credential()]]);
    await env.call("/users/put", { email: session.email, record: { enabled: true, role: "admin", groups: session.groups } });
    env.beforeMutation = () => env.call("/users/put", { email: session.email, record: { enabled: false, role: "admin" } });
    const path = scope === "personal" ? personalPath : adminPath;
    await error(await env.http(`${path}/named_key/rename`, "POST", { name: "No" }, personalOptions), 403, "access_user_disabled");
    assert.deepEqual(env.credentials.get("named_key"), credential());
  });
}

test("rename rechecks a local administrator demotion", async t => {
  const env = await fixture(t, [["named_key", credential()]]);
  await env.call("/users/put", { email: session.email, record: { enabled: true, role: "admin" } });
  env.beforeMutation = () => env.call("/users/put", { email: session.email, record: { enabled: true, role: "user" } });
  await error(await env.http(`${adminPath}/named_key/rename`, "POST", { name: "No" }, personalOptions), 403, "access_admin_required");
  assert.deepEqual(env.credentials.get("named_key"), credential());
});

test("admin metadata PUT preserves an omitted name including a concurrent rename and explicitly clears null", async t => {
  const original = { ...credential(), name: "Old", serviceTiers: ["default"], expiresAt: "2026-12-01T00:00:00Z" };
  const env = await fixture(t, [["named_key", original]]);
  const body = { policyId: original.policyId, principalId: original.principalId };
  const pending = holdMutation(env);
  const put = env.http(`${adminPath}/named_key`, "PUT", body);
  await pending.arrived;
  assert.equal((await env.http(`${personalPath}/named_key/rename`, "POST", { name: "Latest" }, personalOptions)).status, 200);
  pending.release();
  assert.equal((await put).status, 200);
  assert.deepEqual(env.credentials.get("named_key"), { ...original, name: "Latest" });
  assert.equal((await env.http(`${adminPath}/named_key`, "PUT", { ...body, name: null })).status, 200);
  assert.deepEqual(env.credentials.get("named_key"), { ...original, name: null });
  assert.equal((await env.http(`${adminPath}/named_key`, "PUT", { ...body, name: "  New  " })).status, 200);
  assert.equal(env.credentials.get("named_key").name, "New");
  await error(await env.http(`${adminPath}/named_key`, "PUT", { ...body, name: 42 }), 400, "invalid_credential");
});

test("legacy normalization retains valid names, trims them, and safely drops invalid values", async t => {
  const entries = [["unnamed_key", credential()], ...["  Legacy  ", null, false, "bad\nname", "x".repeat(81)].map((name, index) => [`legacy_${index}`, { ...credential(), name }])];
  const env = await fixture(t, entries, { legacy: true });
  const response = await env.http(personalPath, "GET", undefined, personalOptions);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.credentials.find(row => row.credentialId === "legacy_0").name, "Legacy");
  for (const index of [1, 2, 3, 4]) assert.equal(env.credentials.get(`legacy_${index}`).name, null);
  assert.equal(Object.hasOwn(env.credentials.get("unnamed_key"), "name"), false);
  assertPublic(body);
});

test("authority validates names even when HTTP normalization is bypassed", async t => {
  const env = await fixture(t, [["named_key", credential()]]);
  const target = { credentialId: "named_key", scope: "admin", actor: adminActor };
  for (const name of [undefined, false, "bad\nname", "x".repeat(81)]) {
    const result = await env.call("/credentials/mutate", { ...target, operation: "rename", name });
    assert.equal(result.outcome, "invalid");
    assert.equal(result.status, 400);
  }
  const result = await env.call("/credentials/mutate", { ...target, operation: "rename", name: "  Authority  " });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(env.credentials.get("named_key"), { ...credential(), name: "Authority" });
  for (const operation of ["create", "put"]) {
    const result = await env.call("/credentials/mutate", { ...target, credentialId: "invalid_key", operation, credential: { ...credential(), name: false } });
    assert.equal(result.outcome, "invalid");
    assert.equal(env.credentials.has("invalid_key"), false);
  }
});

test("rename consumes no credential slot, does not rotate secrets, and keeps browser security boundaries", async t => {
  const secret = "fixture-named-key-secret";
  const original = { ...credential(), secretSha256: await sha256(secret) };
  const env = await fixture(t, [["named_key", original], ...Array.from({ length: 9 }, (_, i) => [`key_${i}`, credential()])]);
  await error(await env.http(`${personalPath}/named_key/rename`, "POST", { name: "No" }, { auth: "session", headers: { origin: "https://other.example" } }), 403, "access_csrf_required");
  await error(await env.http(`${adminPath}/named_key/rename`, "POST", { name: "No" }, { headers: { authorization: "Bearer invalid" } }), 401, "admin_unauthorized");
  const response = await env.http(`${personalPath}/named_key/rename`, "POST", { name: "My client" }, personalOptions);
  assert.equal(response.status, 200);
  assert.deepEqual(env.credentials.get("named_key"), { ...original, name: "My client" });
  const inspect = await env.http("/v1/key/inspect", "GET", undefined, { headers: { authorization: `Bearer clawrouter-live-named_key-${secret}` } });
  assert.equal(inspect.status, 200);
  assert.equal((await inspect.json()).verified, true);
  assert.equal(env.credentials.size, 10);
});

function assertPublic(body) {
  const text = JSON.stringify(body);
  assert.equal(text.includes("secretSha256"), false);
  assert.equal(text.includes(digest), false);
  assert.equal(text.includes("cd".repeat(32)), false);
}

function holdMutation(env) {
  const arrival = Promise.withResolvers(), released = Promise.withResolvers();
  env.beforeMutation = async () => { arrival.resolve(); await released.promise; };
  return { arrived: arrival.promise, release: released.resolve };
}

async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
