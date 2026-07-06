import snapshotJson from "./generated/provider-snapshot.json";
import { listConnections, resolveConnection } from "./authority";
import { grantUsable as canonicalGrantUsable } from "./grant-selection";
import { grantsVisibleToPolicies, type GrantRecord } from "./grant-scope";
import type {
  AccessPolicyEntry, AuthorizedIdentity, CompiledEndpoint, CompiledModel, CompiledProvider, Env,
  ProviderConnection, ProviderHealth, ProviderSnapshot, UpstreamGrant,
} from "./types";
import { HttpError } from "./utils";

export const snapshot = snapshotJson as unknown as ProviderSnapshot;

export interface Readiness {
  id: string;
  displayName: string;
  class: string;
  serviceKind: string;
  requiredConfig: string[];
  optionalConfig: string[];
  missingConfig: string[];
  configPresent: boolean;
  connectionEnabled: boolean;
  oauthGrantRequired: boolean;
  oauthGrantCount: number;
  upstreamGrantCount: number;
  openaiCompatible: boolean;
  manifestRoutes: number;
  executableEndpoints: string[];
  modelCount: number;
  executable: boolean;
  verified: boolean;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  status: string;
  reasons: string[];
}

export interface UpstreamAuth {
  grant: UpstreamGrant | null;
  baseUrl: string;
  headers: Headers;
  query: URLSearchParams;
  transportPaths: Record<string, string>;
}

export function providerById(id: string): CompiledProvider | undefined {
  return snapshot.providers.find((provider) => provider.id === id);
}

export function modelRoute(model: string): { provider: CompiledProvider; model: CompiledModel } | null {
  const exact = snapshot.model_index[model as keyof typeof snapshot.model_index];
  if (exact) {
    const provider = providerById(exact.provider);
    const entry = provider?.models.find((candidate) => candidate.id === model);
    return provider && entry ? { provider, model: entry } : null;
  }
  for (const provider of snapshot.providers) {
    const prefix = provider.routing.modelPrefixes.find((candidate) => model.startsWith(candidate));
    if (!prefix) continue;
    const upstream = model.slice(prefix.length);
    if (!upstream) continue;
    const template = provider.models[0];
    return {
      provider,
      model: {
        id: model,
        upstream,
        capabilities: template?.capabilities ?? provider.capabilities.map((item) => item.id),
        pricing_ref: null,
        pricing: null,
      },
    };
  }
  return null;
}

export function endpointForPath(provider: CompiledProvider, path: string): CompiledEndpoint | undefined {
  const capability = capabilityForPath(path);
  const endpointId = provider.capabilities.find((item) => item.id === capability)?.endpoint;
  return endpointId ? provider.endpoints.find((endpoint) => endpoint.id === endpointId) : undefined;
}

export function capabilityForPath(path: string): string | null {
  return path === "/v1/chat/completions" ? "llm.chat" : path === "/v1/responses" ? "llm.responses" : path === "/v1/embeddings" ? "llm.embeddings" : null;
}

export function routeCatalog() {
  const openaiCompatible = snapshot.providers.filter((provider) => provider.class === "openai_compatible").map((provider) => ({
    provider: provider.id,
    models: provider.models.map((model) => ({
      id: model.id,
      capabilities: model.capabilities,
      endpoints: model.capabilities.map(unifiedPathForCapability).filter(Boolean),
    })),
    modelPrefixes: provider.routing.modelPrefixes,
    endpoints: provider.capabilities.map((capability) => unifiedPathForCapability(capability.id)).filter(Boolean),
  }));
  const manifestProxy = snapshot.providers.flatMap((provider) => provider.endpoints.map((endpoint) => ({
    provider: provider.id,
    endpoint: endpoint.id,
    route: `/v1/proxy/${provider.id}/${endpoint.id}`,
    methods: endpoint.methods,
    pathParams: endpoint.path_params,
    requestFormat: endpoint.request_format,
    responseFormat: endpoint.response_format,
    sampleModel: provider.models.find((model) => model.capabilities.some((capability) => provider.capabilities.find((item) => item.id === capability)?.endpoint === endpoint.id))?.id ?? null,
    models: provider.models.map((model) => ({ id: model.id, capabilities: model.capabilities })),
    streaming: endpoint.streaming != null,
  })));
  return { openaiCompatible, manifestProxy };
}

