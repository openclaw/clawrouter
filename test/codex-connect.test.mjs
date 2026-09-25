import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { manageCodex } from "../scripts/codex-connect.mjs";
import { nativeCodexClient } from "./helpers/native-codex.mjs";

const secret = "fixture-client-key-not-a-real-credential";
const instructions = "Synthetic full native instructions.\nKeep these bytes.\n";
const descriptor = { slug: "fixture-model", base_instructions: instructions,
  model_messages: { instructions_template: "Synthetic {{ tools }}", future: { preserved: true } },
  context_window: 1000, service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"], use_responses_lite: true };
const route = { endpoint: "responses", path: "/v1/responses", methods: ["POST"], requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse", websocket: "openai.responses" };
function offersFor(models, websocket = true) {
  return models.flatMap((model) => (websocket ? ["http", "websocket"] : ["http"]).map((transport) => ({ endpoint: "responses", modelId: model.id, transport, routeKind: "native", route: "/v1/native/fixture/v1/responses", policyId: "fixture-policy", policyGeneration: "fixture-generation", eligible: true, affordability: "request-dependent" })));
}
const catalog = { version: "clawrouter.client-catalog.v1", scope: { authType: "proxy_key", credentialId: "fixture-credential", principalId: null }, providers: [{ id: "fixture", allowed: true, executable: true, nativeBaseUrl: "/v1/native/fixture", policies: ["fixture-policy"], routes: [route], models: [
  { id: "fixture/model", upstream: "fixture-model", capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "priority", maxInputTokens: null }] } },
] }] };
catalog.providers[0].offers = offersFor(catalog.providers[0].models);
const base = '# base stays byte-identical\r\nmodel = "original"\r\nsandbox_mode = "workspace-write"\r\napproval_policy = "on-request"\r\n[model_providers.original]\r\nenv_key = "OTHER_KEY"\r\n';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "clawrouter-connect-"));
  let server;
  // A failed after hook prevents later hooks from running. Close live resources
  // in this owner before removing files, including when setup only partly ran.
  t.after(async () => {
    const errors = [];
    try {
      if (server?.listening) await new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
    } catch (error) { errors.push(error); }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "fixture cleanup failed");
  });
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
  server = createServer(async (request, response) => {
    state.requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    await state.beforeResponse?.();
    if (await state.respond?.(request, response)) return;
    response.writeHead(state.status, { "content-type": "application/json" });
    response.end(typeof state.catalog === "string" ? state.catalog : JSON.stringify(state.catalog));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: directory, CODEX_HOME: home, CLAWROUTER_API_KEY: secret, FIXTURE_BUNDLE: bundle };
  const common = ["--codex-home", home, "--codex", binary];
  const connect = ["connect", "--router-url", origin, "--provider", "fixture", "--model", "fixture-model", "--service-tier", "priority", ...common];
  const profile = join(home, "clawrouter.config.toml");
  const read = async () => getStaticTOMLValue(parseTOML(await readFile(profile, "utf8")));
  return { directory, home, bundle, binary, server, state, env, common, connect, profile, read,
    run: (command, ...args) => manageCodex([command, ...common, ...args], env) };
}

