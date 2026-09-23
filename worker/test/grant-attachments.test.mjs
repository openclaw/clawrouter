import assert from "node:assert/strict";
import test from "node:test";
import { PolicyBindingIndexObject } from "../authority.ts";
import { GrantCredentialObject, materializeGrantCredentials, putGrantCredentials, reconcileGrantAttachment, revokeGrantCredentials } from "../grant-credentials.ts";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const key = "oauth/policy/account";
const grant = (provider = "openai") => ({ provider, kind: "api_key", credential: "credential-fixture", enabled: true });

test("replacement reserves the new provider while the old attachment remains selectable until owner commit", async () => {
  const env = fixture();
  await putGrantCredentials(env, key, grant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  owner.state.storage.put = async (...args) => {
    if (args[1].providerId === "anthropic" && args[1].poolSyncPending) { entered.resolve(); await held.promise; }
    return put(...args);
  };
  const replacement = putGrantCredentials(env, key, grant("anthropic"));
  await entered.promise;
  assert.equal(owner.values.get("credential").providerId, "openai");
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
  assert.deepEqual((await pool(env, "anthropic")).keys, []);
  assert.equal((await pool(env, "anthropic")).hasAttachment, true);
  held.resolve();
  await replacement;
  assert.equal((await pool(env, "openai")).hasAttachment, false);
  assert.deepEqual((await pool(env, "anthropic")).keys, [key]);
});

test("same-key replacement and revocation serialize through the final secretless generation", async () => {
  const env = fixture();
  await putGrantCredentials(env, key, grant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  owner.state.storage.put = async (...args) => {
    if (args[1].providerId === "anthropic" && args[1].credential && args[1].poolSyncPending) { entered.resolve(); await held.promise; }
    return put(...args);
  };
  const replacement = putGrantCredentials(env, key, grant("anthropic"));
  await entered.promise;
  let revoked = false;
  const revocation = revokeGrantCredentials(env, key).then(() => { revoked = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revoked, false);
  held.resolve();
  await Promise.all([replacement, revocation]);
  assert.equal(owner.values.get("credential").generation, 3);
  assert.equal(owner.values.get("credential").credential, undefined);
  assert.equal((await pool(env, "openai")).hasAttachment, false);
  assert.equal((await pool(env, "anthropic")).hasAttachment, false);
});

for (const enabled of [true, false]) for (const legacy of ["none", "indexed-with-kv-miss", "raw-kv"]) test(`failed new ${enabled ? "active" : "paused"} admission repairs only its proposal with ${legacy} evidence`, async () => {
  const env = fixture();
  if (legacy === "indexed-with-kv-miss") env.grantAuthority.seedLegacy(key, "retired-provider");
  if (legacy === "raw-kv") env.values.set(key, "legacy-private-fixture");
  env.GRANT_CREDENTIALS.get(key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  let writes = 0;
  owner.state.storage.put = async () => { writes += 1; throw new Error("owner store unavailable"); };
  const ambiguous = legacy === "indexed-with-kv-miss";
  await assert.rejects(() => putGrantCredentials(env, key, { ...grant(), enabled }), error => ambiguous
    ? error.status === 409 && error.code === "grant_attachment_changed"
    : error.status === 500 && error.code === "credential_owner_error");
  assert.equal(writes, ambiguous ? 0 : 1);
  assert.deepEqual((await env.grantAuthority.call("pending", {})).keys, ambiguous ? [] : [key]);
  assert.deepEqual((await pool(env, "openai")).keys, []);
  assert.equal((await pool(env, "openai")).hasAttachment, !ambiguous);
  const result = await reconcileGrantAttachment(env, key);
  assert.equal(result.outcome, legacy === "indexed-with-kv-miss" ? "unresolved" : "pending_cancelled");
  assert.deepEqual((await env.grantAuthority.call("pending", {})).keys, []);
  assert.equal((await pool(env, "retired-provider")).hasAttachment, legacy === "indexed-with-kv-miss");
  assert.equal(env.values.get(key), legacy === "raw-kv" ? "legacy-private-fixture" : undefined);
});

test("failed owner reads leave pending evidence intact", async () => {
  const env = fixture();
  await env.grantAuthority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 });
  env.GRANT_CREDENTIALS.get(key);
  env.GRANT_CREDENTIALS.objects.get(key).state.storage.get = async () => { throw new Error("owner read unavailable"); };
  await assert.rejects(() => reconcileGrantAttachment(env, key));
  assert.equal((await env.grantAuthority.call("attachment", { key })).pending, true);
});

test("delayed pending cancellation and old publication cannot cross revoke and reconnect", async () => {
  const env = fixture();
  const abandoned = await env.grantAuthority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 });
  await putGrantCredentials(env, key, grant());
  const active = await env.grantAuthority.call("attachment", { key });
  await revokeGrantCredentials(env, key);
  await putGrantCredentials(env, key, grant("anthropic"));
  await assert.rejects(() => env.grantAuthority.call("cancel-pending", { key, revision: abandoned.revision }), error => error.status === 409);
  await assert.rejects(() => env.grantAuthority.call("publish", { key, provider: "openai", status: "active", generation: active.generation, revision: active.revision }), error => error.status === 409);
  assert.deepEqual((await pool(env, "anthropic")).keys, [key]);
  assert.equal((await pool(env, "openai")).hasAttachment, false);
});

