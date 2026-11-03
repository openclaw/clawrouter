import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const paths = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => `providers/${path}`);
const manifests = paths.map(path => parse(readFileSync(path, "utf8")));

test("imported compiler matches CLI stdout and output-file snapshots", t => {
  const expected = compileProviderSnapshot(manifests);
  const stdout = spawnSync(process.execPath, ["scripts/compile-providers.mjs", ...paths], { encoding: "utf8" });
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
