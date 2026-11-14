import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { loadProviderManifestInputs, parseProviderCompilerArgs } from "../scripts/provider-manifest-inputs.mjs";

const plugin = fileURLToPath(new URL("../examples/provider-plugin/clawrouter.plugin.json", import.meta.url));
const manifest = fileURLToPath(new URL("../examples/provider-plugin/example.provider.yaml", import.meta.url));

test("all legacy provider inputs compile to the same snapshot with the new loader", () => {
  const root = fileURLToPath(new URL("../providers/", import.meta.url));
  const paths = readdirSync(root).filter(name => name.endsWith(".provider.yaml")).map(name => join(root, name));
  const previous = compileProviderSnapshot([...paths].sort().map(path => parse(readFileSync(path, "utf8"))));
  assert.deepEqual(compileProviderSnapshot(loadProviderManifestInputs(paths)), previous);
  assert.deepEqual(previous, JSON.parse(readFileSync(new URL("../worker/generated/provider-snapshot.json", import.meta.url), "utf8")));
});

test("package and legacy versions of the same manifest compile equivalently", () => {
  assert.deepEqual(compileProviderSnapshot(loadProviderManifestInputs([], [plugin])), compileProviderSnapshot(loadProviderManifestInputs([manifest])));
  assert.throws(() => compileProviderSnapshot(loadProviderManifestInputs([manifest], [plugin])), /duplicate provider id example/);
});

test("plugin inputs enforce descriptor identity and supported manifest schema", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-compiler-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL("../examples/provider-plugin/", import.meta.url)), root, { recursive: true });
  const path = join(root, "example.provider.yaml");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("id: example", "id: different"));
  assert.throws(() => loadProviderManifestInputs([], [join(root, "clawrouter.plugin.json")]), /manifest id does not match/);
  writeFileSync(path, original.replace("clawrouter.service-provider.v1", "clawrouter.service-provider.v2"));
  assert.throws(() => loadProviderManifestInputs([], [join(root, "clawrouter.plugin.json")]), /requires clawrouter.service-provider.v1/);
});

test("compiler CLI accepts explicit packages and validates option values", () => {
  assert.deepEqual(parseProviderCompilerArgs(["--", "one.yaml", "--plugin", "plugin.json", "--output", "out.json"]), {
    manifestPaths: ["one.yaml"], pluginPaths: ["plugin.json"], output: "out.json",
  });
  for (const args of [[], ["--plugin"], ["one.yaml", "--output"], ["--unknown"], ["one.yaml", "--output", "a", "--output", "b"]]) {
    assert.throws(() => parseProviderCompilerArgs(args));
  }
  const cli = realpathSync(fileURLToPath(new URL("../scripts/compile-providers.mjs", import.meta.url)));
  const result = JSON.parse(execFileSync(process.execPath, [cli, "--plugin", plugin], { encoding: "utf8" }));
  assert.equal(result.providers[0].id, "example");
});
