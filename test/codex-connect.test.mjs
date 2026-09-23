import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { manageCodex } from "../scripts/codex-connect.mjs";

const secret = "fixture-client-key-not-a-real-credential";
const instructions = "Synthetic full native instructions.\nKeep these bytes.\n";
const descriptor = { slug: "fixture-model", base_instructions: instructions,
  model_messages: { instructions_template: "Synthetic {{ tools }}", future: { preserved: true } },
  context_window: 1000, service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"], use_responses_lite: true };
const route = { path: "/v1/responses", methods: ["POST"], requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse", websocket: "openai.responses" };
const catalog = { providers: [{ id: "fixture", allowed: true, executable: true, nativeBaseUrl: "/v1/native/fixture", routes: [route], models: [
  { id: "fixture/model", upstream: "fixture-model", capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "priority", maxInputTokens: null }] } },
] }] };
const base = '# base stays byte-identical\r\nmodel = "original"\r\nsandbox_mode = "workspace-write"\r\napproval_policy = "on-request"\r\n[model_providers.original]\r\nenv_key = "OTHER_KEY"\r\n';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "clawrouter-connect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "codex-home"), bundle = join(directory, "bundle.json"), binary = join(directory, "codex-fixture");
  await mkdir(home);
  await writeFile(join(home, "config.toml"), base);
  await writeFile(join(home, "auth.json"), '{"fixture":"unrelated-auth"}\n');
  await writeFile(bundle, JSON.stringify({ models: [descriptor] }));
  await writeFile(binary, `#!${process.execPath}\nconst fs = require("node:fs");
if (process.env.CLAWROUTER_API_KEY) { process.stderr.write("credential leaked to producer"); process.exit(1); }
if (process.argv.slice(2).join(" ") === "debug models --bundled") process.stdout.write(fs.readFileSync(process.env.FIXTURE_BUNDLE));
else if (process.argv[2] === "--version") process.stdout.write("codex-cli 0.155.0\\n");
else process.exit(2);\n`);
  await chmod(binary, 0o700);
  const state = { catalog: structuredClone(catalog), status: 200, requests: [], beforeResponse: null };
  const server = createServer(async (request, response) => {
    state.requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    await state.beforeResponse?.();
    response.writeHead(state.status, { "content-type": "application/json" });
    response.end(typeof state.catalog === "string" ? state.catalog : JSON.stringify(state.catalog));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: directory, CODEX_HOME: home, CLAWROUTER_API_KEY: secret, FIXTURE_BUNDLE: bundle };
  const common = ["--codex-home", home, "--codex", binary];
  const connect = ["connect", "--router-url", origin, "--provider", "fixture", "--model", "fixture-model", "--service-tier", "priority", ...common];
  const profile = join(home, "clawrouter.config.toml");
  const read = async () => getStaticTOMLValue(parseTOML(await readFile(profile, "utf8")));
  return { directory, home, bundle, binary, state, env, common, connect, profile, read,
    run: (command, ...args) => manageCodex([command, ...common, ...args], env) };
}

