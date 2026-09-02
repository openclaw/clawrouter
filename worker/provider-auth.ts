import type { AuthScheme, CompiledGrantTransport, CompiledProvider, Env, GrantTransportAuth, UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

type ExecutableAuth = Exclude<AuthScheme, { type: "oauth" | "sig_v4" | "cloudflare_binding" }> | GrantTransportAuth;

export function transportForGrant(provider: CompiledProvider, grant: UpstreamGrant | null): CompiledGrantTransport | null {
  if (!grant?.kind) return null;
  return provider.auth.grantTransports[grant.kind] ?? null;
}

export function applyProviderCredential(
  provider: CompiledProvider,
  grant: UpstreamGrant | null,
  env: Env,
  headers: Headers,
  query: URLSearchParams,
): void {
  const transport = transportForGrant(provider, grant);
  const scheme = transport?.auth ?? provider.auth.schemes.find((candidate) => candidate.type !== "oauth") ?? provider.auth.schemes[0];
  const secret = providerSecret(provider, scheme, grant, env);
  if (scheme.type === "bearer" && secret) headers.set(scheme.header, scheme.format.replace("${secret}", secret));
  else if (scheme.type === "api_key" && secret) headers.set(scheme.header, secret);
  else if (scheme.type === "query_api_key" && secret) query.set(scheme.param, secret);
  else if (scheme.type === "sig_v4") { /* signed after the final URL and request body are known */ }
  else if (!secret && !(scheme.type === "bearer" && "required" in scheme && scheme.required === false)) throw new HttpError(503, "provider_not_configured", `provider ${provider.id} has no usable upstream credential`);
}

export function resolvedTransportHeaders(transport: CompiledGrantTransport | null, grant: UpstreamGrant | null): Record<string, string> {
  if (!transport || !grant) return {};
  return Object.fromEntries(Object.entries(transport.headers).map(([name, value]) => [name, requiredGrantTemplate(value, grant)]));
}

export function applyTransportHeaders(headers: Headers, transport: CompiledGrantTransport | null, grant: UpstreamGrant | null): void {
  if (!transport || !grant) return;
  for (const [name, value] of Object.entries(resolvedTransportHeaders(transport, grant))) headers.set(name, value);
  for (const [name, template] of Object.entries(transport.appendHeaders)) {
    const appended = requiredGrantTemplate(template, grant);
    const values = [...(headers.get(name)?.split(",") ?? []), ...appended.split(",")].map((value) => value.trim()).filter(Boolean);
    headers.set(name, [...new Set(values)].join(","));
  }
}

export function transformTransportBody(transport: CompiledGrantTransport | null, body: Record<string, unknown>): Record<string, unknown> {
  const prepend = transport?.requestTransforms.prependSystem ?? [];
  if (!prepend.length) return body;
  const existing = Array.isArray(body.system)
    ? body.system
    : typeof body.system === "string" && body.system ? [{ type: "text", text: body.system }] : [];
  const existingText = new Set(existing.flatMap((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []));
  const trusted = prepend.filter((block) => !existingText.has(block.text));
  return trusted.length ? { ...body, system: [...trusted, ...existing] } : body;
}

export function requiredGrantTemplate(value: string, grant: UpstreamGrant, errorCode = "grant_transport_unavailable"): string {
  return value.replace(/\$\{grant\.([^}]+)\}/g, (_, name: string) => {
    const resolved = grant[name as keyof UpstreamGrant];
    if (typeof resolved !== "string" || !resolved.trim()) throw new HttpError(400, errorCode, `grant transport requires ${name}`);
    return resolved;
  });
}

function providerSecret(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth, grant: UpstreamGrant | null, env: Env): string | null {
  if (grant) {
    if ((grant.kind === "oauth" || grant.kind === "subscription") && grant.accessToken) return grant.accessToken;
    return grant.credential ?? grant.accessToken ?? firstCredential(grant.credentials) ?? null;
  }
  const kind = "secretKind" in scheme ? scheme.secretKind : "";
  const candidates = provider.config_keys.filter((key) => kind === "api_token" ? key.endsWith("_TOKEN") || key.endsWith("_API_TOKEN") : key.endsWith("_API_KEY") || key.endsWith("_API_TOKEN"));
  return candidates.map((key) => envValue(env, key)).find(Boolean) ?? null;
}

function firstCredential(values: Record<string, string> | undefined): string | null {
  return values ? Object.values(values).find(Boolean) ?? null : null;
}

function envValue(env: Env, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value : null;
}
