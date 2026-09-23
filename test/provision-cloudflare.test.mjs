import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function runFixture(fixture) {
  const { default: childProcess } = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const calls = [];
  childProcess.spawnSync = (command, args) => {
    calls.push({ command, args });
    if (command !== "pnpm" || args[0] !== "exec" || args[1] !== "wrangler") {
      throw new Error("unexpected command");
    }
    if (args[2] !== "whoami" && !(args[2] === "queues" && args[3] === "create")) {
      throw new Error("unexpected Wrangler mutation");
    }
    return fixture.queueExists && args[2] === "queues"
      ? { status: 1, stdout: "", stderr: "queue already exists" }
      : { status: 0, stdout: "", stderr: "" };
  };
  syncBuiltinESMExports();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    if (url !== "https://api.cloudflare.com/client/v4/accounts/fixture-account/storage/kv/namespaces"
      || init.method !== "POST"
      || init.headers.Authorization !== "Bearer fixture-token"
      || init.headers["content-type"] !== "application/json") {
      throw new Error("unexpected Cloudflare request");
    }
    return new Response(fixture.body ?? JSON.stringify({
      success: true,
      result: { id: "fixture-kv", title: JSON.parse(init.body).title },
    }), { status: fixture.status ?? 200 });
  };
  let error;
  try {
    process.argv[1] = fileURLToPath(new URL("../scripts/provision-cloudflare.mjs", import.meta.url));
    await import("../scripts/provision-cloudflare.mjs");
  } catch (caught) {
    error = caught.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ calls, error }));
}

function provision(env = {}, fixture = {}) {
  // Exercise the CLI entry point with no inherited credentials or external
  // process/network calls; only the subprocess's built-in exports are replaced.
  const source = `await (${runFixture.toString()})(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(fixture)], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    env: {
      CLOUDFLARE_ACCOUNT_ID: "fixture-account",
      CLOUDFLARE_API_TOKEN: "fixture-token",
      ...env,
    },
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /fixture-token/);
  return { ...JSON.parse(result.stdout.trim().split("\n").at(-1)), status: result.status, stdout: result.stdout };
}

for (const environment of ["production", "fakeco"]) {
  const env = { CLAWROUTER_DEPLOY_ENV: environment, CLAWROUTER_DEPLOY_CONFIRM: environment };
  const fakeco = environment === "fakeco";
  const title = fakeco ? "clawrouter-policy-fakeco" : "POLICY_KV";
  const queue = fakeco ? "clawrouter-usage-fakeco" : "clawrouter-usage";
  const dlq = `${queue}-dead-letter`;

  test(`${environment} provisioning creates exact KV through the API and preserves output names`, () => {
    const result = provision(env);
    assert.equal(result.status, 0, result.error);
    assert.deepEqual(result.calls, [
      { command: "pnpm", args: ["exec", "wrangler", "whoami"] },
      { command: "pnpm", args: ["exec", "wrangler", "queues", "create", queue] },
      { command: "pnpm", args: ["exec", "wrangler", "queues", "create", dlq] },
      { url: "https://api.cloudflare.com/client/v4/accounts/fixture-account/storage/kv/namespaces", method: "POST", body: { title } },
    ]);
    assert.match(result.stdout, new RegExp(`^CLAWROUTER_DEPLOY_ENV=${environment}$`, "m"));
    assert.match(result.stdout, new RegExp(`^CLAWROUTER_USAGE_QUEUE=${queue}$`, "m"));
    assert.match(result.stdout, new RegExp(`^CLAWROUTER_USAGE_DLQ=${dlq}$`, "m"));
    assert.match(result.stdout, /^CLAWROUTER_POLICY_KV_ID=fixture-kv$/m);
    assert.match(result.stdout, new RegExp(`^${fakeco ? "CLAWROUTER_FAKECO_" : ""}CLOUDFLARE_API_TOKEN=<redacted>$`, "m"));
    assert.match(result.stdout, new RegExp(`^${fakeco ? "CLAWROUTER_FAKECO_POLICY_KV_ID" : "CLAWROUTER_POLICY_KV_ID"}=fixture-kv$`, "m"));
    assert.doesNotMatch(result.stdout, /--json/);
  });

  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    test(`${environment} missing ${name} stops before all resource calls`, () => {
      const result = provision({ ...env, [name]: "  " });
      assert.equal(result.status, 1);
      assert.equal(result.error, `${name} is required`);
      assert.deepEqual(result.calls, []);
      assert.doesNotMatch(result.stdout, /Cloudflare resources ready/);
    });
  }

  const failureCases = [
    ["non-JSON", { body: "upstream unavailable", status: 502 }, /non-JSON HTTP 502/],
    ["null", { body: "null" }, /create failed/],
    ["API error", { body: JSON.stringify({ success: false, errors: [{ message: "denied" }] }) }, /denied/],
    ["duplicate", { status: 400, body: JSON.stringify({ success: false, errors: [{ code: 10014, message: "namespace already exists" }] }) }, /already exists/],
    ["HTTP error", { status: 503, body: JSON.stringify({ success: true, result: { id: "fixture-kv", title } }) }, /HTTP 503/],
    ["missing success", { body: JSON.stringify({ result: { id: "fixture-kv", title } }) }, /create failed/],
    ["invalid id", { body: JSON.stringify({ success: true, result: { id: 42, title } }) }, /create failed/],
    ["empty id", { body: JSON.stringify({ success: true, result: { id: " ", title } }) }, /create failed/],
    ["missing result", { body: JSON.stringify({ success: true }) }, /create failed/],
    ["mismatched title", { body: JSON.stringify({ success: true, result: { id: "fixture-kv", title: "wrong-title" } }) }, /instead of/],
    ["missing title", { body: JSON.stringify({ success: true, result: { id: "fixture-kv" } }) }, /instead of/],
  ];
  for (const [label, fixture, error] of failureCases) {
    test(`${environment} ${label} cannot report successful KV creation or adopt another namespace`, () => {
      const result = provision(env, fixture);
      assert.equal(result.status, 1);
      assert.match(result.error, error);
      assert.equal(result.calls.length, 4);
      assert.equal(result.calls.filter((call) => call.url).length, 1);
      assert.doesNotMatch(result.stdout, /Cloudflare resources ready|CLAWROUTER_POLICY_KV_ID=/);
    });
  }
}

test("production overrides preserve exact titles and existing queues remain allowed", () => {
  const result = provision({ CLAWROUTER_POLICY_KV_NAMESPACE: "custom-policy" }, { queueExists: true });
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(result.calls.at(-1).body, { title: "custom-policy" });
});

for (const env of [
  { CLAWROUTER_DEPLOY_ENV: "unknown" },
  { CLAWROUTER_DEPLOY_ENV: "fakeco" },
  { CLAWROUTER_DEPLOY_ENV: "fakeco", CLAWROUTER_DEPLOY_CONFIRM: "fakeco", CLAWROUTER_POLICY_KV_NAMESPACE: "POLICY_KV" },
]) {
  test(`deployment target guard stops all calls: ${JSON.stringify(env)}`, () => {
    const result = provision(env);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  });
}
