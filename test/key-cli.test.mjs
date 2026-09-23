import "../worker/test/typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { localAdminEnvironment } from "../scripts/grant-target.mjs";

const { default: worker } = await import("../worker/index.ts");
const { PolicyBindingIndexObject } = await import("../worker/authority.ts");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const secretA = "synthetic-secret-a", secretB = "synthetic-secret-b", rotated = "synthetic-rotated-secret";
const putArgs = (kid, providers = "openai") => ["--kid", kid, "--providers", providers, "--secret-stdin", "--local"];

test("local key CLI updates the persisted authority after legacy migration and survives restart", async (t) => {
  const fixture = await scriptFixture(t);
  for (const [kid, secret] of [["keyA", secretA], ["keyB", secretB]]) {
    fixture.values.set(`keys/${kid}`, { enabled: true, generation: "legacy", providers: ["openai"], tenantId: "default", tokenRole: "service", retainRequestContent: false, secretSha256: hash(secret) });
    assert.equal((await fixture.inspect(kid, secret)).status, 200, "inspection materializes legacy input");
  }
  assert.equal((await fixture.admin("/v1/admin/policies")).status, 200);
  assert.equal((await fixture.admin("/v1/admin/credentials")).status, 200);
  assert.deepEqual(fixture.meta().filter((name) => /policies|credentials/.test(name)).sort(), ["credentials_global_initialized", "policies_global_initialized"]);
  // B shares A's policy: revoking A must not disable either the policy or B.
  assert.equal((await fixture.admin("/v1/admin/credentials/keyB", "PUT", { policyId: "keyA", secretSha256: hash(secretB) })).status, 200);
  fixture.closeMigrationReads();
  const generation = fixture.policy("keyA").generation;
  assertSuccess(await fixture.run("key-put.mjs", putArgs("keyA", "tavily,openai,tavily"), {}, secretA));
  assert.deepEqual((await (await fixture.inspect("keyA", secretA)).json()).providers, ["openai", "tavily"]);
  assert.equal(fixture.policy("keyA").generation, generation);
  assert.equal(fixture.credential("keyA").policyGeneration, generation);
  assert.equal(fixture.policy("keyA").retainRequestContent, false);

  const beforeCombined = fixture.snapshot();
  const combined = await fixture.run("key-put.mjs", putArgs("keyA", "openai"), {}, rotated);
  assert.notEqual(combined.status, 0);
  assert.match(combined.stderr, /cannot change policy scope and secret together/);
  assert.deepEqual(fixture.snapshot(), beforeCombined);

  assertSuccess(await fixture.run("key-put.mjs", putArgs("keyA", "openai,tavily"), {}, rotated));
  assert.equal((await fixture.inspect("keyA", secretA)).status, 401);
  assert.equal((await fixture.inspect("keyA", rotated)).status, 200);
  assertSuccess(await fixture.run("key-revoke.mjs", ["--kid", "keyA", "--local"]));
  assert.equal((await fixture.inspect("keyA", rotated)).status, 403);
  assert.equal((await fixture.inspect("keyB", secretB)).status, 200);
  assert.equal(fixture.policy("keyA").enabled, true);

  assertSuccess(await fixture.run("key-put.mjs", putArgs("keyC"), {}, "synthetic-secret-c"));
  assert.match(fixture.policy("keyC").generation, /^policy_/);
  assert.equal(fixture.credential("keyC").policyGeneration, fixture.policy("keyC").generation);
  assert.equal((await fixture.inspect("keyC", "synthetic-secret-c")).status, 200);
  const beforeRestart = fixture.snapshot();
  const missing = await fixture.run("key-revoke.mjs", ["--kid", "missing", "--local"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /credential not found/);
  assert.deepEqual(fixture.snapshot(), beforeRestart);
  fixture.restart();
  assert.deepEqual(fixture.snapshot(), beforeRestart);
  assert.equal((await fixture.inspect("keyA", secretA)).status, 401);
  assert.equal((await fixture.inspect("keyA", rotated)).status, 403);
  assert.equal((await fixture.inspect("keyB", secretB)).status, 200);
  assert.equal((await fixture.inspect("keyC", "synthetic-secret-c")).status, 200);
  assert.equal(fixture.kvWrites(), 0);
  assert.equal(existsSync(fixture.pnpmLog), false);
});

test("key CLI preserves secret inputs, explicit scopes, budgets, and remote transport", async (t) => {
  const fixture = await scriptFixture(t);
  const secretFile = join(fixture.dir, "secret");
  writeFileSync(secretFile, secretA + "\n", { mode: 0o600 });
  assertSuccess(await fixture.run("key-put.mjs", ["--kid", "keyA", "--secret-file", secretFile, "--providers", "openai", "--monthly-budget-micros", "1000000", "--request-cost-micros", "0"]));
  assert.equal(fixture.policy("keyA").monthlyBudgetMicros, 1000000);
  assert.equal(fixture.policy("keyA").requestCostMicros, 0);
  assertSuccess(await fixture.run("key-put.mjs", ["--kid", "keyB", "--secret-env", "TEST_PROXY_SECRET", "--all-providers", "--disabled", "--local"], { TEST_PROXY_SECRET: secretB }));
  assert.deepEqual(fixture.policy("keyB").providers, []);
  assert.equal(fixture.credential("keyB").enabled, false);
  assertSuccess(await fixture.run("key-revoke.mjs", ["--kid", "keyA"]));
  assert.equal((await fixture.inspect("keyA", secretA)).status, 403);
  assert.equal(existsSync(fixture.pnpmLog), false);
});

test("key CLI rejects retired selectors, unsafe local targets and FakeCo overrides before secrets or dispatch", async (t) => {
  const fixture = await scriptFixture(t);
  for (const name of ["key-put.mjs", "key-revoke.mjs"]) {
    const args = ["--kid", "keyA", "--secret-file", join(fixture.dir, "missing"), "--providers", "openai"];
    for (const flag of ["--binding", "--config"]) {
      const result = await fixture.run(name, [...args, flag, "obsolete"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /key and grant mutations use the admin API/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    }
    for (const base of ["https://router.example", "http://user:password@127.0.0.1:8787"]) {
      const result = await fixture.run(name, [...args, "--local"], { CLAWROUTER_BASE_URL: base });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a loopback/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    }
    const flag = await fixture.run(name, [...args, "--local", "false"]);
    assert.notEqual(flag.status, 0);
    assert.match(flag.stderr, /--local is a flag/);
    const locked = await fixture.run(name, [...args, "--local"], { CLAWROUTER_DEPLOY_ENV: "fakeco" });
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /FakeCo isolation refused/);
    assert.doesNotMatch(locked.stderr, /ENOENT/);
  }
  assert.deepEqual(fixture.requests, []);
  assert.equal(existsSync(fixture.pnpmLog), false);
  assert.equal(localAdminEnvironment({ local: true }, {}).CLAWROUTER_BASE_URL, "http://127.0.0.1:8787");
});

test("key CLI validation keeps implicit wildcard and literal secrets out of mutations", async (t) => {
  const fixture = await scriptFixture(t);
  for (const [args, message] of [
    [["--secret-stdin"], /--providers or --all-providers is required/],
    [["--secret-stdin", "--providers", "openai", "--all-providers"], /mutually exclusive/],
    [["--secret-stdin", "--all-providers", "false"], /does not accept a value/],
    [["--secret", "unsafe-literal", "--providers", "openai"], /would expose the proxy secret/],
    [["--secret-stdin", "--providers", "openai", "--monthly-budget-micros", "-1"], /non-negative integer/],
  ]) {
    const result = await fixture.run("key-put.mjs", ["--kid", "keyA", "--local", ...args], {}, secretA);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout + result.stderr, /unsafe-literal/);
  }
  assert.deepEqual(fixture.requests, []);
  assert.equal(existsSync(fixture.pnpmLog), false);
});

test("missing admin configuration, authorization, redirects, server failure and offline local Worker never fall back to KV", async (t) => {
  const fixture = await scriptFixture(t);
  for (const name of ["key-put.mjs", "key-revoke.mjs"]) {
    const args = name === "key-put.mjs" ? putArgs("keyA") : ["--kid", "keyA", "--local"];
    for (const env of [{ CLAWROUTER_ADMIN_TOKEN: "" }, { CLAWROUTER_ADMIN_TOKEN: "incorrect-fixture" }]) {
      const result = await fixture.run(name, args, env, secretA);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CLAWROUTER_ADMIN_TOKEN is required|administrator authentication required/);
    }
    const noBase = await fixture.run(name, args.filter((arg) => arg !== "--local"), { CLAWROUTER_BASE_URL: "" }, secretA);
    assert.notEqual(noBase.status, 0);
    assert.match(noBase.stderr, /CLAWROUTER_BASE_URL is required/);
    for (const status of [302, 500]) {
      fixture.response(status);
      const result = await fixture.run(name, args, {}, secretA);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, status === 302 ? /redirected/ : /fixture server failure/);
    }
    fixture.response(null);
  }
  assert.deepEqual(fixture.snapshot(), { policies: [], credentials: [] });
  await fixture.offline();
  for (const name of ["key-put.mjs", "key-revoke.mjs"]) {
    const result = await fixture.run(name, name === "key-put.mjs" ? putArgs("keyA") : ["--kid", "keyA", "--local"], {}, secretA);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch failed/);
  }
  assert.equal(fixture.kvWrites(), 0);
  assert.equal(existsSync(fixture.pnpmLog), false);
});

