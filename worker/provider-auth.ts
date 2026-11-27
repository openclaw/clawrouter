import { grantSupports, type GrantRequirement } from "./grant-compatibility.ts";
import { transportForGrant } from "../shared/provider-bindings.ts";
export { transportForGrant } from "../shared/provider-bindings.ts";
import { vertexAnthropicProjection } from "./vertex-anthropic-binding.ts";
import { miniMaxEnvironmentBinding } from "./native-media-credential.ts";
import { configuredEndpointPath } from "./endpoint-path.ts";
import { applyTemplateHeaders, resolveTemplate, PreparationAdmission, preparationValue, preparationHeader, preparationReplace } from "./provider-templates.ts";
import type { AuthScheme, CompiledGrantTransport, CompiledProvider, CompiledQuotaProbe, Env, GrantTransportAuth, ProxyRequestBody, UpstreamGrant } from "./types.ts";
import { envValue } from "./utils.ts";
import { HttpError } from "./http-error.ts";
import { assertXiaomiTokenPlanCredential } from "./xiaomi-plan-credentials.ts";
import { assertQwenCodingPlanCredential } from "./qwen-plan-credentials.ts";

// Catalogs inspect credential metadata; dispatch repeats these checks after the
// credential owner materializes the selected revision. Neither is a reservation.
export function assertOperationConfiguration(requirement: GrantRequirement, grant: UpstreamGrant | null, env: Env, owner?: PreparationAdmission): void {
  const { provider, endpoint } = requirement;
  if (!grantSupports(requirement, grant)) throw new HttpError(400, "grant_transport_unavailable", "upstream authorization does not support this operation");
  if (requirement.responsesLifecycle || requirement.managedLifecycle) {
    const lifecycle = requirement.managedLifecycle ? endpoint.lifecycle! : endpoint.responsesLifecycle!;
    for (const id of [lifecycle.retrieve, lifecycle.cancel, "result" in lifecycle ? lifecycle.result : undefined,
      ...(requirement.managedLifecycle ? [requirement.endpoint.lifecycle?.files?.metadata, requirement.endpoint.lifecycle?.files?.download] : [])].filter((id): id is string => typeof id === "string")) {
      assertOperationConfiguration({ provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === id)!, mode: "http" }, grant, env, owner);
    }
  }
  if (endpoint.request_format === "minimax.speech" && !grant && !miniMaxEnvironmentBinding(provider, env, "minimax.speech", owner))
    throw new HttpError(403, "native_media_authorization_required", "Global MiniMax speech requires explicit original credential authorization");
  if (endpoint.request_format === "minimax.music" && !grant && !miniMaxEnvironmentBinding(provider, env, "minimax.music", owner))
    throw new HttpError(403, "minimax_music_authorization_required", "Global MiniMax music requires explicit original credential authorization");
  assertProviderCredential(provider, grant, env, owner);
  const transport = transportForGrant(provider, grant);
  try {
    const headers = new Headers();
    applyTransportHeaders(headers, transport, grant, owner);
    applyTemplateHeaders(provider, provider.adapter.injectHeaders, env, headers, owner);
    applyTemplateHeaders(provider, endpoint.headers, env, headers, owner);
    const base = transport?.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env, owner, 4096);
    const path = preparationReplace(configuredEndpointPath(endpoint, transport?.endpointPaths[endpoint.id], base), /\$\{([^}]+)\}/g, name => endpoint.path_params.includes(name) ? "path-param" : `\${${name}}`, owner);
    const expandedPath = resolveTemplate(provider, path, env, owner); owner?.url(base, expandedPath);
    new URL(`${base.replace(/\/$/, "")}${expandedPath}`);
    for (const values of [provider.adapter.injectQuery, endpoint.query]) for (const name in values) {
      const value = resolveTemplate(provider, values[name], env, owner, 4096); owner?.query(name, value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

export function quotaProbeForGrant(provider: CompiledProvider, grant: UpstreamGrant | null): CompiledQuotaProbe | null {
  if (!grant?.kind) return null;
  return quotaProbesForGrant(provider, grant)[0] ?? null;
}

export function quotaProbesForGrant(provider: CompiledProvider, grant: UpstreamGrant): CompiledQuotaProbe[] {
  return provider.quota.probes.filter(probe => probe.grantKinds.includes(grant.kind!) && (!probe.requiresRefreshToken || !!grant.refreshToken));
}

export function applyProviderCredential(
  provider: CompiledProvider,
  grant: UpstreamGrant | null,
  env: Env,
  headers: Headers,
  query: URLSearchParams,
  owner?: PreparationAdmission,
): void {
  const scheme = providerCredentialScheme(provider, grant);
  const secret = providerSecret(provider, scheme, grant, env, owner);
  if (secret) assertXiaomiTokenPlanCredential(provider.id, secret);
  if (secret) assertQwenCodingPlanCredential(provider.id, secret);
  if (scheme.type === "bearer" && secret) preparationHeader(headers, scheme.header, preparationReplace(scheme.format, "${secret}", () => secret, owner, 8192), owner);
  else if (scheme.type === "api_key" && secret) preparationHeader(headers, scheme.header, secret, owner);
  else if (scheme.type === "query_api_key" && secret) { owner?.query(scheme.param, secret); query.set(scheme.param, secret); }
  else if (scheme.type === "sig_v4") { /* signed after the final URL and request body are known */ }
  else if (!secret && !(scheme.type === "bearer" && "required" in scheme && scheme.required === false)) throw new HttpError(503, "provider_not_configured", `provider ${provider.id} has no usable upstream credential`);
}

function assertProviderCredential(provider: CompiledProvider, grant: UpstreamGrant | null, env: Env, owner?: PreparationAdmission): void {
  const scheme = providerCredentialScheme(provider, grant);
  if (scheme.type === "sig_v4") {
    const present = (field: string, key: string) => grant
      ? !!grant.credentials?.[field] || (grant.credentialStore === "durable_object" && grant.credentialFields?.includes(field))
      : !!preparationValue(env, key, owner);
    if (!present("accessKeyId", "AWS_ACCESS_KEY_ID") || !present("secretAccessKey", "AWS_SECRET_ACCESS_KEY") || !preparationValue(env, "AWS_REGION", owner))
      throw new HttpError(503, "provider_not_configured", "AWS access key, secret key, and region are required");
    return;
  }
  const available = grant?.credentialStore === "durable_object"
    ? grant.credentialStatus !== "reauth_required" && (grant.hasCredential || grant.hasAccessToken || vertexAnthropicProjection(grant)?.source === "service_account")
    : !!providerSecret(provider, scheme, grant, env, owner);
  if (!available && !(scheme.type === "bearer" && "required" in scheme && scheme.required === false))
    throw new HttpError(503, "provider_not_configured", `provider ${provider.id} has no usable upstream credential`);
}

export function providerCredentialScheme(provider: CompiledProvider, grant: UpstreamGrant | null): AuthScheme | GrantTransportAuth {
  return transportForGrant(provider, grant)?.auth ?? provider.auth.schemes.find((candidate) => candidate.type !== "oauth") ?? provider.auth.schemes[0];
}

export function resolvedTransportHeaders(transport: CompiledGrantTransport | null, grant: UpstreamGrant | null): Record<string, string> {
  if (!transport || !grant) return {};
  return Object.fromEntries(Object.entries(transport.headers).map(([name, value]) => [name, requiredGrantTemplate(value, grant)]));
}

export function applyTransportHeaders(headers: Headers, transport: CompiledGrantTransport | null, grant: UpstreamGrant | null, owner?: PreparationAdmission): void {
  if (!transport || !grant) return;
  for (const name in transport.headers) preparationHeader(headers, name, requiredGrantTemplate(transport.headers[name], grant, undefined, owner), owner);
  for (const [name, template] of Object.entries(transport.appendHeaders)) {
    const appended = requiredGrantTemplate(template, grant, undefined, owner);
    owner?.mergeHeader(headers, name, appended);
    const values = [...(headers.get(name)?.split(",") ?? []), ...appended.split(",")].map((value) => value.trim()).filter(Boolean);
    headers.set(name, [...new Set(values)].join(","));
  }
}

export function transformTransportBody(transport: CompiledGrantTransport | null, body: ProxyRequestBody): ProxyRequestBody {
  const prepend = transport?.requestTransforms.prependSystem ?? [];
  if (!prepend.length) return body;
  if (Array.isArray(body)) throw new HttpError(400, "provider_request_invalid", "system instruction transforms require a JSON object body");
  const existing = Array.isArray(body.system)
    ? body.system
    : typeof body.system === "string" && body.system ? [{ type: "text", text: body.system }] : [];
  const existingText = new Set(existing.flatMap((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []));
  const trusted = prepend.filter((block) => !existingText.has(block.text));
  return trusted.length ? { ...body, system: [...trusted, ...existing] } : body;
}

export function requiredGrantTemplate(value: string, grant: UpstreamGrant, errorCode = "grant_transport_unavailable", owner?: PreparationAdmission): string {
  return preparationReplace(value, /\$\{grant\.([^}]+)\}/g, (name: string) => {
    const resolved = grant[name as keyof UpstreamGrant];
    owner?.primitive(name, resolved);
    if (typeof resolved !== "string" || !resolved.trim()) throw new HttpError(400, errorCode, `grant transport requires ${name}`);
    return resolved;
  }, owner, 8192);
}

// Canonical product bindings do not make arbitrary *_KEY names credentials.
function falKeyScheme(scheme: AuthScheme | GrantTransportAuth): boolean {
  return scheme.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Key ${secret}" && "secretKind" in scheme && scheme.secretKind === "api_key";
}

const abliterationSecretKeys = ["ABLIT_KEY", "ABLITERATION_API_KEY"];
function abliterationSecretBinding(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth): boolean {
  return provider.id === "abliteration" && provider.base_urls.default === "https://api.abliteration.ai/v1"
    && scheme.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Bearer ${secret}" && "secretKind" in scheme && scheme.secretKind === "api_key";
}

// These two server names are alternatives for one qualified product credential.
// Canonical precedence is independent of config-key order; grants bypass both.
function abliterationAliases(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth): boolean {
  return abliterationSecretBinding(provider, scheme) && provider.config_keys.some(key => abliterationSecretKeys.includes(key));
}

export function providerConfigPresent(provider: CompiledProvider, key: string, env: Env): boolean {
  const scheme = providerCredentialScheme(provider, null);
  return abliterationSecretKeys.includes(key) && abliterationAliases(provider, scheme)
    ? !!providerSecret(provider, scheme, null, env) : !!envValue(env, key);
}

function canonicalSecretKey(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth, key: string): boolean {
  return key === "ABLIT_KEY" && abliterationSecretBinding(provider, scheme)
    || provider.id === "fal" && key === "FAL_KEY" && falKeyScheme(scheme)
    || provider.id === "runway" && key === "RUNWAYML_API_SECRET" && scheme.type === "bearer"
      && scheme.header.toLowerCase() === "authorization" && scheme.format === "Bearer ${secret}"
      && "secretKind" in scheme && scheme.secretKind === "api_key";
}

export function providerSecretConfigKey(provider: CompiledProvider, key: string): boolean {
  return /_(?:API_KEY|API_TOKEN|TOKEN)$/.test(key)
    || provider.auth.schemes.some(scheme => canonicalSecretKey(provider, scheme, key));
}

function providerSecret(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth, grant: UpstreamGrant | null, env: Env, owner?: PreparationAdmission): string | null {
  let secret: string | null;
  if (grant) {
    secret = (grant.kind === "oauth" || grant.kind === "subscription") && grant.accessToken
      ? grant.accessToken : grant.credential ?? grant.accessToken ?? firstCredential(grant.credentials) ?? null;
  } else {
    const kind = "secretKind" in scheme ? scheme.secretKind : "";
    const candidates = abliterationAliases(provider, scheme) ? abliterationSecretKeys : provider.config_keys.filter((key) => kind === "api_token"
      ? key.endsWith("_TOKEN") || key.endsWith("_API_TOKEN")
      : key.endsWith("_API_KEY") || key.endsWith("_API_TOKEN") || canonicalSecretKey(provider, scheme, key));
    secret = null;
    // Retain candidate order, including admission of each selected declared key.
    for (const key of candidates) { const value = preparationValue(env, key, owner); if (!secret && value) secret = value; }
  }
  if (grant) owner?.primitive("credential", secret);
  // Reject before Headers can include the malformed value in an exception.
  // The selected grant never falls back to an environment credential.
  if ((canonicalSecretKey(provider, scheme, "FAL_KEY") || canonicalSecretKey(provider, scheme, "RUNWAYML_API_SECRET") || abliterationSecretBinding(provider, scheme))
    && secret && /[^\x21-\x7e]/.test(secret)) return null;
  return secret;
}

function firstCredential(values: Record<string, string> | undefined): string | null {
  if (values) for (const name in values) if (Object.hasOwn(values, name) && values[name]) return values[name];
  return null;
}
