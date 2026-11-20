import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseProviderPluginDescriptor, providerPluginFiles, type ProviderPluginDescriptor } from "../packages/provider-plugin-contract/src/index.ts";

export const PROVIDER_PLUGIN_LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  resourceBytes: 1024 * 1024,
  packageBytes: 16 * 1024 * 1024,
});

export interface LoadedProviderPlugin {
  descriptor: ProviderPluginDescriptor;
  manifestSource: string;
  /** Content identity, not a signature or publisher trust assertion. */
  digest: string;
  files: readonly { path: string; bytes: number; sha256: string }[];
  /** Opt-in fixture text captured from the same bytes used for the content digest. */
  fixtureSources?: readonly { path: string; source: string }[];
}

export interface ProviderPluginLoadOptions { captureFixtures?: boolean }

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(root: string, relativePath: string, maxBytes: number): Buffer {
  let path = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`provider plugin symlink is not allowed: ${relativePath}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`provider plugin parent is not a directory: ${relativePath}`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`provider plugin resource is not a regular file: ${relativePath}`);
    if (index === parts.length - 1 && stat.size > maxBytes) throw new Error(`provider plugin resource exceeds byte limit: ${relativePath}`);
  }
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new Error(`provider plugin resource exceeds byte limit: ${relativePath}`);
  return bytes;
}

/** Build-time data loading only. The operator owns and stabilizes the input directory. */
export function loadProviderPlugin(descriptorPath: string, options: ProviderPluginLoadOptions = {}): LoadedProviderPlugin {
  const absolute = resolve(descriptorPath);
  if (basename(absolute) !== "clawrouter.plugin.json") throw new Error("provider plugin descriptor must be named clawrouter.plugin.json");
  const root = realpathSync(dirname(absolute));
  const descriptorBytes = readRegularFile(root, "clawrouter.plugin.json", PROVIDER_PLUGIN_LIMITS.descriptorBytes);
  const descriptor = parseProviderPluginDescriptor(JSON.parse(descriptorBytes.toString("utf8")));
  const files = [{ path: "clawrouter.plugin.json", bytes: descriptorBytes.length, sha256: hash(descriptorBytes) }];
  const fixtureSources: { path: string; source: string }[] = [];
  let manifestSource = "";
  let total = descriptorBytes.length;
  for (const path of providerPluginFiles(descriptor)) {
    if (path === "clawrouter.plugin.json") throw new Error("provider plugin payload cannot reference its descriptor");
    const bytes = readRegularFile(root, path, path === descriptor.manifest ? PROVIDER_PLUGIN_LIMITS.manifestBytes : PROVIDER_PLUGIN_LIMITS.resourceBytes);
    total += bytes.length;
    if (total > PROVIDER_PLUGIN_LIMITS.packageBytes) throw new Error("provider plugin package exceeds total byte limit");
    if (path === descriptor.manifest) manifestSource = bytes.toString("utf8");
    if (options.captureFixtures && descriptor.fixtures?.includes(path)) fixtureSources.push({ path, source: bytes.toString("utf8") });
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { descriptor, manifestSource, files, digest: hash(JSON.stringify(files)), ...(options.captureFixtures ? { fixtureSources } : {}) };
}

/** Explicit inputs only; ordering cannot select a winner for a duplicate provider. */
export function loadProviderPlugins(paths: readonly string[], options: ProviderPluginLoadOptions = {}): LoadedProviderPlugin[] {
  const loaded = paths.map(path => loadProviderPlugin(path, options)).sort((a, b) => a.descriptor.id < b.descriptor.id ? -1 : a.descriptor.id > b.descriptor.id ? 1 : 0);
  const ids = new Set<string>();
  for (const { descriptor } of loaded) {
    if (ids.has(descriptor.id)) throw new Error(`duplicate provider plugin id ${descriptor.id}`);
    ids.add(descriptor.id);
  }
  return loaded;
}
