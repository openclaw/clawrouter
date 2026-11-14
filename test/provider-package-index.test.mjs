import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { buildProviderPackageIndex } from "../scripts/provider-package-index.mjs";

const source = fileURLToPath(new URL("../examples/provider-plugin/", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-package-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(source, root, { recursive: true });
  return { root, descriptor: join(root, "clawrouter.plugin.json") };
}

test("package index contains validated identity and resource references, not file contents", t => {
  const { root, descriptor } = fixture(t);
  writeFileSync(join(root, "README.md"), "PRIVATE_DOCUMENT_SENTINEL");
  const index = buildProviderPackageIndex([descriptor]);
  assert.equal(index.schema, "clawrouter.provider-package-index.v1");
  const [entry] = index.packages;
  assert.equal(entry.id, "example");
  assert.equal(entry.displayName, "Example");
  assert.equal(entry.version, "1.0.0");
  assert.deepEqual(Object.keys(entry).sort(), ["digest", "displayName", "documentation", "fixtures", "id", "license", "logo", "manifest", "products", "version"]);
  assert.deepEqual(entry.products, [{ id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key" }]);
  assert.deepEqual(entry.logo.light.path, "assets/logo.svg");
  assert.equal(entry.documentation.bytes, Buffer.byteLength("PRIVATE_DOCUMENT_SENTINEL"));
  assert.match(entry.documentation.sha256, /^[0-9a-f]{64}$/);
  for (const text of [root, "PRIVATE_DOCUMENT_SENTINEL", "api.example.invalid", "EXAMPLE_API_KEY", "<svg"]) {
    assert.ok(!JSON.stringify(index).includes(text), text);
  }
  assert.deepEqual(buildProviderPackageIndex([descriptor]), index);
  writeFileSync(join(root, "README.md"), "updated docs");
  assert.notEqual(buildProviderPackageIndex([descriptor]).packages[0].digest, entry.digest);
});

test("package products expose sorted metadata without execution or auth configuration", t => {
  const { root, descriptor } = fixture(t);
  const path = join(root, "example.provider.yaml");
  const manifest = parse(readFileSync(path, "utf8"));
  const api = manifest.products[0];
  manifest.auth.grantTransports = { subscription: {
    auth: { type: "bearer", header: "Authorization", format: "Bearer ${secret}" },
    allowedEndpoints: ["invoke"], headers: { "X-Private-Metadata": "PRIVATE_TRANSPORT_SENTINEL" },
  } };
  manifest.products = [{ ...api, id: "z-api" }, { ...api, id: "a-subscription", displayName: "Subscription",
    commercialModel: "subscription", authenticationMethod: "oauth2", binding: { type: "grant-transport", grantKind: "subscription" } }];
  writeFileSync(path, stringify(manifest));
  const [entry] = buildProviderPackageIndex([descriptor]).packages;
  assert.deepEqual(entry.products, [
    { id: "a-subscription", displayName: "Subscription", commercialModel: "subscription", authenticationMethod: "oauth2" },
    { id: "z-api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key" },
  ]);
  for (const product of entry.products) {
    assert.deepEqual(Object.keys(product).sort(), ["authenticationMethod", "commercialModel", "displayName", "id"]);
  }
  const encoded = JSON.stringify(entry);
  for (const excluded of ["PRIVATE_TRANSPORT_SENTINEL", "grant-transport", "allowedEndpoints", "tool.invoke", "EXAMPLE_API_KEY", "api.example.invalid"]) {
    assert.ok(!encoded.includes(excluded), excluded);
  }
  assert.deepEqual(buildProviderPackageIndex([descriptor]).packages[0], entry);
  manifest.products[1].endpoints = ["unknown"];
  writeFileSync(path, stringify(manifest));
  assert.throws(() => buildProviderPackageIndex([descriptor]), /unknown endpoint/);
});

test("legacy package indexes omit product metadata instead of inventing a default", t => {
  const { root, descriptor } = fixture(t);
  const path = join(root, "example.provider.yaml");
  const manifest = parse(readFileSync(path, "utf8"));
  delete manifest.products;
  writeFileSync(path, stringify(manifest));
  const [entry] = buildProviderPackageIndex([descriptor]).packages;
  assert.equal(Object.hasOwn(entry, "products"), false);
});

test("optional assets and fixtures remain absent instead of acquiring defaults", t => {
  const { descriptor } = fixture(t);
  const value = JSON.parse(readFileSync(descriptor, "utf8"));
  delete value.assets;
  delete value.fixtures;
  writeFileSync(descriptor, JSON.stringify(value));
  const [entry] = buildProviderPackageIndex([descriptor]).packages;
  assert.equal(entry.logo, undefined);
  assert.deepEqual(entry.fixtures, []);
});

test("package index rejects identity drift and invalid execution manifests", t => {
  const { root, descriptor } = fixture(t);
  const path = join(root, "example.provider.yaml"), original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("id: example", "id: changed"));
  assert.throws(() => buildProviderPackageIndex([descriptor]), /manifest id does not match/);
  writeFileSync(path, original.replace("class: rest_json", "class: imaginary"));
  assert.throws(() => buildProviderPackageIndex([descriptor]));
});

test("package index CLI reads explicit descriptors and emits only the versioned index", () => {
  const cli = realpathSync(fileURLToPath(new URL("../scripts/provider-package-index.mjs", import.meta.url)));
  const descriptor = join(source, "clawrouter.plugin.json");
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, "--plugin", descriptor], { encoding: "utf8" })), buildProviderPackageIndex([descriptor]));
  assert.throws(() => execFileSync(process.execPath, [cli, join(source, "example.provider.yaml")], { stdio: "pipe" }), /Command failed/);
});
