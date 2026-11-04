import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadProviderPlugin, loadProviderPlugins, PROVIDER_PLUGIN_LIMITS } from "../scripts/provider-plugin-loader.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-plugin-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL("../examples/provider-plugin", import.meta.url)), root, { recursive: true });
  return { root, descriptor: join(root, "clawrouter.plugin.json") };
}

test("loader captures deterministic data and changes its digest with resource content", t => {
  const { root, descriptor } = fixture(t);
  const first = loadProviderPlugin(descriptor);
  assert.deepEqual(loadProviderPlugin(descriptor), first);
  assert.match(first.manifestSource, /id: example/);
  assert.equal(first.files.length, 6);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  writeFileSync(join(root, "README.md"), "new documentation");
  assert.notEqual(loadProviderPlugin(descriptor).digest, first.digest);
  assert.match(first.manifestSource, /id: example/);
});

test("loader rejects file and parent-directory symlinks, including links within the package", t => {
  for (const directory of [false, true]) {
    const { root, descriptor } = fixture(t);
    if (directory) {
      rmSync(join(root, "assets"), { recursive: true });
      mkdirSync(join(root, "actual-assets"));
      writeFileSync(join(root, "actual-assets/logo.svg"), "<svg/>");
      symlinkSync(join(root, "actual-assets"), join(root, "assets"), "dir");
    } else {
      rmSync(join(root, "README.md"));
      symlinkSync(join(root, "LICENSE"), join(root, "README.md"));
    }
    assert.throws(() => loadProviderPlugin(descriptor), /symlink is not allowed/);
  }
});

test("loader rejects missing, directory, oversized, and symlink descriptors", t => {
  const { root, descriptor } = fixture(t);
  assert.throws(() => loadProviderPlugin(join(root, "missing.json")), /must be named/);
  rmSync(join(root, "README.md"));
  assert.throws(() => loadProviderPlugin(descriptor), /ENOENT/);
  mkdirSync(join(root, "README.md"));
  assert.throws(() => loadProviderPlugin(descriptor), /not a regular file/);
  rmSync(join(root, "README.md"), { recursive: true });
  writeFileSync(join(root, "README.md"), "");
  truncateSync(join(root, "README.md"), PROVIDER_PLUGIN_LIMITS.resourceBytes + 1);
  assert.throws(() => loadProviderPlugin(descriptor), /exceeds byte limit/);
  rmSync(descriptor);
  symlinkSync(join(root, "LICENSE"), descriptor);
  assert.throws(() => loadProviderPlugin(descriptor), /symlink is not allowed/);
});

test("loader bounds descriptor and aggregate package bytes", t => {
  const { root, descriptor } = fixture(t);
  const original = readFileSync(descriptor, "utf8");
  truncateSync(descriptor, PROVIDER_PLUGIN_LIMITS.descriptorBytes + 1);
  assert.throws(() => loadProviderPlugin(descriptor), /exceeds byte limit/);
  const data = JSON.parse(original);
  data.fixtures = [];
  for (let i = 0; i < 17; i++) {
    const file = `fixtures/${i}.json`;
    writeFileSync(join(root, file), "");
    truncateSync(join(root, file), PROVIDER_PLUGIN_LIMITS.resourceBytes);
    data.fixtures.push(file);
  }
  writeFileSync(descriptor, JSON.stringify(data));
  assert.throws(() => loadProviderPlugin(descriptor), /total byte limit/);
});

test("explicit plugin list rejects duplicate IDs and does not scan adjacent folders", t => {
  const { descriptor } = fixture(t);
  assert.equal(loadProviderPlugins([descriptor]).length, 1);
  assert.throws(() => loadProviderPlugins([descriptor, descriptor]), /duplicate provider plugin id example/);
  assert.deepEqual(loadProviderPlugins([]), []);
});
