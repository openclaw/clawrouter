import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { localAdminEnvironment } from "../scripts/grant-target.mjs";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../scripts/grant-pool-recovery.mjs";

const { default: worker } = await import("../worker/index.ts");
const { attachGrantCredentialNamespace } = await import("../worker/test/grant-credential-mock.mjs");
const grantPath = "/v1/admin/upstream-grants/policies/policy/anthropic";

test("CLI acknowledges oversized committed grant imports and revocations", async (context) => {
  const fixture = await scriptFixture(context), key = "oauth/policy/anthropic";
  // Keep each public argument below OS per-argument limits while the actual
  // Worker projection exceeds the transport's bounded JSON reader.
  const label = "label-fixture".padEnd(70 * 1024, "l"), accountId = "account-fixture".padEnd(70 * 1024, "a");
  assertSuccess(await fixture.run("oauth-put.mjs", ["--kid", "policy", "--provider", "anthropic", "--kind", "subscription", "--access-token-env", "TEST_ACCESS_TOKEN", "--label", label, "--account-id", accountId]));
  const owner = fixture.env.GRANT_CREDENTIALS.objects.get(key);
  const imported = owner.values.get("credential");
  assert.equal(imported.metadata.label, label);
  assert.equal(imported.accountId, accountId);
  assert.equal(imported.accessToken, "access-fixture");
  assert.equal(fixture.values.get(key).label, label);
  assert.equal(fixture.values.get(key).accountId, accountId);
  assert.equal(fixture.values.get(key).hasAccessToken, true);
  assert.ok(owner.alarm() > Date.now());
  assert.ok((await fixture.env.grantAuthority.call("attachment", { key })).attached);
  assert.ok(fixture.responseBytes[0] > 128 * 1024);

  assertSuccess(await fixture.run("oauth-revoke.mjs", ["--kid", "policy", "--provider", "anthropic"]));
  const revoked = owner.values.get("credential");
  assert.equal(revoked.generation, imported.generation + 1);
  assert.equal(revoked.enabled, false);
  assert.ok(revoked.revokedAt);
  assert.equal(revoked.metadata.label, label);
  assert.equal(revoked.accountId, accountId);
  assert.doesNotMatch(JSON.stringify(revoked), /access-fixture/);
  assert.equal(owner.alarm(), null);
  assert.equal((await fixture.env.grantAuthority.call("attachment", { key })).attached, false);
  assert.equal(fixture.values.get(key).hasAccessToken, false);
  assert.ok(fixture.responseBytes[1] > 128 * 1024);
  assert.deepEqual(fixture.requests, ["PUT " + grantPath + "?mode=replace", "POST " + grantPath + "/revoke"]);
});

