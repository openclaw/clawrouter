import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { GrantCredentialObject, accountCredentialResponse, installOAuthTokenResponse, materializeGrantCredentials, putGrantCredentials, revokeGrantCredentials } from "../grant-credentials.ts";
import { tokenResponseExpiry, REFRESH_MARGIN_MS } from "../grant-expiry.ts";
import { grantAvailable, grantUsable, resolveGrantCandidates, selectPolicyCandidates } from "../grant-selection.ts";
import { grantResponse } from "../grant-credential-view.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

const key = "oauth/policy/expiry";
const now = Date.parse("2026-09-24T12:00:00Z");
const refresh = { tokenUrl: "https://token.example/refresh" };
const invalid = error => error.code === "grant_refresh_failed" && error.status === 502;
const reauth = error => error.code === "grant_reauthorization_required";
const token = { access_token: "rotated-access-fixture", refresh_token: "rotated-refresh-fixture" };

for (const value of [null, "3600", -1, {}, [], true, Number.MAX_VALUE, Infinity, NaN]) test(`expiry classifier denies explicit ${JSON.stringify(value)}`, () => {
  assert.deepEqual(tokenResponseExpiry({ expires_in: value }, now), { expiresAt: null, tokenResponseError: "invalid_expiry" });
});
test("expiry classifier distinguishes omission, zero and a representable positive deadline", () => {
  assert.deepEqual(tokenResponseExpiry({}, now), { expiresAt: null, tokenResponseError: null });
  assert.deepEqual(tokenResponseExpiry({ expires_in: 0 }, now), { expiresAt: new Date(now).toISOString(), tokenResponseError: null });
  assert.deepEqual(tokenResponseExpiry({ expires_in: 3600 }, now), { expiresAt: new Date(now + 3_600_000).toISOString(), tokenResponseError: null });
  assert.equal(tokenResponseExpiry({ expires_in: 8.64e12 }, now).tokenResponseError, "invalid_expiry");
});

for (const via of ["foreground", "alarm", "callback"]) test(`${via} zero expiry retains rotation and schedules only the existing recovery window`, async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture(), active = await putGrantCredentials(env, key, grant());
  const own = owner(env), before = structuredClone(row(env));
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ...token, expires_in: 0 }); });
  if (via === "callback") await assert.rejects(() => installOAuthTokenResponse(env, key, grant(), { ...token, expires_in: 0 }), invalid);
  else if (via === "alarm") {
    row(env).nextRefreshAttemptAt = new Date(now - 1).toISOString();
    await own.object.alarm();
  } else await assert.rejects(() => materialize(env, active, true), invalid);
  const rotated = structuredClone(row(env)), initialCalls = calls;
  assert.equal(rotated.generation, before.generation + 1);
  assert.equal(rotated.accessToken, token.access_token);
  assert.equal(rotated.refreshToken, token.refresh_token);
  assert.equal(rotated.expiresAt, new Date(now).toISOString());
  assert.equal(rotated.tokenResponseError, null);
  assert.equal(rotated.nextRefreshAttemptAt, new Date(now + REFRESH_MARGIN_MS).toISOString());
  assert.equal(own.alarm(), now + REFRESH_MARGIN_MS);
  assert.equal(grantResponse(key, env.values.get(key)).usable, false);
  row(env).nextQuotaProbeAt = row(env).nextKeepWarmAt = new Date(now - 1).toISOString();
  clock++;
  await own.object.alarm();
  await Promise.all([assert.rejects(() => materialize(env, active), invalid), assert.rejects(() => materialize(env, active, true), invalid)]);
  assert.equal(calls, initialCalls, "stale forced requests and early alarms cannot bypass the retry generation/window");
  assert.equal(row(env).nextRefreshAttemptAt, rotated.nextRefreshAttemptAt);
  assert.equal(own.alarm(), now + REFRESH_MARGIN_MS);
  clock = now + REFRESH_MARGIN_MS;
  await Promise.all([own.object.alarm(), own.object.alarm()]);
  assert.equal(calls, initialCalls + 1);
  assert.equal(row(env).nextRefreshAttemptAt, new Date(clock + REFRESH_MARGIN_MS).toISOString());
  assert.equal(own.alarm(), clock + REFRESH_MARGIN_MS);
});