test("connect dry-run, verify, update, and remove preserve base/auth/key and complete native metadata", async (t) => {
  const f = await fixture(t);
  const keyFile = join(f.directory, "client-key.txt");
  await writeFile(keyFile, `${secret}\n`);
  const args = [...f.connect, "--key-file", keyFile];
  const dry = await manageCodex([...args, "--dry-run"], { ...f.env, CLAWROUTER_API_KEY: undefined });
  assert.equal(dry.status, "planned");
  assert.deepEqual(await readdir(f.home), ["auth.json", "config.toml"]);
  const applied = await manageCodex(args, { ...f.env, CLAWROUTER_API_KEY: undefined });
  assert.equal(applied.status, "applied");
  assert.equal(applied.launch, "codex --profile clawrouter");
  const config = await f.read();
  assert.equal(config.model_provider, "clawrouter_clawrouter");
  assert.equal(config.model_providers.clawrouter_clawrouter.env_key, "CLAWROUTER_API_KEY");
  assert.equal(config.model_providers.clawrouter_clawrouter.supports_websockets, true);
  assert.equal(config.service_tier, "priority");
  assert.equal(config.web_search, "disabled");
  assert.deepEqual(JSON.parse(await readFile(join(f.home, config.model_catalog_json), "utf8")).models, [descriptor]);
  for (const path of [f.profile, join(f.home, config.model_catalog_json)]) assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const unchanged = await readFile(f.profile, "utf8");
  assert.equal((await f.run("verify")).inferenceProbed, false);
  assert.deepEqual((await f.run("update", "--dry-run")).changed, []);
  await f.run("update");
  assert.equal(await readFile(f.profile, "utf8"), unchanged);
  await f.run("remove");
  assert.equal((await f.run("remove")).status, "absent");
  assert.deepEqual(await readdir(f.home), ["auth.json", "config.toml"]);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), base);
  assert.equal(await readFile(join(f.home, "auth.json"), "utf8"), '{"fixture":"unrelated-auth"}\n');
  assert.equal(await readFile(keyFile, "utf8"), `${secret}\n`);
  assert.ok(f.state.requests.every((request) => request.method === "GET" && request.url === "/v1/catalog" && request.authorization === `Bearer ${secret}`));
  assert.ok(!JSON.stringify(applied).includes(secret) && !JSON.stringify(applied).includes(instructions));
});

test("refresh switches one complete generation and preserves user comments, fields, and empty tables", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const original = await f.read();
  const extra = '\n# user comment stays\nstream_max_retries = 7\n[tools]\n[custom]\nmulti = """line one\nline two"""\n';
  await writeFile(f.profile, `${await readFile(f.profile, "utf8")}${extra}`);
  const nextDescriptor = { ...descriptor, unknown_future_metadata: { complete: true } };
  await writeFile(f.bundle, JSON.stringify({ models: [nextDescriptor] }));
  await assert.rejects(f.run("verify"), /run update/);
  f.state.catalog.providers[0].routes[0].websocket = undefined;
  const updated = await f.run("update");
  assert.ok(updated.changed.includes("model_catalog_json"));
  const config = await f.read();
  assert.equal(config.model_providers.clawrouter_clawrouter.supports_websockets, false);
  assert.ok((await readFile(f.profile, "utf8")).endsWith(extra));
  assert.deepEqual(JSON.parse(await readFile(join(f.home, config.model_catalog_json), "utf8")).models, [nextDescriptor]);
  await assert.rejects(readFile(join(f.home, original.model_catalog_json)), { code: "ENOENT" });
  await f.run("remove");
  assert.ok((await readFile(f.profile, "utf8")).endsWith(extra));
  assert.deepEqual(await f.read(), { model_providers: { clawrouter_clawrouter: { stream_max_retries: 7 } }, tools: {}, custom: { multi: "line one\nline two" } });
});

test("update refuses changed owned fields; remove retains their user values and modified catalog", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const config = await f.read();
  await writeFile(f.profile, (await readFile(f.profile, "utf8")).replace('"model" = "fixture-model"', '"model" = "user-selected" # keep'));
  await writeFile(join(f.home, config.model_catalog_json), "user-owned catalog bytes\n");
  const before = await readFile(f.profile, "utf8");
  await assert.rejects(f.run("update"), /owned profile settings changed/);
  assert.equal(await readFile(f.profile, "utf8"), before);
  const removed = await f.run("remove");
  assert.ok(removed.retained.includes("model"));
  assert.ok(removed.retained.includes("model catalog modified outside setup"));
  assert.equal((await f.read()).model, "user-selected");
  assert.ok((await readFile(f.profile, "utf8")).includes("# keep"));
  assert.equal(await readFile(join(f.home, config.model_catalog_json), "utf8"), "user-owned catalog bytes\n");
  assert.equal(removed.revoked, false);
});