test("actual CLI imports, rotates and revokes the credential used by Worker routing and alarms", async (context) => {
  const fixture = await scriptFixture(context), key = "oauth/policy/anthropic";
  const refreshFile = join(fixture.dir, "refresh-token");
  writeFileSync(refreshFile, "refresh-fixture\n", { mode: 0o600 });
  const args = ["--kid", "policy", "--provider", "anthropic", "--kind", "subscription", "--access-token-env", "TEST_ACCESS_TOKEN"];
  const imported = await fixture.run("oauth-put.mjs", [...args, "--refresh-token-file", refreshFile, "--expires-at", new Date(Date.now() + 3_600_000).toISOString(), "--account-id", "account-fixture", "--subscription-plan", "max", "--scopes", "inference,profile,inference"]);
  assertSuccess(imported);
  const owner = fixture.env.GRANT_CREDENTIALS.objects.get(key);
  assert.equal(owner.values.get("credential").refreshToken, "refresh-fixture");
  assert.equal(owner.values.get("credential").accountId, "account-fixture");
  assert.deepEqual(fixture.values.get(key).scopes, ["inference", "profile"]);
  assert.ok(owner.alarm() > Date.now());
  assert.doesNotMatch(JSON.stringify(fixture.values.get(key)), /access-fixture|refresh-fixture/);
  let calls = 0, expectedToken = "access-fixture";
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${expectedToken}`);
    return Response.json({ id: "message-fixture", type: "message", role: "assistant", content: [{ type: "text", text: "fixture" }], model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  assert.equal((await fixture.proxy()).status, 200);
  expectedToken = "rotated-fixture";
  assertSuccess(await fixture.run("oauth-put.mjs", [...args, "--local"], { TEST_ACCESS_TOKEN: expectedToken }));
  const replacement = owner.values.get("credential");
  assert.equal(replacement.accessToken, expectedToken);
  assert.equal(replacement.refreshToken, undefined);
  assert.equal(replacement.accountId, undefined);
  assert.equal(replacement.subscription, undefined);
  assert.equal(replacement.refresh, undefined);
  assert.equal((await fixture.proxy()).status, 200);
  replacement.expiresAt = "2020-01-01T00:00:00.000Z";
  replacement.nextQuotaProbeAt = "2020-01-01T00:00:00.000Z";
  replacement.nextKeepWarmAt = "2020-01-01T00:00:00.000Z";
  assertSuccess(await fixture.run("oauth-revoke.mjs", ["--kid", "policy", "--provider", "anthropic", "--local"]));
  await owner.object.alarm();
  const denied = await fixture.proxy();
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error.code, "provider_not_configured");
  assert.equal(calls, 2, "revoke and maintenance never dispatch another provider request");
  assert.equal(owner.alarm(), null);
  assert.equal(owner.values.get("credential").enabled, false);
  assert.doesNotMatch(JSON.stringify(owner.values.get("credential")), /access-fixture|refresh-fixture|rotated-fixture/);
  assert.equal(fixture.values.get(key).hasAccessToken, false);
  assert.deepEqual(fixture.requests, ["PUT " + grantPath + "?mode=replace", "PUT " + grantPath + "?mode=replace", "POST " + grantPath + "/revoke"]);
});

test("CLI replacement clears a credential bundle, and preserves stdin and public refresh configuration", async (context) => {
  const fixture = await scriptFixture(context), key = "oauth/tenants/default/aws-bedrock";
  const args = ["--tenant", "default", "--provider", "aws-bedrock", "--kind", "api_key"];
  assertSuccess(await fixture.run("oauth-put.mjs", [...args, "--credentials-json-env", "TEST_BUNDLE"], { TEST_BUNDLE: JSON.stringify({ accessKeyId: "access-fixture", secretAccessKey: "secret-fixture", sessionToken: "session-fixture" }) }));
  assert.deepEqual(fixture.values.get(key).credentialFields, ["accessKeyId", "secretAccessKey", "sessionToken"]);
  assertSuccess(await fixture.run("oauth-put.mjs", [...args, "--provider", "anthropic", "--token-ref", "aws-bedrock", "--credential-stdin"], {}, "scalar-fixture\n"));
  const record = fixture.env.GRANT_CREDENTIALS.objects.get(key).values.get("credential");
  assert.equal(record.credential, "scalar-fixture");
  assert.equal(record.credentials, undefined);
  assert.equal(record.providerId, "anthropic");
  assert.deepEqual(fixture.values.get(key).credentialFields, []);
  assertSuccess(await fixture.run("oauth-put.mjs", ["--kid", "policy", "--provider", "openai", "--access-token-stdin", "--refresh-token-url", "https://provider.example/oauth/token", "--refresh-client-id", "public-client-id", "--refresh-extra-params-json", '{"audience":"provider-api"}'], {}, "access-fixture\n"));
  assert.deepEqual(fixture.values.get("oauth/policy/openai").refresh, { tokenUrl: "https://provider.example/oauth/token", clientId: "public-client-id", extraParams: { audience: "provider-api" } });
});

test("replacement intent requires fresh secrets and leaves default API merges unchanged", async (context) => {
  const fixture = await scriptFixture(context);
  for (const suffix of ["?mode=replace", "?mode=unknown"]) {
    const response = await fixture.admin(grantPath + suffix, "PUT", { provider: "anthropic", kind: "subscription", credentialStore: "durable_object", hasAccessToken: true });
    assert.equal(response.status, 400);
    assert.equal(fixture.env.GRANT_CREDENTIALS.objects.size, 0);
  }
  const initial = await fixture.admin(grantPath, "PUT", { provider: "anthropic", kind: "subscription", accessToken: "access-fixture", refreshToken: "refresh-fixture", label: "original label" });
  assert.equal(initial.status, 200, await initial.text());
  const merged = await fixture.admin(grantPath, "PUT", { provider: "anthropic", kind: "subscription", label: "new label" });
  assert.equal(merged.status, 200, await merged.text());
  const record = fixture.env.GRANT_CREDENTIALS.objects.get("oauth/policy/anthropic").values.get("credential");
  assert.equal(record.refreshToken, "refresh-fixture");
  assert.equal(record.metadata.label, "new label");
  const replaced = await fixture.admin(grantPath + "?mode=replace", "PUT", { provider: "anthropic", kind: "oauth", accessToken: "new-access-fixture" });
  assert.equal(replaced.status, 200, await replaced.text());
  const owner = fixture.env.GRANT_CREDENTIALS.objects.get("oauth/policy/anthropic");
  assert.equal(owner.values.get("credential").refreshToken, undefined);
  context.mock.method(globalThis, "fetch", async () => assert.fail("replacement refreshed an old account"));
  await owner.object.alarm();
  assert.equal(owner.alarm(), null);
});

test("CLI replaces raw legacy tokens and revokes legacy metadata without altering an owned identity", async (context) => {
  const fixture = await scriptFixture(context), key = "oauth/policy/anthropic";
  fixture.values.set(key, "legacy-raw-private");
  assertSuccess(await fixture.run("oauth-put.mjs", ["--kid", "policy", "--provider", "anthropic", "--access-token-env", "TEST_ACCESS_TOKEN"]));
  assertSuccess(await fixture.run("oauth-revoke.mjs", ["--kid", "policy", "--token-ref", "anthropic", "--provider", "retired-provider", "--kind", "api_key", "--label", "wrong label"]));
  assert.equal(fixture.values.get(key).provider, "anthropic");
  assert.equal(fixture.values.get(key).kind, "oauth");
  assert.equal(fixture.values.get(key).label, undefined);
  fixture.values.set("oauth/policy/legacy", { access_token: "legacy-private", account_id: "old-account", refresh: { extraParams: { client_secret: "nested-private", audience: "fixture" } } });
  assertSuccess(await fixture.run("oauth-revoke.mjs", ["--kid", "policy", "--token-ref", "legacy", "--provider", "retired-provider", "--kind", "subscription", "--label", "legacy account"]));
  const revoked = fixture.values.get("oauth/policy/legacy");
  assert.equal(revoked.provider, "retired-provider");
  assert.equal(revoked.label, "legacy account");
  assert.equal(revoked.accountId, "old-account");
  assert.deepEqual(revoked.refresh.extraParams, { audience: "fixture" });
  assert.doesNotMatch(JSON.stringify(revoked), /legacy-private|nested-private/);
  const missing = await fixture.run("oauth-revoke.mjs", ["--kid", "policy", "--token-ref", "missing"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not registered/);
});

for (const [name, raw] of [
  ["malformed JSON", '{"accessToken":"legacy-private",'],
  ["oversized JSON", JSON.stringify({ accessToken: "legacy-private", padding: "x".repeat(3 * 1024 * 1024) })],
  ["raw token", "legacy-private"],
  ["valid aliases", { access_token: "legacy-private", account_id: "old-account", refresh: { extraParams: { client_secret: "nested-private", audience: "fixture" } } }],
]) test(`actual CLI replacement and revocation recover ${name} through the authenticated owner`, async (context) => {
  const fixture = await scriptFixture(context);
  for (const operation of ["put", "revoke"]) {
    const tokenRef = `legacy-${operation}`, key = `oauth/policy/${tokenRef}`;
    fixture.values.set(key, raw);
    fixture.env.grantAuthority.seedLegacy(key, "old-provider");
    fixture.env.grantAuthority.sql.exec("INSERT INTO upstream_grant_pool_versions (grant_key, generation, revision) VALUES (?, ?, ?)", key, 5, 2);
    const args = ["--kid", "policy", "--token-ref", tokenRef, "--provider", "anthropic", "--kind", "oauth"];
    if (operation === "put") args.push("--access-token-env", "TEST_ACCESS_TOKEN");
    const result = await fixture.run(`oauth-${operation}.mjs`, args);
    assertSuccess(result);
    assert.doesNotMatch(result.stdout + result.stderr, /legacy-private|nested-private/);
    const stored = fixture.env.GRANT_CREDENTIALS.objects.get(key).values.get("credential");
    assert.equal(stored.generation, 6);
    assert.equal(stored.enabled, operation === "put");
    assert.doesNotMatch(JSON.stringify([stored, fixture.values.get(key)]), /legacy-private|nested-private/);
    if (operation === "revoke" && name === "valid aliases") {
      assert.equal(stored.accountId, "old-account");
      assert.deepEqual(stored.refresh.extraParams, { audience: "fixture" });
    }
    assert.equal((await fixture.env.grantAuthority.call("resolve", { policyId: "policy", providerId: "old-provider" })).hasAttachment, false);
  }
});

test("corrupt grant recovery retains admin authentication, browser CSRF and explicit fresh-primary gates", async (context) => {
  const fixture = await scriptFixture(context), key = "oauth/policy/anthropic", raw = '{"accessToken":"legacy-private",';
  fixture.values.set(key, raw);
  const token = "a".repeat(64);
  fixture.env.CLAWROUTER_LOCAL_AUTH = "enabled";
  fixture.values.set(`local/sessions/${createHash("sha256").update(token).digest("hex")}`, { email: "admin@example.com", role: "admin", expiresAtMs: Date.now() + 60_000 });
  const get = fixture.env.ACCESS_CONTROL.get;
  fixture.env.ACCESS_CONTROL.get = id => ({ fetch: (url, init) => new URL(url).pathname === "/users/resolve"
    ? Response.json({ initialized: true, users: [{ email: "admin@example.com", record: { enabled: true, role: "admin" } }], missingEmails: [] }) : get(id).fetch(url, init) });
  for (const [method, suffix, body] of [["PUT", "?mode=replace", { provider: "anthropic", kind: "oauth", accessToken: "access-fixture" }], ["POST", "/revoke", {}]]) {
    for (const [headers, status, code] of [[{}, 401, "admin_unauthorized"], [{ cookie: `clawrouter_session=${token}`, origin: "https://other.example" }, 403, "access_csrf_required"]]) {
      const response = await fixture.dispatch(new Request(`http://127.0.0.1${grantPath}${suffix}`, { method, headers, body: JSON.stringify(body) }));
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
  }
  for (const suffix of ["?mode=replace", "?mode=unknown"]) assert.equal((await fixture.admin(grantPath + suffix, "PUT", { provider: "anthropic", hasAccessToken: true })).status, 400);
  assert.equal((await fixture.admin(grantPath, "PUT", { provider: "anthropic", kind: "oauth", accessToken: "access-fixture" })).status, 500, "default merge still rejects corrupt legacy JSON");
  assert.equal((await fixture.admin(grantPath + "/refresh", "POST", {})).status, 500, "refresh cannot acquire replacement intent");
  assert.equal(fixture.env.GRANT_CREDENTIALS.objects.size, 0);
  assert.equal(fixture.values.get(key), raw);
});

