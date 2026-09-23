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

const { default: worker } = await import("../worker/index.ts");
const { attachGrantCredentialNamespace } = await import("../worker/test/grant-credential-mock.mjs");
const grantPath = "/v1/admin/upstream-grants/policies/policy/anthropic";

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
  assert.notEqual(denied.status, 200);
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

async function scriptFixture(context) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-grant-test-"));
  // Prevent a regression to Wrangler from ever reaching operator credentials.
  writeFileSync(join(dir, "pnpm"), "#!/bin/sh\necho 'unexpected Wrangler invocation' >&2\nexit 99\n", { mode: 0o755 });
  const values = new Map(), pool = new Set(), requests = [];
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
    },
    USAGE_QUEUE: { async send() {} },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential: { enabled: true, secretSha256: hash("proxy-secret-fixture"), policyId: "policy", policyGeneration: "generation" } }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "policy", policy: { enabled: true, generation: "generation", providers: ["anthropic"], tenantId: "default", requestCostMicros: 0, retainRequestContent: false } }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }], missingProviderIds: [] });
      if (path === "/grant-pools/states") return Response.json({ states: {} });
      if (path === "/grant-pools/stats") return Response.json({ stats: {} });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [...pool], states: {} });
      if (path === "/grant-pools/select") return Response.json({ selectedKey: body.candidates[0].key });
      if (path === "/grant-pools/feedback") return new Response("updated");
      if (path === "/grant-pools/sync") {
        const key = body.scope === "policies" ? `oauth/${body.scopeId}/${body.tokenRef}` : `oauth/tenants/${body.scopeId}/${body.tokenRef}`;
        if (body.enabled) pool.add(key); else pool.delete(key);
        return new Response("updated");
      }
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
  const server = createServer(async (incoming, outgoing) => {
    try {
      requests.push(`${incoming.method} ${incoming.url}`);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const response = await dispatch(new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers, body: Buffer.concat(chunks) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end('{"error":{"message":"fixture dispatch failed"}}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { force: true, recursive: true }); });
  return {
    dir, values, env, requests,
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