export async function providerReadiness(env: Env): Promise<Readiness[]> {
  const { grants, health, connections } = await readinessInputs(env);
  return providerReadinessFromState(env, grants, [...connections.values()], health);
}

export async function providerReadinessForPolicies(env: Env, policies: AccessPolicyEntry[]): Promise<Readiness[]> {
  const { grants, health, connections } = await readinessInputs(env);
  const visibleGrants = grantsVisibleToPolicies(grants, policies);
  return providerReadinessFromState(env, visibleGrants, [...connections.values()], health);
}

export function providerReadinessFromState(env: Env, grants: GrantRecord[], storedConnections: ProviderConnection[], health: Map<string, ProviderHealth>): Readiness[] {
  const connections = new Map(storedConnections.map((connection) => [connection.providerId, connection]));
  return snapshot.providers.map((provider) => readinessFor(provider, env, grants, connections.get(provider.id) ?? { providerId: provider.id, enabled: true }, health.get(provider.id)));
}

async function readinessInputs(env: Env) {
  const [grants, health, storedConnections] = await Promise.all([listGrantRecords(env), listHealth(env), listConnections(env, snapshot.providers.map((provider) => provider.id))]);
  const connections = new Map(storedConnections.map((connection) => [connection.providerId, connection]));
  return { grants, health, connections };
}

export async function readinessForIdentity(env: Env, auth: AuthorizedIdentity): Promise<Readiness[]> {
  const all = await providerReadinessForPolicies(env, [{ policyId: auth.policyId, policy: auth.policy }]);
  return all.filter((row) => auth.policy.providers.length === 0 || auth.policy.providers.includes(row.id));
}

function readinessFor(provider: CompiledProvider, env: Env, grants: GrantRecord[], connection: ProviderConnection, health?: ProviderHealth): Readiness {
  const configuredOptional = new Set((envValue(env, "CLAWROUTER_OPTIONAL_CONFIG_KEYS") ?? "").split(",").map((key) => key.trim()).filter(Boolean));
  const optionalConfig = provider.config_keys.filter((key) => provider.optional_config_keys.includes(key) || configuredOptional.has(key) || (provider.auth.schemes.every((scheme) => scheme.type === "bearer" && scheme.required === false) && secretConfigKey(key)));
  const requiredConfig = provider.config_keys.filter((key) => !optionalConfig.includes(key));
  const providerGrants = grants.filter((entry) => entry.grant.enabled !== false && entry.grant.provider === provider.id && grantUsable(entry.grant));
  const hasGrant = providerGrants.length > 0;
  const missingConfig = requiredConfig.filter((key) => !envValue(env, key) && !grantSatisfiesConfig(key, providerGrants));
  const configPresent = missingConfig.length === 0;
  const executableEndpoints = configPresent && connection.enabled ? provider.endpoints.filter((endpoint) => endpointTemplatesConfigured(provider, endpoint, env)).map((endpoint) => endpoint.id) : [];
  const checked = health?.checkedAt ? Date.parse(health.checkedAt) : NaN;
  const verified = health?.status === "verified" && Number.isFinite(checked) && Date.now() - checked < 86_400_000;
  const executable = connection.enabled && executableEndpoints.length > 0;
  const reasons: string[] = [];
  if (!connection.enabled) reasons.push("Provider connection is disabled.");
  if (!configPresent) reasons.push(`Missing ${missingConfig.join(", ")}.`);
  if (executable && !verified) reasons.push("Configured but not recently verified by a live smoke test.");
  if (health?.status === "failed") reasons.push(health.error ?? "Latest provider smoke failed.");
  const status = !connection.enabled ? "disabled" : !configPresent ? "missing_config" : health?.status === "failed" ? "failed" : verified ? "verified" : "unverified";
  return {
    id: provider.id,
    displayName: provider.display_name,
    class: provider.class,
    serviceKind: provider.service_kind,
    requiredConfig,
    optionalConfig,
    missingConfig: configPresent ? [] : missingConfig,
    configPresent,
    connectionEnabled: connection.enabled,
    oauthGrantRequired: provider.auth.schemes.some((scheme) => scheme.type === "oauth") && !hasGrant,
    oauthGrantCount: providerGrants.filter((entry) => entry.grant.kind === "oauth").length,
    upstreamGrantCount: providerGrants.length,
    openaiCompatible: provider.class === "openai_compatible",
    manifestRoutes: provider.endpoints.length,
    executableEndpoints,
    modelCount: provider.models.length,
    executable,
    verified,
    lastCheckedAt: health?.checkedAt ?? null,
    latencyMs: health?.latencyMs ?? null,
    status,
    reasons,
  };
}