for (const fault of ["none", "owner-ack", "kv", "index"]) test(`malformed rotation survives restart, stale projection and ${fault}`, async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture(), active = await putGrantCredentials(env, key, grant()), own = owner(env);
  const old = structuredClone(row(env));
  let calls = 0, armed = true;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ...token, expires_in: "bad", error_description: "private-provider-detail" }); });
  const put = own.state.storage.put, kv = env.POLICY_KV.put, get = env.ACCESS_CONTROL.get;
  if (fault === "owner-ack") own.state.storage.put = async (name, value) => { await put(name, value); if (armed && value.tokenResponseError) { armed = false; throw new Error("lost ACK"); } };
  if (fault === "kv") env.POLICY_KV.put = async (...args) => { if (armed) { armed = false; throw new Error("KV unavailable"); } return kv(...args); };
  if (fault === "index") env.ACCESS_CONTROL.get = id => ({ fetch: (url, init) => {
    if (new URL(url).pathname === "/grant-pools/publish" && armed) { armed = false; throw new Error("index unavailable"); }
    return get(id).fetch(url, init);
  } });
  await assert.rejects(() => materialize(env, active, true));
  assert.equal(row(env).generation, old.generation + 1);
  assert.equal(row(env).lineage, old.lineage);
  assert.equal(row(env).accessToken, token.access_token);
  assert.equal(row(env).refreshToken, token.refresh_token);
  assert.equal(row(env).tokenResponseError, "invalid_expiry");
  assert.equal(row(env).expiresAt, null);
  assert.equal(row(env).status, "active");
  own.object = new GrantCredentialObject(own.state, env);
  await assert.rejects(() => materialize(env, active), invalid);
  assert.equal(calls, 1);
  const attachment = await env.grantAuthority.call("attachment", { key });
  assert.equal(attachment.attached, true);
  assert.equal(env.grantAuthority.sql.exec("SELECT status FROM upstream_grant_pool_members WHERE scope_id = ? AND token_ref = ?", "policy", "expiry")[0].status, "active");
  const projection = env.values.get(key), view = grantResponse(key, projection);
  assert.equal(grantUsable(projection), true, "configured presence survives retryable denial");
  assert.equal(grantAvailable(projection), false);
  assert.equal(view.usable, false);
  assert.equal(view.tokenResponseError, "invalid_expiry");
  assert.doesNotMatch(JSON.stringify([projection, view]), /rotated-access-fixture|rotated-refresh-fixture|private-provider-detail/);
});

for (const outcome of ["omitted", "positive", "zero", "transient", "permanent"]) test(`denied token recovery handles ${outcome} without losing its rotated pair`, async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture();
  await assert.rejects(() => installOAuthTokenResponse(env, key, grant(), { ...token, expires_in: null }), invalid);
  clock += REFRESH_MARGIN_MS;
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), token.refresh_token);
    if (outcome === "transient") return Response.json({ error: "unavailable" }, { status: 503 });
    if (outcome === "permanent") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "recovered-fixture", ...(outcome === "omitted" ? {} : { expires_in: outcome === "zero" ? 0 : 3600 }) });
  });
  const operation = () => materialize(env, env.values.get(key));
  if (["omitted", "positive"].includes(outcome)) assert.equal((await operation()).accessToken, "recovered-fixture");
  else await assert.rejects(operation, outcome === "permanent" ? reauth : invalid);
  assert.equal(calls, 1);
  assert.equal(row(env).refreshToken, token.refresh_token);
  assert.equal(row(env).tokenResponseError, ["transient", "permanent"].includes(outcome) ? "invalid_expiry" : null);
  if (outcome === "omitted") assert.equal(row(env).expiresAt, null);
  if (["zero", "transient"].includes(outcome)) assert.equal(owner(env).alarm(), clock + REFRESH_MARGIN_MS);
  if (outcome === "permanent") { assert.equal(row(env).status, "reauth_required"); assert.equal(owner(env).alarm(), null); }
});

