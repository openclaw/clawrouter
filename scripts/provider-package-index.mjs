import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { compileProviderSnapshot } from "./compile-providers.mjs";
import { providerPluginManifest, parseProviderCompilerArgs } from "./provider-manifest-inputs.mjs";
import { loadProviderPlugins } from "./provider-plugin-loader.ts";

/** @returns {import('../packages/provider-plugin-contract/src/package-index.ts').ProviderPackageIndex} */
export function buildProviderPackageIndex(pluginPaths) {
  const plugins = loadProviderPlugins(pluginPaths);
  // Names and identities come from validated manifests, not untrusted extra metadata.
  const snapshot = compileProviderSnapshot(plugins.map(providerPluginManifest));
  const providers = new Map(snapshot.providers.map(provider => [provider.id, provider]));
  return {
    schema: "clawrouter.provider-package-index.v1",
    packages: plugins.map(plugin => {
      const { descriptor } = plugin;
      const resource = path => {
        const file = plugin.files.find(file => file.path === path);
        if (!file) throw new Error(`provider plugin ${descriptor.id} resource was not captured: ${path}`);
        return { ...file };
      };
      return {
        id: descriptor.id,
        version: descriptor.version,
        displayName: providers.get(descriptor.id).display_name,
        digest: plugin.digest,
        manifest: resource(descriptor.manifest),
        documentation: resource(descriptor.documentation),
        license: resource(descriptor.license),
        ...(descriptor.assets ? { logo: {
          light: resource(descriptor.assets.logo.light),
          ...(descriptor.assets.logo.dark ? { dark: resource(descriptor.assets.logo.dark) } : {}),
        } } : {}),
        fixtures: (descriptor.fixtures ?? []).map(resource),
      };
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifestPaths, pluginPaths, output } = parseProviderCompilerArgs(process.argv.slice(2));
  if (manifestPaths.length || !pluginPaths.length) throw new Error("usage: provider-package-index --plugin descriptor [--plugin descriptor...] [--output path]");
  const encoded = `${JSON.stringify(buildProviderPackageIndex(pluginPaths), null, 2)}\n`;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, encoded);
  } else process.stdout.write(encoded);
}