export async function assertProviderAccess(provider: CompiledProvider, auth: AuthorizedIdentity, env: Env): Promise<void> {
  if (auth.policy.providers.length && !auth.policy.providers.includes(provider.id)) throw new HttpError(403, "provider_not_allowed", `policy does not allow provider ${provider.id}`);
  const connection = await connectionFor(env, provider.id);
  if (!connection.enabled) throw new HttpError(503, "provider_disabled", `provider ${provider.id} is disabled`);
}

export async function upstreamAuth(provider: CompiledProvider, endpoint: CompiledEndpoint, auth: AuthorizedIdentity, env: Env): Promise<UpstreamAuth> {
  const grant = await grantFor(provider, auth, env);
  const headers = new Headers();
  const query = new URLSearchParams();
  const scheme = provider.auth.schemes.find((candidate) => candidate.type !== "oauth") ?? provider.auth.schemes[0];
  const secret = secretFor(provider, scheme, grant, env);
  if (scheme.type === "bearer" && secret) headers.set(scheme.header, scheme.format.replace("${secret}", secret));
  else if (scheme.type === "api_key" && secret) headers.set(scheme.header, secret);
  else if (scheme.type === "query_api_key" && secret) query.set(scheme.param, secret);
  else if (scheme.type === "sig_v4") { /* signed after the final URL and request body are known */ }
  else if (!secret && !(scheme.type === "bearer" && scheme.required === false)) throw new HttpError(503, "provider_not_configured", `provider ${provider.id} has no usable upstream credential`);
  for (const [name, value] of Object.entries(provider.adapter.injectHeaders)) headers.set(name, resolveTemplate(provider, value, env));
  for (const [name, value] of Object.entries(provider.adapter.injectQuery)) query.set(name, resolveTemplate(provider, value, env));
  const transport = grant?.kind ? provider.auth.grantTransports[grant.kind as keyof typeof provider.auth.grantTransports] : undefined;
  if (transport && grant) for (const [name, value] of Object.entries(transport.headers)) headers.set(name, grantTemplate(value, grant));
  return {
    grant,
    baseUrl: transport?.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env),
    headers,
    query,
    transportPaths: transport?.endpointPaths ?? {},
  };
}

export function upstreamPath(provider: CompiledProvider, endpoint: CompiledEndpoint, pathParams: Record<string, string>, env: Env, auth: UpstreamAuth): string {
  const transportPath = auth.transportPaths[endpoint.id as keyof typeof auth.transportPaths];
  let path = transportPath ?? endpoint.path;
  for (const name of endpoint.path_params) {
    const raw = pathParams[name];
    if (!raw) throw new HttpError(400, "missing_path_param", `path parameter ${name} is required`);
    const style = endpoint.path_param_styles[name as keyof typeof endpoint.path_param_styles] ?? "segment";
    path = path.replace(`\${${name}}`, encodePathParam(raw, style));
  }
  return resolveTemplate(provider, path, env);
}

export function copyRequestHeaders(incoming: Headers, provider: CompiledProvider, endpoint: CompiledEndpoint, target: Headers, env: Env): void {
  for (const name of [...provider.adapter.passthroughHeaders, ...endpoint.request_headers]) {
    const value = incoming.get(name);
    if (value) target.set(name, value);
  }
  for (const [name, value] of Object.entries(endpoint.headers)) target.set(name, resolveTemplate(provider, value, env));
  target.set("content-type", incoming.get("content-type") ?? "application/json");
}

export function transformRequestBody(provider: CompiledProvider, path: string, model: string, body: Record<string, unknown>, env: Env): Record<string, unknown> {
  const transformed = structuredClone(body);
  for (const rename of provider.adapter.requestTransforms.renameFields) {
    if (rename.paths.length && !rename.paths.includes(path)) continue;
    const allowed = rename.upstreams.length === 0 || rename.upstreams.includes(model) || (!!rename.upstreamConfig && configuredList(provider, rename.upstreamConfig, env).includes(model));
    if (allowed && rename.from in transformed && !(rename.to in transformed)) {
      transformed[rename.to] = transformed[rename.from];
      delete transformed[rename.from];
    }
  }
  return transformed;
}

