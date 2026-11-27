import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProviderPluginDescriptor, providerPluginFiles, providerPluginPath, ProviderPluginContractError } from "../packages/provider-plugin-contract/src/index.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../examples/provider-plugin/clawrouter.plugin.json", import.meta.url), "utf8"));

test("plugin contract accepts the complete contributor example and detaches its result", () => {
  const input = fixture();
  const parsed = parseProviderPluginDescriptor(input);
  assert.deepEqual(parsed, input);
  input.assets.logo.light = "changed.svg";
  input.fixtures.push("changed.json");
  assert.equal(parsed.assets.logo.light, "assets/logo.svg");
  assert.deepEqual(parsed.fixtures, ["fixtures/request.json"]);
  assert.deepEqual(providerPluginFiles(parsed), ["LICENSE", "README.md", "assets/logo.svg", "example.provider.yaml", "fixtures/request.json"]);
});

test("every declared example resource exists", () => {
  for (const file of providerPluginFiles(parseProviderPluginDescriptor(fixture()))) {
    assert.ok(readFileSync(new URL(`../examples/provider-plugin/${file}`, import.meta.url)).length);
  }
});

test("plugin paths reject traversal, absolute paths, URLs and nonportable spelling", () => {
  for (const path of ["../secret", "/etc/passwd", "C:/secret", "https://example.com/logo.svg", "a/../b", "./a", "a//b", "a/", "a\\b", "a/%2e%2e/b", "a\0b", ""]) {
    assert.throws(() => providerPluginPath(path), ProviderPluginContractError, path);
  }
  assert.equal(providerPluginPath("assets/logo-dark.svg"), "assets/logo-dark.svg");
});

test("version, identifier and unknown fields fail with field-specific errors", () => {
  for (const [key, values] of Object.entries({
    schema: ["clawrouter.provider-plugin.v2", null],
    id: ["OpenAI", "a/b", "a--b", "a".repeat(65)],
    version: ["^1.0.0", "1.0", "01.0.0", "1.0.0-beta.1"],
    manifest: ["provider.json", "../provider.provider.yaml"],
    documentation: ["readme.txt"],
    license: [null],
  })) {
    for (const value of values) assert.throws(() => parseProviderPluginDescriptor({ ...fixture(), [key]: value }), error => error instanceof ProviderPluginContractError && error.pointer === `/${key}`);
  }
  assert.throws(() => parseProviderPluginDescriptor({ ...fixture(), scripts: { install: "echo unexpected" } }), /\/scripts: unknown field/);
  assert.throws(() => parseProviderPluginDescriptor({ ...fixture(), assets: { logo: { light: "logo.svg", url: "https://example.com" } } }), /\/assets\/logo\/url/);
});

test("optional resources are strict and bounded", () => {
  const input = fixture();
  delete input.assets;
  delete input.fixtures;
  assert.deepEqual(parseProviderPluginDescriptor(input), input);
  for (const assets of [null, {}, { logo: [] }, { logo: { light: "icon.html" } }]) {
    assert.throws(() => parseProviderPluginDescriptor({ ...input, assets }), ProviderPluginContractError);
  }
  for (const fixtures of [["a.json", "a.json"], ["a.yaml"], Array.from({ length: 129 }, (_, i) => `${i}.json`), {}]) {
    assert.throws(() => parseProviderPluginDescriptor({ ...input, fixtures }), ProviderPluginContractError);
  }
});

test("public plugin exports retain the descriptor owner's identities", async () => {
  const root = await import("../packages/provider-plugin-contract/src/index.ts");
  const descriptor = await import("../packages/provider-plugin-contract/src/plugin-descriptor.ts");
  for (const name of Object.keys(descriptor)) assert.equal(root[name], descriptor[name], name);
});

test("plugin tooling loads only its descriptor and conformance owners", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const loaded = new Set();
    registerHooks({ load(url, context, next) {
      const name = /\\/packages\\/provider-plugin-contract\\/src\\/([^/]+)$/.exec(url)?.[1];
      if (name) {
        assert.ok(!["index.ts", "bindings.ts", "native-capabilities.ts"].includes(name), name);
        loaded.add(name);
      }
      return next(url, context);
    } });
    const { loadProviderPlugin } = await import("./scripts/provider-plugin-loader.ts");
    assert.equal(loadProviderPlugin("examples/provider-plugin/clawrouter.plugin.json").descriptor.id, "example");
    assert.deepEqual([...loaded], ["plugin-descriptor.ts"]);
    const { validateProviderConformance } = await import("./scripts/validate-provider-conformance.mjs");
    assert.equal(validateProviderConformance(["examples/provider-plugin/clawrouter.plugin.json"]).packages[0].id, "example");
    assert.deepEqual([...loaded].sort(), ["conformance.ts", "plugin-descriptor.ts"]);
    process.stdout.write("isolated contract owners\\n");
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(output, "isolated contract owners\n");
});