for (const lost of ["admit", "publish", "ack-store"]) test(`lost ${lost} acknowledgement recovers from a fresh owner/index read`, async () => {
  const env = fixture();
  if (lost === "ack-store") {
    env.GRANT_CREDENTIALS.get(key);
    const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
    let fail = true;
    owner.state.storage.put = async (...args) => {
      if (args[1].poolSyncPending === false && fail) { fail = false; throw new Error("ack write unavailable"); }
      return put(...args);
    };
  } else {
    const fetch = env.grantAuthority.fetch;
    let fail = true;
    env.grantAuthority.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(url).pathname === `/grant-pools/${lost}` && fail) { fail = false; throw new Error("ack lost after commit"); }
      return response;
    };
  }
  await assert.rejects(() => putGrantCredentials(env, key, grant()));
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  owner.object = new GrantCredentialObject(owner.state, env);
  if (lost === "admit") {
    assert.equal(owner.values.has("credential"), false);
    await putGrantCredentials(env, key, grant());
  } else {
    assert.equal(owner.values.get("credential").poolSyncPending, true);
    assert.equal((await materializeGrantCredentials(env, key, grant(), "openai", null, false)).credential, "credential-fixture");
    assert.equal(owner.values.get("credential").poolSyncPending, false);
  }
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
  assert.equal((await env.grantAuthority.call("attachment", { key })).pending, false);
});

