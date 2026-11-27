import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { compileProviderSnapshot as compileCore } from "../scripts/provider-compiler.mjs";

const paths = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => `providers/${path}`);
const manifests = paths.map(path => parse(readFileSync(path, "utf8")));

test("imported compiler matches CLI stdout and output-file snapshots", t => {
  assert.equal(compileProviderSnapshot, compileCore, "the original import path preserves the core export");
  const expected = compileProviderSnapshot(manifests);
  // The CLI sorts paths even when its caller supplies them in reverse.
  // Bound capture to this inventory plus diagnostics; pretty JSON exceeds Node's 1 MiB default.
  const maxBuffer = Buffer.byteLength(JSON.stringify(expected, null, 2)) + 64 * 1024;
  const stdout = spawnSync(process.execPath, ["scripts/compile-providers.mjs", ...paths.toReversed()], { encoding: "utf8", maxBuffer });
  assert.ifError(stdout.error);
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.deepEqual(JSON.parse(stdout.stdout), expected);
  const directory = mkdtempSync(join(tmpdir(), "provider-compiler-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "nested", "snapshot.json");
  const file = spawnSync(process.execPath, ["scripts/compile-providers.mjs", ...paths, "--", "--output", output], { encoding: "utf8" });
  assert.equal(file.status, 0, file.stderr);
  assert.equal(file.stdout, "");
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), expected);
});

test("parsed-manifest compilation does not load package or YAML input handling", () => {
  const core = new URL("../scripts/provider-compiler.mjs", import.meta.url).href;
  const source = `
    import { registerHooks } from "node:module";
    import { readFileSync } from "node:fs";
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (specifier === "yaml" || resolved.url.endsWith("/provider-manifest-inputs.mjs")
        || resolved.url.endsWith("/provider-plugin-loader.ts")
        || resolved.url.includes("/packages/provider-plugin-contract/")) {
        throw new Error("parsed-manifest compiler loaded package input handling");
      }
      return resolved;
    } });
    const { compileProviderSnapshot } = await import(${JSON.stringify(core)});
    process.stdout.write(JSON.stringify(compileProviderSnapshot(JSON.parse(readFileSync(0, "utf8")))));
  `;
  const expected = compileCore(manifests);
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    input: JSON.stringify(manifests), encoding: "utf8", maxBuffer: Buffer.byteLength(JSON.stringify(expected)) + 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("model display names round-trip without changing model identity or execution metadata", () => {
  const manifest = structuredClone(manifests.find(provider => provider.id === "anthropic"));
  for (const model of manifest.models.entries) delete model.displayName;
  const baseline = compileProviderSnapshot([manifest]);
  const entry = manifest.models.entries.find(model => model.id === "anthropic/claude-opus-5-5");
  entry.displayName = "Claude Opus 5.5";
  const named = compileProviderSnapshot([manifest]);
  assert.equal(named.providers[0].models.find(model => model.id === entry.id).displayName, entry.displayName);
  assert.equal(named.model_index[entry.id].displayName, entry.displayName);
  delete named.providers[0].models.find(model => model.id === entry.id).displayName;
  delete named.model_index[entry.id].displayName;
  assert.deepEqual(named, baseline, "labels must not affect routing, prices, or other metadata");
  assert.equal("displayName" in baseline.model_index[entry.id], false, "unnamed models remain supported");
});

for (const displayName of ["", " \t\n", null, 123]) test(`compiler rejects invalid model display name ${JSON.stringify(displayName)}`, () => {
  const manifest = structuredClone(manifests.find(provider => provider.id === "anthropic"));
  manifest.models.entries[0].displayName = displayName;
  assert.throws(() => compileProviderSnapshot([manifest]), /invalid manifest/);
});

function catalogReferenceManifest() {
  const manifest = parse(readFileSync("examples/provider-plugin/example.provider.yaml", "utf8"));
  manifest.models = { entries: [{ id: "example/router-alias", upstream: "native-slug", capabilities: ["tool.invoke"] }] };
  return manifest;
}

test("catalogue references preserve exact identities without changing execution metadata", () => {
  const manifest = catalogReferenceManifest();
  const baseline = compileProviderSnapshot([manifest]);
  const entry = manifest.models.entries[0];
  entry.catalogRef = { provider: "catalog-provider", modelId: "org/Model:revision" };
  const snapshot = compileProviderSnapshot([manifest]);
  const compiled = snapshot.providers[0].models[0], indexed = snapshot.model_index[entry.id];
  assert.deepEqual(compiled.catalogRef, entry.catalogRef);
  assert.deepEqual(indexed.catalogRef, entry.catalogRef);
  assert.equal(compiled.id, "example/router-alias");
  assert.equal(compiled.upstream, "native-slug");
  entry.catalogRef.modelId = "changed-input";
  assert.equal(compiled.catalogRef.modelId, "org/Model:revision");
  compiled.catalogRef.modelId = "changed-provider-row";
  assert.equal(indexed.catalogRef.modelId, "org/Model:revision");
  delete compiled.catalogRef;
  delete indexed.catalogRef;
  assert.deepEqual(snapshot, baseline, "a reference supplies no prices, capabilities, or execution settings");
  assert.equal(Object.hasOwn(baseline.providers[0].models[0], "catalogRef"), false);
  assert.equal(Object.hasOwn(baseline.model_index[entry.id], "catalogRef"), false);
});

test("distinct router aliases may explicitly reference the same catalogue model", () => {
  const manifest = catalogReferenceManifest();
  const first = manifest.models.entries[0];
  first.catalogRef = { provider: "catalog-provider", modelId: "org/Model" };
  manifest.models.entries.push({ ...first, id: "example/second-alias" });
  const snapshot = compileProviderSnapshot([manifest]);
  assert.deepEqual(snapshot.model_index[first.id].catalogRef, snapshot.model_index["example/second-alias"].catalogRef);
  assert.equal(Object.keys(snapshot.model_index).length, 2);
});

for (const catalogRef of [null, [], "provider/model", {}, { provider: "provider" }, { modelId: "model" },
  { provider: "", modelId: "model" }, { provider: "provider", modelId: " \t" },
  { provider: 1, modelId: "model" }, { provider: "provider", modelId: "model", capabilities: ["llm.chat"] }]) {
  test(`compiler rejects invalid catalogue reference ${JSON.stringify(catalogRef)}`, () => {
    const manifest = catalogReferenceManifest();
    manifest.models.entries[0].catalogRef = catalogRef;
    assert.throws(() => compileProviderSnapshot([manifest]), /invalid manifest/);
  });
}

test("CLI still rejects missing manifests and invalid inputs without output", () => {
  const missing = spawnSync(process.execPath, ["scripts/compile-providers.mjs"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage: compile-providers/);
  assert.equal(missing.stdout, "");
  const duplicate = spawnSync(process.execPath, ["scripts/compile-providers.mjs", paths[0], paths[0]], { encoding: "utf8" });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate provider id/);
  assert.equal(duplicate.stdout, "");
});

test("CLI rejects invalid native metadata without emitting a partial snapshot", t => {
  const manifest = structuredClone(manifests.find(provider => provider.id === "openai"));
  manifest.models.entries.find(model => model.id === "openai/gpt-6.1-sol").nativeCapabilities.version = "clawrouter.native-capabilities.v2";
  const directory = mkdtempSync(join(tmpdir(), "provider-compiler-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, "provider.yaml"), output = join(directory, "snapshot.json");
  writeFileSync(input, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, ["scripts/compile-providers.mjs", input, "--output", output], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid manifest/);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(output), false);
});