test("ordinary refresh omission discards the old deadline and retry state", async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture(), active = await putGrantCredentials(env, key, grant());
  context.mock.method(globalThis, "fetch", async () => Response.json(token));
  const result = await materialize(env, active, true);
  assert.equal(result.expiresAt, null);
  assert.equal(result.nextRefreshAttemptAt, null);
  assert.equal(row(env).expiresAt, null);
});

for (const edit of [{ label: "renamed" }, { enabled: false }, { expiresAt: "2099-01-01T00:00:00Z" }, { expiresAt: null }, { refreshToken: null }, { refreshToken: "different-refresh" }, { accountId: "different-account" }]) test(`legacy metadata ${Object.keys(edit)[0]} cannot heal token-response denial`, async () => {
  const env = fixture();
  await assert.rejects(() => installOAuthTokenResponse(env, key, grant(), { ...token, expires_in: null }), invalid);
  await putGrantCredentials(env, key, { ...env.values.get(key), ...edit, tokenResponseError: null, nextRefreshAttemptAt: null }, true);
  assert.equal(row(env).tokenResponseError, "invalid_expiry");
  assert.equal(env.values.get(key).tokenResponseError, "invalid_expiry");
  assert.equal(row(env).metadata.tokenResponseError, undefined);
  assert.equal(row(env).metadata.nextRefreshAttemptAt, undefined);
  await putGrantCredentials(env, key, { ...env.values.get(key), enabled: true, accessToken: "fresh-primary" }, true);
  assert.equal(row(env).tokenResponseError, null);
  await revokeGrantCredentials(env, key);
  assert.equal(row(env).tokenResponseError, undefined);
  assert.equal(row(env).metadata.tokenResponseError, undefined);
});

test("strict CAS refuses before expiry mutation, while accepted metadata cannot extend expired authority", async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture();
  await putGrantCredentials(env, key, grant({ refreshToken: null, expiresAt: new Date(now + 10).toISOString() }));
  const before = structuredClone(row(env));
  clock += 11;
  let response = await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: 99, expiresAt: null });
  assert.equal(response.status, 409);
  assert.deepEqual(row(env), before);
  response = await accountCredentialResponse(env, key, "read");
  assert.equal((await response.json()).usable, false);
  assert.deepEqual(row(env), before, "read does not transition expiry");
  response = await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: before.generation, expiresAt: "2099-01-01T00:00:00Z" });
  assert.equal(response.status, 200);
  assert.equal(row(env).generation, before.generation + 1);
  assert.equal(row(env).expiresAt, before.expiresAt);
  assert.equal(row(env).status, "reauth_required");
  assert.equal(owner(env).alarm(), null);
});

test("strict metadata cannot forge expiry facts and replacement clears them without resuming", async () => {
  const env = fixture();
  await assert.rejects(() => installOAuthTokenResponse(env, key, grant(), { ...token, expires_in: null }), invalid);
  const before = structuredClone(row(env));
  for (const field of ["tokenResponseError", "nextRefreshAttemptAt"]) {
    const result = await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: before.generation, [field]: null });
    assert.equal(result.status, 400);
    assert.deepEqual(row(env), before);
  }
  await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: before.generation, expiresAt: null, enabled: false, refreshToken: null });
  assert.equal(row(env).tokenResponseError, "invalid_expiry");
  assert.equal(owner(env).alarm(), null);
  const result = await accountCredentialResponse(env, key, "replace", { expectedCredentialGeneration: row(env).generation, accessToken: "replacement-fixture" });
  assert.equal(result.status, 200);
  assert.equal(row(env).tokenResponseError, undefined);
  assert.equal(env.values.get(key).tokenResponseError, null);
  assert.equal(row(env).enabled, false);
});