test("a dirty owner repairs before provider I/O after restart", async context => {
  const env = fixture();
  const active = await putGrantCredentials(env, key, { ...grant(), kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", refresh: { tokenUrl: "https://token.example/refresh", extraParams: {} } });
  const fetch = env.grantAuthority.fetch;
  let fail = true, calls = 0;
  env.grantAuthority.fetch = (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish" && JSON.parse(init.body).status === "paused" && fail) throw new Error("index unavailable");
    return fetch(url, init);
  };
  await assert.rejects(() => putGrantCredentials(env, key, { ...active, enabled: false }, true));
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  owner.object = new GrantCredentialObject(owner.state, env);
  context.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected provider I/O"); });
  await assert.rejects(() => owner.object.alarm());
  assert.equal(calls, 0);
  fail = false;
  await owner.object.alarm();
  assert.equal(calls, 0);
  assert.deepEqual((await pool(env, "openai")).keys, []);
  assert.equal((await pool(env, "openai")).hasAttachment, true);
});

test("revocation removes secrets even when an earlier active publication still cannot be repaired", async () => {
  const env = fixture(), fetch = env.grantAuthority.fetch;
  env.grantAuthority.fetch = (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish") throw new Error("index unavailable");
    return fetch(url, init);
  };
  await assert.rejects(() => putGrantCredentials(env, key, grant()));
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  assert.equal(owner.values.get("credential").credential, "credential-fixture");
  await assert.rejects(() => revokeGrantCredentials(env, key));
  const tombstone = owner.values.get("credential");
  assert.equal(tombstone.credential, undefined);
  assert.equal(tombstone.enabled, false);
  assert.equal(tombstone.poolSyncPending, true);
  assert.equal(owner.alarm(), null);
  env.grantAuthority.fetch = fetch;
  assert.equal((await reconcileGrantAttachment(env, key)).outcome, "detached");
  assert.equal((await pool(env, "openai")).hasAttachment, false);
});

for (const legacy of [false, true]) test(`repeat revoke repairs a failed reconnect from a ${legacy ? "pre-attachment" : "clean"} tombstone`, async () => {
  const env = fixture();
  await putGrantCredentials(env, key, grant());
  await revokeGrantCredentials(env, key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  const tombstone = owner.values.get("credential");
  if (legacy) delete tombstone.poolSyncPending;
  owner.values.set("credential", tombstone);
  owner.state.storage.put = async () => { throw new Error("fixture reconnect write failure"); };
  await assert.rejects(() => putGrantCredentials(env, key, grant()));
  owner.state.storage.put = put;
  const pending = await env.grantAuthority.call("attachment", { key });
  assert.equal(pending.pending, true);
  const fetch = env.grantAuthority.fetch;
  env.grantAuthority.fetch = (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish") throw new Error("fixture index unavailable");
    return fetch(url, init);
  };
  await assert.rejects(() => revokeGrantCredentials(env, key));
  const saved = owner.values.get("credential");
  assert.equal(saved.poolSyncPending, true);
  assert.equal(saved.credential, undefined);
  assert.equal(saved.generation, tombstone.generation);
  assert.equal(saved.lineage, tombstone.lineage);
  assert.equal(saved.revokedAt, tombstone.revokedAt);
  env.grantAuthority.fetch = fetch;
  owner.object = new GrantCredentialObject(owner.state, env);
  await revokeGrantCredentials(env, key);
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), { generation: tombstone.generation, revision: pending.revision + 1, pending: false, attached: false });
  assert.equal(owner.values.get("credential").poolSyncPending, false);
  assert.equal((await pool(env, "openai")).hasAttachment, false);
});

test("repeat revoke finishes legacy membership cleanup for a pre-attachment tombstone", async () => {
  const env = fixture();
  await putGrantCredentials(env, key, grant());
  await revokeGrantCredentials(env, key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), tombstone = owner.values.get("credential");
  delete tombstone.poolSyncPending;
  owner.values.set("credential", tombstone);
  env.grantAuthority.sql.exec("DELETE FROM upstream_grant_pool_versions WHERE grant_key = ?", key);
  env.grantAuthority.seedLegacy(key, "openai");
  await revokeGrantCredentials(env, key);
  assert.equal((await pool(env, "openai")).hasAttachment, false);
  assert.equal(owner.values.get("credential").generation, tombstone.generation);
  assert.equal(owner.values.get("credential").lineage, tombstone.lineage);
});

test("active capacity counts legacy and pending reservations while paused and reauth attachments remain present", async context => {
  const env = fixture();
  for (let i = 0; i < 40; i++) {
    const item = `oauth/policy/paused-${i}`;
    const active = await putGrantCredentials(env, item, grant());
    await putGrantCredentials(env, item, { ...active, enabled: false }, true);
  }
  env.grantAuthority.seedLegacy("oauth/policy/legacy", "openai");
  for (let i = 0; i < 30; i++) await putGrantCredentials(env, `oauth/policy/active-${i}`, grant());
  await env.grantAuthority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 });
  await assert.rejects(() => putGrantCredentials(env, "oauth/policy/full", grant()));
  assert.equal((await pool(env, "openai")).keys.length, 31);
  await reconcileGrantAttachment(env, key);
  const oauth = { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture" };
  const active = await putGrantCredentials(env, key, oauth);
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", { tokenUrl: "https://token.example/refresh", extraParams: {} }, true));
  assert.equal((await pool(env, "openai")).keys.includes(key), false);
  assert.equal(env.grantAuthority.sql.exec("SELECT status FROM upstream_grant_pool_members WHERE token_ref = 'account'")[0].status, "reauth_required");
  await putGrantCredentials(env, "oauth/policy/freed-slot", grant());
  const resolved = await pool(env, "openai");
  assert.equal(resolved.keys.length, 32);
  assert.equal(resolved.hasAttachment, true);
});

