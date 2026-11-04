import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
const { adminApi } = await import("../admin.ts");
const { GrantCredentialObject, inspectGrantCredentials, revokeGrantCredentials, putGrantCredentials, materializeGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");

const origin = "https://console.example.invalid";
const issuer = "https://device-fixture.cloudflareaccess.com";
const email = "admin@example.invalid", otherEmail = "other@example.invalid", key = "oauth/fixture/minimax";
const path = "/v1/admin/upstream-grants/policies/fixture/minimax/authorize";
let keys, jwk;
test.before(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "device-test-key" };
});
async function jwt(actor = email, patch = {}) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "device-fixture", email: actor, sub: actor, exp: Math.floor(Date.now() / 1000) + 3600, ...patch })}`;
  return `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}
function deferred() { return Promise.withResolvers(); }
async function fixture(t) {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const kv = new Map(), sent = [], logs = [];
  const env = { CLAWROUTER_ACCESS_TEAM_DOMAIN: issuer, CLAWROUTER_ACCESS_AUD: "device-fixture",
    CLAWROUTER_ACCESS_ADMIN_EMAILS: `${email},${otherEmail}`, CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex("synthetic-admin-token"),
    POLICY_KV: { async get(k, type) { const v = kv.get(k); return v === undefined ? null : type === "json" ? structuredClone(v) : JSON.stringify(v); },
      async put(k, v) { kv.set(k, JSON.parse(v)); }, async list({ prefix = "" } = {}) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: (url, init) => authority.fetch(url, init) }) };
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: kv });
  const f = { env, kv, sent, logs, authority,
    advance(ms = 2000) { now += ms; },
    owner() { return env.GRANT_CREDENTIALS.objects.get(key); },
    record() { return structuredClone(f.owner()?.values.get("credential")); },
    restart() { const o = f.owner(); o.object = new GrantCredentialObject(o.state, env); },
    async user(enabled, actor = email) {
      return authority.fetch("https://clawrouter.internal/users/put", { method: "POST", body: JSON.stringify({ email: actor, record: { role: "admin", enabled, tenantId: "default", groups: [], contentRetentionDisabled: false } }) });
    },
    reply(url, init) {
      const form = new URLSearchParams(init.body);
      if (url.endsWith("/device/code")) return Response.json({ state: form.get("state"), user_code: "SYNTHETIC-CODE", verification_uri: url.includes("minimaxi") ? "https://platform.minimaxi.com/approve" : "https://platform.minimax.io/approve", expired_in: now + 60_000, interval: 2000 });
      return Response.json({ status: "success", access_token: "synthetic-device-access", refresh_token: "synthetic-device-refresh", expired_in: 3600 });
    },
    async run(body, options = {}) {
      const headers = new Headers({ origin, "content-type": "application/json", "cf-access-jwt-assertion": await jwt(options.actor) });
      for (const [k, v] of Object.entries(options.headers ?? {})) { if (v === null) headers.delete(k); else headers.set(k, v); }
      return adminApi(new Request(`${origin}${options.path ?? path}`, { method: "POST", headers, body: JSON.stringify({ flow: "minimax-device.v1", provider: "minimax", ...body }), signal: options.signal }), env, options.path ?? path);
    },
    begin(extra = {}, options) { return f.run({ operation: "begin", region: "global", intentId: "synthetic-intent-0001", expectedGeneration: 0, ...extra }, options); },
    action(operation, attemptId, options) { return f.run({ operation, attemptId }, options); },
  };
  for (const name of ["log", "warn", "error"]) t.mock.method(console, name, (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    assert.match(String(url), /^https:\/\/account\.minimax(?:i)?\.(?:io|com)\/oauth2\/(?:device\/code|token)$/);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has("cf-access-jwt-assertion"), false);
    sent.push({ url: String(url), init, record: f.record() });
    return f.reply(String(url), init);
  });
  t.after(() => assert.deepEqual(logs, []));
  await f.user(true); await f.user(true, otherEmail);
  return f;
}
async function body(response, status = 200) {
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  if (status === 200) assert.match(response.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-device-(?:access|refresh)|verifier|ownerBinding|code_challenge|credentialGeneration/);
  return value;
}

