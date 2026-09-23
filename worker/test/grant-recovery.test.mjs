import assert from "node:assert/strict";
import test from "node:test";
import { GrantCredentialObject, materializeGrantCredentials, putGrantCredentials, reconcileGrantAttachment, revokeGrantCredentials } from "../grant-credentials.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const key = "oauth/policy/legacy-account";
const corrupt = '{"accessToken":"old-private",';
const grant = { provider: "anthropic", kind: "api_key", credential: "new-private", enabled: true };
const replace = env => putGrantCredentials(env, key, grant, false, "replace");
const revoke = env => revokeGrantCredentials(env, key, { provider: "retired-provider", label: "legacy account" });

for (const enabled of [true, false]) test(`explicit ${enabled ? "active" : "paused"} recovery fences retained index generations and clears all old provider rows`, async () => {
  const env = fixture();
  const before = await attachment(env);
  const saved = await putGrantCredentials(env, key, { ...grant, enabled }, false, "replace");
  const record = owner(env).values.get("credential"), indexed = await attachment(env);
  assert.equal(saved.credentialGeneration, before.generation + 1);
  assert.equal(record.poolAdmissionRevision, before.revision + 1);
  assert.equal(indexed.generation, saved.credentialGeneration);
  assert.equal(indexed.pending, false);
  assert.deepEqual(await members(env), [{ provider_id: "anthropic", status: enabled ? "active" : "paused" }]);
  assert.doesNotMatch(JSON.stringify([record, env.values.get(key)]), /old-private/);
});

test("ownerless revocation commits above retained index state, then detaches every provider", async () => {
  const env = fixture(), before = await attachment(env);
  const saved = await revoke(env), record = owner(env).values.get("credential");
  assert.equal(saved.credentialGeneration, before.generation + 1);
  assert.equal(saved.label, "legacy account");
  assert.equal(record.enabled, false);
  assert.deepEqual(await members(env), []);
  assert.doesNotMatch(JSON.stringify([record, env.values.get(key)]), /old-private|new-private/);
  assert.deepEqual(await revoke(env), saved);
});

for (const pending of [false, true]) for (const action of [replace, revoke]) test(`${action.name} requires positive legacy existence before recovering ownerless ${pending ? "pending" : "attached"} evidence`, async () => {
  const env = fixture();
  if (pending) await env.grantAuthority.call("admit", { key, generation: 7, revision: 4, provider: "anthropic", status: "active" });
  env.values.delete(key);
  const before = await attachment(env), rows = await members(env);
  await assert.rejects(() => action(env), error => error.status === (action === revoke ? 404 : 409));
  assert.equal(owner(env).values.has("credential"), false);
  assert.deepEqual(await attachment(env), before);
  assert.deepEqual(await members(env), rows);
});

test("known-existing legacy revocation also clears a failed admission at a retained generation", async () => {
  const env = fixture();
  await env.grantAuthority.call("admit", { key, generation: 7, revision: 4, provider: "anthropic", status: "active" });
  await revoke(env);
  assert.deepEqual(await members(env), []);
  assert.equal((await attachment(env)).generation, 8);
  assert.equal((await attachment(env)).pending, false);
});

test("explicit first creation remains available without owner, legacy KV or index state", async () => {
  const env = fixture({ generation: 0, providers: [], raw: null });
  assert.equal((await replace(env)).credentialGeneration, 1);
  assert.deepEqual(await members(env), [{ provider_id: "anthropic", status: "active" }]);
});

for (const raw of [corrupt, JSON.stringify({ accessToken: "old-private", padding: "x".repeat(3 * 1024 * 1024) })]) {
  for (const preserve of [false, true]) test(`ordinary ${preserve ? "OAuth/merge" : "contribution"} PUT retains strict ${raw === corrupt ? "JSON" : "size"} validation`, async () => {
    const env = fixture({ raw });
    await assert.rejects(() => putGrantCredentials(env, key, grant, preserve), error => error.code === "invalid_upstream_grant");
    assert.equal(owner(env).values.has("credential"), false);
    assert.equal(env.values.get(key), raw);
  });
}

test("internal replacement intent also requires a fresh primary credential", async () => {
  const env = fixture(), before = await attachment(env);
  await assert.rejects(() => putGrantCredentials(env, key, { ...grant, credential: undefined, hasCredential: true }, true, "replace"), error => error.code === "invalid_upstream_grant");
  assert.equal(owner(env).values.has("credential"), false);
  assert.deepEqual(await attachment(env), before);
});