test("fixture cleanup closes the listener and active connection when directory removal fails", async (t) => {
  const cleanups = [];
  const f = await fixture({ after: (cleanup) => cleanups.push(cleanup) });
  const remove = fs.promises.rm;
  const failure = Object.assign(new Error("synthetic directory removal failure"), { code: "ENOTEMPTY" });
  let socket, mocked;
  try {
    f.state.respond = () => true;
    socket = createConnection({ host: "127.0.0.1", port: f.server.address().port });
    await once(socket, "connect");
    const received = once(f.server, "request");
    socket.write("GET /v1/catalog HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await received;
    // Destroying an active HTTP connection may reset it instead of sending EOF.
    socket.on("error", () => {});
    const closed = new Promise((done) => socket.once("close", done));
    mocked = t.mock.method(fs.promises, "rm", async (path, ...args) => {
      if (path === f.directory) throw failure;
      return remove(path, ...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(async () => { for (const cleanup of cleanups) await cleanup(); }, (error) => error === failure);
    assert.equal(f.server.listening, false);
    await closed;
    assert.equal(socket.destroyed, true);
    assert.ok((await lstat(f.directory)).isDirectory());
  } finally {
    mocked?.mock.restore();
    syncBuiltinESMExports();
    socket?.destroy();
    if (f.server.listening) await new Promise((done) => { f.server.close(done); f.server.closeAllConnections(); });
    await remove(f.directory, { recursive: true, force: true });
  }
});

test("fixture cleanup removes its directory after partial setup fails", async (t) => {
  const cleanups = [];
  const failure = new Error("synthetic setup failure");
  let directory;
  const mocked = t.mock.method(fs.promises, "writeFile", async (path) => {
    directory = resolve(path, "..", "..");
    assert.equal(path, join(directory, "codex-home", "config.toml"));
    throw failure;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(fixture({ after: (cleanup) => cleanups.push(cleanup) }), (error) => error === failure);
    for (const cleanup of cleanups) await cleanup();
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

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
  assert.equal(applied.launch, `CODEX_HOME='${f.home}' '${f.binary}' --profile clawrouter`);
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
  f.state.catalog.providers[0].offers = offersFor(f.state.catalog.providers[0].models, false);
  const updated = await f.run("update");
  assert.ok(updated.changed.includes("model_catalog_json"));
  const config = await f.read();
  assert.equal(config.model_providers.clawrouter_clawrouter.supports_websockets, false);
  assert.ok((await readFile(f.profile, "utf8")).endsWith(extra));
  assert.deepEqual(JSON.parse(await readFile(join(f.home, config.model_catalog_json), "utf8")).models, [nextDescriptor]);
  // A process that read the previous profile before the switch can still open
  // its catalog after the updater has finished.
  assert.deepEqual(JSON.parse(await readFile(join(f.home, original.model_catalog_json), "utf8")).models, [descriptor]);
  await f.run("remove");
  await assert.rejects(readFile(join(f.home, original.model_catalog_json)), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.home, config.model_catalog_json)), { code: "ENOENT" });
  assert.ok((await readFile(f.profile, "utf8")).endsWith(extra));
  assert.deepEqual(await f.read(), { model_providers: { clawrouter_clawrouter: { name: "ClawRouter", stream_max_retries: 7 } }, tools: {}, custom: { multi: "line one\nline two" } });
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
  assert.ok(removed.retained.includes(`${config.model_catalog_json}: modified outside setup`));
  assert.equal((await f.read()).model, "user-selected");
  assert.ok((await readFile(f.profile, "utf8")).includes("# keep"));
  assert.equal(await readFile(join(f.home, config.model_catalog_json), "utf8"), "user-owned catalog bytes\n");
  assert.equal(removed.revoked, false);
});

for (const form of ["rollback", "absolute", "relative"]) test(`remove keeps published catalogs for a retained ${form} pointer`, async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const original = await f.read();
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "new generation" }] }));
  await f.run("update");
  const current = await f.read();
  const text = await readFile(f.profile, "utf8");
  const pointer = form === "absolute" ? join(f.home, current.model_catalog_json) : form === "relative" ? `./${current.model_catalog_json}` : original.model_catalog_json;
  await writeFile(f.profile, text.replace(`"model_catalog_json" = "${current.model_catalog_json}"`, `"model_catalog_json" = ${JSON.stringify(pointer)}`));
  const result = await f.run("remove");
  assert.equal((await f.read()).model_catalog_json, pointer);
  assert.ok(result.retained.includes("model_catalog_json"));
  assert.ok(result.retained.includes("model catalogs retained because the catalog pointer changed"));
  assert.deepEqual(JSON.parse(await readFile(join(f.home, original.model_catalog_json), "utf8")).models, [descriptor]);
  assert.ok(await readFile(join(f.home, current.model_catalog_json), "utf8"));
});

test("invalid/empty/unauthorized refreshes and unqualified priority keep previous files", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8"), names = await readdir(f.home);
  for (const body of ["not JSON with a private response", { ...catalog, providers: [] }, { ...catalog, providers: [{ ...catalog.providers[0], models: [] }] },
    { ...catalog, providers: [{ ...catalog.providers[0], models: [{ ...catalog.providers[0].models[0], pricing: { serviceTiers: [] } }] }] }]) {
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

test("unrelated explicit and inline provider containers do not collide with the selected provider", async (t) => {
  const f = await fixture(t);
  for (const text of ['[model_providers]\n[model_providers.other]\nname = "Other"\n', 'model_providers = {}\n', 'model_providers = { other = { name = "Other" } }\n', 'model_providers = { __proto__.clawrouter_probe = true }\n', '[profiles]\n[profiles.other]\nmodel = "other"\n', 'profiles = { other = { model = "other" } }\n']) {
    await writeFile(join(f.home, "config.toml"), text);
    await manageCodex(f.connect, f.env);
    await f.run("remove");
    assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), text);
    assert.equal(Object.hasOwn(Object.prototype, "clawrouter_probe"), false);
  }
});

test("launch quotes the selected binary and home and selects the installed profile", async (t) => {
  const f = await fixture(t);
  const customHome = join(f.directory, "a home'with$dollars");
  const customBinary = join(f.directory, "a codex'with$dollars");
  await writeFile(customBinary, (await readFile(f.binary, "utf8")).replace('if (process.env.CLAWROUTER_API_KEY)', `if (process.argv[2] === "--profile") process.exit(process.env.CODEX_HOME === process.env.EXPECTED_HOME && process.argv[3] === "clawrouter" ? 0 : 3);\nif (process.env.CLAWROUTER_API_KEY)`));
  await chmod(customBinary, 0o700);
  const args = f.connect.map((value) => value === f.home ? customHome : value === f.binary ? customBinary : value);
  const result = await manageCodex(args, { ...f.env, CODEX_HOME: undefined });
  const child = spawn("/bin/sh", ["-c", result.launch], {
    env: { ...f.env, EXPECTED_HOME: customHome, CODEX_HOME: undefined }, stdio: "ignore",
  });
  assert.equal((await once(child, "close"))[0], 0);
  assert.ok(await readFile(join(customHome, "clawrouter.config.toml"), "utf8"));
  assert.deepEqual(await readdir(f.home), ["auth.json", "config.toml"]);
});

