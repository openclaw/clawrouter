import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProviderPlugin } from "../scripts/create-provider-plugin.ts";
import { loadProviderPlugin } from "../scripts/provider-plugin-loader.ts";
import { loadProviderManifestInputs } from "../scripts/provider-manifest-inputs.mjs";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { parseProviderConformanceScenario } from "../packages/provider-plugin-contract/src/index.ts";

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "create-provider-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("scaffold produces a complete provider-specific package that compiles", t => {
  const root = temporary(t), target = join(root, "acme");
  const path = createProviderPlugin("acme-ai", target);
  const plugin = loadProviderPlugin(path);
  assert.equal(plugin.descriptor.id, "acme-ai");
  assert.equal(plugin.descriptor.manifest, "acme-ai.provider.yaml");
  assert.equal(plugin.descriptor.version, "1.0.0");
  assert.match(plugin.manifestSource, /ACME_AI_API_KEY/);
  assert.match(plugin.manifestSource, /api.acme-ai.invalid/);
  assert.ok(!existsSync(join(target, "example.provider.yaml")));
  const snapshot = compileProviderSnapshot(loadProviderManifestInputs([], [path]));
  assert.equal(snapshot.providers[0].id, "acme-ai");
  assert.equal(snapshot.providers[0].display_name, "Acme Ai");
  assert.match(readFileSync(join(target, "README.md"), "utf8"), /does not register, enable, or deploy/);
  assert.equal(plugin.files.length, 6);
  const scenario = parseProviderConformanceScenario(JSON.parse(readFileSync(join(target, "fixtures/request.json"), "utf8")));
  assert.equal(scenario.providerId, "acme-ai");
  assert.equal(scenario.endpoint, "invoke");
  assert.equal(scenario.capability, "tool.invoke");
});

test("scaffold rejects invalid IDs before writing files", t => {
  const root = temporary(t), target = join(root, "invalid");
  for (const id of ["", "UPPER", "../escape", "with space", "a--b", "a".repeat(65)]) {
    assert.throws(() => createProviderPlugin(id, target));
    assert.ok(!existsSync(target));
  }
  assert.throws(() => createProviderPlugin("valid", ""));
});

test("YAML scalar names remain strings and template-like names are replaced once", t => {
  const root = temporary(t);
  for (const id of ["true", "false", "null", "my-example"]) {
    const path = createProviderPlugin(id, join(root, id));
    const [provider] = compileProviderSnapshot(loadProviderManifestInputs([], [path])).providers;
    assert.equal(provider.id, id);
    assert.equal(provider.service_platform, id);
    assert.equal(provider.display_name, id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" "));
  }
});

test("scaffold refuses existing files, directories and symlinks without overwriting", t => {
  const root = temporary(t);
  const file = join(root, "file");
  writeFileSync(file, "preserve");
  const directory = join(root, "directory");
  mkdirSync(directory);
  const link = join(root, "link");
  symlinkSync(directory, link, "dir");
  for (const target of [file, directory, link]) assert.throws(() => createProviderPlugin("acme", target), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), "preserve");
  assert.deepEqual(readdirSync(directory), []);
});

test("CLI prints the generated descriptor path and rejects surplus arguments", t => {
  const root = temporary(t), target = join(root, "cli");
  const cli = realpathSync(fileURLToPath(new URL("../scripts/create-provider-plugin.ts", import.meta.url)));
  const output = execFileSync(process.execPath, [cli, "acme", target], { encoding: "utf8" });
  assert.equal(output.trim(), join(root, "cli/clawrouter.plugin.json"));
  assert.throws(() => execFileSync(process.execPath, [cli, "acme", join(root, "extra"), "unexpected"], { stdio: "pipe" }));
  assert.ok(!existsSync(join(root, "extra")));
});
