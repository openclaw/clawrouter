import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { loadProviderPlugins } from "./provider-plugin-loader.ts";
import { PROVIDER_MANIFEST_SCHEMA } from "../packages/provider-plugin-contract/src/index.ts";

/** Preserve legacy ordering; package inputs are explicit and sorted by provider ID. */
export function loadProviderManifestInputs(manifestPaths, pluginPaths = []) {
  const manifests = [...manifestPaths].sort().map(path => parse(readFileSync(path, "utf8")));
  for (const plugin of loadProviderPlugins(pluginPaths)) {
    manifests.push(providerPluginManifest(plugin));
  }
  return manifests;
}

/** Parse the already captured source; consumers must not reopen package files. */
export function providerPluginManifest(plugin) {
  const manifest = parse(plugin.manifestSource);
  if (manifest?.schema !== PROVIDER_MANIFEST_SCHEMA) throw new Error(`provider plugin ${plugin.descriptor.id} requires ${PROVIDER_MANIFEST_SCHEMA}`);
  if (manifest.id !== plugin.descriptor.id) throw new Error(`provider plugin ${plugin.descriptor.id} manifest id does not match descriptor`);
  return manifest;
}

export function parseProviderCompilerArgs(args) {
  const manifestPaths = [], pluginPaths = [];
  let output = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--plugin" || arg === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--plugin") pluginPaths.push(value);
      else {
        if (output !== null) throw new Error("--output may only be specified once");
        output = value;
      }
    } else if (arg.startsWith("--")) throw new Error(`unknown provider compiler option ${arg}`);
    else manifestPaths.push(arg);
  }
  if (!manifestPaths.length && !pluginPaths.length) throw new Error("usage: compile-providers <manifest...> [--plugin descriptor...] [--output path]");
  return { manifestPaths, pluginPaths, output };
}