for (const region of ["global", "cn"]) test(`MiniMax device ${region} real admin/owner installs exactly once with native PKCE`, async t => {
  const f = await fixture(t), begin = await body(await f.begin({ region }));
  assert.equal(begin.status, "pending"); assert.equal(begin.userCode, "SYNTHETIC-CODE");
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].record.minimaxDeviceAttempt.phase, "begin_unknown");
  const form = new URLSearchParams(f.sent[0].init.body), session = f.record().minimaxDeviceAttempt.session;
  assert.equal(form.get("code_challenge_method"), "S256");
  assert.equal(form.get("code_challenge"), Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.verifier))).toString("base64url"));
  await body(await f.action("poll", begin.attemptId), 409); assert.equal(f.sent.length, 1);
  f.advance(); const completed = await body(await f.action("poll", begin.attemptId)); assert.equal(completed.status, "committed");
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].record.minimaxDeviceAttempt.phase, "poll_unknown");
  assert.equal(new URLSearchParams(f.sent[1].init.body).get("code_verifier"), session.verifier);
  const record = f.record(); assert.equal(record.accessToken, "synthetic-device-access"); assert.equal(record.credentialProvenance, "clawrouter_oauth");
  assert.equal(record.minimaxAnthropicBinding.region, region); assert.equal(record.nativeMediaBinding ?? null, null);
  assert.equal(record.minimaxDeviceAttempt.session, undefined); assert.equal(record.minimaxDeviceAttempt.authorization, undefined);
  const generation = record.generation;
  for (const operation of ["poll", "status"]) assert.equal((await body(await f.action(operation, begin.attemptId))).status, "committed");
  assert.equal(f.sent.length, 2); assert.equal(f.record().generation, generation);
  const projection = await inspectGrantCredentials(f.env, key);
  assert.doesNotMatch(JSON.stringify(projection), /SYNTHETIC-CODE|synthetic-device|verifier|minimaxDeviceAttempt/);
  const materialized = await materializeGrantCredentials(f.env, key, projection, "minimax", null, false);
  assert.equal(materialized.accessToken, "synthetic-device-access"); assert.equal(materialized.minimaxAnthropicBinding.region, region);
});

for (const options of [
  { headers: { "cf-access-jwt-assertion": null, authorization: "Bearer synthetic-admin-token" } },
  { headers: { "cf-access-jwt-assertion": null, authorization: "Bearer synthetic-proxy-key" } },
  { headers: { origin: "https://foreign.example.invalid" } }, { headers: { origin: null } }, { actor: "member@example.invalid" },
]) test("MiniMax device requires verified current Access admin and same-origin " + JSON.stringify(options), async t => {
  const f = await fixture(t), response = await f.begin({}, options);
  assert.ok([401, 403].includes(response.status)); await response.text(); assert.equal(f.sent.length, 0);
});

for (const change of [{ region: "unknown" }, { provider: "other" }, { flow: "unknown" }, { tokenEndpoint: "https://other.example/token" },
  { intentId: "bad" }, { expectedGeneration: -1 }, { expectedGeneration: 1 }, { priority: -1 }])
  test("MiniMax device closed begin request " + JSON.stringify(change), async t => {
    const f = await fixture(t), r = await f.begin(change); assert.ok([400, 409].includes(r.status)); await r.text(); assert.equal(f.sent.length, 0);
  });

test("MiniMax concurrent begin and poll deduplicate without holding the owner tail over I/O", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), reply = f.reply;
  f.reply = async (...args) => { entered.resolve(); await release.promise; return reply(...args); };
  const first = f.begin(); await entered.promise;
  const duplicate = await body(await f.begin()); assert.equal(duplicate.status, "starting"); assert.equal(f.sent.length, 1);
  release.resolve(); const begin = await body(await first); assert.equal(begin.attemptId, duplicate.attemptId);
  f.advance(); const polled = deferred(), token = deferred();
  f.reply = async (...args) => { polled.resolve(); await token.promise; return reply(...args); };
  const firstPoll = f.action("poll", begin.attemptId); await polled.promise;
  const second = await body(await f.action("poll", begin.attemptId)); assert.equal(second.status, "polling"); assert.equal(f.sent.length, 2);
  token.resolve(); assert.equal((await body(await firstPoll)).status, "committed");
});

for (const phase of ["begin", "poll"]) for (const mutation of ["cancel", "revoke", "replace", "admin"])
  test(`MiniMax ${mutation} during ${phase} fetch denies late success`, async t => {
    const f = await fixture(t), begin = phase === "poll" ? await body(await f.begin()) : null;
    f.advance(); const entered = deferred(), release = deferred(), reply = f.reply;
    f.reply = async (...args) => { entered.resolve(); await release.promise; return reply(...args); };
    const pending = phase === "poll" ? f.action("poll", begin.attemptId) : f.begin(); await entered.promise;
    const id = f.record().minimaxDeviceAttempt.id;
    if (mutation === "cancel") assert.equal((await body(await f.action("cancel", id))).status, "cancelled");
    else if (mutation === "revoke") await revokeGrantCredentials(f.env, key);
    else if (mutation === "replace") await putGrantCredentials(f.env, key, { provider: "minimax", kind: "api_key", credential: "synthetic-replacement" });
    else await f.user(false);
    if (mutation !== "admin") assert.equal(f.sent.at(-1).init.signal.aborted, true);
    release.resolve(); const response = await pending; assert.ok([200, 403, 409].includes(response.status)); await response.text();
    assert.notEqual(f.record().accessToken, "synthetic-device-access");
    assert.equal(f.sent.length, phase === "poll" ? 2 : 1);
  });