for (const replace of [false, true]) test(`${replace ? "provider replacement with pause" : "new paused grant"} does not reserve active capacity in a full destination`, async () => {
  const env = fixture();
  for (let i = 0; i < 32; i++) await putGrantCredentials(env, `oauth/policy/active-${i}`, grant());
  if (replace) await putGrantCredentials(env, key, grant("anthropic"));
  env.GRANT_CREDENTIALS.get(key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  owner.state.storage.put = async (...args) => {
    if (args[1].providerId === "openai" && args[1].poolSyncPending) { entered.resolve(); await held.promise; }
    return put(...args);
  };
  const paused = putGrantCredentials(env, key, { ...grant(), enabled: false });
  try {
    await Promise.race([entered.promise, paused]);
    assert.equal(owner.values.get("credential")?.providerId, replace ? "anthropic" : undefined);
    assert.deepEqual((await pool(env, "anthropic")).keys, replace ? [key] : []);
    assert.equal((await pool(env, "openai")).keys.length, 32);
    assert.equal(env.grantAuthority.sql.exec("SELECT status FROM upstream_grant_pool_members WHERE provider_id = 'openai' AND token_ref = 'account'")[0].status, "pending_inactive");
    assert.deepEqual((await env.grantAuthority.call("pending", {})).keys, [key]);
    await assert.rejects(() => putGrantCredentials(env, "oauth/policy/overflow", grant()));
  } finally { held.resolve(); }
  const saved = await paused;
  assert.equal(saved.enabled, false);
  assert.equal((await pool(env, "openai")).keys.length, 32);
  assert.equal((await pool(env, "anthropic")).hasAttachment, false);
  assert.equal(env.grantAuthority.sql.exec("SELECT status FROM upstream_grant_pool_members WHERE token_ref = 'account'")[0].status, "paused");
  assert.deepEqual((await env.grantAuthority.call("pending", {})).keys, []);
  await assert.rejects(() => putGrantCredentials(env, key, { ...saved, enabled: true }, true));
  assert.equal(owner.values.get("credential").enabled, false);
});

test("raw migration and ordinary refresh remain unattached after a lost publication acknowledgement", async context => {
  const env = fixture();
  const raw = { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: "2020-01-01T00:00:00.000Z" };
  env.values.set(key, raw);
  const fetch = env.grantAuthority.fetch;
  let fail = true;
  env.grantAuthority.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/publish" && fail) { fail = false; throw new Error("publication acknowledgement lost"); }
    return response;
  };
  context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "rotated-fixture", expires_in: 3600 }));
  await assert.rejects(() => materializeGrantCredentials(env, key, raw, "openai", null, false));
  const migrated = await materializeGrantCredentials(env, key, raw, "openai", { tokenUrl: "https://token.example/refresh", extraParams: {} }, false);
  assert.equal(migrated.accessToken, "rotated-fixture");
  assert.equal((await pool(env, "openai")).hasAttachment, false);
  const first = await reconcileGrantAttachment(env, key), replay = await reconcileGrantAttachment(env, key);
  assert.equal(first.outcome, "unattached");
  assert.deepEqual(replay, first);
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.get("credential").generation, 2);
});

test("selectable discovery stays within two scoped pools plus two default keys", async () => {
  const env = fixture();
  for (let i = 0; i < 32; i++) {
    env.grantAuthority.seedLegacy(`oauth/policy/policy-${i}`, "openai");
    env.grantAuthority.seedLegacy(`oauth/tenants/tenant/tenant-${i}`, "openai");
  }
  const result = await env.grantAuthority.call("resolve", { providerId: "openai", policyId: "policy", tenantId: "tenant", defaultKeys: ["oauth/policy/default", "oauth/tenants/tenant/default"] });
  assert.equal(result.keys.length, 66);
  assert.equal(result.hasAttachment, true);
});