test("remove deletes only the empty owned table, preserving comments and unrelated settings", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8");
  await writeFile(f.profile, before.replace('"model" =', '# user root comment\nmodel_reasoning_effort = "high"\n"model" =') + "# user trailing comment\n");
  await f.run("remove");
  assert.deepEqual(await f.read(), { model_reasoning_effort: "high" });
  const removed = await readFile(f.profile, "utf8");
  assert.ok(removed.includes("# user root comment") && removed.includes("# user trailing comment"));
});

test("remove keeps the required provider name for user fields and subtables", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  await writeFile(f.profile, `${await readFile(f.profile, "utf8")}\n[model_providers.clawrouter_clawrouter.http_headers]\n"x-user-setting" = "fixture"\n`);
  const removed = await f.run("remove");
  assert.ok(removed.retained.includes("model_providers.clawrouter_clawrouter.name"));
  assert.deepEqual(await f.read(), { model_providers: { clawrouter_clawrouter: { name: "ClawRouter", http_headers: { "x-user-setting": "fixture" } } } });
});

test("remove preserves an editor save made during catalog cleanup", async (t) => {
  const f = await fixture(t);
  await manageCodex(f.connect, f.env);
  const config = await f.read();
  const remove = fs.promises.rm;
  const edited = "# saved during removal\nmodel = 'user-selected'\n";
  const mocked = t.mock.method(fs.promises, "rm", async (path, ...args) => {
    if (path === join(f.home, config.model_catalog_json)) await writeFile(f.profile, edited);
    return remove(path, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await f.run("remove"); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.profile, "utf8"), edited);
  assert.ok(result.retained.includes("profile changed during removal"));
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

const desktopBase = `# existing root comment\nmodel = 'original'\nmodel_provider = 'original'\nmodel_catalog_json = 'original.json'\nweb_search = 'cached'\nservice_tier = 'priority'\nmodel_reasoning_effort = 'high'\nsandbox_mode = 'read-only'\napproval_policy = 'on-request'\n[model_providers.original]\nname = 'Original'\nenv_key = 'OTHER_KEY'\n`;
async function desktopFixture(t, root = desktopBase) {
  const f = await fixture(t), profile = join(f.home, "config.toml");
  if (root === null) await rm(profile); else await writeFile(profile, root);
  const common = ["--target", "desktop", ...f.common];
  return { ...f, profile, common,
    connect: ["connect", "--router-url", f.connect[2], "--provider", "fixture", "--model", "fixture-model", ...common],
    read: async () => getStaticTOMLValue(parseTOML(await readFile(profile, "utf8"))),
    run: (command, ...args) => manageCodex([command, ...common, ...args], f.env) };
}
async function changeRoot(f, name, value) {
  const text = await readFile(f.profile, "utf8");
  const node = parseTOML(text).body[0].body.find((node) => node.type === "TOMLKeyValue" && getStaticTOMLValue(node.key)[0] === name);
  await writeFile(f.profile, text.slice(0, node.value.range[0]) + JSON.stringify(value) + text.slice(node.value.range[1]));
}

for (const target of ["CLI", "Desktop"]) {
  test(`${target} never replaces an ineligible selected model with an eligible sibling`, async (t) => {
    const f = await (target === "Desktop" ? desktopFixture(t) : fixture(t));
    await manageCodex(f.connect, f.env);
    const before = await readFile(f.profile, "utf8"), files = await readdir(f.home);
    const provider = f.state.catalog.providers[0];
    const sibling = { ...provider.models[0], id: "fixture/sibling", upstream: "fixture-sibling", codexModel: descriptor.slug };
    provider.models.push(sibling);
    provider.offers = [...offersFor([sibling]), ...offersFor([provider.models[0]]).map((offer) => ({ ...offer, eligible: false, affordability: "exact-blocked" }))];
    for (const command of ["verify", "update"]) {
      await assert.rejects(f.run(command), /selected model has no authorized native descriptor/);
      assert.equal(await readFile(f.profile, "utf8"), before);
      assert.deepEqual(await readdir(f.home), files);
    }
    await f.run("remove");
    await assert.rejects(manageCodex(f.connect, f.env), /selected model has no authorized native descriptor/);
  });

  test(`${target} updates provider-wide WebSockets when an exported sibling loses its offer`, async (t) => {
    const f = await (target === "Desktop" ? desktopFixture(t) : fixture(t));
    const provider = f.state.catalog.providers[0];
    provider.models.push({ ...provider.models[0], id: "fixture/sibling", upstream: "fixture-sibling", codexModel: descriptor.slug });
    provider.offers = offersFor(provider.models);
    await manageCodex(f.connect, f.env);
    const original = await f.read(), providerId = original.model_provider;
    assert.equal(original.model_providers[providerId].supports_websockets, true);
    // The route still advertises the format and the selected main model's WS
    // offer remains eligible. The sibling must govern the shared native flag.
    provider.offers.find((offer) => offer.modelId === "fixture/sibling" && offer.transport === "websocket").eligible = false;
    await assert.rejects(f.run("verify"), /transport changed/);
    const updated = await f.run("update");
    assert.ok(updated.changed.includes(`model_providers.${providerId}.supports_websockets`));
    const current = await f.read();
    assert.equal(current.model_catalog_json, original.model_catalog_json);
    assert.equal(current.model_providers[providerId].supports_websockets, false);
    assert.equal((await f.run("verify")).status, "verified");
    provider.offers = offersFor(provider.models);
    await f.run("update");
    assert.equal((await f.read()).model_providers[providerId].supports_websockets, true);
  });
}

for (const root of [null, "", "# only a user comment\n", desktopBase]) test(`Desktop restores original root values and absence (${root === null ? "absent" : root.length})`, async (t) => {
  const f = await desktopFixture(t, root);
  const before = await readdir(f.home);
  const dry = await manageCodex([...f.connect, "--dry-run"], f.env);
  assert.equal(dry.target, "desktop");
  assert.deepEqual(await readdir(f.home), before);
  const applied = await manageCodex(f.connect, f.env), config = await f.read();
  assert.match(applied.scope, /unprofiled CLI/);
  assert.equal(config.model_provider, "clawrouter.desktop");
  assert.equal(config.model_providers["clawrouter.desktop"].requires_openai_auth, false);
  assert.equal(config.service_tier, root === desktopBase ? "priority" : undefined);
  assert.equal(config.model_reasoning_effort, root === desktopBase ? "high" : undefined);
  assert.ok(config.model_catalog_json.startsWith(".clawrouter-desktop."));
  assert.equal((await f.run("verify")).inferenceProbed, false);
  await f.run("remove");
  if (root === null) await assert.rejects(readFile(f.profile), { code: "ENOENT" });
  else {
    const restored = await readFile(f.profile, "utf8");
    assert.deepEqual(getStaticTOMLValue(parseTOML(restored)), getStaticTOMLValue(parseTOML(root)));
    if (root === desktopBase) assert.ok(restored.includes("model = 'original'") && restored.includes("# existing root comment"));
    if (root.startsWith("# only")) assert.ok(restored.includes(root));
  }
  assert.deepEqual(await readdir(f.home), before);
  assert.equal(await readFile(join(f.home, "auth.json"), "utf8"), '{"fixture":"unrelated-auth"}\n');
});

test("Desktop update preserves comments, custom provider fields, tier and reasoning preferences", async (t) => {
  const f = await desktopFixture(t);
  await manageCodex(f.connect, f.env);
  const old = await f.read();
  await writeFile(f.profile, `${await readFile(f.profile, "utf8")}\n# added after setup\nstream_max_retries = 7\n[model_providers."clawrouter.desktop".http_headers]\n"x-user-setting" = "fixture"\n`);
  await changeRoot(f, "service_tier", "default");
  await changeRoot(f, "model_reasoning_effort", "medium");
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "desktop generation" }] }));
  await f.run("update");
  const updated = await f.read();
  assert.notEqual(updated.model_catalog_json, old.model_catalog_json);
  assert.equal(updated.service_tier, "default");
  assert.equal(updated.model_reasoning_effort, "medium");
  assert.ok(await readFile(join(f.home, old.model_catalog_json)));
  const result = await f.run("remove");
  assert.ok(result.retained.includes("model_providers.clawrouter.desktop.name"));
  const restored = await f.read();
  assert.equal(restored.model, "original");
  assert.equal(restored.service_tier, "default");
  assert.equal(restored.model_reasoning_effort, "medium");
  assert.deepEqual(restored.model_providers["clawrouter.desktop"], { name: "ClawRouter", stream_max_retries: 7, http_headers: { "x-user-setting": "fixture" } });
  assert.ok((await readFile(f.profile, "utf8")).includes("# added after setup"));
});

