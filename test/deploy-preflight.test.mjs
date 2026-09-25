import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const env = {
  CLOUDFLARE_API_TOKEN: "fixture-token", CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLAWROUTER_POLICY_KV_ID: "fixture-kv", CLAWROUTER_ADMIN_TOKEN: "fixture-admin",
  CLAWROUTER_ADMIN_TOKEN_SHA256: createHash("sha256").update("fixture-admin").digest("hex"),
};

function preflight(overrides = {}, args = []) {
  const source = `
    process.argv = [process.execPath, "deploy-preflight.mjs", ...${JSON.stringify(args)}];
    globalThis.fetch = async (url, init = {}) => {
      if (new URL(url).origin !== "https://api.cloudflare.com") throw new Error("unexpected fixture target");
      console.log("fixture fetch " + (init.method ?? "GET"));
      return Response.json({ success: true, result: {} });
    };
    await import(${JSON.stringify(new URL("../scripts/deploy-preflight.mjs", import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const [label, overrides, error] of [
  ["missing raw token", { CLAWROUTER_ADMIN_TOKEN: "" }, /missing required deploy env: CLAWROUTER_ADMIN_TOKEN/],
  ["blank raw token", { CLAWROUTER_ADMIN_TOKEN: "   " }, /missing required deploy env: CLAWROUTER_ADMIN_TOKEN/],
  ["mismatched raw token", { CLAWROUTER_ADMIN_TOKEN: "different-fixture" }, /must match CLAWROUTER_ADMIN_TOKEN_SHA256/],
  ["invalid digest", { CLAWROUTER_ADMIN_TOKEN_SHA256: "invalid" }, /64-character hex/],
  ["partial Access pair", { CF_ACCESS_CLIENT_ID: "fixture-client" }, /must be configured together/],
  ["blank Cloudflare account", { CLOUDFLARE_ACCOUNT_ID: "   " }, /missing required deploy env: CLOUDFLARE_ACCOUNT_ID/],
  ["invalid base URL", { CLAWROUTER_BASE_URL: "invalid" }, /valid absolute URL/],
  ["blank smoke key", { CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai", CLAWROUTER_SMOKE_KEY: "   " }, /CLAWROUTER_SMOKE_KEY is required/],
]) test(`deploy preflight rejects ${label} before any remote probe`, () => {
  const result = preflight(overrides);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
  assert.doesNotMatch(result.stdout, /fixture fetch/);
});

test("valid trimmed inputs retain the Worker read and KV permission probe", () => {
  const result = preflight({ CLAWROUTER_ADMIN_TOKEN: " fixture-admin ", CF_ACCESS_CLIENT_ID: "fixture-client", CF_ACCESS_CLIENT_SECRET: "fixture-secret" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.match(/fixture fetch \w+/g), ["fixture fetch GET", "fixture fetch PUT", "fixture fetch DELETE"]);
  assert.match(result.stdout, /deploy preflight passed/);
});

for (const [name, value] of [
  ["CLAWROUTER_PREFLIGHT_REQUIRE_ACCESS", "1"],
  ["CLAWROUTER_ACCESS_TEAM_DOMAIN", "fixture.cloudflareaccess.com"],
  ["CLAWROUTER_ACCESS_AUD", "fixture-audience"],
]) for (const blank of ["", "   "]) test(`Access marker ${name} rejects ${JSON.stringify(blank)} recovery credentials before remote probes`, () => {
  const result = preflight({ [name]: value, CF_ACCESS_CLIENT_ID: blank, CF_ACCESS_CLIENT_SECRET: blank });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required/);
  assert.doesNotMatch(result.stdout, /fixture fetch/);
});

test("production Access provisioning validates recovery inputs before the new audience exists", () => {
  const required = { CLAWROUTER_PREFLIGHT_REQUIRE_ACCESS: "1" };
  const credentials = { CF_ACCESS_CLIENT_ID: "fixture-client", CF_ACCESS_CLIENT_SECRET: "fixture-secret" };
  const missing = preflight(required, ["--before-access"]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required/);
  assert.doesNotMatch(missing.stdout, /fixture fetch/);
  const before = preflight({ ...required, ...credentials }, ["--before-access"]);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /mode=before-access-read-only/);
  assert.doesNotMatch(before.stdout, /fixture fetch/);
  const incomplete = preflight({ ...required, ...credentials });
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.match(incomplete.stderr, /missing required Access deploy env: CLAWROUTER_ACCESS_AUD/);
  assert.doesNotMatch(incomplete.stdout, /fixture fetch/);
  const after = preflight({ ...required, ...credentials, CLAWROUTER_ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com", CLAWROUTER_ACCESS_AUD: "fixture-audience" });
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(after.stdout.match(/fixture fetch \w+/g), ["fixture fetch GET", "fixture fetch PUT", "fixture fetch DELETE"]);
});

test("deployments without Access retain their credential-free Access transport", () => {
  const result = preflight();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.match(/fixture fetch \w+/g), ["fixture fetch GET", "fixture fetch PUT", "fixture fetch DELETE"]);
});

const deployCommands = [
  ["cf:target", "--", "--deploy"], ["cf:preflight"],
  ["provider:compile", "--", "--output", "worker/generated/provider-snapshot.json"],
  ["--dir", "admin", "build"], ["cf:content:provision"], ["cf:config"],
  ["exec", "wrangler", "deploy", "--config", ".wrangler.generated.toml"],
  ["cf:accounts"], ["cf:smoke"],
];

async function runManualFixture(fixture) {
  const childProcess = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const spawn = childProcess.default.spawnSync;
  childProcess.default.spawnSync = (command, args, options) => {
    const scriptLauncher = fixture.packageManager.endsWith(".cjs");
    if (command !== (scriptLauncher ? process.execPath : fixture.packageManager) || options.shell) throw new Error("unexpected package-manager launcher");
    if (scriptLauncher && args[0] !== fixture.packageManager) throw new Error("missing package-manager script");
    const argv = scriptLauncher ? args.slice(1) : args;
    console.log("fixture command " + JSON.stringify({ argv, baseUrl: options.env.CLAWROUTER_BASE_URL, deploy: options.env.CLAWROUTER_PREFLIGHT_DEPLOY, providers: options.env.CLAWROUTER_SMOKE_LIVE_PROVIDERS, model: options.env.CLAWROUTER_SMOKE_MODEL_OPENAI }));
    if (argv[0] === fixture.failAt) return { status: 7 };
    if (argv[0] === fixture.signalAt) return { status: null, signal: "SIGTERM" };
    const script = { "cf:target": "assert-deployment-target", "cf:preflight": "deploy-preflight", "cf:accounts": "grant-pool-recovery" }[argv[0]];
    if (!script) return { status: 0 };
    const scriptUrl = new URL(`scripts/${script}.mjs`, fixture.root);
    // Execute the real target, preflight and recovery owners. Only their fetch
    // boundary is synthetic; compile, validation and CLI failure remain real.
    const source = `
      process.argv = ${JSON.stringify([process.execPath, fileURLToPath(scriptUrl), ...(argv[0] === "cf:target" ? ["--deploy"] : [])])};
      const activated = ${JSON.stringify(fixture.recoveryReady)};
      const readiness = { revision: 1, baseline: activated ? "existing" : null, activatedAt: activated ? "fixture-activation" : null };
      globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
        console.log("fixture fetch " + JSON.stringify({ method: init.method ?? "GET", url: String(url) }));
        if (parsed.origin === "https://api.cloudflare.com") return Response.json({ success: true, result: { title: ${JSON.stringify(fixture.namespaceTitle ?? "clawrouter-policy-fakeco")} } });
        if (parsed.origin !== new URL(process.env.CLAWROUTER_BASE_URL).origin) throw new Error("unexpected fixture target");
        if (parsed.pathname === "/v1/key/inspect") return Response.json({ verified: true, providers: ["openai"] });
        if (parsed.pathname === "/v1/admin/grant-pools/readiness") return Response.json(readiness);
        if (parsed.pathname === "/v1/admin/grant-pools/repair" && activated) return Response.json({ readiness, outcomes: [], cursor: null });
        throw new Error("unexpected fixture request");
      };
      await import(${JSON.stringify(scriptUrl.href)});
    `;
    const result = spawn(process.execPath, ["--input-type=module", "-e", source], { env: options.env, encoding: "utf8", timeout: 10_000 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  };
  syncBuiltinESMExports();
  await import(new URL("scripts/deploy-cloudflare.mjs", fixture.root));
}

function manualDeploy(overrides = {}, fixture = {}) {
  const packageManager = fixture.packageManager ?? "/fixture/package manager/pnpm.cjs";
  const source = `await (${runManualFixture.toString()})(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify({ root: new URL("../", import.meta.url).href, recoveryReady: true, ...fixture, packageManager })], {
    env: { ...env, npm_execpath: packageManager, CLAWROUTER_SMOKE_KEY: "fixture-smoke", CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai", CLAWROUTER_SMOKE_MODEL_OPENAI: "openai/gpt-6-astra", ...overrides }, encoding: "utf8", timeout: 20_000,
  });
  assert.ifError(result.error);
  const records = prefix => result.stdout.split("\n").filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
  return { ...result, commands: records("fixture command "), requests: records("fixture fetch ") };
}