for (const action of [replace, revoke]) test(`complete owner ${action.name} ignores corrupt KV and legacy hints`, async () => {
  const env = fixture({ generation: 0, providers: [], raw: null });
  const initial = await putGrantCredentials(env, key, { provider: "openai", kind: "api_key", credential: "owned-private", accountId: "owned-account", label: "owned label" });
  env.values.set(key, corrupt);
  env.POLICY_KV.get = async () => { throw new Error("canonical owner must not read KV"); };
  const result = await action(env);
  assert.equal(result.credentialGeneration, initial.credentialGeneration + 1);
  if (action === revoke) {
    assert.equal(result.provider, "openai");
    assert.equal(result.accountId, "owned-account");
    assert.equal(result.label, "owned label");
  }
  assert.doesNotMatch(JSON.stringify(owner(env).values.get("credential")), /old-private|owned-private/);
});

for (const indexed of [0, 6, 7, 8]) test(`pre-C01 replacement preserves owner generation 7 against index ${indexed} without intermediate publication`, async () => {
  const env = fixture({ generation: indexed });
  seedOldOwner(env);
  const initial = structuredClone(owner(env).values.get("credential")), puts = [];
  const put = owner(env).state.storage.put;
  owner(env).state.storage.put = async (...args) => { puts.push(structuredClone(args[1])); return put(...args); };
  if (indexed > 7) {
    const before = await attachment(env);
    await assert.rejects(() => replace(env), error => error.code === "grant_attachment_changed");
    assert.deepEqual(owner(env).values.get("credential"), initial);
    assert.deepEqual(await attachment(env), before);
    assert.deepEqual(puts, []);
  } else {
    const result = await replace(env);
    assert.equal(result.credentialGeneration, 8);
    assert.ok(puts.length > 0);
    assert.ok(puts.every(record => record.generation === 8 && record.credential === "new-private" && record.providerId === "anthropic"));
  }
});

for (const raw of [corrupt, { provider: "wrong-provider", account_id: "wrong-account", label: "legacy label", enabled: false, revoked_at: "2026-09-01T00:00:00.000Z", refresh: { extraParams: { client_secret: "nested-private", audience: "fixture" } } }]) test(`pre-C01 revoke preserves owner identity and ${typeof raw === "string" ? "discards corrupt bytes" : "imports valid negative metadata"} in its only mutation`, async () => {
  const env = fixture({ raw });
  seedOldOwner(env);
  const writes = [], put = owner(env).state.storage.put;
  owner(env).state.storage.put = async (...args) => { writes.push(structuredClone(args[1])); return put(...args); };
  const result = await revoke(env);
  assert.equal(result.provider, "openai");
  assert.equal(result.accountId, "owned-account");
  assert.equal(result.credentialGeneration, 8);
  if (typeof raw !== "string") {
    assert.equal(result.label, "legacy label");
    assert.equal(result.revokedAt, raw.revoked_at);
  }
  assert.ok(writes.every(record => record.generation === 8 && record.enabled === false && !record.credential));
  assert.doesNotMatch(JSON.stringify(writes), /old-private|owned-private|nested-private|wrong-account/);
});

test("an existing owner revokes locally even when the index is newer, retaining the dirty tombstone", async () => {
  const env = fixture({ generation: 10 });
  seedOldOwner(env);
  await assert.rejects(() => revoke(env), error => error.code === "grant_attachment_changed");
  const tombstone = structuredClone(owner(env).values.get("credential"));
  assert.equal(tombstone.generation, 8);
  assert.equal(tombstone.poolSyncPending, true);
  assert.equal(tombstone.credential, undefined);
  await assert.rejects(() => revoke(env), error => error.code === "grant_attachment_changed");
  assert.deepEqual(owner(env).values.get("credential"), tombstone);
  assert.equal((await attachment(env)).generation, 10);
});

test("pre-C01 revoke erases owned secrets before an unavailable index, then resumes after restart", async () => {
  const env = fixture();
  seedOldOwner(env);
  const restore = failOnce(env, "index-read");
  await assert.rejects(() => revoke(env));
  const stored = structuredClone(owner(env).values.get("credential"));
  assert.equal(stored.generation, 8);
  assert.equal(stored.poolSyncPending, true);
  assert.doesNotMatch(JSON.stringify(stored), /owned-private|old-private/);
  restore();
  owner(env).object = new GrantCredentialObject(owner(env).state, env);
  await revoke(env);
  assert.equal(owner(env).values.get("credential").generation, stored.generation);
  assert.deepEqual(await members(env), []);
});