async function scriptFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-cli-"));
  const pnpmLog = join(dir, "pnpm-invoked");
  writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nprintf called >> "$TEST_PNPM_LOG"\nexit 99\n', { mode: 0o755 });
  const values = new Map(), requests = [];
  let db, authority, closed = false, writes = 0, responseStatus = null;
  function restart() {
    db?.close();
    db = new DatabaseSync(join(dir, "authority.sqlite"));
    authority = new PolicyBindingIndexObject({ storage: { sql: { exec(query, ...bindings) {
      const statement = db.prepare(query);
      if (statement.columns().length) return statement.all(...bindings);
      statement.run(...bindings);
      return [];
    } } } });
  }
  restart();
  const env = {
    CLAWROUTER_ADMIN_TOKEN_SHA256: hash("admin-fixture"),
    CLAWROUTER_CONTENT_RETENTION_DEFAULT: "false",
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: (url, init) => authority.fetch(new Request(url, init)) }) },
    POLICY_KV: {
      async get(key) { assert.equal(closed, false, "closed migration read KV"); return structuredClone(values.get(key) ?? null); },
      async list({ prefix }) { assert.equal(closed, false, "closed migration listed KV"); return { list_complete: true, keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }; },
      async put() { writes++; assert.fail("key mutation wrote KV"); },
    },
  };
  const dispatch = (request) => worker.fetch(request, env, { waitUntil() { assert.fail("key administration started background work"); } });
  const server = createServer(async (incoming, outgoing) => {
    try {
      requests.push(`${incoming.method} ${incoming.url}`);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = responseStatus ? Response.json({ error: { message: "fixture server failure" } }, { status: responseStatus, headers: { location: "/unexpected-redirect" } })
        : await dispatch(new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end('{"error":{"message":"fixture dispatch failed"}}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const offline = async () => { server.closeAllConnections(); if (server.listening) await new Promise((resolve) => server.close(resolve)); };
  t.after(async () => { await offline(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (table, column) => db.prepare(`SELECT ${column} FROM ${table} ORDER BY 1`).all().map((row) => JSON.parse(row[column]));
  return {
    dir, pnpmLog, values, requests, restart, offline,
    closeMigrationReads() { closed = true; },
    kvWrites: () => writes,
    response(status) { responseStatus = status; },
    meta: () => db.prepare("SELECT meta_key FROM policy_binding_meta").all().map((row) => row.meta_key),
    policy: (id) => JSON.parse(db.prepare("SELECT policy_json FROM access_policies WHERE policy_id = ?").get(id).policy_json),
    credential: (id) => JSON.parse(db.prepare("SELECT credential_json FROM proxy_credentials WHERE credential_id = ?").get(id).credential_json),
    snapshot: () => ({ policies: rows("access_policies", "policy_json"), credentials: rows("proxy_credentials", "credential_json") }),
    inspect: (kid, secret) => dispatch(new Request("http://127.0.0.1/v1/key/inspect", { headers: { authorization: `Bearer clawrouter-live-${kid}-${secret}` } })),
    admin: (path, method = "GET", body) => dispatch(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: "Bearer admin-fixture", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
    run(name, args, extraEnv = {}, input = "") {
      return new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [resolve("scripts", name), ...args], { env: { PATH: dir, NODE_NO_WARNINGS: "1", TEST_PNPM_LOG: pnpmLog, CLAWROUTER_BASE_URL: baseUrl, CLAWROUTER_ADMIN_TOKEN: "admin-fixture", ...extraEnv }, timeout: 10_000 });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (status) => resolveResult({ status, stdout, stderr }));
        child.stdin.end(input);
      });
    },
  };
}
function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|synthetic-rotated|admin-fixture/);
}