for (const [label, overrides, baseUrl] of [
  ["production default", {}, "https://clawrouter.openclaw.ai"],
  ["custom hostname", { CLAWROUTER_ROUTE_HOSTNAME: "router.example" }, "https://router.example"],
  ["explicit URL", { CLAWROUTER_ROUTE_HOSTNAME: "router.example", CLAWROUTER_BASE_URL: " https://proxy.example " }, "https://proxy.example"],
  ["locked FakeCo", { CLAWROUTER_DEPLOY_ENV: "fakeco", CLAWROUTER_DEPLOY_CONFIRM: "fakeco" }, "https://clawrouter-fakeco.openclaw.ai"],
]) test(`manual deployment forwards the ${label} through preflight, recovery and one selected smoke`, () => {
  const result = manualDeploy(overrides);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands);
  assert.ok(result.commands.every(call => call.baseUrl === baseUrl && call.deploy === "1" && call.providers === "openai" && call.model === "openai/gpt-6-astra"));
  assert.ok(result.requests.some(call => call.url === `${baseUrl}/v1/admin/grant-pools/repair`));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["cf:deploy"], "node scripts/deploy-cloudflare.mjs");
});

for (const [label, overrides, error] of [
  ["missing providers", { CLAWROUTER_SMOKE_LIVE_PROVIDERS: "" }, /must name at least one golden provider/],
  ["missing smoke key", { CLAWROUTER_SMOKE_KEY: "" }, /CLAWROUTER_SMOKE_KEY is required/],
  ["blank smoke key", { CLAWROUTER_SMOKE_KEY: "   " }, /CLAWROUTER_SMOKE_KEY is required/],
  ["mismatched admin token", { CLAWROUTER_ADMIN_TOKEN: "wrong-fixture" }, /must match CLAWROUTER_ADMIN_TOKEN_SHA256/],
  ["missing protected-route Access credentials", { CLAWROUTER_ACCESS_AUD: "fixture-audience" }, /CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required/],
]) test(`manual deployment rejects ${label} before any permission mutation or deploy child`, () => {
  const result = manualDeploy(overrides);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, error);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, 2));
  assert.deepEqual(result.requests, []);
});

