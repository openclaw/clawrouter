import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const snapshotPath = fileURLToPath(new URL("../../worker/generated/provider-snapshot.json", import.meta.url));
const supported = new Map([["cohere", "embed"], ["voyage", "embeddings"], ["elevenlabs", "speech"]]);

export function compileCatalogVariant(providers) {
  assert.ok(Array.isArray(providers) && providers.length > 0, "name at least one supported manifest variant");
  assert.equal(new Set(providers).size, providers.length, "duplicate variant provider");
  for (const id of providers) assert.ok(supported.has(id), "unsupported manifest variant");
  const directory = new URL("../../providers/", import.meta.url);
  const manifests = readdirSync(directory).filter(path => path.endsWith(".provider.yaml")).sort()
    .map(path => parse(readFileSync(new URL(path, directory), "utf8")));
  const baseline = compileProviderSnapshot(manifests);
  assert.deepEqual(baseline, JSON.parse(readFileSync(snapshotPath, "utf8")), "bundled YAML must reproduce the checked-in snapshot");
  const configured = structuredClone(manifests), expected = structuredClone(baseline);
  for (const id of providers) {
    const endpoint = supported.get(id);
    configured.find(provider => provider.id === id).endpoints[endpoint].nativeProxy = false;
    expected.providers.find(provider => provider.id === id).endpoints.find(row => row.id === endpoint).native_proxy = false;
  }
  // Run schema and semantic validation; the complete comparison also protects
  // model indexes, prices, authentication and every unrelated endpoint.
  const variant = compileProviderSnapshot(configured);
  assert.deepEqual(variant, expected, "only the named native_proxy flags may differ");
  return variant;
}

export async function startCatalogVariantFixture(temporary, routerScript, upstreamScript, providers, options) {
  const variant = compileCatalogVariant(providers);
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const { build } = require("esbuild");
  let substitutions = 0;
  const bundle = await build({
    stdin: { contents: routerScript, resolveDir: root, sourcefile: "catalog-variant-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "compiled-catalog-variant", setup(build) {
      build.onLoad({ filter: /provider-snapshot\.json$/ }, args => {
        if (args.path !== snapshotPath) return;
        substitutions++;
        return { contents: JSON.stringify(variant), loader: "json" };
      });
    } }],
  });
  assert.equal(substitutions, 1, "replace exactly the generated snapshot module before Worker evaluation");
  const { startBundledWorkerdFixture } = await import("./workerd.mjs");
  return startBundledWorkerdFixture(temporary, bundle.outputFiles[0].text, upstreamScript, options);
}
