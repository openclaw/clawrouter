import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
const { adminApi } = await import("../admin.ts");
const { GrantCredentialObject, inspectGrantCredentials, revokeGrantCredentials, putGrantCredentials, materializeGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { sha256Hex } = await import("../utils.ts");

const origin = "https://console.example.invalid";
const issuer = "https://device-fixture.cloudflareaccess.com";
const email = "admin@example.invalid", otherEmail = "other@example.invalid", key = "oauth/fixture/copilot";
const path = "/v1/admin/upstream-grants/policies/fixture/copilot/authorize";
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
function vendor(url, value, status = 200) {
  let bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const stream = new ReadableStream({ type: 'bytes', pull(controller) {
    if (bytes) { const next = bytes; bytes = null; controller.enqueue(next); }
    else { controller.close(); controller.byobRequest?.respond(0); }
  } });
  const response = new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
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
    advance(ms = 5000) { now += ms; },
    owner() { return env.GRANT_CREDENTIALS.objects.get(key); },
    record() { return structuredClone(f.owner()?.values.get("credential")); },
    restart() { const o = f.owner(); o.object = new GrantCredentialObject(o.state, env); },
    async user(enabled, actor = email) {
      return authority.fetch("https://clawrouter.internal/users/put", { method: "POST", body: JSON.stringify({ email: actor, record: { role: "admin", enabled, tenantId: "default", groups: [], contentRetentionDisabled: false } }) });
    },
    reply(url) {
      return vendor(url, url.endsWith('/device/code')
        ? { device_code: 'synthetic-private-device-code', user_code: 'SYNTHETIC-CODE', verification_uri: new URL('/login/device', url).href, expires_in: 900, interval: 5 }
        : { access_token: 'synthetic-original-github-token', token_type: 'bearer', scope: 'read:user' });
    },
    async run(body, options = {}) {
      const headers = new Headers({ origin, "content-type": "application/json", "cf-access-jwt-assertion": await jwt(options.actor) });
      for (const [k, v] of Object.entries(options.headers ?? {})) { if (v === null) headers.delete(k); else headers.set(k, v); }
      return adminApi(new Request(`${origin}${options.path ?? path}?flow=copilot-device.v1`, { method: "POST", headers, body: options.raw ?? JSON.stringify({ flow: "copilot-device.v1", provider: "github-copilot", ...body }), signal: options.signal }), env, options.path ?? path);
    },
    begin(extra = {}, options) { return f.run({ operation: "begin", githubDomain: "github.com", intentId: "synthetic-intent-0001", expectedGeneration: 0, ...extra }, options); },
    action(operation, attemptId, options) { return f.run({ operation, attemptId }, options); },
  };
  for (const name of ["log", "warn", "error"]) t.mock.method(console, name, (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    assert.match(String(url), /^https:\/\/(?:github\.com|fixture\.ghe\.com)\/login\/(?:device\/code|oauth\/access_token)$/);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has("cf-access-jwt-assertion"), false);
    sent.push({ url: String(url), init, record: f.record() });
    return f.reply(String(url), init);
  });
  t.after(() => assert.deepEqual(logs, []));
  // Capture the real owner continuation, including work that outlives a prompt
  // cancellation response. Never substitute a second cancel for its first ACK.
  env.GRANT_CREDENTIALS.get(key);
  const retained = new Set();
  f.owner().state.waitUntil = promise => { const work = promise.catch(() => undefined); retained.add(work); void work.finally(() => retained.delete(work)); };
  f.retired = async () => { while (retained.size) await Promise.all([...retained]); };
  await f.user(true); await f.user(true, otherEmail);
  return f;
}
async function body(response, status = 200) {
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-original-github-token|synthetic-private-device-code|ownerBinding|copilotDeviceCredential|credentialGeneration/);
  return value;
}