for (const operation of ["materialize", "refresh", "reconcile", "alarm"]) test(`ordinary pre-C01 ${operation} cannot inherit recovery tolerance`, async () => {
  const env = fixture();
  seedOldOwner(env);
  const initial = structuredClone(owner(env).values.get("credential"));
  const action = operation === "reconcile" ? () => reconcileGrantAttachment(env, key)
    : operation === "alarm" ? () => owner(env).object.alarm()
      : () => materializeGrantCredentials(env, key, { provider: "openai", kind: "api_key", hasCredential: true }, "openai", null, operation === "refresh");
  await assert.rejects(action, error => error.code === "invalid_upstream_grant");
  assert.deepEqual(owner(env).values.get("credential"), initial);
  assert.equal(env.values.get(key), corrupt);
});

for (const action of [replace, revoke]) for (const failure of ["kv-read", "owner-read", "index-read", "owner-store", "owner-ack", "publish-sql", "publish-ack", "kv-put", "ack-store", ...(action === replace ? ["admit-sql", "admit-ack"] : [])]) test(`ownerless ${action.name} recovers ${failure} without importing corrupt secrets or losing old attachments before commit`, async () => {
  const env = fixture(), restore = failOnce(env, failure);
  await assert.rejects(() => action(env), error => !/old-private|new-private/.test(error.message));
  const committed = owner(env).values.get("credential");
  if (!committed) {
    assert.equal(env.values.get(key), corrupt);
    assert.deepEqual((await pool(env, "openai")).keys, [key]);
    assert.deepEqual((await pool(env, "retired-provider")).keys, [key]);
    assert.deepEqual((await pool(env, "anthropic")).keys, []);
  } else {
    assert.equal(committed.generation, 8);
    assert.doesNotMatch(JSON.stringify(committed), /old-private/);
    if (action === revoke) assert.equal(committed.credential, undefined);
  }
  restore();
  owner(env).object = new GrantCredentialObject(owner(env).state, env);
  if (!committed && (await attachment(env)).pending) {
    assert.equal((await reconcileGrantAttachment(env, key)).outcome, "unresolved");
    assert.equal((await attachment(env)).pending, true, "nonzero index evidence requires explicit recovery");
  }
  if (committed) await reconcileGrantAttachment(env, key);
  else await action(env);
  assert.equal(owner(env).values.get("credential").generation, 8);
  assert.equal(owner(env).values.get("credential").poolSyncPending, false);
  assert.equal((await attachment(env)).pending, false);
  assert.deepEqual(await members(env), action === replace ? [{ provider_id: "anthropic", status: "active" }] : []);
  assert.doesNotMatch(JSON.stringify(env.values.get(key)), /old-private|new-private/);
});

test("a canonical dirty receipt is reconciled before another explicit replacement admission", async () => {
  const env = fixture(), restore = failOnce(env, "publish-ack");
  await assert.rejects(() => replace(env));
  restore();
  const paths = [], fetch = env.grantAuthority.fetch;
  env.grantAuthority.fetch = (url, init) => { paths.push(new URL(url).pathname); return fetch(url, init); };
  await replace(env);
  assert.ok(paths.indexOf("/grant-pools/publish") < paths.indexOf("/grant-pools/admit"));
  assert.equal(owner(env).values.get("credential").generation, 9);
});

for (const first of [replace, revoke]) test(`corrupt recovery serializes ${first.name} with the later command and rejects delayed index writes`, async () => {
  const env = fixture(), entered = Promise.withResolvers(), held = Promise.withResolvers();
  const put = owner(env).state.storage.put;
  let stop = true;
  owner(env).state.storage.put = async (...args) => {
    if (stop) { stop = false; entered.resolve(); await held.promise; }
    return put(...args);
  };
  const earlier = first(env);
  await entered.promise;
  const stale = await attachment(env);
  assert.deepEqual((await pool(env, "openai")).keys, [key]);
  assert.equal(owner(env).values.has("credential"), false);
  let completed = false;
  const later = (first === replace ? revoke : replace)(env).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  held.resolve();
  await Promise.all([earlier, later]);
  assert.equal(owner(env).values.get("credential").generation, 9);
  assert.equal(!!owner(env).values.get("credential").credential, first === revoke);
  await assert.rejects(() => env.grantAuthority.call("cancel-pending", { key, revision: stale.revision }), error => error.code === "grant_attachment_changed");
  await assert.rejects(() => env.grantAuthority.call("publish", { key, generation: stale.generation, revision: stale.revision, provider: "openai", status: "active" }), error => error.code === "grant_attachment_changed");
});

