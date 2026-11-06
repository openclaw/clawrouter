import { miniMaxSearchProjection, miniMaxSearchRequirement } from "./minimax-search-credential.ts";
import { miniMaxVideoProjection, miniMaxVideoRequirement } from "./minimax-video-credential.ts";
import { miniMaxImageProjection, miniMaxImageRequirement } from "./minimax-image-credential.ts";
import { vertexAnthropicProjection } from "./vertex-anthropic-binding.ts";
import { isQualifiedVertexModelLocation } from "./vertex-model-eligibility.ts";
import { miniMaxAnthropicProjection } from "./minimax-anthropic-binding.ts";
import { miniMaxEnvironmentBinding, miniMaxMediaProjection, miniMaxMusicRequirement } from "./native-media-credential.ts";
import { isModelDiscovery } from "./model-discovery.ts";
import { publicCatalogProvider } from "./public-model-discovery-formats.ts";
import { configuredEndpointPath } from "./endpoint-path.ts";
import { applyTemplateHeaders, resolveTemplate } from "./provider-templates.ts";
import type { AuthScheme, CompiledEndpoint, CompiledGrantTransport, CompiledProvider, CompiledQuotaProbe, Env, GrantTransportAuth, ProxyRequestBody, UpstreamGrant } from "./types.ts";
import { envValue, HttpError } from "./utils.ts";

export function transportForGrant(provider: CompiledProvider, grant: UpstreamGrant | null): CompiledGrantTransport | null {
  if (!grant?.kind) return null;
  return provider.auth.grantTransports[grant.kind] ?? null;
}

export interface GrantRequirement { provider: CompiledProvider; endpoint: CompiledEndpoint; mode: "http" | "websocket"; model?: string | null; responsesLifecycle?: boolean; managedLifecycle?: boolean }

// This one opaque PCM profile is qualified only for an original owned API key.
export function openRouterPcmModel(provider: CompiledProvider, modelId?: string | null): boolean {
  return provider.id === "openrouter"
    && (provider.models.find(model => model.id === modelId)?.upstream ?? modelId) === "google/gemini-3.1-flash-tts-preview";
}
export function openRouterPcmRequirement(requirement: Pick<GrantRequirement, "provider" | "endpoint" | "model">): boolean {
  return requirement.endpoint.request_format === "openai.audio_speech" && openRouterPcmModel(requirement.provider, requirement.model);
}