for (const githubDomain of ["github.com", "fixture.ghe.com"]) test(`Copilot ${githubDomain} admin/owner atomically acquires only the original private token`, async t => {
  const f = await fixture(t), begin = await body(await f.begin({ githubDomain }));
  assert.equal(begin.status, "pending"); assert.equal(begin.userCode, "SYNTHETIC-CODE");
  assert.equal(begin.verificationUri, `https://${githubDomain}/login/device`);
  const admission = f.record(), form = new URLSearchParams(f.sent[0].init.body);
  assert.equal(admission.copilotDeviceAttempt.phase, "pending");
  assert.equal(f.sent[0].record.copilotDeviceAttempt.phase, "begin_unknown");
  assert.equal(form.get("client_id"), "Iv1.b507a08c87ecfe98"); assert.equal(form.get("scope"), "read:user");
  assert.equal(form.has("code_challenge"), false);
  await body(await f.action("poll", begin.attemptId), 409); assert.equal(f.sent.length, 1);
  f.advance(); const completed = await body(await f.action("poll", begin.attemptId));
  assert.equal(completed.status, "committed"); assert.equal(f.sent.length, 2);
  const tokenForm = new URLSearchParams(f.sent[1].init.body);
  assert.equal(tokenForm.get("device_code"), "synthetic-private-device-code"); assert.equal(tokenForm.has("user_code"), false);
  assert.equal(tokenForm.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  const record = f.record();
  assert.equal(record.copilotDeviceCredential.accessToken, "synthetic-original-github-token");
  assert.equal(record.copilotDeviceCredential.githubDomain, githubDomain);
  assert.equal(record.generation, admission.generation + 1); assert.equal(record.lineage, admission.lineage);
  assert.equal(record.status, "reauth_required");
  for (const field of ["accessToken", "credential", "refreshToken", "expiresAt"]) assert.equal(record[field], undefined);
  assert.equal(record.copilotDeviceAttempt.authorization, undefined);
  for (const operation of ["poll", "status"]) assert.equal((await body(await f.action(operation, begin.attemptId))).status, "committed");
  assert.equal(f.sent.length, 2); assert.equal(f.record().generation, record.generation);
  const projection = await inspectGrantCredentials(f.env, key);
  assert.doesNotMatch(JSON.stringify(projection), /synthetic-original|synthetic-private|copilotDevice|ownerBinding/);
  assert.equal(projection.hasAccessToken, false); assert.equal(projection.hasCredential, false);
  assert.equal(projection.credentialStatus, "reauth_required");
  await assert.rejects(materializeGrantCredentials(f.env, key, projection, "github-copilot", null, false));
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

for (const options of [
  { headers: { "cf-access-jwt-assertion": null, authorization: "Bearer synthetic-admin-token" } },
  { headers: { "cf-access-jwt-assertion": null, authorization: "Bearer synthetic-proxy-key" } },
  { headers: { origin: "https://foreign.example.invalid" } }, { headers: { origin: null } }, { actor: "member@example.invalid" },
]) test("Copilot Access admin and same-origin boundary " + JSON.stringify(options), async t => {
  const f = await fixture(t), response = await f.begin({}, options);
  assert.ok([401, 403].includes(response.status)); await response.text(); assert.equal(f.sent.length, 0);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

for (const change of [{ githubDomain: "evil.example" }, { githubDomain: "a.b.ghe.com" }, { provider: "copilot-proxy" },
  { flow: "unknown" }, { tokenEndpoint: "https://other.example/token" }, { intentId: "bad" },
  { expectedGeneration: -1 }, { expectedGeneration: 1 }, { priority: -1 }, { deviceCode: "forged" }])
  test("Copilot closed begin input " + JSON.stringify(change), async t => {
    const f = await fixture(t), response = await f.begin(change);
    assert.ok([400, 409].includes(response.status)); await response.text(); assert.equal(f.sent.length, 0);
    await f.retired(); assert.equal(bodyBudgetCharged(), 0);
  });

test("Copilot original admin/grant/domain and committed generation remain bound", async t => {
  const f = await fixture(t), begin = await body(await f.begin());
  await body(await f.action("status", begin.attemptId, { actor: otherEmail }), 409);
  await body(await f.action("status", begin.attemptId, { path: path.replace("/copilot/", "/foreign/") }), 409);
  await body(await f.begin({ githubDomain: "fixture.ghe.com" }), 409);
  f.advance(); await body(await f.action("poll", begin.attemptId));
  await putGrantCredentials(f.env, key, { provider: "github-copilot", kind: "api_key", credential: "synthetic-replacement" });
  await body(await f.action("status", begin.attemptId), 409);
  assert.equal(f.record().copilotDeviceCredential, undefined); assert.equal(f.sent.length, 2);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

test("Copilot duplicate begin/poll do not hold the owner tail over remote I/O", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), reply = f.reply;
  f.reply = async (...args) => { entered.resolve(); await release.promise; return reply(...args); };
  const first = f.begin(); await entered.promise;
  const duplicate = await body(await f.begin()); assert.equal(duplicate.status, "starting"); assert.equal(f.sent.length, 1);
  release.resolve(); const begin = await body(await first); assert.equal(begin.attemptId, duplicate.attemptId);
  f.advance(); const polled = deferred(), token = deferred();
  f.reply = async (...args) => { polled.resolve(); await token.promise; return reply(...args); };
  const firstPoll = f.action("poll", begin.attemptId); await polled.promise;
  assert.equal((await body(await f.action("poll", begin.attemptId))).status, "polling"); assert.equal(f.sent.length, 2);
  token.resolve(); assert.equal((await body(await firstPoll)).status, "committed");
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

for (const mutation of ["cancel", "revoke", "replace", "admin"]) test(`Copilot ${mutation} while token fetch is held fences late success`, async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const entered = deferred(), release = deferred(), reply = f.reply;
  f.reply = async (...args) => { entered.resolve(); await release.promise; return reply(...args); };
  const pending = f.action("poll", begin.attemptId); await entered.promise;
  assert.equal(bodyBudgetCharged(), 66 * 1024 * 1024);
  if (mutation === "cancel") assert.equal((await body(await f.action("cancel", begin.attemptId))).status, "cancelled");
  else if (mutation === "revoke") await revokeGrantCredentials(f.env, key);
  else if (mutation === "replace") await putGrantCredentials(f.env, key, { provider: "github-copilot", kind: "api_key", credential: "synthetic-replacement" });
  else await f.user(false);
  if (mutation !== "admin") {
    assert.equal(f.sent.at(-1).init.signal.aborted, true);
    const response = await pending; assert.ok([200, 403, 409].includes(response.status)); await response.text();
    assert.ok(bodyBudgetCharged() >= 64 * 1024 * 1024);
    const contender = new BodyLease(); assert.equal(contender.grow(17 * 1024 * 1024), false); contender.release();
  }
  release.resolve();
  if (mutation === "admin") { const response = await pending; assert.equal(response.status, 403); await response.text(); }
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(f.record().copilotDeviceCredential, undefined); assert.equal(f.sent.length, 2);
});

test("Copilot pending and cumulative slow_down use durable absolute clocks without automatic polling", async t => {
  const f = await fixture(t), begin = await body(await f.begin());
  f.reply = url => vendor(url, { error: "authorization_pending", interval: 1 });
  f.advance(); let pending = await body(await f.action("poll", begin.attemptId));
  assert.equal(f.record().copilotDeviceAttempt.intervalMs, 5000);
  await body(await f.action("poll", begin.attemptId), 409);
  f.reply = url => vendor(url, { error: "slow_down" });
  f.advance(); pending = await body(await f.action("poll", begin.attemptId));
  assert.equal(f.record().copilotDeviceAttempt.intervalMs, 10000);
  f.restart(); f.advance(10000); pending = await body(await f.action("poll", begin.attemptId));
  assert.equal(f.record().copilotDeviceAttempt.intervalMs, 15000);
  f.advance(900_000); assert.equal((await body(await f.action("poll", begin.attemptId))).status, "expired");
  assert.equal(f.sent.length, 4); await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

for (const outcome of ["access_denied", "expired_token", "unrecognized", "malformed", "redirect", "network", "foreign-url"])
  test("Copilot terminal/uncertain outcome never becomes pending or replays: " + outcome, async t => {
    const f = await fixture(t), begin = await body(await f.begin()); f.advance();
    f.reply = url => {
      if (outcome === "network") throw new Error("synthetic-private-vendor-description");
      return vendor(outcome === "foreign-url" ? "https://foreign.example/token" : url,
        outcome === "malformed" ? "{" : { error: outcome, error_description: "synthetic-private-vendor-description" }, outcome === "redirect" ? 302 : 200);
    };
    const result = await body(await f.action("poll", begin.attemptId));
    assert.ok(["denied", "expired", "failed", "unknown"].includes(result.status));
    f.restart(); assert.equal((await body(await f.action("poll", begin.attemptId))).status, result.status);
    assert.equal(f.sent.length, 2); assert.equal(f.record().copilotDeviceCredential, undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
    await f.retired(); assert.equal(bodyBudgetCharged(), 0);
  });

for (const mode of ["before-write", "after-write", "publication"]) test("Copilot atomic token/terminal commit " + mode, async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const storage = f.owner().state.storage, put = storage.put; let failed = false;
  storage.put = async (name, value) => {
    if (!failed && value.copilotDeviceAttempt?.phase === "committed" && mode !== "publication") {
      failed = true; if (mode === "after-write") await put(name, value);
      throw new Error("synthetic persistence fault");
    }
    return put(name, value);
  };
  const publish = f.env.POLICY_KV.put;
  f.env.POLICY_KV.put = async (...args) => {
    if (!failed && mode === "publication" && f.record()?.copilotDeviceAttempt?.phase === "committed") { failed = true; throw new Error("synthetic publication fault"); }
    return publish(...args);
  };
  const result = await body(await f.action("poll", begin.attemptId));
  assert.equal(result.status, mode === "before-write" ? "unknown" : "committed");
  assert.equal(f.record().copilotDeviceCredential?.accessToken, mode === "before-write" ? undefined : "synthetic-original-github-token");
  f.restart(); assert.equal((await body(await f.action("status", begin.attemptId))).status, result.status);
  assert.equal((await body(await f.action("poll", begin.attemptId))).status, result.status); assert.equal(f.sent.length, 2);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

test("Copilot restart fence and explicit replacement do not replay uncertain exchange", async t => {
  const f = await fixture(t), begin = await body(await f.begin()), record = f.record();
  record.copilotDeviceAttempt.phase = "poll_unknown"; await f.owner().state.storage.put("credential", record); f.restart();
  assert.equal((await body(await f.action("status", begin.attemptId))).status, "unknown");
  await body(await f.begin({ intentId: "synthetic-intent-0002", replacesAttemptId: begin.attemptId, expectedGeneration: record.generation }), 409);
  assert.equal(f.sent.length, 1);
  await body(await f.action("cancel", begin.attemptId));
  const next = await body(await f.begin({ intentId: "synthetic-intent-0002", replacesAttemptId: begin.attemptId, expectedGeneration: record.generation }));
  assert.notEqual(next.attemptId, begin.attemptId); assert.equal(f.sent.length, 2);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

test("Copilot failed durable begin fence makes zero vendor requests", async t => {
  const f = await fixture(t);
  f.owner().state.storage.put = async () => { throw new Error("synthetic owner fault"); };
  await body(await f.begin(), 503); assert.equal(f.sent.length, 0); assert.equal(f.record(), undefined);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

test("Copilot fresh admin check after final attachment await prevents token install", async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === "/grant-pools/admit") await f.user(false);
    return response;
  } }; };
  await body(await f.action("poll", begin.attemptId), 403);
  assert.equal(f.record().copilotDeviceCredential, undefined);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});

for (const rejectedCleanup of [false, true]) test(`Copilot prompt cancellation retains charge through original read and FIRST cancel (reject=${rejectedCleanup})`, async t => {
  const f = await fixture(t), begin = await body(await f.begin()); f.advance();
  const reading = deferred(), readAck = deferred(), cancelling = deferred(), cancelAck = deferred();
  let reads = 0, cancels = 0, unlocks = 0, response;
  f.reply = url => {
    response = new Response(new ReadableStream({ type: "bytes", cancel() { return cancelAck.promise; } }), { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = options => {
      const reader = getReader(options);
      return {
        async read(view) { reads++; reading.resolve(); try { return await reader.read(view); } finally { await readAck.promise; } },
        cancel(reason) { cancels++; const pending = reader.cancel(reason); cancelling.resolve(); return pending; },
        releaseLock() { unlocks++; reader.releaseLock(); },
      };
    };
    return response;
  };
  const poll = f.action("poll", begin.attemptId); await reading.promise;
  assert.equal((await body(await f.action("cancel", begin.attemptId))).status, "cancelled");
  await cancelling.promise;
  assert.equal((await body(await poll)).status, "cancelled");
  assert.equal(reads, 1); assert.equal(cancels, 1); assert.equal(unlocks, 0); assert.equal(response.body.locked, true);
  assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  const contender = new BodyLease(); assert.equal(contender.grow(17 * 1024 * 1024), false);
  readAck.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(unlocks, 0); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  if (rejectedCleanup) cancelAck.reject(new Error("synthetic cleanup failure")); else cancelAck.resolve();
  await f.retired(); assert.equal(response.body.locked, false); assert.equal(unlocks, 1);
  assert.equal(cancels, 1); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(f.record().copilotDeviceCredential, undefined); assert.equal(f.sent.length, 2); contender.release();
});

for (const completion of ["eof", "cancel"]) test("Copilot bounded public producer retains its own charge until " + completion, async t => {
  const f = await fixture(t), response = await f.begin();
  await f.retired(); assert.equal(bodyBudgetCharged(), 2 * 1024 * 1024);
  if (completion === "eof") await body(response); else await response.body.cancel();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(bodyBudgetCharged(), 0);
});

test("Copilot unknown private fields cannot enter through generic admin grant mutation", async t => {
  const f = await fixture(t);
  for (const field of ["copilotDeviceAttempt", "copilotDeviceCredential"]) {
    const response = await adminApi(new Request(origin + path.replace("/authorize", ""), { method: "PUT",
      headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": await jwt() },
      body: JSON.stringify({ provider: "github-copilot", [field]: { accessToken: "synthetic-forgery" } }) }), f.env, path.replace("/authorize", ""));
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(f.sent.length, 0); assert.equal(f.record(), undefined);
});

test("Copilot fixed intake checks authority before reading and rejects declared overflow before a pull", async t => {
  const f = await fixture(t);
  for (const authorized of [false, true]) {
    let reads = 0, cancels = 0;
    const input = new ReadableStream({ pull() { reads++; throw new Error("must not read"); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const request = new Request(origin + path + "?flow=copilot-device.v1", { method: "POST", duplex: "half", body: input,
      headers: { origin, "content-type": "application/json", "content-length": "8193", ...(authorized ? { "cf-access-jwt-assertion": await jwt() } : {}) } });
    const response = await adminApi(request, f.env, path);
    assert.equal(response.status, authorized ? 400 : 401); await response.text();
    assert.equal(reads, 0); assert.equal(cancels, authorized ? 1 : 0); assert.equal(input.locked, false);
    if (!authorized) await input.cancel();
  }
  await f.retired(); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.sent.length, 0);
});

test("Copilot intake wire cap includes ignored whitespace and its charge survives first cancellation cleanup", async t => {
  const f = await fixture(t);
  const valid = JSON.stringify({ flow: "copilot-device.v1", provider: "github-copilot", operation: "begin",
    githubDomain: "github.com", intentId: "synthetic-intent-0001", expectedGeneration: 0 });
  const begin = await body(await f.begin({}, { raw: valid.padEnd(8192, " ") }));
  assert.equal(begin.status, "pending"); assert.equal(f.sent.length, 1);
  await body(await f.begin({}, { raw: valid.padEnd(8193, " ") }), 400);
  const cancelStarted = deferred(), cancelAck = deferred(); let cancels = 0;
  const input = new ReadableStream({ cancel() { cancels++; cancelStarted.resolve(); return cancelAck.promise; } }, { highWaterMark: 0 });
  const request = new Request(origin + path + "?flow=copilot-device.v1", { method: "POST", duplex: "half", body: input,
    headers: { origin, "content-type": "application/json", "content-length": "8193", "cf-access-jwt-assertion": await jwt() } });
  const pending = adminApi(request, f.env, path); await cancelStarted.promise;
  assert.equal(input.locked, true); assert.equal(bodyBudgetCharged(), 2 * 1024 * 1024);
  cancelAck.resolve(); await body(await pending, 400);
  assert.equal(cancels, 1); assert.equal(input.locked, false);
  await f.retired(); assert.equal(bodyBudgetCharged(), 0); assert.equal(f.sent.length, 1);
});

test("Copilot capacity contention denies begin before owner fence and vendor I/O", async t => {
  const f = await fixture(t), other = new BodyLease();
  assert.equal(other.grow(17 * 1024 * 1024), true);
  try {
    await body(await f.begin(), 503);
    assert.equal(f.record(), undefined); assert.equal(f.sent.length, 0);
    await f.retired(); assert.equal(bodyBudgetCharged(), 34 * 1024 * 1024);
  } finally { other.release(); }
  assert.equal((await body(await f.begin())).status, "pending");
  await f.retired(); assert.equal(bodyBudgetCharged(), 0);
});