test("unknown legacy provider identity preserves indexed evidence without creating a new attachment", async () => {
  const env = fixture();
  env.grantAuthority.seedLegacy(key, "openai");
  const raw = { kind: "api_key", credential: "legacy-fixture" };
  env.values.set(key, raw);
  await materializeGrantCredentials(env, key, raw, "openai", null, false);
  assert.equal((await reconcileGrantAttachment(env, key)).outcome, "unattached");
  assert.equal((await pool(env, "openai")).hasAttachment, true);
});

test("admission rolls back its reservation when the SQL commit section fails", async () => {
  const env = fixture(), sql = env.grantAuthority.sql, exec = sql.exec;
  sql.exec = (query, ...bindings) => {
    if (query.startsWith("INSERT INTO upstream_grant_pool_versions")) throw new Error("fixture SQL failure");
    return exec(query, ...bindings);
  };
  await assert.rejects(() => putGrantCredentials(env, key, grant()));
  sql.exec = exec;
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), { generation: 0, revision: 0, pending: false, attached: false });
  assert.equal(env.GRANT_CREDENTIALS.objects.get(key).values.has("credential"), false);
});

for (const mutation of ["replacement", "revoke"]) test(`publication SQL failure after ${mutation} commit preserves dirty owner recovery`, async () => {
  const env = fixture();
  await putGrantCredentials(env, key, grant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key), sql = env.grantAuthority.sql, exec = sql.exec;
  const before = await env.grantAuthority.call("attachment", { key });
  sql.exec = (query, ...bindings) => {
    if (query.startsWith("INSERT INTO upstream_grant_pool_versions") && bindings[1] === 2) throw new Error("fixture publication SQL failure");
    return exec(query, ...bindings);
  };
  await assert.rejects(() => mutation === "revoke" ? revokeGrantCredentials(env, key) : putGrantCredentials(env, key, grant("anthropic")));
  assert.equal(owner.values.get("credential").generation, 2);
  assert.equal(owner.values.get("credential").poolSyncPending, true);
  if (mutation === "revoke") assert.equal(owner.values.get("credential").credential, undefined);
  else assert.equal(owner.values.get("credential").providerId, "anthropic");
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), { ...before, revision: before.revision + (mutation === "replacement" ? 1 : 0), pending: mutation === "replacement" });
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
  assert.deepEqual((await pool(env, "anthropic")).keys, []);
  assert.equal(env.values.get(key).provider, "openai");
  sql.exec = exec;
  owner.object = new GrantCredentialObject(owner.state, env);
  assert.equal((await reconcileGrantAttachment(env, key)).outcome, mutation === "revoke" ? "detached" : "attached");
  assert.equal(owner.values.get("credential").poolSyncPending, false);
  assert.equal(owner.values.get("credential").generation, 2);
  assert.equal((await pool(env, "openai")).hasAttachment, false);
  assert.deepEqual((await pool(env, "anthropic")).keys, mutation === "replacement" ? [key] : []);
  assert.equal(env.values.get(key).credentialGeneration, 2);
});

