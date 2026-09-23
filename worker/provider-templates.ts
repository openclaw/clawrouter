import type { CompiledProvider, Env } from "./types.ts";
import { HttpError } from "./utils.ts";

export function optionalConfigKeys(provider: CompiledProvider, env: Env): Set<string> {
  return new Set([...provider.optional_config_keys, ...(envValue(env, "CLAWROUTER_OPTIONAL_CONFIG_KEYS") ?? "").split(",").map((key) => key.trim()).filter(Boolean)]);
}

export function templateCandidates(provider: CompiledProvider, name: string): string[] {
  const normalized = name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return provider.config_keys.filter((key) => key === normalized || key.endsWith(`_${normalized}`));
}

export function resolveTemplate(provider: CompiledProvider, value: string, env: Env): string {
  return renderTemplate(provider, value, env)!;
}

export function resolveHeaderTemplate(provider: CompiledProvider, value: string, env: Env): string | null {
  return renderTemplate(provider, value, env, optionalConfigKeys(provider, env));
}

export function applyTemplateHeaders(provider: CompiledProvider, values: Record<string, string>, env: Env, headers: Headers): void {
  for (const [name, value] of Object.entries(values)) {
    const resolved = resolveHeaderTemplate(provider, value, env);
    if (resolved !== null) headers.set(name, resolved);
  }
}

function renderTemplate(provider: CompiledProvider, value: string, env: Env, optional?: ReadonlySet<string>): string | null {
  let omit = false;
  const resolved = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const candidates = templateCandidates(provider, name);
    const key = candidates.find((candidate) => envValue(env, candidate));
    if (key) return envValue(env, key)!;
    if (candidates.length && candidates.every((candidate) => optional?.has(candidate))) {
      omit = true;
      return "";
    }
    throw new HttpError(503, "provider_not_configured", `missing Cloudflare config value ${name} for provider ${provider.id}`);
  });
  // Resolve every binding before omitting a header: an optional field must not
  // hide a missing required field in the same template.
  return omit ? null : resolved;
}

function envValue(env: Env, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value : null;
}