export function grantSupports(requirement: GrantRequirement, grant: UpstreamGrant | null): boolean {
  if (requirement.endpoint.lifecycle?.protocol === "minimax.video" && (!miniMaxVideoRequirement(requirement)
    || !miniMaxVideoProjection(grant) || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.request_format === "minimax.search" && (!miniMaxSearchRequirement(requirement)
    || !miniMaxSearchProjection(grant) || grant?.minimaxSearchBinding?.origin !== requirement.provider.base_urls.default)) return false;
  if (requirement.endpoint.request_format === "minimax.music" && (!miniMaxMusicRequirement(requirement)
    || grant && (!miniMaxMediaProjection(grant, "minimax.music") || !Number.isSafeInteger(grant.credentialGeneration)
      || !grant.credentialLineage || transportForGrant(requirement.provider, grant) !== null))) return false;
  if (requirement.endpoint.request_format === "minimax.images" && (!miniMaxImageRequirement(requirement)
    || !miniMaxImageProjection(grant) || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.provider.id === "anthropic-vertex") {
    const binding = vertexAnthropicProjection(grant);
    const models = requirement.provider.models.filter(model => model.id === requirement.model || model.upstream === requirement.model);
    if (!binding || models.length !== 1 || !isQualifiedVertexModelLocation(models[0].upstream, binding.location)
      || requirement.mode !== "http" || requirement.endpoint.request_format !== "anthropic.messages"
      || requirement.endpoint.response_format !== "anthropic.messages" || requirement.endpoint.method !== "POST"
      || requirement.endpoint.path !== "/v1/messages" || requirement.endpoint.upstreamPath !== undefined || requirement.endpoint.auth
      || requirement.endpoint.websocket || requirement.endpoint.lifecycle || requirement.endpoint.responsesLifecycle
      || requirement.endpoint.modelPassthrough || requirement.endpoint.path_params.length || Object.keys(requirement.endpoint.query).length
      || transportForGrant(requirement.provider, grant) !== null
      || binding.source !== "service_account" && Date.parse(grant?.expiresAt ?? "") <= Date.now() + 60_000) return false;
  }
  if (requirement.provider.id === "minimax") {
    const native = requirement.endpoint.request_format === "anthropic.messages";
    if (native && (requirement.mode !== "http" || requirement.endpoint.response_format !== "anthropic.messages"
      || requirement.endpoint.method !== "POST" || requirement.endpoint.path !== "/anthropic/v1/messages"
      || requirement.endpoint.upstreamPath !== undefined || requirement.endpoint.auth || requirement.endpoint.websocket
      || requirement.endpoint.lifecycle || requirement.endpoint.responsesLifecycle || requirement.endpoint.modelPassthrough
      || requirement.endpoint.path_params.length || Object.keys(requirement.endpoint.query).length
      || transportForGrant(requirement.provider, grant) !== null || !miniMaxAnthropicProjection(grant))) return false;
    if (!native && (grant?.kind === "oauth" || grant?.minimaxAnthropicBinding?.region === "cn")) return false;
  }
  if (openRouterPcmRequirement(requirement) && (requirement.mode !== "http" || !grant || grant.kind !== "api_key"
    || grant.provider !== "openrouter" || grant.credentialStore !== "durable_object" || !grant.credentialLineage
    || !Number.isSafeInteger(grant.credentialGeneration) || !(grant.credential || grant.hasCredential && !grant.credentialFields?.length)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  const publicProvider = publicCatalogProvider(requirement.endpoint.request_format);
  if (publicProvider && (requirement.provider.id !== publicProvider || requirement.mode !== "http"
    || requirement.endpoint.response_format !== requirement.endpoint.request_format || !grant || grant.kind !== "api_key"
    || grant.credentialStore !== "durable_object" || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.request_format === "featherless.catalog" && (requirement.provider.id !== "featherless"
    || requirement.endpoint.response_format !== "featherless.catalog" || requirement.mode !== "http"
    || !grant || grant.kind !== "api_key" || grant.credentialStore !== "durable_object"
    || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.inputProfile !== undefined && (requirement.endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1"
    || requirement.provider.id !== "pixverse" || requirement.mode !== "http" || !grant || grant.kind !== "api_key"
    || grant.credentialStore !== "durable_object" || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration))) return false;
  if (requirement.endpoint.request_format === "minimax.speech" && grant && !miniMaxMediaProjection(grant)) return false;
  if (isModelDiscovery(requirement.endpoint) && grant?.kind !== "api_key") return false;
  if (requirement.endpoint.websocket === "openai.realtime" && requirement.mode !== "websocket") return false;
  if (requirement.endpoint.request_format === "openai.standalone_search" && grant && grant.kind !== "api_key") return false;
  if (requirement.endpoint.request_format === "openai.moderations" && grant && grant.kind !== "api_key") return false;
  if (requirement.endpoint.request_format === "openai.responses_input_tokens" && grant && grant.kind !== "api_key") return false;
  const transport = transportForGrant(requirement.provider, grant);
  if (transport?.allowedEndpoints && !transport.allowedEndpoints.includes(requirement.endpoint.id)) return false;
  if (requirement.responsesLifecycle || requirement.managedLifecycle) {
    const lifecycle = requirement.managedLifecycle ? requirement.endpoint.lifecycle : requirement.endpoint.responsesLifecycle;
    if (requirement.mode !== "http" || !lifecycle || ![lifecycle.retrieve, lifecycle.cancel, "result" in lifecycle ? lifecycle.result : undefined,
      ...(requirement.managedLifecycle ? [requirement.endpoint.lifecycle?.files?.metadata, requirement.endpoint.lifecycle?.files?.download] : [])].filter((id): id is string => typeof id === "string").every(id =>
      requirement.provider.endpoints.some(endpoint => endpoint.id === id) && (!transport?.allowedEndpoints || transport.allowedEndpoints.includes(id)))) return false;
  }
  return requirement.mode === "http" || (["openai.responses", "openai.realtime"].includes(requirement.endpoint.websocket ?? "") && transport === null && (requirement.endpoint.websocket !== "openai.realtime" || !grant || grant.kind === "api_key"));
}

// Catalogs inspect credential metadata; dispatch repeats these checks after the
// credential owner materializes the selected revision. Neither is a reservation.
export function assertOperationConfiguration(requirement: GrantRequirement, grant: UpstreamGrant | null, env: Env): void {
  const { provider, endpoint } = requirement;
  if (!grantSupports(requirement, grant)) throw new HttpError(400, "grant_transport_unavailable", "upstream authorization does not support this operation");
  if (requirement.responsesLifecycle || requirement.managedLifecycle) {
    const lifecycle = requirement.managedLifecycle ? endpoint.lifecycle! : endpoint.responsesLifecycle!;
    for (const id of [lifecycle.retrieve, lifecycle.cancel, "result" in lifecycle ? lifecycle.result : undefined,
      ...(requirement.managedLifecycle ? [requirement.endpoint.lifecycle?.files?.metadata, requirement.endpoint.lifecycle?.files?.download] : [])].filter((id): id is string => typeof id === "string")) {
      assertOperationConfiguration({ provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === id)!, mode: "http" }, grant, env);
    }
  }
  if (endpoint.request_format === "minimax.speech" && !grant && !miniMaxEnvironmentBinding(provider, env))
    throw new HttpError(403, "native_media_authorization_required", "Global MiniMax speech requires explicit original credential authorization");
  if (endpoint.request_format === "minimax.music" && !grant && !miniMaxEnvironmentBinding(provider, env, "minimax.music"))
    throw new HttpError(403, "minimax_music_authorization_required", "Global MiniMax music requires explicit original credential authorization");
  assertProviderCredential(provider, grant, env);
  const transport = transportForGrant(provider, grant);
  try {
    const headers = new Headers();
    applyTransportHeaders(headers, transport, grant);
    applyTemplateHeaders(provider, provider.adapter.injectHeaders, env, headers);
    applyTemplateHeaders(provider, endpoint.headers, env, headers);
    const base = transport?.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env);
    const path = configuredEndpointPath(endpoint, transport?.endpointPaths[endpoint.id], base).replace(/\$\{([^}]+)\}/g, (template, name: string) => endpoint.path_params.includes(name) ? "path-param" : template);
    new URL(`${base.replace(/\/$/, "")}${resolveTemplate(provider, path, env)}`);
    for (const value of [...Object.values(provider.adapter.injectQuery), ...Object.values(endpoint.query)]) resolveTemplate(provider, value, env);
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
): void {
  const scheme = providerCredentialScheme(provider, grant);
  const secret = providerSecret(provider, scheme, grant, env);
  if (scheme.type === "bearer" && secret) headers.set(scheme.header, scheme.format.replace("${secret}", secret));
  else if (scheme.type === "api_key" && secret) headers.set(scheme.header, secret);
  else if (scheme.type === "query_api_key" && secret) query.set(scheme.param, secret);
  else if (scheme.type === "sig_v4") { /* signed after the final URL and request body are known */ }
  else if (!secret && !(scheme.type === "bearer" && "required" in scheme && scheme.required === false)) throw new HttpError(503, "provider_not_configured", `provider ${provider.id} has no usable upstream credential`);
}

function assertProviderCredential(provider: CompiledProvider, grant: UpstreamGrant | null, env: Env): void {
  const scheme = providerCredentialScheme(provider, grant);
  if (scheme.type === "sig_v4") {
    const present = (field: string, key: string) => grant
      ? !!grant.credentials?.[field] || (grant.credentialStore === "durable_object" && grant.credentialFields?.includes(field))
      : !!envValue(env, key);
    if (!present("accessKeyId", "AWS_ACCESS_KEY_ID") || !present("secretAccessKey", "AWS_SECRET_ACCESS_KEY") || !envValue(env, "AWS_REGION"))
      throw new HttpError(503, "provider_not_configured", "AWS access key, secret key, and region are required");
    return;
  }
  const available = grant?.credentialStore === "durable_object"
    ? grant.credentialStatus !== "reauth_required" && (grant.hasCredential || grant.hasAccessToken || vertexAnthropicProjection(grant)?.source === "service_account")
    : !!providerSecret(provider, scheme, grant, env);
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

export function applyTransportHeaders(headers: Headers, transport: CompiledGrantTransport | null, grant: UpstreamGrant | null): void {
  if (!transport || !grant) return;
  for (const [name, value] of Object.entries(resolvedTransportHeaders(transport, grant))) headers.set(name, value);
  for (const [name, template] of Object.entries(transport.appendHeaders)) {
    const appended = requiredGrantTemplate(template, grant);
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

export function requiredGrantTemplate(value: string, grant: UpstreamGrant, errorCode = "grant_transport_unavailable"): string {
  return value.replace(/\$\{grant\.([^}]+)\}/g, (_, name: string) => {
    const resolved = grant[name as keyof UpstreamGrant];
    if (typeof resolved !== "string" || !resolved.trim()) throw new HttpError(400, errorCode, `grant transport requires ${name}`);
    return resolved;
  });
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

function providerSecret(provider: CompiledProvider, scheme: AuthScheme | GrantTransportAuth, grant: UpstreamGrant | null, env: Env): string | null {
  let secret: string | null;
  if (grant) {
    secret = (grant.kind === "oauth" || grant.kind === "subscription") && grant.accessToken
      ? grant.accessToken : grant.credential ?? grant.accessToken ?? firstCredential(grant.credentials) ?? null;
  } else {
    const kind = "secretKind" in scheme ? scheme.secretKind : "";
    const candidates = abliterationAliases(provider, scheme) ? abliterationSecretKeys : provider.config_keys.filter((key) => kind === "api_token"
      ? key.endsWith("_TOKEN") || key.endsWith("_API_TOKEN")
      : key.endsWith("_API_KEY") || key.endsWith("_API_TOKEN") || canonicalSecretKey(provider, scheme, key));
    secret = candidates.map((key) => envValue(env, key)).find(Boolean) ?? null;
  }
  // Reject before Headers can include the malformed value in an exception.
  // The selected grant never falls back to an environment credential.
  if ((canonicalSecretKey(provider, scheme, "FAL_KEY") || canonicalSecretKey(provider, scheme, "RUNWAYML_API_SECRET") || abliterationSecretBinding(provider, scheme))
    && secret && /[^\x21-\x7e]/.test(secret)) return null;
  return secret;
}

function firstCredential(values: Record<string, string> | undefined): string | null {
  return values ? Object.values(values).find(Boolean) ?? null : null;
}