test("populated pre-attachment SQLite schema upgrades and reconstructs without losing legacy membership", async () => {
  const authority = createGrantAuthority(sql => {
    // This is the pre-C06 table: construction must add status without replacing
    // populated rows or assuming their owner state has already been migrated.
    sql.exec("CREATE TABLE upstream_grant_pool_members (scope TEXT NOT NULL, scope_id TEXT NOT NULL, provider_id TEXT NOT NULL, token_ref TEXT NOT NULL, PRIMARY KEY (scope, scope_id, provider_id, token_ref))");
    for (let i = 0; i < 32; i++) sql.exec("INSERT INTO upstream_grant_pool_members VALUES ('policies', 'policy', 'openai', ?)", `legacy-${String(i).padStart(2, "0")}`);
  });
  const expected = Array.from({ length: 32 }, (_, i) => `oauth/policy/legacy-${String(i).padStart(2, "0")}`);
  assert.deepEqual(authority.sql.exec("SELECT DISTINCT status FROM upstream_grant_pool_members").map(row => row.status), ["legacy"]);
  const restarted = new PolicyBindingIndexObject({ storage: authority.storage });
  const response = await restarted.fetch(new Request("https://clawrouter.internal/grant-pools/resolve", { method: "POST", body: JSON.stringify({ policyId: "policy", providerId: "openai" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).keys, expected);
  assert.deepEqual(await authority.call("attachment", { key: expected[0] }), { generation: 0, revision: 0, pending: false, attached: true });
  await assert.rejects(() => authority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 }), error => error.status === 400);
  await authority.call("admit", { key, provider: "openai", status: "paused", generation: 0, revision: 0 });
  assert.deepEqual((await authority.call("resolve", { policyId: "policy", providerId: "openai" })).keys, expected);
});

test("pending pages use full grant keys and advance past unresolved legacy evidence", async () => {
  const env = fixture();
  const keys = ["oauth/a/same", "oauth/b/same", "oauth/tenants/a/same", "oauth/tenants/b/same"];
  for (const key of keys) await env.grantAuthority.call("admit", { key, provider: "openai", status: "active", generation: 0, revision: 0 });
  env.grantAuthority.seedLegacy(keys[0], "retired-provider");
  const first = await env.grantAuthority.call("pending", { limit: 2 });
  assert.deepEqual(first.keys, keys.slice(0, 2));
  assert.equal((await reconcileGrantAttachment(env, keys[0])).outcome, "unresolved");
  const second = await env.grantAuthority.call("pending", { limit: 2, cursor: first.cursor });
  assert.deepEqual(second.keys, keys.slice(2));
  assert.equal(second.cursor, null);
  await assert.rejects(() => env.grantAuthority.call("pending", { limit: 65 }), error => error.status === 400);
});

test("metadata-only pause and resume preserve owner credential continuity fields", async () => {
  const env = fixture();
  const active = await putGrantCredentials(env, key, grant());
  const owner = env.GRANT_CREDENTIALS.objects.get(key);
  assert.match(active.credentialLineage, /^[0-9a-f-]{36}$/);
  const paused = await putGrantCredentials(env, key, { ...active, enabled: false }, true);
  const resumed = await putGrantCredentials(env, key, { ...paused, enabled: true }, true);
  assert.equal(paused.credentialLineage, active.credentialLineage);
  assert.equal(resumed.credentialLineage, active.credentialLineage);
  assert.equal(owner.values.get("credential").lineage, active.credentialLineage);
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
});

for (const enabled of [true, false]) for (const nextEnabled of [true, false]) test(`failed ${nextEnabled ? "active" : "paused"} admission preserves an unattached ${enabled ? "active" : "paused"} owner`, async () => {
  const env = fixture(), raw = { ...grant(), enabled };
  env.values.set(key, raw);
  const migrate = () => materializeGrantCredentials(env, key, raw, "openai", null, false);
  if (enabled) await migrate(); else await assert.rejects(migrate);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  owner.state.storage.put = async () => { throw new Error("fixture owner write failure"); };
  await assert.rejects(() => putGrantCredentials(env, key, { ...grant(), enabled: nextEnabled }));
  const pending = await env.grantAuthority.call("attachment", { key });
  assert.equal(pending.pending, true);
  owner.state.storage.put = put;
  env.values.set(key, { ...raw, poolAdmissionRevision: pending.revision });
  owner.object = new GrantCredentialObject(owner.state, env);
  const repaired = await reconcileGrantAttachment(env, key);
  assert.deepEqual(repaired, { generation: 1, revision: pending.revision + 1, pending: false, attached: false, outcome: "unattached" });
  assert.deepEqual(await reconcileGrantAttachment(env, key), repaired);
  assert.equal(owner.values.get("credential").enabled, enabled);
  await assert.rejects(() => env.grantAuthority.call("publish", { key, ...pending, provider: "openai", status: enabled ? "active" : "paused" }), error => error.status === 409);
  await putGrantCredentials(env, key, { ...grant(), enabled: nextEnabled });
  assert.equal((await pool(env, "openai")).hasAttachment, true);
  assert.equal(owner.values.get("credential").generation, 2);
});

for (const attached of [false, true]) test(`ordinary refresh cannot acknowledge a failed proposal for an ${attached ? "attached" : "unattached"} owner`, async context => {
  const env = fixture(), now = Date.now();
  context.mock.timers.enable({ apis: ["Date"], now });
  const raw = { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: new Date(now + 3_600_000).toISOString() };
  env.values.set(key, raw);
  const active = attached ? await putGrantCredentials(env, key, raw) : await materializeGrantCredentials(env, key, raw, "openai", null, false);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  const receipt = owner.values.get("credential").poolAdmissionRevision;
  if (attached) assert.equal(typeof receipt, "number"); else assert.equal(receipt, undefined);
  owner.state.storage.put = async () => { throw new Error("fixture owner write failure"); };
  await assert.rejects(() => putGrantCredentials(env, key, { ...raw, provider: attached ? "anthropic" : "openai", accessToken: "replacement-fixture" }));
  assert.notEqual(receipt, (await env.grantAuthority.call("attachment", { key })).revision);
  owner.state.storage.put = put;
  context.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "refreshed-fixture", expires_in: 3600 }));
  context.mock.timers.tick(7_200_000);
  const refreshed = await materializeGrantCredentials(env, key, active, "openai", { tokenUrl: "https://token.example/refresh", extraParams: {} }, false);
  assert.equal(refreshed.accessToken, "refreshed-fixture");
  assert.equal(refreshed.credentialLineage, active.credentialLineage);
  assert.equal(owner.values.get("credential").poolAdmissionRevision, receipt);
  assert.equal(owner.values.get("credential").generation, 2);
  assert.equal((await pool(env, "openai")).hasAttachment, attached);
  assert.equal((await pool(env, "anthropic")).hasAttachment, false);
  assert.equal((await env.grantAuthority.call("attachment", { key })).pending, false);
});