for (const installation of ["put", "lazy"]) test(`${installation} imports cannot forge canonical expiry markers`, async () => {
  const env = fixture(), forged = grant({ tokenResponseError: "invalid_expiry", nextRefreshAttemptAt: "2099-01-01T00:00:00Z" });
  if (installation === "put") await putGrantCredentials(env, key, forged);
  else { env.values.set(key, forged); await materialize(env, forged); }
  assert.equal(row(env).tokenResponseError, undefined);
  assert.equal(env.values.get(key).tokenResponseError, null);
  assert.equal(env.values.get(key).nextRefreshAttemptAt, null);
  assert.equal((await materialize(env, forged)).tokenResponseError, null);
});

test("availability skips expired access-only and denied grants before policy choice while preserving presence", async () => {
  const env = fixture();
  const expired = await putGrantCredentials(env, key, grant({ refreshToken: null, expiresAt: "2020-01-01T00:00:00Z" }));
  const candidates = await resolveGrantCandidates("openai", "policy", "default", "expiry", env);
  assert.equal(candidates.available.length, 0);
  assert.equal(candidates.hasConfiguredGrant, true);
  const later = { available: [{ key: "later", grant: grant() }], hasConfiguredGrant: true, environmentReady: true };
  assert.equal(selectPolicyCandidates([{ entry: { id: "first" }, candidates }, { entry: { id: "second" }, candidates: later }]).entry.id, "second");
  await assert.rejects(() => materialize(env, expired), reauth);
  assert.equal(row(env).status, "reauth_required");
});

test("expired renewable selection enters the canonical owner only when recovery is due", async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture();
  await putGrantCredentials(env, key, grant({ expiresAt: new Date(now - 1).toISOString() }));
  assert.equal((await resolveGrantCandidates("openai", "policy", "default", "expiry", env)).available.length, 1);
  context.mock.method(globalThis, "fetch", async () => Response.json({ ...token, expires_in: 0 }));
  await assert.rejects(() => materialize(env, env.values.get(key)), invalid);
  const denied = await resolveGrantCandidates("openai", "policy", "default", "expiry", env);
  assert.equal(denied.available.length, 0);
  assert.equal(denied.hasConfiguredGrant, true);
});

for (const mutation of ["legacy", "strict"]) test(`${mutation} expiry edits preserve expired renewable authority and clearing refresh requires reauthorization`, async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture();
  await putGrantCredentials(env, key, grant({ expiresAt: new Date(now + 10).toISOString() }));
  clock += 11;
  const original = structuredClone(row(env));
  if (mutation === "legacy") await putGrantCredentials(env, key, { ...env.values.get(key), expiresAt: null }, true);
  else assert.equal((await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: row(env).generation, expiresAt: null })).status, 200);
  assert.equal(row(env).expiresAt, original.expiresAt);
  assert.equal(row(env).status, "active");
  assert.equal(row(env).generation, original.generation + 1);
  assert.equal((await accountCredentialResponse(env, key, "patch", { expectedCredentialGeneration: row(env).generation, refreshToken: null })).status, 200);
  assert.equal(row(env).status, "reauth_required");
});

for (const expiry of [0, null]) test(`unrenewable callback expiry ${expiry} is denied without a recovery alarm`, async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture();
  await assert.rejects(() => installOAuthTokenResponse(env, key, grant({ refreshToken: null }), { access_token: "callback-fixture", expires_in: expiry }), invalid);
  assert.equal(row(env).accessToken, "callback-fixture");
  assert.equal(row(env).status, expiry === 0 ? "reauth_required" : "active");
  assert.equal(row(env).tokenResponseError, expiry === 0 ? null : "invalid_expiry");
  assert.equal(owner(env).alarm(), null);
  context.mock.method(globalThis, "fetch", async () => assert.fail("unrenewable egress"));
  await owner(env).object.alarm();
  await assert.rejects(() => materialize(env, env.values.get(key)), expiry === 0 ? reauth : invalid);
});