test("Worker revocation accepts bodyless requests and empty streams but rejects malformed or oversized metadata", async (context) => {
  const fixture = await scriptFixture(context);
  assert.equal((await fixture.admin(grantPath, "PUT", { provider: "anthropic", kind: "api_key", credential: "access-fixture" })).status, 200);
  const headers = { authorization: "Bearer admin-fixture", "content-type": "application/json" };
  for (const body of [undefined, ""]) {
    const response = await fixture.dispatch(new Request(`http://127.0.0.1${grantPath}/revoke`, { method: "POST", headers, body }));
    assert.equal(response.status, 200, await response.text());
  }
  for (const body of [" ", "not-json", "null", "[]"]) {
    assert.equal((await fixture.dispatch(new Request(`http://127.0.0.1${grantPath}/revoke`, { method: "POST", headers, body }))).status, 400);
  }
  const oversized = await fixture.dispatch(new Request(`http://127.0.0.1${grantPath}/revoke`, { method: "POST", headers: { ...headers, "content-length": String(8 * 1024 * 1024 + 1) } }));
  assert.equal(oversized.status, 413, "optional body never bypasses the declared size limit");
});

test("CLI rejects retired KV selectors, unsafe local targets and argv secrets before network or secret input", async (context) => {
  const fixture = await scriptFixture(context);
  for (const name of ["oauth-put.mjs", "oauth-revoke.mjs"]) {
    const args = ["--kid", "policy", "--provider", "anthropic", "--access-token-file", join(fixture.dir, "missing-secret")];
    for (const flag of ["--binding", "--config"]) {
      const result = await fixture.run(name, [...args, flag, "obsolete"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /grant mutations use the admin API/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    }
    const local = await fixture.run(name, [...args, "--local"], { CLAWROUTER_BASE_URL: "https://router.example" });
    assert.notEqual(local.status, 0);
    assert.match(local.stderr, /requires a loopback/);
    assert.doesNotMatch(local.stderr, /ENOENT/);
  }
  for (const secret of ["access-token", "credential", "credentials-json", "refresh-token"]) {
    const result = await fixture.run("oauth-put.mjs", ["--kid", "policy", "--provider", "anthropic", `--${secret}`, "unsafe-fixture"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would expose the secret in process argv/);
    assert.doesNotMatch(result.stderr, /unsafe-fixture/);
  }
  assert.deepEqual(fixture.requests, []);
  assert.equal(localAdminEnvironment({ local: true }, {}).CLAWROUTER_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(localAdminEnvironment({ local: true }, { CLAWROUTER_BASE_URL: "http://[::1]:8787" }).CLAWROUTER_BASE_URL, "http://[::1]:8787");
});

test("actual recovery CLI requires explicit baseline and activates through the authenticated Worker", async context => {
  const fixture = await scriptFixture(context, false);
  const initial = await fixture.run("grant-pool-recovery.mjs", ["--status"]);
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(JSON.parse(initial.stdout).baseline, null);
  const denied = await fixture.run("grant-pool-recovery.mjs", []);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /baseline is not accepted/);
  assertSuccess(await fixture.run("grant-pool-recovery.mjs", ["--accept-existing"]));
  assertSuccess(await fixture.run("grant-pool-recovery.mjs", []));
  const active = await fixture.run("grant-pool-recovery.mjs", ["--status"]);
  assert.ok(JSON.parse(active.stdout).activatedAt);
  assertSuccess(await fixture.run("grant-pool-recovery.mjs", []));
  assert.equal(fixture.requests.filter(path => path.endsWith("/baseline")).length, 1);
});

async function scriptFixture(context, active = true) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-grant-test-"));
  // Prevent a regression to Wrangler from ever reaching operator credentials.
  writeFileSync(join(dir, "pnpm"), "#!/bin/sh\necho 'unexpected Wrangler invocation' >&2\nexit 99\n", { mode: 0o755 });
  const values = new Map(), requests = [], responseBytes = [];
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const env = attachGrantCredentialNamespace({
    CLAWROUTER_ADMIN_TOKEN_SHA256: hash("admin-fixture"),
    POLICY_KV: {
      async get(key, type) {
        if (Array.isArray(key)) return new Map(await Promise.all(key.map(async (item) => [item, await this.get(item, type)])));
        const value = values.get(key) ?? null;
        return value === null ? null : type === "text" ? typeof value === "string" ? value : JSON.stringify(value) : typeof value === "string" ? JSON.parse(value) : structuredClone(value);
      },
      async put(key, value) { values.set(key, JSON.parse(value)); },
      async list({ prefix }) { return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    },
    USAGE_QUEUE: { async send() {} },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential: { enabled: true, secretSha256: hash("proxy-secret-fixture"), policyId: "policy", policyGeneration: "generation" } }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "policy", policy: { enabled: true, generation: "generation", providers: ["anthropic"], tenantId: "default", requestCostMicros: 0, retainRequestContent: false } }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }], missingProviderIds: [] });
      if (path === "/grant-pools/states") return Response.json({ states: {} });
      if (path === "/grant-pools/stats") return Response.json({ stats: {} });
      if (path === "/grant-pools/resolve") return Response.json(await env.grantAuthority.call("resolve", body));
      if (path === "/grant-pools/select") return Response.json({ selectedKey: body.candidates[0].key });
      if (path === "/grant-pools/feedback") return new Response("updated");
      throw new Error(`unexpected authority operation ${path}`);
    } }) },
  });
  async function dispatch(request) {
    const pending = [];
    const response = await worker.fetch(request, env, { waitUntil: (promise) => pending.push(promise) });
    const body = await response.text();
    await Promise.all(pending);
    return new Response(body, { status: response.status, headers: response.headers });
  }
  if (active) {
    const request = async (path, { method = "GET", body } = {}) => {
      const response = await dispatch(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: "Bearer admin-fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    await acceptGrantPoolBaseline("fresh", { request });
    await recoverGrantPools({ request });
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      requests.push(`${incoming.method} ${incoming.url}`);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const response = await dispatch(new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) }));
      const body = await response.text();
      responseBytes.push(Buffer.byteLength(body));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(body);
    } catch { outgoing.writeHead(500); outgoing.end('{"error":{"message":"fixture dispatch failed"}}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { force: true, recursive: true }); });
  return {
    dir, values, env, requests, responseBytes, dispatch,
    run(name, args, extraEnv = {}, input = "") {
      return new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [resolve("scripts", name), ...args], { env: { PATH: dir, NODE_NO_WARNINGS: "1", CLAWROUTER_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAWROUTER_ADMIN_TOKEN: "admin-fixture", TEST_ACCESS_TOKEN: "access-fixture", ...extraEnv }, timeout: 10_000 });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (status) => resolveResult({ status, stdout, stderr }));
        child.stdin.end(input);
      });
    },
    admin(path, method, body) { return dispatch(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: "Bearer admin-fixture", "content-type": "application/json" }, body: JSON.stringify(body) })); },
    proxy() { return dispatch(new Request("http://127.0.0.1/v1/native/anthropic/v1/messages", { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-proxy-secret-fixture", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }) })); },
  };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /access-fixture|refresh-fixture|secret-fixture|session-fixture|rotated-fixture|scalar-fixture/);
}