for (const name of ["model", "model_provider", "model_catalog_json", "web_search"]) test(`Desktop preserves the complete routing group when ${name} changes`, async (t) => {
  const f = await desktopFixture(t);
  await manageCodex(f.connect, f.env);
  await changeRoot(f, name, "user-selected");
  const text = await readFile(f.profile, "utf8"), files = await readdir(f.home);
  await assert.rejects(f.run("update"), /owned profile settings changed/);
  const result = await f.run("remove");
  assert.equal(result.status, "retained");
  assert.deepEqual(result.retained, [name]);
  assert.deepEqual(result.changed, []);
  assert.equal(await readFile(f.profile, "utf8"), text);
  assert.deepEqual(await readdir(f.home), files);
});

test("Desktop collisions and CLI-only options fail before catalog access", async (t) => {
  const f = await desktopFixture(t);
  for (const text of ['[model_providers."clawrouter.desktop"]\nname = "Existing"\n', 'model_providers = { "clawrouter.desktop" = { name = "Existing" } }\n', 'profile = "existing"\n']) {
    await writeFile(f.profile, text);
    await assert.rejects(manageCodex(f.connect, f.env), /conflicting/);
    assert.equal(await readFile(f.profile, "utf8"), text);
  }
  for (const args of [["--profile", "other"], ["--service-tier", "priority"]]) await assert.rejects(manageCodex([...f.connect, ...args], f.env), /CLI-only/);
  assert.equal(f.state.requests.length, 0);
});