test("raw migration cannot acknowledge a failed first admission", async () => {
  const env = fixture(), raw = grant();
  env.values.set(key, raw);
  env.GRANT_CREDENTIALS.get(key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  owner.state.storage.put = async () => { throw new Error("fixture owner write failure"); };
  await assert.rejects(() => putGrantCredentials(env, key, { ...raw, credential: "replacement-fixture" }));
  const pending = await env.grantAuthority.call("attachment", { key });
  assert.equal(pending.pending, true);
  owner.state.storage.put = put;
  env.values.set(key, { ...raw, poolAdmissionRevision: pending.revision });
  assert.equal((await materializeGrantCredentials(env, key, raw, "openai", null, false)).credential, raw.credential);
  assert.equal(owner.values.get("credential").poolAdmissionRevision, undefined);
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), { generation: 1, revision: pending.revision + 1, pending: false, attached: false });
});

test("a lost owner-write acknowledgement retains its committed admission receipt", async () => {
  const env = fixture();
  env.GRANT_CREDENTIALS.get(key);
  const owner = env.GRANT_CREDENTIALS.objects.get(key), put = owner.state.storage.put;
  let fail = true;
  owner.state.storage.put = async (...args) => {
    await put(...args);
    if (fail) { fail = false; throw new Error("fixture acknowledgement lost after owner commit"); }
  };
  await assert.rejects(() => putGrantCredentials(env, key, grant()));
  const pending = await env.grantAuthority.call("attachment", { key });
  const receipt = owner.values.get("credential").poolAdmissionRevision;
  assert.equal(receipt, pending.revision);
  assert.equal(owner.values.get("credential").poolSyncPending, true);
  owner.object = new GrantCredentialObject(owner.state, env);
  assert.equal((await reconcileGrantAttachment(env, key)).outcome, "attached");
  assert.equal(owner.values.get("credential").poolAdmissionRevision, receipt);
  assert.equal(owner.values.get("credential").poolSyncPending, false);
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
});