test("MiniMax foreign actor/grant and changed region cannot operate the original attempt", async t => {
  const f = await fixture(t), begin = await body(await f.begin());
  await body(await f.action("status", begin.attemptId, { actor: otherEmail }), 409);
  await body(await f.action("status", begin.attemptId, { path: path.replace("/minimax/", "/foreign/") }), 409);
  await body(await f.begin({ region: "cn" }), 409);
  assert.equal(f.sent.length, 1);
});

for (const problem of ["state", "approval", "resource", "empty-refresh", "native-error", "slow-down", "missing-status", "redirect", "malformed", "network", "expiry", "empty-chunks"])
  test("MiniMax native " + problem + " is bounded unknown, never repeated", async t => {
    const f = await fixture(t), tokenPhase = ["resource", "empty-refresh", "native-error", "slow-down", "missing-status"].includes(problem);
    const begin = tokenPhase ? await body(await f.begin()) : null; f.advance();
    const reply = f.reply;
    f.reply = async (url, init) => {
      if (problem === "network") throw new Error("synthetic secret vendor error");
      if (problem === "redirect") return new Response(null, { status: 302, headers: { location: "https://foreign.example.invalid" } });
      if (problem === "malformed") return new Response("{", { headers: { "content-type": "application/json" } });
      if (problem === "empty-chunks") return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); } }), { headers: { "content-type": "application/json" } });
      const value = await reply(url, init).json();
      if (problem === "state") value.state = "foreign-state";
      if (problem === "approval") value.verification_uri = "https://foreign.example.invalid/approve";
      if (problem === "expiry") value.expired_in = Date.now() - 1;
      if (problem === "resource") value.resource_url = "https://api.minimaxi.com/anthropic";
      if (problem === "empty-refresh") value.refresh_token = "";
      if (problem === "native-error") value.base_resp = { status_code: 1004 };
      if (problem === "slow-down") value.status = "slow_down";
      if (problem === "missing-status") delete value.status;
      return Response.json(value);
    };
    const result = await body(await (tokenPhase ? f.action("poll", begin.attemptId) : f.begin())); assert.equal(result.status, "unknown");
    const count = f.sent.length;
    f.restart(); assert.equal((await body(await f.action("poll", result.attemptId))).status, "unknown");
    await body(await f.begin({ intentId: "synthetic-intent-0002", expectedGeneration: f.record().generation, replacesAttemptId: result.attemptId }), 409);
    assert.equal(f.sent.length, count); assert.equal(f.record().accessToken, undefined);
  });

test("MiniMax decoded pending respects milliseconds/minimum and absolute expiry; no automatic polling", async t => {
  const f = await fixture(t), reply = f.reply;
  f.reply = async (...args) => { const value = await reply(...args).json(); value.interval = 1; return Response.json(value); };
  const begin = await body(await f.begin()); assert.equal(begin.nextPollAt - Date.now(), 2000);
  f.advance(); f.reply = () => Response.json({ status: "pending" });
  const pending = await body(await f.action("poll", begin.attemptId)); assert.equal(pending.nextPollAt - Date.now(), 2000);
  await body(await f.action("poll", begin.attemptId), 409); assert.equal(f.sent.length, 2);
  f.advance(60_000); assert.equal((await body(await f.action("poll", begin.attemptId))).status, "expired"); assert.equal(f.sent.length, 2);
});