test("Desktop verify and update reject a root profile selector added after setup", async (t) => {
  const f = await desktopFixture(t);
  await manageCodex(f.connect, f.env);
  const installed = await readFile(f.profile, "utf8"), line = installed.indexOf("\n") + 1;
  const edited = installed.slice(0, line) + 'profile = "other"\n' + installed.slice(line);
  await writeFile(f.profile, edited);
  const files = await readdir(f.home), requestCount = f.state.requests.length;
  for (const command of ["verify", "update"]) await assert.rejects(f.run(command), /conflicting/);
  assert.equal(await readFile(f.profile, "utf8"), edited);
  assert.deepEqual(await readdir(f.home), files);
  assert.equal(f.state.requests.length, requestCount);
});

for (const map of ['{}', '{ other = { name = "Other", http_headers = { "x-user" = "kept" } } }', '{ "other.provider" = { name = "Other" }, another.name = "Another" }']) test(`Desktop preserves unrelated inline provider members ${map}`, async (t) => {
  const original = `# inline map remains user-owned\nmodel_providers = ${map}\n[profiles.other]\nmodel = "unselected"\n`;
  const f = await desktopFixture(t, original);
  await manageCodex(f.connect, f.env);
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "inline refresh" }] }));
  await f.run("update");
  await f.run("remove");
  const restored = await readFile(f.profile, "utf8");
  assert.ok(restored.includes(original));
  assert.deepEqual(getStaticTOMLValue(parseTOML(restored)), getStaticTOMLValue(parseTOML(original)));
});

test("Desktop retains an extended inline provider as one valid owned dependency", async (t) => {
  const f = await desktopFixture(t, 'model_providers = {}\n');
  await manageCodex(f.connect, f.env);
  const config = await f.read(), text = await readFile(f.profile, "utf8");
  const member = parseTOML(text).body[0].body.find((node) => node.type === "TOMLKeyValue" && getStaticTOMLValue(node.key)[0] === "model_providers").value.body[0];
  const at = member.value.range[1] - 1;
  await writeFile(f.profile, text.slice(0, at) + ', http_headers = { "x-user-setting" = "kept" }' + text.slice(at));
  const result = await f.run("remove");
  assert.ok(result.retained.includes("provider retained for user settings"));
  const restored = await f.read();
  assert.equal(restored.model, undefined);
  assert.equal(restored.model_providers["clawrouter.desktop"].name, "ClawRouter");
  assert.deepEqual(restored.model_providers["clawrouter.desktop"].http_headers, { "x-user-setting": "kept" });
  assert.ok(await readFile(join(f.home, config.model_catalog_json)));
});

for (const position of [0, 1, 2]) test(`Desktop removes only its inline member and separator at position ${position}`, async (t) => {
  const original = 'model_providers = { left = { name = "Left" }, right = { name = "Right" } }\n';
  const f = await desktopFixture(t, original);
  await manageCodex(f.connect, f.env);
  const text = await readFile(f.profile, "utf8");
  const table = parseTOML(text).body[0].body.find((node) => node.type === "TOMLKeyValue" && getStaticTOMLValue(node.key)[0] === "model_providers").value;
  const members = table.body.map((node) => text.slice(...node.range));
  members.splice(position, 0, members.pop());
  await writeFile(f.profile, text.slice(0, table.range[0]) + `{ ${members.join(", ")} }` + text.slice(table.range[1]));
  await f.run("remove");
  const restored = await readFile(f.profile, "utf8");
  assert.deepEqual(await f.read(), getStaticTOMLValue(parseTOML(original)));
  assert.ok(restored.includes('left = { name = "Left" }') && restored.includes('right = { name = "Right" }'));
});

test("Desktop removes an unchanged provider rewritten as a dotted inline member", async (t) => {
  const f = await desktopFixture(t, "# retained root comment\n");
  await manageCodex(f.connect, f.env);
  const text = await readFile(f.profile, "utf8"), config = await f.read();
  const table = parseTOML(text).body[0].body.find((node) => node.type === "TOMLTable");
  const inline = `model_providers."clawrouter.desktop" = { ${Object.entries(config.model_providers["clawrouter.desktop"]).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(", ")} }`;
  await writeFile(f.profile, text.slice(0, table.range[0]) + inline + text.slice(table.range[1]));
  await f.run("remove");
  assert.deepEqual(await f.read(), {});
  assert.ok((await readFile(f.profile, "utf8")).includes("# retained root comment"));
});

