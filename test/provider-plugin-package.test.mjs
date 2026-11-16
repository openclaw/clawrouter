import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const typescript = require.resolve("typescript/package.json");
const tsc = resolve(dirname(typescript), JSON.parse(readFileSync(typescript, "utf8")).bin.tsc);

test("packed plugin contract runs and typechecks outside the repository", t => {
  const root = mkdtempSync(join(tmpdir(), "provider-plugin-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), consumer = join(root, "consumer");
  cpSync(join(repo, "packages/provider-plugin-contract"), source, {
    recursive: true, filter: path => !["node_modules", "dist"].includes(path.split(/[\\/]/).at(-1)),
  });
  // Use the host's pinned build tool only. Neither source nor dependencies ship to the consumer.
  execFileSync("pnpm", ["pack", "--pack-destination", root], {
    cwd: source, encoding: "utf8", timeout: 30_000, stdio: "pipe",
    env: { ...process.env, PATH: `${join(repo, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}` },
  });
  const archives = readdirSync(root).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const installed = join(consumer, "node_modules/@clawrouter/provider-plugin-contract");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", join(root, archives[0]), "--strip-components=1", "-C", installed], { timeout: 30_000 });
  const files = readdirSync(installed, { recursive: true }).map(name => name.replaceAll("\\", "/")).sort();
  assert.deepEqual(files.filter(name => name !== "dist"), [
    "LICENSE", "README.md", "dist/conformance.d.ts", "dist/conformance.js", "dist/index.d.ts", "dist/index.js",
    "dist/package-index.d.ts", "dist/package-index.js", "dist/product-metadata.d.ts", "dist/product-metadata.js", "dist/products.d.ts", "dist/products.js", "package.json",
  ].sort());
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(manifest.private, true, "local packaging must not enable registry publication");
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { parseProviderPluginDescriptor, providerPluginFiles, ProviderPluginContractError,
  parseProviderConformanceScenario, PROVIDER_PLUGIN_SCHEMA, PROVIDER_CONFORMANCE_SCHEMA } from "@clawrouter/provider-plugin-contract";
const descriptor = parseProviderPluginDescriptor({ schema: PROVIDER_PLUGIN_SCHEMA, id: "example", version: "1.0.0",
  manifest: "example.provider.yaml", documentation: "README.md", license: "LICENSE" });
assert.deepEqual(providerPluginFiles(descriptor), ["LICENSE", "README.md", "example.provider.yaml"]);
assert.throws(() => parseProviderPluginDescriptor({}), ProviderPluginContractError);
assert.equal(typeof parseProviderConformanceScenario, "function");
assert.equal(PROVIDER_CONFORMANCE_SCHEMA, "clawrouter.provider-conformance.v1");
`);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, encoding: "utf8", timeout: 30_000 });
  writeFileSync(join(consumer, "consumer.ts"), `
import { parseProviderPluginDescriptor, type ProviderPluginDescriptor, type ProviderPackageIndex,
  type ProviderProductSummary, type ProviderGrantKind, type ProviderProduct, type ProviderProductBinding,
  type ProviderProductOffer, type ProviderOfferDefinition, type ProviderOfferReference, type ProviderConformanceScenario, type ProviderConformanceExecution,
  type ProviderConformanceValidation } from "@clawrouter/provider-plugin-contract";
const descriptor: ProviderPluginDescriptor = parseProviderPluginDescriptor({});
const product: ProviderProductSummary = { id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key" };
const kind: ProviderGrantKind = "subscription";
const binding: ProviderProductBinding = { type: "grant-transport", grantKind: kind };
const selection: ProviderProductOffer = { endpoint: "invoke", capability: "tool.invoke", models: null };
const fullProduct: ProviderProduct = { ...product, binding, endpoints: ["invoke"], offers: [selection] };
const definition: ProviderOfferDefinition = { id: "offer", providerId: "example", productId: product.id,
  endpoint: "invoke", capability: "tool.invoke", model: null, qualification: "declared" };
const reference: ProviderOfferReference = { id: definition.id, productId: definition.productId };
// @ts-expect-error Protocol labels cannot be used as credential classifications.
const invalidKind: ProviderGrantKind = "rest";
// @ts-expect-error Authored offers cannot claim runtime qualification.
const invalidQualification: ProviderOfferDefinition["qualification"] = "eligible";
const index: ProviderPackageIndex = { schema: "clawrouter.provider-package-index.v1", packages: [] };
declare const scenario: ProviderConformanceScenario;
declare const validation: ProviderConformanceValidation;
declare const execution: ProviderConformanceExecution;
export { descriptor, product, kind, binding, selection, fullProduct, definition, reference, index, scenario, validation, execution };
`);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, noEmit: true },
    files: ["consumer.ts"],
  }));
  execFileSync(process.execPath, [tsc, "--project", "tsconfig.json"], { cwd: consumer, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
});