for (const mode of ["before-write", "lost-ack", "publication"])
  test(`MiniMax token ${mode} never replays and commits credential/terminal state atomically`, async t => {
    const f = await fixture(t), begin = await body(await f.begin()); f.advance();
    const o = f.owner(), put = o.state.storage.put, kvPut = f.env.POLICY_KV.put;
    let writes = 0;
    o.state.storage.put = async (name, value) => {
      if (value.minimaxDeviceAttempt?.phase === "committed") {
        writes++; assert.equal(value.accessToken, "synthetic-device-access");
        if (writes === 1 && mode === "before-write") throw new Error("synthetic persistence failure");
        await put(name, value);
        if (writes === 1 && mode === "lost-ack") throw new Error("synthetic lost ACK");
        return;
      }
      return put(name, value);
    };
    if (mode === "publication") f.env.POLICY_KV.put = async () => { throw new Error("synthetic publication failure"); };
    const result = await body(await f.action("poll", begin.attemptId));
    assert.equal(result.status, mode === "before-write" ? "unknown" : "committed");
    o.state.storage.put = put; f.env.POLICY_KV.put = kvPut; f.restart();
    assert.equal((await body(await f.action("status", begin.attemptId))).status, result.status);
    assert.equal((await body(await f.action("poll", begin.attemptId))).status, result.status); assert.equal(f.sent.length, 2);
    assert.equal(f.record().accessToken, mode === "before-write" ? undefined : "synthetic-device-access");
  });

test("MiniMax restart with a persisted dispatch fence is UNKNOWN without exchange recovery", async t => {
  const f = await fixture(t), begin = await body(await f.begin());
  const record = f.record(); record.minimaxDeviceAttempt.phase = "poll_unknown";
  await f.owner().state.storage.put("credential", record); f.restart();
  assert.equal((await body(await f.action("status", begin.attemptId))).status, "unknown");
  assert.equal((await body(await f.action("poll", begin.attemptId))).status, "unknown"); assert.equal(f.sent.length, 1);
});

test("MiniMax explicit new lifecycle requires a new intent and matching current generation", async t => {
  const f = await fixture(t), old = await body(await f.begin());
  await body(await f.action("cancel", old.attemptId));
  await body(await f.begin({ intentId: "synthetic-intent-0002" }), 409);
  const next = await body(await f.begin({ intentId: "synthetic-intent-0002", expectedGeneration: f.record().generation, replacesAttemptId: old.attemptId }));
  assert.notEqual(next.attemptId, old.attemptId); assert.equal(f.sent.length, 2);
  await body(await f.begin(), 409); assert.equal(f.sent.length, 2);
});

test("MiniMax device code persistence ACK loss recovers the same code without a second begin", async t => {
  const f = await fixture(t);
  f.env.GRANT_CREDENTIALS.get(key);
  const o = f.owner(), put = o.state.storage.put;
  let lost = false;
  o.state.storage.put = async (name, value) => {
    await put(name, value);
    if (!lost && value.minimaxDeviceAttempt?.phase === "pending") { lost = true; throw new Error("synthetic code ACK lost"); }
  };
  const begin = await body(await f.begin()); assert.equal(begin.status, "pending");
  f.restart(); assert.deepEqual(await body(await f.begin()), begin); assert.equal(f.sent.length, 1);
});

test("MiniMax admin revocation during final attachment await prevents credential installation", async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const result = await stub.fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/admit" && JSON.parse(init.body).status === "active") await f.user(false);
    return result;
  } }; };
  const response = await f.action("poll", begin.attemptId); assert.equal(response.status, 403); await response.text();
  assert.equal(f.record().accessToken, undefined); assert.equal(f.record().minimaxDeviceAttempt.phase, "unknown"); assert.equal(f.sent.length, 2);
});

test("MiniMax failed reservation write sends no request and creates no usable code", async t => {
  const f = await fixture(t); f.env.GRANT_CREDENTIALS.get(key);
  f.owner().state.storage.put = async () => { throw new Error("synthetic owner write failure"); };
  await body(await f.begin(), 503); assert.equal(f.sent.length, 0); assert.equal(f.record(), undefined);
});

test("MiniMax owner restart cannot replay a pending exchange after cancellation", async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const entered = deferred(), release = deferred(), reply = f.reply;
  f.reply = async (...args) => { entered.resolve(); await release.promise; return reply(...args); };
  const pending = f.action("poll", begin.attemptId); await entered.promise;
  await body(await f.action("cancel", begin.attemptId)); f.restart();
  release.resolve(); await body(await pending);
  assert.equal((await body(await f.action("poll", begin.attemptId))).status, "cancelled"); assert.equal(f.sent.length, 2);
});

test("MiniMax committed status cannot cross a later owner generation or lineage", async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  await body(await f.action("poll", begin.attemptId));
  const current = await inspectGrantCredentials(f.env, key);
  await putGrantCredentials(f.env, key, { ...current, label: "synthetic administrative update" }, true);
  await body(await f.action("status", begin.attemptId), 409);
  await body(await f.action("poll", begin.attemptId), 409);
  assert.equal(f.sent.length, 2);
});
