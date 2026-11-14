import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createProviderPlugin } from "../scripts/create-provider-plugin.ts";
import { loadProviderPlugin } from "../scripts/provider-plugin-loader.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const runner = join(root, "scripts/run-provider-conformance.mjs");
const example = join(root, "examples/provider-plugin/clawrouter.plugin.json");
function run(paths) {
  const result = spawnSync(process.execPath, [runner, ...paths.flatMap(path => ["--plugin", path])], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, EXAMPLE_API_KEY: "PRIVATE_ENV_SENTINEL" },
  });
  assert.equal(result.error, undefined);
  return result;
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "provider-conformance-execution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, "examples/provider-plugin"), directory, { recursive: true });
  const change = (file, yaml, mutate) => {
    const path = join(directory, file);
    const value = yaml ? parse(readFileSync(path, "utf8")) : JSON.parse(readFileSync(path, "utf8"));
    mutate(value); writeFileSync(path, yaml ? stringify(value) : JSON.stringify(value));
  };
  return { descriptor: join(directory, "clawrouter.plugin.json"),
    scenario: mutate => change("fixtures/request.json", false, mutate),
    manifest: mutate => change("example.provider.yaml", true, mutate) };
}
function failed(result, pattern) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "", "no partial success report");
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /PRIVATE_.*SENTINEL|synthetic-conformance-key|synthetic-conformance-router/);
}

test("the starter executes through the Worker with synthetic host credentials", () => {
  const result = run([example]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "clawrouter.provider-conformance-execution.v1");
  assert.equal(report.scope, "native-rest-json-exchanges");
  assert.equal(report.packages[0].digest, loadProviderPlugin(example).digest);
  assert.deepEqual(report.packages[0].scenarios, [{ id: "invoke-success", fixture: "fixtures/request.json", endpoint: "invoke", capability: "tool.invoke" }]);
  assert.doesNotMatch(result.stdout, /PRIVATE_ENV_SENTINEL|synthetic-conformance|Authorization|api.example.invalid/);
});

test("native model-free bodies stay intact while host header injection and subset assertions run", t => {
  const f = fixture(t);
  f.manifest(m => {
    m.adapter.requestTransforms = { renameFields: [{ from: "input", to: "prompt" }] };
    m.adapter.injectHeaders = { "x-fixture": "synthetic" };
  });
  f.scenario(s => {
    s.upstream.request.body = { input: "example" };
    s.upstream.request.headers = { authorization: "Bearer synthetic-conformance-key", "x-fixture": "synthetic" };
    s.upstream.response.headers = { "content-type": "application/json", "x-unasserted": "extra" };
    s.response.headers = { "content-type": "application/json" };
  });
  const result = run([f.descriptor]);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate, expected] of [
  ["upstream path", s => { s.upstream.request.path = "/PRIVATE_PATH_SENTINEL"; }, /upstream path mismatch/],
  ["upstream body", s => { s.upstream.request.body = { input: "PRIVATE_BODY_SENTINEL" }; }, /upstream request body mismatch/],
  ["upstream header", s => { s.upstream.request.headers = { "x-missing": "PRIVATE_HEADER_SENTINEL" }; }, /upstream request header mismatch/],
  ["client status", s => { s.response.status = 201; }, /client response status mismatch/],
  ["client body", s => { s.response.body = { output: "PRIVATE_BODY_SENTINEL" }; }, /client response body mismatch/],
  ["client header", s => { s.response.headers = { "x-missing": "PRIVATE_HEADER_SENTINEL" }; }, /client response header mismatch/],
]) test(`the runner rejects ${name} drift without echoing message content`, t => {
  const f = fixture(t); f.scenario(mutate); failed(run([f.descriptor]), expected);
});

test("omitted bodies and JSON null stay distinct", t => {
  const f = fixture(t);
  f.scenario(s => { s.upstream.response.body = null; s.response.body = null; });
  assert.equal(run([f.descriptor]).status, 0);
  f.scenario(s => { delete s.response.body; });
  failed(run([f.descriptor]), /client response unexpected body/);
  f.scenario(s => { delete s.upstream.response.body; });
  assert.equal(run([f.descriptor]).status, 0);
});

test("non-success upstream JSON responses are compared through host error handling", t => {
  const f = fixture(t);
  f.scenario(s => {
    s.upstream.response = { status: 400, body: { error: "synthetic rejection" } };
    s.response = structuredClone(s.upstream.response);
  });
  const result = run([f.descriptor]);
  assert.equal(result.status, 0, result.stderr);
});

test("unsupported streaming, route ambiguity and host-owned client auth fail before execution", t => {
  for (const [manifest, scenario, expected] of [
    [m => { m.endpoints.invoke.streaming = "sse"; }, () => {}, /non-streaming endpoint/],
    [m => { m.endpoints.duplicate = { ...m.endpoints.invoke }; m.capabilities.push({ id: "tool.other", endpoint: "duplicate", methods: ["POST"] }); }, () => {}, /unambiguous literal native route/],
    [() => {}, s => { s.request.path = "/wrong"; }, /unambiguous literal native route/],
    [() => {}, s => { s.request.headers = { authorization: "PRIVATE_AUTH_SENTINEL" }; }, /authorization belongs to the host/],
    [() => {}, s => { s.upstream.response.headers = { "content-type": "text/event-stream" }; }, /JSON content types/],
  ]) {
    const f = fixture(t); f.manifest(manifest); f.scenario(scenario);
    failed(run([f.descriptor]), expected);
  }
});

test("all packages validate before execution and failures produce no partial report", t => {
  const f = fixture(t);
  f.scenario(s => { s.endpoint = "missing"; });
  // The first scenario would fail execution if any package ran before validation finished.
  const first = fixture(t);
  first.manifest(m => { m.id = "first"; });
  const descriptor = JSON.parse(readFileSync(first.descriptor, "utf8")); descriptor.id = "first";
  writeFileSync(first.descriptor, JSON.stringify(descriptor));
  first.scenario(s => { s.providerId = "first"; s.upstream.request.path = "/wrong"; });
  failed(run([first.descriptor, f.descriptor]), /invalid package or host failure/);
});


test("failed host execution restores global transport and the bundled provider registry", async t => {
  const { runProviderConformance } = await import("../scripts/run-provider-conformance.mjs");
  const { snapshot } = await import("../worker/providers.ts");
  const before = { fetch: globalThis.fetch, providers: snapshot.providers, models: snapshot.model_index };
  const f = fixture(t); f.scenario(s => { s.response.status = 201; });
  await assert.rejects(runProviderConformance([f.descriptor]), /client response status mismatch/);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(snapshot.providers, before.providers);
  assert.equal(snapshot.model_index, before.models);
  assert.equal((await runProviderConformance([example])).packages[0].id, "example");
});


test("a newly scaffolded provider executes without manual host registration", t => {
  const directory = mkdtempSync(join(tmpdir(), "provider-conformance-scaffold-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const descriptor = createProviderPlugin("acme-ai", join(directory, "acme"));
  const result = run([descriptor]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).packages[0].id, "acme-ai");
  assert.match(readFileSync(join(directory, "acme/README.md"), "utf8"), /run-provider-conformance/);
});