test("invalid/empty/unauthorized refreshes and unqualified priority keep previous files", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8"), names = await readdir(f.home);
  for (const body of ["not JSON with a private response", { providers: [] }, { providers: [{ ...catalog.providers[0], models: [] }] },
    { providers: [{ ...catalog.providers[0], models: [{ ...catalog.providers[0].models[0], pricing: { serviceTiers: [] } }] }] }]) {
    f.state.catalog = body;
    await assert.rejects(f.run("update"));
    assert.equal(await readFile(f.profile, "utf8"), before);
    assert.deepEqual(await readdir(f.home), names);
  }
  f.state.status = 401;
  await assert.rejects(f.run("verify"), /HTTP 401/);
  assert.equal(await readFile(f.profile, "utf8"), before);
});

test("collisions, symlinks, locks, and concurrent profile edits are not overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(f.profile, "# existing user profile\n");
  await assert.rejects(manageCodex(f.connect, f.env), /profile already exists/);
  await rm(f.profile);
  await symlink(join(f.home, "config.toml"), f.profile);
  await assert.rejects(manageCodex(f.connect, f.env), /not symlinks/);
  await rm(f.profile);
  await mkdir(join(f.home, ".clawrouter.clawrouter-connect.lock"));
  await assert.rejects(manageCodex(f.connect, f.env), /profile lock/);
  await rm(join(f.home, ".clawrouter.clawrouter-connect.lock"), { recursive: true });
  f.state.beforeResponse = () => writeFile(f.profile, "# concurrent user edit\n");
  await assert.rejects(manageCodex(f.connect, f.env), /profile changed/);
  assert.equal(await readFile(f.profile, "utf8"), "# concurrent user edit\n");
  assert.deepEqual((await readdir(f.home)).sort(), ["auth.json", "clawrouter.config.toml", "config.toml"]);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), base);
});

test("base provider or legacy profile collisions fail before catalog access", async (t) => {
  const f = await fixture(t);
  for (const text of ['[model_providers.clawrouter_clawrouter]\nauth = { command = "existing" }\n', '[profiles.clawrouter]\nmodel = "existing"\n', '[profiles.clawrouter]\n', 'model_providers = { clawrouter_clawrouter = { name = "existing" } }\n', 'broken = [']) {
    await writeFile(join(f.home, "config.toml"), text);
    await assert.rejects(manageCodex(f.connect, f.env), /conflicting|valid TOML/);
    assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), text);
  }
  assert.equal(f.state.requests.length, 0);
});

test("failed profile commit cleans its new generation, temp files, and lock while retaining the old catalog", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8"), files = await readdir(f.home);
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "new generation" }] }));
  const rename = fs.promises.rename;
  const mocked = t.mock.method(fs.promises, "rename", async (from, to) => {
    if (to === f.profile) throw Object.assign(new Error("synthetic profile commit failure"), { code: "EACCES" });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.run("update"), { code: "EACCES" }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.profile, "utf8"), before);
  assert.deepEqual(await readdir(f.home), files);
});

test("concurrent edit between temporary profile write and rename is retained and unreferenced generation removed", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8"), files = await readdir(f.home);
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "new generation" }] }));
  const write = fs.promises.writeFile;
  const mocked = t.mock.method(fs.promises, "writeFile", async (path, ...args) => {
    await write(path, ...args);
    if (path.startsWith(`${f.profile}.`) && path.endsWith(".tmp")) await write(f.profile, `${before}# concurrent edit\n`);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.run("update"), /changed during the operation/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.profile, "utf8"), `${before}# concurrent edit\n`);
  assert.deepEqual(await readdir(f.home), files);
});

test("CLI failures never print a key, response body, or native producer stderr", async (t) => {
  const f = await fixture(t);
  f.state.catalog = `private response ${secret}`;
  const child = spawn(process.execPath, ["scripts/codex-connect.mjs", ...f.connect], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(output, /invalid JSON/);
  assert.ok(!output.includes(secret) && !output.includes("private response"));
  f.state.catalog = catalog;
  await writeFile(f.binary, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(instructions)}); process.exit(1);\n`);
  await assert.rejects(f.run("verify"), /not owned/);
  await assert.rejects(manageCodex(f.connect, f.env), (error) => /bundled export failed/.test(error.message) && !error.message.includes(instructions));
});