test("Desktop locks and observed concurrent root edits preserve existing files", async (t) => {
  const f = await desktopFixture(t);
  const lock = join(f.home, ".clawrouter-desktop.lock");
  await mkdir(lock);
  await assert.rejects(manageCodex(f.connect, f.env), /lock/);
  assert.equal(await readFile(f.profile, "utf8"), desktopBase);
  await rm(lock, { recursive: true });
  f.state.beforeResponse = () => writeFile(f.profile, `${desktopBase}# concurrent edit\n`);
  await assert.rejects(manageCodex(f.connect, f.env), /changed during the operation/);
  assert.equal(await readFile(f.profile, "utf8"), `${desktopBase}# concurrent edit\n`);
  assert.deepEqual((await readdir(f.home)).sort(), ["auth.json", "config.toml"]);
});

test("Desktop failed catalog refresh and root commit retain the last usable generation", async (t) => {
  const f = await desktopFixture(t);
  await manageCodex(f.connect, f.env);
  const before = await readFile(f.profile, "utf8"), files = await readdir(f.home);
  f.state.catalog = { providers: [] };
  await assert.rejects(f.run("update"));
  assert.equal(await readFile(f.profile, "utf8"), before);
  f.state.catalog = structuredClone(catalog);
  await writeFile(f.bundle, JSON.stringify({ models: [{ ...descriptor, future_metadata: "desktop next" }] }));
  const rename = fs.promises.rename;
  const mocked = t.mock.method(fs.promises, "rename", async (from, to) => {
    if (to === f.profile) throw Object.assign(new Error("synthetic root commit failure"), { code: "EACCES" });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(f.run("update"), { code: "EACCES" }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.profile, "utf8"), before);
  assert.deepEqual(await readdir(f.home), files);
});

const nativeBinary = process.env.CLAWROUTER_CODEX_BINARY;
const nativeProducer = process.env.CLAWROUTER_CODEX_CATALOG_BINARY ?? nativeBinary;
const nativeVersion = nativeBinary ? (await promisify(execFile)(nativeBinary, ["--version"], { env: { PATH: process.env.PATH }, timeout: 20_000, maxBuffer: 1024 })).stdout.trim() : null;
// Keep both pinned account/read shapes exact, including the new nullable field.
const hasWorkspaceRouting = nativeVersion === "codex-cli 0.156.1";
for (const shape of ["table", "inline"]) test(`native Desktop root lifecycle preserves auth and clears GUI tier (${shape})`, { skip: !nativeBinary, timeout: 180_000 }, async (t) => {
  const f = await desktopFixture(t), origin = f.connect[2], requests = [];
  const env = { PATH: process.env.PATH, HOME: f.directory, CODEX_HOME: f.home, RUST_LOG: "warn", CLAWROUTER_API_KEY: secret };
  f.state.catalog.providers[0].routes[0].websocket = undefined;
  f.state.catalog.providers[0].models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((slug) => ({ id: `fixture/${slug}`, upstream: slug, capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "priority", maxInputTokens: null }] } }));
  f.state.catalog.providers[0].offers = offersFor(f.state.catalog.providers[0].models, false);
  f.state.respond = async (request, response) => {
    if (request.method !== "POST") return false;
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, url: request.url, authorization: request.headers.authorization });
    const item = { id: "desktop_message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic Desktop complete.", annotations: [] }] };
    const result = { id: "desktop_response", object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { ...result, status: "in_progress", output: [] } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: result }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    return true;
  };
  const bundle = await promisify(execFile)(nativeProducer, ["debug", "models", "--bundled"], { env: { ...env, CLAWROUTER_API_KEY: undefined }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(f.home, "original.json"), bundle.stdout);
  const provider = `name = "Original", base_url = "${origin}/v1", env_key = "CLAWROUTER_API_KEY", requires_openai_auth = false`;
  const root = `# native Desktop base\nmodel = 'gpt-5.6-sol'\nmodel_provider = 'original'\nmodel_catalog_json = 'original.json'\nservice_tier = 'priority'\nmodel_reasoning_effort = 'high'\nweb_search = 'disabled'\nsandbox_mode = 'read-only'\napproval_policy = 'on-request'\ncli_auth_credentials_store = 'file'\nchatgpt_base_url = '${origin}/control'\n${shape === "inline" ? `model_providers = { original = { ${provider} } }` : `[model_providers.original]\n${provider.replaceAll(", ", "\n")}`}\n`;
  await writeFile(f.profile, root);
  await rm(join(f.home, "auth.json"));
  const common = ["--target", "desktop", "--codex-home", f.home, "--codex", nativeProducer];
  const run = async (connected) => {
    const client = nativeCodexClient(t, nativeBinary, f.home, env), count = requests.length;
    try {
      await client.rpc("initialize", { clientInfo: { name: "clawrouter_desktop_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      client.child.stdin.write('{"method":"initialized"}\n');
      const config = (await client.rpc("config/read", { includeLayers: false })).config;
      assert.equal(config.model_provider, connected ? "clawrouter.desktop" : "original");
      assert.equal(config.model, connected ? "gpt-6-astra" : "gpt-5.6-sol");
      assert.equal(resolve(f.home, config.model_catalog_json), resolve(f.home, (await f.read()).model_catalog_json));
      assert.equal(config.service_tier, "priority", "setup must preserve the preexisting tier preference");
      assert.ok((await client.rpc("model/list", {})).data.some((entry) => entry.model === "gpt-6-astra"));
      assert.deepEqual(await client.rpc("account/read", { refreshToken: false }), { account: null, requiresOpenaiAuth: false, ...(hasWorkspaceRouting ? { workspaceRouting: null } : {}) });
      const auth = await client.rpc("getAuthStatus", { includeToken: false, refreshToken: false });
      assert.equal(auth.authMethod, null);
      assert.equal(auth.requiresOpenaiAuth, false);
      // The installed GUI emits null when its account gate disables Fast.
      // A preserved root priority preference must not turn this into Fast.
      const thread = await client.rpc("thread/start", { cwd: f.home, ephemeral: true, serviceTier: null });
      await client.rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return synthetic Desktop complete without tools." }], serviceTier: null });
      const deadline = Date.now() + 30_000;
      while (!client.notifications.some(({ method }) => method === "turn/completed") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      assert.equal(client.notifications.find(({ method }) => method === "turn/completed")?.params.turn.status, "completed");
      assert.equal(requests.length, count + 1);
      const request = requests.at(-1);
      assert.equal(request.url, connected ? "/v1/native/fixture/v1/responses" : "/v1/responses");
      assert.equal(request.body.model, connected ? "gpt-6-astra" : "gpt-5.6-sol");
      assert.equal(request.authorization, `Bearer ${secret}`);
      assert.equal(request.body.service_tier, undefined);
      assert.equal(/fallback model metadata/i.test(client.stderr()), false);
      assert.deepEqual(client.errors, []);
    } finally { await client.close(); }
  };
  await manageCodex(["connect", "--router-url", origin, "--provider", "fixture", "--model", "gpt-6-astra", ...common], env);
  await run(true);
  if (shape === "table" && process.env.CLAWROUTER_DESKTOP_FIXTURE_OUTPUT) {
    // This portable synthetic output lets the installed macOS app consume
    // exactly the tested writer output without installing task dependencies.
    const output = process.env.CLAWROUTER_DESKTOP_FIXTURE_OUTPUT;
    const config = await readFile(f.profile, "utf8"), filename = (await f.read()).model_catalog_json;
    const models = await readFile(join(f.home, filename), "utf8");
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    assert.ok(Buffer.byteLength(config + models + bundle.stdout) < 32 * 1024 * 1024);
    assert.ok(!config.includes(f.directory) && !config.includes(secret));
    await mkdir(output, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries({ "config.toml": config, [filename]: models, "original.json": bundle.stdout,
      "fixture.json": JSON.stringify({ version: 1, origin, catalog: filename, sourceRevision: process.env.GITHUB_SHA,
        configSha256: digest(config), catalogSha256: digest(models), originalSha256: digest(bundle.stdout) }) })) {
      await writeFile(join(output, name), bytes, { flag: "wx", mode: 0o600 });
    }
  }
  for (const model of f.state.catalog.providers[0].models) model.pricing.serviceTiers = [];
  await manageCodex(["update", ...common], env);
  await run(true);
  await manageCodex(["remove", ...common], env);
  await run(false);
  assert.deepEqual(await f.read(), getStaticTOMLValue(parseTOML(root)));
  assert.equal(await readFile(join(f.home, "original.json"), "utf8"), bundle.stdout);
  await assert.rejects(readFile(join(f.home, "auth.json")), { code: "ENOENT" });
  assert.deepEqual(f.state.requests.filter(({ method, url }) => !((method === "GET" && url === "/v1/catalog") || (method === "POST" && ["/v1/native/fixture/v1/responses", "/v1/responses"].includes(url)))).map(({ method, url }) => ({ method, url })), []);
});

for (const additions of ["empty", "comments", "provider"]) test(`native generated profile loads through connect/update/remove with ${additions}`, { skip: !nativeBinary, timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const env = { PATH: process.env.PATH, HOME: f.directory, CODEX_HOME: f.home, RUST_LOG: "warn", CLAWROUTER_API_KEY: secret };
  const origin = f.connect[2], requests = [];
  const pluginList = "/control/plugins/featured?platform=codex";
  f.state.respond = async (request, response) => {
    // Both native versions fetch this optional-auth control-plane list at
    // startup, independently of the selected inference provider.
    if (request.method === "GET" && request.url === pluginList) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return true;
    }
    if (request.method !== "POST") return false;
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, url: request.url, authorization: request.headers.authorization });
    const item = { id: "fixture_message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic profile complete.", annotations: [] }] };
    const result = { id: "fixture_response", object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { ...result, status: "in_progress", output: [] } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: result }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    return true;
  };
  // Exercise profile loading over HTTP. Existing native fixtures qualify WS;
  // its speculative startup prewarm is unnecessary for this lifecycle proof.
  f.state.catalog.providers[0].routes[0].websocket = undefined;
  const root = `model = "gpt-5.6-sol"\nmodel_provider = "original"\nsandbox_mode = "read-only"\napproval_policy = "on-request"\ndeveloper_instructions = "Synthetic base configuration marker."\ncli_auth_credentials_store = "file"\nchatgpt_base_url = "${origin}/control"\n[model_providers.original]\nname = "Original"\nbase_url = "${origin}/v1"\nenv_key = "CLAWROUTER_API_KEY"\nrequires_openai_auth = false\n`;
  await writeFile(join(f.home, "config.toml"), root);
  await rm(join(f.home, "auth.json"));
  f.state.catalog.providers[0].models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((slug) => ({
    id: `fixture/${slug}`, upstream: slug, capabilities: ["llm.responses"], pricing: { serviceTiers: [{ id: "priority", maxInputTokens: null }] },
  }));
  f.state.catalog.providers[0].offers = offersFor(f.state.catalog.providers[0].models, false);
  const common = ["--codex-home", f.home, "--codex", nativeProducer];
  await manageCodex(["connect", "--router-url", f.connect[2], "--provider", "fixture", "--model", "gpt-6-astra", ...common], env);
  const generated = await f.read();
  assert.equal(generated.model, "gpt-6-astra");
  assert.equal(generated.model_provider, "clawrouter_clawrouter");
  const run = async (valid = true, selectProfile = true, connected = true) => {
    // Both engines reject --profile on app-server. Exec loads the real profile
    // and sends a synthetic turn only to this isolated loopback responder.
    const count = requests.length;
    let result;
    try {
      const execution = promisify(execFile)(nativeBinary, [...(selectProfile ? ["--profile", "clawrouter"] : []), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "Return synthetic profile complete without tools."], { cwd: f.home, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      // Exec appends piped stdin to positional prompts and waits for its EOF.
      execution.child.stdin.end();
      result = await execution;
    }
    catch (error) { if (valid) assert.fail(`native profile load failed (${error.code})`); return { failed: true, stderr: error.stderr ?? "" }; }
    if (valid) {
      assert.ok(result.stdout.includes("Synthetic profile complete."), "native turn must consume the synthetic response");
      assert.equal(requests.length, count + 1);
      const request = requests.at(-1);
      assert.equal(request.body.model, connected ? "gpt-6-astra" : "gpt-5.6-sol");
      assert.equal(request.url, connected ? "/v1/native/fixture/v1/responses" : "/v1/responses");
      assert.equal(request.authorization, `Bearer ${secret}`);
      assert.ok(JSON.stringify(request.body).includes("Synthetic base configuration marker."), "base configuration must remain effective");
      assert.equal(/fallback model metadata/i.test(result.stderr), false, "native profile must resolve official model metadata");
    }
    return result;
  };
  await run();
  if (additions === "empty") {
    // Negative controls prove this is the selected profile/provider/catalog,
    // rather than a bundled-export bypass or a parse-only TOML assertion.
    const original = await readFile(f.profile, "utf8");
    await writeFile(f.profile, original.replace('[model_providers."clawrouter_clawrouter"]', '[model_providers."unselected_fixture"]'));
    const providerFailure = await run(false);
    assert.equal(providerFailure.failed, true);
    assert.ok(providerFailure.stderr.includes("Model provider `clawrouter_clawrouter` not found"));
    await writeFile(f.profile, original);
    const path = join(f.home, generated.model_catalog_json), bytes = await readFile(path, "utf8");
    await writeFile(path, '{"models":[]}');
    const catalogFailure = await run(false);
    assert.equal(catalogFailure.failed, true);
    assert.ok(catalogFailure.stderr.includes(path) && catalogFailure.stderr.includes("must contain at least one model"));
    await writeFile(path, bytes);
    assert.equal(requests.length, 1, "invalid config must fail before inference");
  }
  const extra = additions === "comments" ? "\n# retained user comment\n[tools]\n" : additions === "provider" ? "\nstream_max_retries = 7\n[model_providers.clawrouter_clawrouter.http_headers]\n\"x-user-setting\" = \"fixture\"\n" : "";
  await writeFile(f.profile, `${await readFile(f.profile, "utf8")}${extra}`);
  for (const model of f.state.catalog.providers[0].models) model.pricing.serviceTiers = [];
  await manageCodex(["update", ...common], env);
  assert.notEqual((await f.read()).model_catalog_json, generated.model_catalog_json);
  await run();
  await manageCodex(["remove", ...common], env);
  if (additions === "empty") {
    await assert.rejects(readFile(f.profile), { code: "ENOENT" });
  } else assert.ok((await readFile(f.profile, "utf8")).endsWith(extra));
  await run(true, additions !== "empty", false);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), root);
  for (const request of f.state.requests.filter((request) => request.url === pluginList)) assert.equal(request.authorization, undefined, "router key must not reach the control plane");
  const unexpected = f.state.requests.filter((request) => !((request.method === "GET" && ["/v1/catalog", pluginList].includes(request.url)) || (request.method === "POST" && ["/v1/native/fixture/v1/responses", "/v1/responses"].includes(request.url))));
  assert.deepEqual(unexpected.map(({ method, url }) => ({ method, url })), [], "native proof must use only the isolated catalog, control, and synthetic inference routes");
});