test("full capacity rejects active legacy recovery but permits a paused replacement", async () => {
  const env = fixture(), before = await attachment(env);
  for (let i = 0; i < 32; i++) env.grantAuthority.seedLegacy(`oauth/policy/full-${i}`, "anthropic");
  await assert.rejects(() => replace(env));
  assert.deepEqual(await attachment(env), before);
  assert.equal(owner(env).values.has("credential"), false);
  await putGrantCredentials(env, key, { ...grant, enabled: false }, false, "replace");
  assert.equal(owner(env).values.get("credential").enabled, false);
  assert.equal((await pool(env, "anthropic")).keys.length, 32);
});

for (const owned of [false, true]) for (const action of [replace, revoke]) test(`${owned ? "owned" : "ownerless"} ${action.name} rejects generation exhaustion before mutation`, async () => {
  const env = fixture({ generation: Number.MAX_SAFE_INTEGER - 1 });
  if (owned) seedOldOwner(env, Number.MAX_SAFE_INTEGER - 1);
  const before = await attachment(env), stored = structuredClone(owner(env).values.get("credential"));
  await assert.rejects(() => action(env), error => error.code === "grant_generation_exhausted");
  assert.deepEqual(await attachment(env), before);
  assert.deepEqual(owner(env).values.get("credential"), stored);
  assert.equal(env.values.get(key), corrupt);
});

function fixture({ raw = corrupt, generation = 7, providers = ["openai", "retired-provider"] } = {}) {
  const values = new Map(raw === null ? [] : [[key, raw]]);
  const env = attachGrantCredentialNamespace({ values, POLICY_KV: {
    async get(name, type) {
      const value = values.get(name) ?? null;
      return value === null ? null : type === "text" ? typeof value === "string" ? value : JSON.stringify(value) : typeof value === "string" ? JSON.parse(value) : structuredClone(value);
    },
    async put(name, value) { values.set(name, JSON.parse(value)); },
  } });
  for (const provider of providers) env.grantAuthority.seedLegacy(key, provider);
  if (generation) env.grantAuthority.sql.exec("INSERT INTO upstream_grant_pool_versions (grant_key, generation, revision) VALUES (?, ?, ?)", key, generation, 4);
  env.GRANT_CREDENTIALS.get(key);
  return env;
}

function seedOldOwner(env, generation = 7) {
  owner(env).values.set("credential", { version: 1, generation, status: "active", grantKey: key, providerId: "openai", kind: "api_key", credential: "owned-private", accountId: "owned-account", updatedAt: "2026-09-01T00:00:00.000Z" });
}

function owner(env) { return env.GRANT_CREDENTIALS.objects.get(key); }
function attachment(env) { return env.grantAuthority.call("attachment", { key }); }
function pool(env, providerId) { return env.grantAuthority.call("resolve", { policyId: "policy", providerId }); }
function members(env) { return env.grantAuthority.sql.exec("SELECT provider_id, status FROM upstream_grant_pool_members WHERE token_ref = 'legacy-account' ORDER BY provider_id").map(({ provider_id, status }) => ({ provider_id, status })); }

function failOnce(env, failure) {
  let fired = false;
  const hit = () => { if (!fired) { fired = true; throw new Error("fixture unavailable"); } };
  const { storage } = owner(env).state, authority = env.grantAuthority;
  const get = storage.get, put = storage.put, kvGet = env.POLICY_KV.get, kvPut = env.POLICY_KV.put, fetch = authority.fetch, exec = authority.sql.exec;
  storage.get = async (...args) => { if (failure === "owner-read") hit(); return get(...args); };
  storage.put = async (...args) => {
    if (failure === "owner-store" || failure === "ack-store" && args[1].poolSyncPending === false) hit();
    await put(...args);
    if (failure === "owner-ack") hit();
  };
  env.POLICY_KV.get = async (...args) => { if (failure === "kv-read") hit(); return kvGet(...args); };
  env.POLICY_KV.put = async (...args) => { if (failure === "kv-put") hit(); return kvPut(...args); };
  authority.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (failure === "index-read" && path.endsWith("/attachment")) hit();
    const response = await fetch(url, init);
    if (failure === "admit-ack" && path.endsWith("/admit") || failure === "publish-ack" && path.endsWith("/publish")) hit();
    return response;
  };
  authority.sql.exec = (query, ...bindings) => {
    if (failure === "admit-sql" && query.startsWith("INSERT INTO upstream_grant_pool_members") || failure === "publish-sql" && query.startsWith("DELETE FROM upstream_grant_pool_members")) hit();
    return exec(query, ...bindings);
  };
  return () => { storage.get = get; storage.put = put; env.POLICY_KV.get = kvGet; env.POLICY_KV.put = kvPut; authority.fetch = fetch; authority.sql.exec = exec; };
}
