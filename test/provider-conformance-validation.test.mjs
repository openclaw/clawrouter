import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createProviderPlugin } from "../scripts/create-provider-plugin.ts";
import { validateProviderConformance } from "../scripts/validate-provider-conformance.mjs";
import { loadProviderPlugin } from "../scripts/provider-plugin-loader.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-conformance-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL("../examples/provider-plugin/", import.meta.url)), root, { recursive: true });
  const change = (path, format, update) => {
    const value = format === "yaml" ? parse(readFileSync(join(root, path), "utf8")) : JSON.parse(readFileSync(join(root, path), "utf8"));
    update(value);
    writeFileSync(join(root, path), format === "yaml" ? stringify(value) : JSON.stringify(value));
  };
  return { root, descriptor: join(root, "clawrouter.plugin.json"),
    scenario: update => change("fixtures/request.json", "json", update),
    manifest: update => change("example.provider.yaml", "yaml", update),
    metadata: update => change("clawrouter.plugin.json", "json", update) };
}

test("report binds scenarios to captured package identity without exposing fixture contents", t => {
  const f = fixture(t);
  f.scenario(s => { s.request.body = { input: "PRIVATE_CONTENT_SENTINEL" }; });
  const report = validateProviderConformance([f.descriptor]);
  assert.equal(report.schema, "clawrouter.provider-conformance-validation.v1");
  assert.equal(report.scope, "declarations");
  assert.deepEqual(report.packages, [{ id: "example", version: "1.0.0", digest: loadProviderPlugin(f.descriptor).digest,
    scenarios: [{ id: "invoke-success", fixture: "fixtures/request.json", endpoint: "invoke", capability: "tool.invoke" }] }]);
  for (const text of [f.root, "PRIVATE_CONTENT_SENTINEL", "EXAMPLE_API_KEY", "api.example.invalid"]) assert.ok(!JSON.stringify(report).includes(text));
  assert.deepEqual(validateProviderConformance([f.descriptor]), report);
});

test("validation rejects provider, endpoint, capability and upstream method drift", t => {
  for (const [change, message] of [
    [s => { s.providerId = "foreign"; }, /providerId must match/],
    [s => { s.endpoint = "unknown"; }, /endpoint is not declared/],
    [s => { s.capability = "llm.chat"; }, /capability is not declared for this endpoint/],
    [s => { s.upstream.request.method = "DELETE"; }, /upstream method is not declared/],
  ]) {
    const f = fixture(t); f.scenario(change);
    assert.throws(() => validateProviderConformance([f.descriptor]), message);
  }
  const f = fixture(t);
  f.manifest(m => { m.endpoints.other = { ...m.endpoints.invoke, path: "/other" }; m.capabilities.push({ id: "llm.chat", endpoint: "other", methods: ["POST"] }); });
  f.scenario(s => { s.capability = "llm.chat"; });
  assert.throws(() => validateProviderConformance([f.descriptor]), /capability is not declared for this endpoint/);
});

test("model references are exact opaque IDs with the selected capability", t => {
  const f = fixture(t), model = "gateway/vendor/model";
  f.manifest(m => { m.models = { entries: [{ id: model, upstream: "model", capabilities: ["tool.invoke"] }] }; });
  f.scenario(s => { s.model = model; });
  assert.equal(validateProviderConformance([f.descriptor]).packages[0].scenarios[0].model, model);
  for (const value of ["model", "vendor/model", "foreign/vendor/model"]) {
    f.scenario(s => { s.model = value; });
    assert.throws(() => validateProviderConformance([f.descriptor]), /exact declared router model ID/);
  }
  f.manifest(m => {
    m.capabilities.push({ id: "llm.chat", endpoint: "invoke", methods: ["POST"] });
    m.models.entries[0].capabilities = ["llm.chat"];
  });
  f.scenario(s => { s.model = model; });
  assert.throws(() => validateProviderConformance([f.descriptor]), /model does not declare this capability/);
});

test("split capability method declarations are independent of declaration order", t => {
  const f = fixture(t);
  f.manifest(m => { m.capabilities.unshift({ id: "tool.invoke", endpoint: "invoke", methods: ["GET"] }); });
  assert.equal(validateProviderConformance([f.descriptor]).packages[0].scenarios.length, 1);
  f.manifest(m => { m.capabilities.reverse(); });
  assert.equal(validateProviderConformance([f.descriptor]).packages[0].scenarios.length, 1);
  f.scenario(s => { s.upstream.request.method = "GET"; });
  assert.equal(validateProviderConformance([f.descriptor]).packages[0].scenarios.length, 1);
});

test("selected packages need unique scenarios, while empty and legacy fixture packages still load", t => {
  assert.throws(() => validateProviderConformance([]), /at least one provider plugin/);
  const empty = fixture(t);
  empty.metadata(d => { delete d.fixtures; });
  assert.ok(loadProviderPlugin(empty.descriptor));
  assert.throws(() => validateProviderConformance([empty.descriptor]), /at least one scenario/);
  const legacy = fixture(t);
  writeFileSync(join(legacy.root, "fixtures/request.json"), '{"request":{},"response":{}}');
  assert.ok(loadProviderPlugin(legacy.descriptor));
  assert.throws(() => validateProviderConformance([legacy.descriptor]), /expected clawrouter.provider-conformance.v1/);
  const duplicate = fixture(t);
  cpSync(join(duplicate.root, "fixtures/request.json"), join(duplicate.root, "fixtures/other.json"));
  duplicate.metadata(d => { d.fixtures.push("fixtures/other.json"); });
  assert.throws(() => validateProviderConformance([duplicate.descriptor]), /duplicate scenario ID/);
  duplicate.scenario(s => { s.id = "a-invoke"; });
  assert.deepEqual(validateProviderConformance([duplicate.descriptor]).packages[0].scenarios.map(s => s.id), ["a-invoke", "invoke-success"]);
});

test("packages are validated as one set and emitted in stable order", t => {
  const f = fixture(t), other = createProviderPlugin("acme", join(f.root, "acme"));
  const report = validateProviderConformance([f.descriptor, other]);
  assert.deepEqual(report.packages.map(p => p.id), ["acme", "example"]);
  assert.deepEqual(report, validateProviderConformance([other, f.descriptor]));
  assert.throws(() => validateProviderConformance([f.descriptor, f.descriptor]), /duplicate provider plugin id/);
});

test("CLI emits only a full report and rejects invalid input without echoing malformed JSON", t => {
  const f = fixture(t), cli = fileURLToPath(new URL("../scripts/validate-provider-conformance.mjs", import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [cli, "--plugin", f.descriptor], { encoding: "utf8" }));
  assert.equal(report.scope, "declarations");
  for (const args of [[], ["--plugin"], [f.descriptor], ["--plugin", f.descriptor, "--unknown"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
  }
  const badRoot = join(f.root, "bad"), bad = createProviderPlugin("z-bad", badRoot);
  writeFileSync(join(badRoot, "fixtures/request.json"), '{"private":"MALFORMED_CONTENT_SENTINEL');
  const result = spawnSync(process.execPath, [cli, "--plugin", f.descriptor, "--plugin", bad], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
  const invalid = spawnSync(process.execPath, [cli, "--plugin", bad], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /invalid JSON fixture/);
  assert.doesNotMatch(invalid.stderr, /MALFORMED_CONTENT_SENTINEL/);
});
