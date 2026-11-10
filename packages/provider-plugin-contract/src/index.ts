/** Packaging metadata only. Execution remains governed by the provider manifest. */
export { PROVIDER_CONFORMANCE_SCHEMA, ProviderConformanceContractError, parseProviderConformanceScenario } from "./conformance.ts";
export type { ProviderConformanceScenario, ProviderFixtureJson, ProviderFixtureRequest, ProviderFixtureResponse } from "./conformance.ts";
export type { ProviderPackageIndex, ProviderPackageResource } from "./package-index.ts";
export type { ProviderAuthenticationMethod, ProviderCommercialModel, ProviderProductSummary } from "./product-metadata.ts";
export const PROVIDER_PLUGIN_SCHEMA = "clawrouter.provider-plugin.v1";
export const PROVIDER_MANIFEST_SCHEMA = "clawrouter.service-provider.v1";

export interface ProviderPluginDescriptor {
  schema: typeof PROVIDER_PLUGIN_SCHEMA;
  id: string;
  version: string;
  manifest: string;
  documentation: string;
  license: string;
  assets?: { logo: { light: string; dark?: string } };
  fixtures?: string[];
}

export class ProviderPluginContractError extends Error {
  readonly pointer: string;
  constructor(pointer: string, message: string) {
    super(`provider plugin ${pointer || "/"}: ${message}`);
    this.name = "ProviderPluginContractError";
    this.pointer = pointer;
  }
}

function fail(pointer: string, message: string): never {
  throw new ProviderPluginContractError(pointer, message);
}

function record(value: unknown, pointer: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(pointer, "expected an object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) fail(`${pointer}/${key}`, "unknown field");
  }
  return result;
}

function string(value: unknown, pointer: string): string {
  if (typeof value !== "string" || !value || value.length > 256) fail(pointer, "expected a nonempty string of at most 256 characters");
  return value;
}

/** Portable package-relative file reference, not a URL or a filesystem boundary check. */
export function providerPluginPath(value: unknown, pointer = "/path"): string {
  const path = string(value, pointer);
  if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    fail(pointer, "expected a portable relative file path without traversal");
  }
  return path;
}

export function parseProviderPluginDescriptor(value: unknown): ProviderPluginDescriptor {
  const input = record(value, "", ["schema", "id", "version", "manifest", "documentation", "license", "assets", "fixtures"]);
  if (input.schema !== PROVIDER_PLUGIN_SCHEMA) fail("/schema", `expected ${PROVIDER_PLUGIN_SCHEMA}`);
  const id = string(input.id, "/id");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) fail("/id", "expected a lowercase provider identifier of at most 64 characters");
  const version = string(input.version, "/version");
  // Stable package versions only in v1; ranges and prerelease selection need a separate resolver.
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) fail("/version", "expected an exact stable major.minor.patch version");
  const manifest = providerPluginPath(input.manifest, "/manifest");
  if (!manifest.endsWith(".provider.yaml")) fail("/manifest", "expected a .provider.yaml file");
  const documentation = providerPluginPath(input.documentation, "/documentation");
  if (!documentation.endsWith(".md")) fail("/documentation", "expected a Markdown file");
  const result: ProviderPluginDescriptor = {
    schema: PROVIDER_PLUGIN_SCHEMA, id, version, manifest, documentation,
    license: providerPluginPath(input.license, "/license"),
  };
  if (input.assets !== undefined) {
    const assets = record(input.assets, "/assets", ["logo"]);
    const logo = record(assets.logo, "/assets/logo", ["light", "dark"]);
    const image = (value: unknown, pointer: string) => {
      const path = providerPluginPath(value, pointer);
      if (!/\.(svg|png|webp)$/.test(path)) fail(pointer, "expected an SVG, PNG, or WebP asset");
      return path;
    };
    result.assets = { logo: { light: image(logo.light, "/assets/logo/light") } };
    if (logo.dark !== undefined) result.assets.logo.dark = image(logo.dark, "/assets/logo/dark");
  }
  if (input.fixtures !== undefined) {
    if (!Array.isArray(input.fixtures) || input.fixtures.length > 128) fail("/fixtures", "expected at most 128 fixture files");
    result.fixtures = input.fixtures.map((entry, index) => {
      const path = providerPluginPath(entry, `/fixtures/${index}`);
      if (!path.endsWith(".json")) fail(`/fixtures/${index}`, "expected a JSON fixture");
      return path;
    });
    if (new Set(result.fixtures).size !== result.fixtures.length) fail("/fixtures", "duplicate fixture paths");
  }
  return result;
}

/** Explicit inventory for packagers/loaders. Never discover or execute package scripts. */
export function providerPluginFiles(descriptor: ProviderPluginDescriptor): string[] {
  return [...new Set([
    descriptor.manifest, descriptor.documentation, descriptor.license,
    ...(descriptor.assets ? [descriptor.assets.logo.light, ...(descriptor.assets.logo.dark ? [descriptor.assets.logo.dark] : [])] : []),
    ...(descriptor.fixtures ?? []),
  ])].sort();
}