test("manual deployment preserves FakeCo confirmation before any remote probe", () => {
  const result = manualDeploy({ CLAWROUTER_DEPLOY_ENV: "fakeco" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CLAWROUTER_DEPLOY_CONFIRM=fakeco/);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, 1));
  assert.deepEqual(result.requests, []);
});

test("manual deployment refuses an unrelated FakeCo namespace before preflight or mutations", () => {
  const result = manualDeploy({ CLAWROUTER_DEPLOY_ENV: "fakeco", CLAWROUTER_DEPLOY_CONFIRM: "fakeco" }, { namespaceTitle: "unrelated-namespace" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FakeCo isolation refused/);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, 1));
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].method, "GET");
});

for (const [failAt, signalAt, status] of [["cf:config", null, 7], [null, "exec", 1]]) test(`manual deployment stops after ${failAt ?? signalAt} fails`, () => {
  const result = manualDeploy({}, { failAt, signalAt });
  assert.equal(result.status, status, result.stderr);
  const end = deployCommands.findIndex(args => args[0] === (failAt ?? signalAt));
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, end + 1));
});

test("post-deploy recovery failure prevents smoke without accepting a baseline or rolling back", () => {
  const result = manualDeploy({}, { recoveryReady: false });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /account routing baseline is not accepted/);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, -1));
  assert.deepEqual(result.requests.filter(call => call.url.includes("/grant-pools/")).map(call => call.method), ["GET"]);
});

test("manual deployment invokes standalone pnpm without a shell or a Node script wrapper", () => {
  const result = manualDeploy({}, { packageManager: "/fixture/package manager/pnpm.exe", failAt: "cf:target" });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(result.commands.map(call => call.argv), deployCommands.slice(0, 1));
});