export function resolveTemplate(provider: CompiledProvider, value: string, env: Env): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const key = templateCandidates(provider, name).find((candidate) => envValue(env, candidate));
    if (!key) throw new HttpError(503, "provider_not_configured", `missing Cloudflare config value ${name} for provider ${provider.id}`);
    return envValue(env, key)!;
  });
}

export async function signSigV4(provider: CompiledProvider, url: URL, method: string, body: string | undefined, headers: Headers, env: Env, grant: UpstreamGrant | null): Promise<void> {
  const scheme = provider.auth.schemes.find((candidate) => candidate.type === "sig_v4");
  if (!scheme || scheme.type !== "sig_v4") return;
  const credentials = grant?.credentials ?? {};
  const accessKeyId = credentials.accessKeyId ?? envValue(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = credentials.secretAccessKey ?? envValue(env, "AWS_SECRET_ACCESS_KEY");
  const sessionToken = credentials.sessionToken ?? envValue(env, "AWS_SESSION_TOKEN");
  const region = envValue(env, "AWS_REGION");
  if (!accessKeyId || !secretAccessKey || !region) throw new HttpError(503, "provider_not_configured", "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION are required");
  const date = new Date(), amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ""), dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256(body ?? "");
  headers.set("host", url.host); headers.set("x-amz-date", amzDate); headers.set("x-amz-content-sha256", payloadHash);
  if (sessionToken) headers.set("x-amz-security-token", sessionToken);
  const headerNames: string[] = []; headers.forEach((_, name) => headerNames.push(name.toLowerCase()));
  const signedHeaderNames = headerNames.filter((name) => name === "host" || name.startsWith("x-amz-")).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const queryEntries: Array<[string, string]> = []; url.searchParams.forEach((value, key) => queryEntries.push([key, value]));
  const query = queryEntries.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`).join("&");
  const uri = url.pathname.split("/").map(awsEncode).join("/") || "/";
  const canonicalRequest = `${method}\n${uri}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/${scheme.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`;
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region), serviceKey = await hmac(regionKey, scheme.service), signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  headers.delete("host");
}

export async function listGrantRecords(env: Env): Promise<GrantRecord[]> {
  const entries: GrantRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.POLICY_KV.list({ prefix: "oauth/", cursor });
    for (const key of page.keys) {
      const grant = await env.POLICY_KV.get<UpstreamGrant>(key.name, "json");
      if (grant) entries.push({ key: key.name, grant });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

export async function listHealth(env: Env): Promise<Map<string, ProviderHealth>> {
  const result = new Map<string, ProviderHealth>();
  const page = await env.POLICY_KV.list({ prefix: "health/providers/" });
  for (const key of page.keys) {
    const record = await env.POLICY_KV.get<ProviderHealth>(key.name, "json");
    if (record) result.set(record.providerId, record);
  }
  return result;
}

async function grantFor(provider: CompiledProvider, auth: AuthorizedIdentity, env: Env): Promise<UpstreamGrant | null> {
  const tokenRef = provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? provider.id;
  const tenant = auth.policy.tenantId ?? "default";
  for (const key of [`oauth/${auth.policyId}/${tokenRef}`, `oauth/tenants/${tenant}/${tokenRef}`]) {
    const grant = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
    if (grant && grant.enabled !== false && (!grant.provider || grant.provider === provider.id) && grantUsable(grant)) return refreshGrant(key, grant, provider, env, false);
  }
  return null;
}

export async function refreshStoredGrant(env: Env, key: string): Promise<UpstreamGrant> {
  const grant = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
  if (!grant?.provider) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered");
  const provider = providerById(grant.provider);
  if (!provider) throw new HttpError(400, "unknown_provider", "upstream grant provider is not registered");
  return refreshGrant(key, grant, provider, env, true);
}

async function refreshGrant(key: string, grant: UpstreamGrant, provider: CompiledProvider, env: Env, force: boolean): Promise<UpstreamGrant> {
  const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
  if (!force && (!Number.isFinite(expires) || expires > Date.now() + 5 * 60_000)) return grant;
  if (!grant.refreshToken) {
    if (force) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no refresh token");
    return grant;
  }
  const config = grant.refresh ?? provider.auth.refresh;
  if (!config?.tokenUrl) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no approved refresh configuration");
  const clientId = config.clientId ?? (config.clientIdConfig ? envValue(env, config.clientIdConfig) : null);
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken });
  if (clientId) form.set("client_id", clientId);
  if (config.clientSecretConfig) {
    const secret = envValue(env, config.clientSecretConfig);
    if (!secret) throw new HttpError(503, "provider_not_configured", `missing refresh client secret ${config.clientSecretConfig}`);
    form.set("client_secret", secret);
  }
  for (const [name, value] of Object.entries(config.extraParams ?? {})) form.set(name, value);
  const response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== "string") throw new HttpError(502, "grant_refresh_failed", `provider ${provider.id} rejected the refresh request`);
  const now = new Date().toISOString();
  const updated: UpstreamGrant = {
    ...grant,
    accessToken: payload.access_token as string,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : grant.refreshToken,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : grant.tokenType,
    scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : grant.scopes,
    expiresAt: typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1_000).toISOString() : grant.expiresAt,
    updatedAt: now,
  };
  await env.POLICY_KV.put(key, JSON.stringify(updated));
  return updated;
}

function grantUsable(grant: UpstreamGrant): boolean {
  return canonicalGrantUsable(grant);
}

function grantSatisfiesConfig(key: string, grants: GrantRecord[]): boolean {
  if (secretConfigKey(key)) return grants.length > 0;
  const fields: Record<string, string> = { AWS_ACCESS_KEY_ID: "accessKeyId", AWS_SECRET_ACCESS_KEY: "secretAccessKey", AWS_SESSION_TOKEN: "sessionToken" };
  const field = fields[key];
  return !!field && grants.some(({ grant }) => !!grant.credentials?.[field]);
}

function secretFor(provider: CompiledProvider, scheme: CompiledProvider["auth"]["schemes"][number], grant: UpstreamGrant | null, env: Env): string | null {
  if (grant) return grant.credential ?? grant.accessToken ?? firstCredential(grant.credentials) ?? null;
  const kind = "secretKind" in scheme ? scheme.secretKind : "";
  const candidates = provider.config_keys.filter((key) => kind === "api_token" ? key.endsWith("_TOKEN") || key.endsWith("_API_TOKEN") : key.endsWith("_API_KEY") || key.endsWith("_API_TOKEN"));
  return candidates.map((key) => envValue(env, key)).find(Boolean) ?? null;
}

function firstCredential(values: Record<string, string> | undefined): string | null {
  return values ? Object.values(values).find(Boolean) ?? null : null;
}

async function connectionFor(env: Env, providerId: string): Promise<ProviderConnection> {
  return await resolveConnection(env, providerId) ?? { providerId, enabled: true };
}

function endpointTemplatesConfigured(provider: CompiledProvider, endpoint: CompiledEndpoint, env: Env): boolean {
  const values = [provider.base_urls.default, endpoint.path, ...Object.values(provider.adapter.injectHeaders), ...Object.values(provider.adapter.injectQuery)];
  return values.every((value) => [...value.matchAll(/\$\{([^}]+)\}/g)].every((match) => templateCandidates(provider, match[1]).some((key) => envValue(env, key)) || endpoint.path_params.includes(match[1])));
}

function templateCandidates(provider: CompiledProvider, name: string): string[] {
  const normalized = name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return provider.config_keys.filter((key) => key === normalized || key.endsWith(`_${normalized}`));
}

function envValue(env: Env, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function sha256(value: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> { const cryptoKey = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value))); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }

function configuredList(provider: CompiledProvider, name: string, env: Env): string[] {
  const key = templateCandidates(provider, name).find((candidate) => envValue(env, candidate));
  return key ? envValue(env, key)!.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function grantTemplate(value: string, grant: UpstreamGrant): string {
  return value.replace(/\$\{grant\.([^}]+)\}/g, (_, name: string) => String(grant[name as keyof UpstreamGrant] ?? ""));
}

function encodePathParam(value: string, style: string): string {
  if (style === "relative_path") {
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    return segments.map(encodeURIComponent).join("/");
  }
  if (value.includes("/") || value === "." || value === "..") throw new HttpError(400, "invalid_path_param", "path parameter must be one segment");
  return encodeURIComponent(value);
}

function secretConfigKey(key: string): boolean { return /_(?:API_KEY|API_TOKEN|TOKEN)$/.test(key); }
function unifiedPathForCapability(capability: string): string { return capability === "llm.chat" ? "/v1/chat/completions" : capability === "llm.responses" ? "/v1/responses" : capability === "llm.embeddings" ? "/v1/embeddings" : ""; }