for (const renewable of [false, true]) test(`missing transport still processes ${renewable ? "renewal" : "terminal expiry"}`, async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture(), active = await putGrantCredentials(env, key, grant({ provider: "retired-provider", kind: "oauth", refreshToken: renewable ? "refresh-fixture" : null, expiresAt: new Date(now + 1).toISOString() }));
  if (!renewable) assert.equal(owner(env).alarm(), now + 1_000, "the existing minimum delay bounds a deadline alarm without a transport");
  row(env).expiresAt = new Date(now - 1).toISOString();
  row(env).nextQuotaProbeAt = row(env).nextKeepWarmAt = new Date(now - 1).toISOString();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ...token, expires_in: 0 }); });
  await owner(env).object.alarm();
  assert.equal(calls, renewable ? 1 : 0);
  assert.equal(row(env).generation, active.credentialGeneration + 1);
  assert.equal(row(env).status, renewable ? "active" : "reauth_required");
  assert.equal(owner(env).alarm(), renewable ? now + REFRESH_MARGIN_MS : null);
});

for (const expiry of [null, 0]) test(`denied ${expiry} renewal blocks overdue quota and keep-warm traffic`, async context => {
  context.mock.method(Date, "now", () => now);
  const env = fixture();
  await putGrantCredentials(env, key, grant({ provider: "anthropic", maintenance: { keepWarm: true } }));
  row(env).nextRefreshAttemptAt = row(env).nextQuotaProbeAt = row(env).nextKeepWarmAt = new Date(now - 1).toISOString();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async url => {
    calls++;
    assert.equal(String(url), refresh.tokenUrl, "only recovery may use the token while maintenance is denied");
    return Response.json({ ...token, expires_in: expiry });
  });
  await owner(env).object.alarm();
  await owner(env).object.alarm();
  assert.equal(calls, 1);
  assert.equal(owner(env).alarm(), now + REFRESH_MARGIN_MS);
  assert.equal(row(env).nextQuotaProbeAt, new Date(now - 1).toISOString());
  assert.equal(row(env).nextKeepWarmAt, new Date(now - 1).toISOString());
});

test("expiry crossing awaited keep-warm prerequisites denies egress and commits reauthorization", async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture();
  await putGrantCredentials(env, key, grant({ provider: "anthropic", refreshToken: null, maintenance: { keepWarm: true }, expiresAt: new Date(now + 10).toISOString() }));
  row(env).nextKeepWarmAt = new Date(now - 1).toISOString();
  const get = env.ACCESS_CONTROL.get;
  env.ACCESS_CONTROL.get = id => ({ fetch: (url, init) => {
    if (new URL(url).pathname === "/grant-pools/states") { clock += 11; return Response.json({ states: {} }); }
    return get(id).fetch(url, init);
  } });
  context.mock.method(globalThis, "fetch", async () => assert.fail("expired keep-warm egress"));
  await owner(env).object.alarm();
  assert.equal(row(env).status, "reauth_required");
  assert.equal(owner(env).alarm(), null);
});

test("final materialization rechecks expiry after awaited publication", async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const env = fixture(), active = await putGrantCredentials(env, key, grant({ refreshToken: null, expiresAt: new Date(now + 10).toISOString() }));
  const get = env.POLICY_KV.get;
  env.POLICY_KV.get = async (...args) => { clock += 11; return get(...args); };
  await assert.rejects(() => materialize(env, { ...active, credentialGeneration: 0 }), invalid);
});

function fixture() {
  const values = new Map();
  return attachGrantCredentialNamespace({ values, POLICY_KV: {
    async get(key, type) {
      if (Array.isArray(key)) return new Map(key.map(item => [item, structuredClone(values.get(item) ?? null)]));
      const value = values.get(key) ?? null;
      return type === "text" && value !== null ? JSON.stringify(value) : structuredClone(value);
    },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  } });
}
function grant(extra = {}) { return { provider: "openai", kind: "subscription", enabled: true, accessToken: "access-fixture", refreshToken: "refresh-fixture", refresh, accountId: "account-fixture", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra }; }
function owner(env) { env.GRANT_CREDENTIALS.get(key); return env.GRANT_CREDENTIALS.objects.get(key); }
function row(env) { return owner(env).values.get("credential"); }
function materialize(env, projection, force = false) { return materializeGrantCredentials(env, key, projection, "openai", refresh, force); }