for (const previous of [null, "paused", "reauth_required"]) test(`repeated admission preserves ${previous ?? "absent"} membership and restores it atomically`, async context => {
  const env = fixture();
  if (previous) {
    if (previous === "reauth_required") {
      const active = await putGrantCredentials(env, key, { provider: "openai", kind: "oauth", accessToken: "access-fixture", refreshToken: "refresh-fixture" });
      context.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
      await assert.rejects(() => materializeGrantCredentials(env, key, active, "openai", { tokenUrl: "https://token.example/refresh", extraParams: {} }, true));
    } else await putGrantCredentials(env, key, { ...grant(), enabled: false });
  }
  const before = await env.grantAuthority.call("attachment", { key });
  const first = await env.grantAuthority.call("admit", { key, ...before, provider: "openai", status: previous ? "active" : "paused" });
  const second = await env.grantAuthority.call("admit", { key, ...first, provider: "openai", status: "active" });
  assert.equal(env.grantAuthority.sql.exec("SELECT pending_previous_status FROM upstream_grant_pool_members WHERE token_ref = 'account'")[0].pending_previous_status, previous);
  const sql = env.grantAuthority.sql, exec = sql.exec;
  sql.exec = (query, ...bindings) => {
    if (query.startsWith("INSERT INTO upstream_grant_pool_versions")) throw new Error("fixture restoration fence failure");
    return exec(query, ...bindings);
  };
  await assert.rejects(() => reconcileGrantAttachment(env, key));
  assert.deepEqual(await env.grantAuthority.call("attachment", { key }), second);
  assert.equal(sql.exec("SELECT pending_previous_status FROM upstream_grant_pool_members WHERE token_ref = 'account'")[0].pending_previous_status, previous);
  sql.exec = exec;
  const repaired = await reconcileGrantAttachment(env, key);
  assert.equal(repaired.outcome, previous ? "attached" : "pending_cancelled");
  assert.equal(repaired.revision, second.revision + 1);
  assert.equal(repaired.pending, false);
  assert.equal(repaired.attached, !!previous);
  assert.deepEqual(await reconcileGrantAttachment(env, key), repaired);
  await assert.rejects(() => env.grantAuthority.call("cancel-pending", { key, revision: second.revision }), error => error.status === 409);
  await assert.rejects(() => env.grantAuthority.call("publish", { key, ...second, provider: "openai", status: previous, admissionRevision: second.revision }), error => error.status === 409);
  if (previous) assert.equal(sql.exec("SELECT status FROM upstream_grant_pool_members WHERE token_ref = 'account'")[0].status, previous);
});

test("attachment lookup and cleanup index the complete identity without planner statistics", () => {
  const env = fixture(), sql = env.grantAuthority.sql;
  for (let i = 0; i < 64; i++) sql.exec("INSERT INTO upstream_grant_pool_members (scope, scope_id, provider_id, token_ref, status) VALUES ('policies', 'policy', 'openai', ?, 'paused')", `inactive-${i}`);
  for (const query of [
    "SELECT 1 FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ? AND status NOT IN ('pending', 'pending_inactive') LIMIT 1",
    "DELETE FROM upstream_grant_pool_members WHERE scope = ? AND scope_id = ? AND token_ref = ?",
  ]) {
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${query}`, "policies", "policy", "absent").map(row => row.detail).join("\n");
    assert.match(plan, /upstream_grant_pool_identity \(scope=\? AND scope_id=\? AND token_ref=\?\)/);
  }
});

function fixture() {
  const values = new Map();
  return attachGrantCredentialNamespace({ values, POLICY_KV: {
    async get(key, type) {
      const value = values.get(key) ?? null;
      return value === null ? null : type === "text" ? typeof value === "string" ? value : JSON.stringify(value) : structuredClone(value);
    },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
}

function pool(env, providerId) { return env.grantAuthority.call("resolve", { policyId: "policy", providerId }); }
