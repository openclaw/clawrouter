import { selectOwnedHttpIdentity, prepareOwnedHttpCredential, reserveOwnedHttpForeground, type OwnedHttpCredential, type GenerationSelectionHandle } from "./credential-preflight.ts";
import { checkOwnedHttpRequest, growOwnedHttpRequest, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { identityFailure as ownedHttpIdentityFailure } from "./identity-admission.ts";
import { checkOwnedHttpProviderInput, acceptOwnedHttpConfiguredProvider } from "./proxy.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { ProxyQuery } from "./proxy-query.ts";
import { reserveOwnedHttpSerialization } from "./pricing.ts";

import { admitIdentity, isIdentityFailure } from "./identity-admission.ts";
import type { MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { miniMaxVideoDenied, miniMaxVideoIdentity, miniMaxVideoRequirement } from "./minimax-video-credential.ts";
import { readMiniMaxVideoBinding } from "../shared/minimax-video-binding.ts";
import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { miniMaxSearchDenied, miniMaxSearchIdentity } from "./minimax-search-credential.ts";
import type { WanManagedOperation } from "./managed-media-json.ts";
import { capabilityForPath, createRouteCatalog, unifiedPathForRequestFormat } from "../shared/route-catalog.ts";
export { capabilityForPath, modelSupportsEndpoint } from "../shared/route-catalog.ts";
import { selectedCredentialFailure } from "./grant-credential-failure.ts";
import { grantStickyInput } from "./grant-sticky.ts";
import { configuredEndpointPath } from "./endpoint-path.ts";
import { modelForEndpoint } from "./model-pricing.ts";
import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import { listConnections, resolveConnection } from "./authority.ts";
import { admittedGrantSelection, proxyAdmission, proxySessionHash } from "./proxy-auth.ts";

import { grantRevision, grantUsable, resolveGrantSelection, type PinnedGrant } from "./grant-selection.ts";
import { grantsVisibleToPolicies, type GrantRecord } from "./grant-scope.ts";
import { materializeGrantCredentials, reconcileGrantAttachment, refreshGrantQuota } from "./grant-credentials.ts";
import { hotCacheConfig, registerHotCache, tryRunInBackground } from "./hot-cache.ts";
import { cachedGrantCredentials, evictGrantCredentials, prepareOwnedHttpGrantCredentials } from "./credential-cache.ts";
import { recordCredentialWait } from "./admission-timing.ts";
import { applyProviderCredential, applyTransportHeaders, assertOperationConfiguration, grantSupports, providerConfigPresent, providerSecretConfigKey, transportForGrant, type GrantRequirement } from "./provider-auth.ts";
import type {
  AccessPolicyEntry, AuthorizedIdentity, CompiledEndpoint, CompiledGrantTransport, CompiledModel, CompiledProvider, Env,
  ProviderConnection, ProviderHealth, ProviderSnapshot, UpstreamGrant,
} from "./types.ts";
import { envValue, HttpError, sha256Hex } from "./utils.ts";
import { providerConfigurationList } from "./provider-connections.ts";
import { applyTemplateHeaders, optionalConfigKeys, resolveHeaderTemplate, resolveTemplate, templateCandidates, PreparationAdmission, isPreparationLimit, preparationValue, preparationHeader, preparationBytes, preparationEncodedBytes } from "./provider-templates.ts";

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
  grantKey: string | null;
  grantLane: import("./types").GrantLane;
  grantRevision: string | null;
  baseUrl: string;
  headers: Headers;
  query: URLSearchParams;
  transportPaths: Record<string, string>;
  transport: CompiledGrantTransport | null;
}

export function providerById(id: string): CompiledProvider | undefined {
  return snapshot.providers.find((provider) => provider.id === id);
}

export function providerForModel(model: string): CompiledProvider | undefined {
  const exact = snapshot.model_index[model as keyof typeof snapshot.model_index];
  return exact ? providerById(exact.provider) : snapshot.providers.find((provider) => provider.routing.modelPrefixes.some((prefix) => model.startsWith(prefix) && model.length > prefix.length));
}

export function modelRoute(model: string, capability?: string): { provider: CompiledProvider; model: CompiledModel } | null {
  const provider = providerForModel(model);
  if (!provider) return null;
  const endpointId = provider.capabilities.find((item) => item.id === capability)?.endpoint;
  const entry = providerModel(provider, model, provider.endpoints.find((endpoint) => endpoint.id === endpointId));
  return entry ? { provider, model: entry } : null;
}

export function providerModel(provider: CompiledProvider, value: string, endpoint?: CompiledEndpoint, native = false): CompiledModel | null {
  const prefix = provider.routing.modelPrefixes.find((candidate) => value.startsWith(candidate));
  const upstream = prefix && !native ? value.slice(prefix.length) : value;
  const known = provider.models.find((model) => model.id === value) ?? provider.models.find((model) => model.upstream === value || model.upstream === upstream);
  if (known) return modelForEndpoint(known, endpoint?.id);
  if (native && value) {
    // A registered native identity may differ from its physical upstream alias.
    // Match only literal cards with an exact declared router prefix plus identity,
    // never configured deployment templates, suffixes or stripped unknown IDs.
    const declared = provider.models.filter((model) => !model.id.includes("${") && !model.upstream.includes("${")
      && provider.routing.modelPrefixes.some((prefix) => model.id === prefix + value));
    if (declared.length > 1) return null;
    if (declared.length === 1) return modelForEndpoint(declared[0], endpoint?.id);
  }
  if (!value || !endpoint?.modelPassthrough) return null;
  if (!upstream) return null;
  // Native opaque ids belong to the upstream namespace, even when they match
  // a routing prefix. They cannot inherit another model's metadata or price.
  return {
    id: value,
    upstream,
    capabilities: provider.capabilities.filter((capability) => capability.endpoint === endpoint.id).map((capability) => capability.id),
    pricing_ref: endpoint.modelPassthrough.pricing_ref,
    pricing: endpoint.modelPassthrough.pricing,
  };
}

export function endpointForPath(provider: CompiledProvider, path: string): CompiledEndpoint | undefined {
  const capability = capabilityForPath(path);
  const endpointId = provider.capabilities.find((item) => item.id === capability)?.endpoint;
  return endpointId ? provider.endpoints.find((endpoint) => endpoint.id === endpointId) : undefined;
}

export function unifiedPathForEndpoint(provider: CompiledProvider, endpoint: CompiledEndpoint): string | null {
  const format = endpoint.request_format;
  const path = unifiedPathForRequestFormat(format);
  const responseFormat = format === "openai.audio_speech" ? "audio.binary" : format;
  return path && endpoint.response_format === responseFormat && endpointForPath(provider, path)?.id === endpoint.id ? path : null;
}

export function routeCatalog() { return createRouteCatalog(snapshot.providers); }

export async function providerReadiness(env: Env): Promise<Readiness[]> {
  const { grants, health, connections } = await readinessInputs(env);
  return providerReadinessFromState(env, grants, [...connections.values()], health);
}

export async function providerReadinessForPolicies(env: Env, policies: AccessPolicyEntry[], storedConnections?: ProviderConnection[]): Promise<Readiness[]> {
  const { grants, health, connections } = await readinessInputs(env, storedConnections);
  const visibleGrants = grantsVisibleToPolicies(grants, policies);
  return providerReadinessFromState(env, visibleGrants, [...connections.values()], health);
}

export function providerReadinessFromState(env: Env, grants: GrantRecord[], storedConnections: ProviderConnection[], health: Map<string, ProviderHealth>): Readiness[] {
  const connections = new Map(storedConnections.map((connection) => [connection.providerId, connection]));
  return snapshot.providers.map((provider) => providerReadinessForState(provider, env, grants, connections.get(provider.id) ?? { providerId: provider.id, enabled: true }, health.get(provider.id)));
}

async function readinessInputs(env: Env, suppliedConnections?: ProviderConnection[]) {
  const [grants, health, storedConnections] = await Promise.all([listGrantRecords(env), listHealth(env), suppliedConnections ?? listConnections(env, snapshot.providers.map((provider) => provider.id))]);
  const connections = new Map(storedConnections.map((connection) => [connection.providerId, connection]));
  return { grants, health, connections };
}

export function providerReadinessForState(provider: CompiledProvider, env: Env, grants: GrantRecord[], connection: ProviderConnection, health?: ProviderHealth, operation?: Pick<Readiness, "executableEndpoints" | "executable" | "status" | "reasons">): Readiness {
  const configuredOptional = optionalConfigKeys(provider, env);
  const optionalConfig = provider.config_keys.filter((key) => configuredOptional.has(key) || (provider.auth.schemes.every((scheme) => scheme.type === "bearer" && scheme.required === false) && providerSecretConfigKey(provider, key)));
  const requiredConfig = provider.config_keys.filter((key) => !optionalConfig.includes(key));
  const providerGrants = grants.filter((entry) => entry.grant.enabled !== false && entry.grant.provider === provider.id && grantUsable(entry.grant));
  const hasGrant = providerGrants.length > 0;
  const missingConfig = requiredConfig.filter((key) => !providerConfigPresent(provider, key, env) && !grantSatisfiesConfig(provider, key, providerGrants));
  const configPresent = missingConfig.length === 0;
  const executableEndpoints = operation?.executableEndpoints ?? (configPresent && connection.enabled ? provider.endpoints.filter((endpoint) => endpointTemplatesConfigured(provider, endpoint, env)).map((endpoint) => endpoint.id) : []);
  const checked = health?.checkedAt ? Date.parse(health.checkedAt) : NaN;
  const verified = health?.status === "verified" && Number.isFinite(checked) && Date.now() - checked < 86_400_000;
  const executable = operation?.executable ?? (connection.enabled && executableEndpoints.length > 0);
  // Scoped operation facts replace coarse configuration blockers, while saved
  // probe diagnostics remain advisory and never authorize or block an offer.
  const reasons = operation ? [...operation.reasons] : [];
  if (!operation) {
    if (!connection.enabled) reasons.push("Provider connection is disabled.");
    if (!configPresent) reasons.push(`Missing ${missingConfig.join(", ")}.`);
  }
  if (executable && !verified) reasons.push("Configured but not recently verified by a live smoke test.");
  if (health?.status === "failed") reasons.push(health.error ?? "Latest provider smoke failed.");
  const blockedStatus = operation ? operation.executable ? null : operation.status : !connection.enabled ? "disabled" : !configPresent ? "missing_config" : null;
  const status = blockedStatus ?? (health?.status === "failed" ? "failed" : verified ? "verified" : "unverified");
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

export async function assertProviderAccess(provider: CompiledProvider, auth: AuthorizedIdentity, env: Env, resolvedConnection?: ProviderConnection, wan?: WanManagedOperation, video?: MiniMaxVideoOperation): Promise<ProviderConnection> {
  if (auth.policy.providers.length && !auth.policy.providers.includes(provider.id)) throw new HttpError(403, "provider_not_allowed", `policy does not allow provider ${provider.id}`);
  if (video) {
    const current = resolvedConnection ?? await resolveConnection(env, provider.id, undefined, undefined, video);
    if (!current?.enabled) miniMaxVideoDenied();
    return current;
  }
  const admission = proxyAdmission(auth);
  if (!resolvedConnection && admission?.connectionsUnavailable) throw new Error("admission connection resolution failed");
  if (wan && (wan.kind === "poll" || !resolvedConnection && !(admission && Object.hasOwn(admission.pools, provider.id)))) {
    resolvedConnection = await resolveConnection(env, provider.id, wan) ?? undefined;
    if (!resolvedConnection) throw new HttpError(503, "prediction_owner_unavailable", "Wan connection is unavailable");
  }
  const connection = resolvedConnection ?? (admission && Object.hasOwn(admission.pools, provider.id) ? admission.connections.find(item => item.providerId === provider.id) ?? { providerId: provider.id, enabled: true } : await connectionFor(env, provider.id));
  if (!connection.enabled) throw new HttpError(503, "provider_disabled", `provider ${provider.id} is disabled`);
  return connection;
}

export async function upstreamAuth(provider: CompiledProvider, auth: AuthorizedIdentity, env: Env, excludedGrantKeys: ReadonlySet<string> = new Set(), stickyHash: string | null = null, recordSelection = true, pinned?: PinnedGrant, requirement?: GrantRequirement, signal?: AbortSignal, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, owner?: PreparationAdmission): Promise<UpstreamAuth> {
  const resolution = await grantFor(provider, auth, env, excludedGrantKeys, stickyHash, recordSelection, pinned, requirement, signal, wan, search, video, owner);
  const selected = resolution.selected;
  if (video && !selected) miniMaxVideoDenied();
  if (search && !selected) miniMaxSearchDenied();
  if (!selected && resolution.hasConfiguredGrant) {
    const unavailable = () => grantPoolUnavailable(provider, resolution.retryAt);
    if (video || wan || !auth.policy.grantRouting?.environmentFallback || pinned?.key != null) throw unavailable();
    try { if (requirement) assertOperationConfiguration(requirement, null, env, owner); configuredUpstream(provider, null, env, undefined, owner); }
    catch (error) { if (isPreparationLimit(error)) throw error; throw unavailable(); }
  }
  const grant = selected?.grant ?? null;
  assertPinnedGrant(pinned, selected);
  if (requirement) assertOperationConfiguration(requirement, grant, env, owner);
  return { ...configuredUpstream(provider, grant, env, video ? requirement : undefined, owner), grantKey: selected?.key ?? null, grantRevision: grant ? grantRevision(grant) : null };
}

function assertPinnedGrant(pinned: PinnedGrant | undefined, selected: { key: string; grant: UpstreamGrant } | null): void {
  const grant = selected?.grant;
  if (pinned && ((selected?.key ?? null) !== pinned.key || ("lineage" in pinned ? grant?.credentialLineage !== pinned.lineage : (grant ? grantRevision(grant) : null) !== pinned.revision))) throw new HttpError(409, "upstream_grant_changed", "upstream authorization changed; open a new connection");
}

// Selection and credential ownership stay with their callers. Both generation
// and pinned controls use this same configuration-to-wire preparation.
export function configuredUpstream(provider: CompiledProvider, grant: UpstreamGrant | null, env: Env, videoRequirement?: GrantRequirement, owner?: PreparationAdmission): UpstreamAuth {
  const videoBinding = videoRequirement ? readMiniMaxVideoBinding(grant?.minimaxVideoBinding) : null;
  if (videoRequirement && (!videoBinding || !miniMaxVideoRequirement(videoRequirement) || !grant || !grantSupports(videoRequirement, grant))) miniMaxVideoDenied();
  const headers = new Headers();
  const query = new URLSearchParams();
  applyProviderCredential(provider, grant, env, headers, query, owner);
  applyTemplateHeaders(provider, provider.adapter.injectHeaders, env, headers, owner);
  for (const name in provider.adapter.injectQuery) { const value = resolveTemplate(provider, provider.adapter.injectQuery[name], env, owner, 4096); owner?.query(name, value); query.set(name, value); }
  const transport = transportForGrant(provider, grant);
  applyTransportHeaders(headers, transport, grant, owner);
  const baseUrl = videoBinding?.origin ?? transport?.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env, owner, 4096);
  owner?.text(baseUrl, 4096);
  return {
    grant,
    grantKey: null,
    grantLane: !grant ? "environment" : grant.kind === "api_key" ? "api_key" : "subscription",
    grantRevision: grant ? grantRevision(grant) : null,
    baseUrl,
    headers,
    query,
    transportPaths: transport?.endpointPaths ?? {},
    transport,
  };
}

export function upstreamPath(provider: CompiledProvider, endpoint: CompiledEndpoint, pathParams: Record<string, string>, env: Env, auth: UpstreamAuth, owner?: PreparationAdmission): string {
  owner?.paths(pathParams, endpoint.path_param_styles);
  const transportPath = auth.transportPaths[endpoint.id as keyof typeof auth.transportPaths];
  let path = configuredEndpointPath(endpoint, transportPath, auth.baseUrl);
  for (const name of endpoint.path_params) {
    const raw = pathParams[name];
    if (!raw) throw new HttpError(400, "missing_path_param", `path parameter ${name} is required`);
    const style = endpoint.path_param_styles[name as keyof typeof endpoint.path_param_styles] ?? "segment";
    const placeholder = `\${${name}}`;
    if (owner) {
      const encoded = owner.path(raw, style === "relative_path", style === "opaque_segment" || style === "relative_path");
      owner.text(path, 16384);
      if (path.includes(placeholder)) {
        if (path.length - placeholder.length + encoded > 16384 || preparationBytes(path) - preparationBytes(placeholder) + encoded > 16384) owner.fail();
        owner.substitute(1);
      }
    }
    path = path.replace(placeholder, encodePathParam(raw, style));
  }
  return resolveTemplate(provider, path, env, owner);
}

export function copyRequestHeaders(incoming: Headers, provider: CompiledProvider, endpoint: CompiledEndpoint, target: Headers, env: Env, owner?: PreparationAdmission): void {
  for (const name of [...provider.adapter.passthroughHeaders, ...endpoint.request_headers]) {
    const lower = name.toLowerCase();
    // Caller-selected tenancy, profile trust grants and replay keys have no
    // authorized owner binding. A manifest allowlist cannot grant authority.
    if (["x-clawrouter-background-recovery", "anthropic-workspace-id", "anthropic-user-profile-id", "idempotency-key"].includes(lower)) continue;
    const value = incoming.get(name);
    if (value) preparationHeader(target, name, value, owner);
  }
  preparationHeader(target, "content-type", incoming.get("content-type") ?? "application/json", owner);
  applyTemplateHeaders(provider, endpoint.headers, env, target, owner);
}

export function transformRequestBody(provider: CompiledProvider, path: string, model: string, body: Record<string, unknown>, env: Env, owner?: PreparationAdmission): Record<string, unknown> {
  // Renames only replace top-level fields; nested prompt/tool data is read-only.
  const transformed = { ...body };
  for (const rename of provider.adapter.requestTransforms.renameFields) {
    if (rename.paths.length && !rename.paths.includes(path)) continue;
    const allowed = rename.upstreams.length === 0 || rename.upstreams.includes(model) || (!!rename.upstreamConfig && configuredList(provider, rename.upstreamConfig, env, owner).includes(model));
    if (allowed && rename.from in transformed && !(rename.to in transformed)) {
      transformed[rename.to] = transformed[rename.from];
      delete transformed[rename.from];
    }
  }
  return transformed;
}

export function signSigV4(provider: CompiledProvider, url: URL, method: string, body: string | undefined, headers: Headers, env: Env, grant: UpstreamGrant | null, now = new Date(), owner?: PreparationAdmission): Promise<string | undefined> {
  try {
    const scheme = provider.auth.schemes.find((candidate) => candidate.type === "sig_v4");
    if (!scheme || scheme.type !== "sig_v4") return Promise.resolve(undefined);
    const credentials = grant?.credentials;
    const accessKeyId = grant ? credentials?.accessKeyId : preparationValue(env, "AWS_ACCESS_KEY_ID", owner);
    const secretAccessKey = grant ? credentials?.secretAccessKey : preparationValue(env, "AWS_SECRET_ACCESS_KEY", owner);
    const sessionToken = grant ? credentials?.sessionToken : preparationValue(env, "AWS_SESSION_TOKEN", owner);
    const region = preparationValue(env, "AWS_REGION", owner);
    if (grant) { owner?.primitive("accessKeyId", accessKeyId); owner?.primitive("secretAccessKey", secretAccessKey); owner?.primitive("sessionToken", sessionToken); }
    if (!accessKeyId || !secretAccessKey || !region) {
      const message = grant
        ? "selected AWS grant must contain accessKeyId and secretAccessKey; AWS_REGION is required"
        : "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION are required";
      throw new HttpError(503, "provider_not_configured", message);
    }
    owner?.primitive("service", scheme.service);
    return signAdmittedSigV4(url, method, body, headers, accessKeyId, secretAccessKey, sessionToken, region, scheme.service, now, owner);
  } catch (error) { return Promise.reject(error); }
}

// No Env or grant survives into this asynchronous signer.
async function signAdmittedSigV4(url: URL, method: string, body: string | undefined, headers: Headers,
  accessKeyId: string, secretAccessKey: string, sessionToken: string | null | undefined, region: string, service: string,
  now: Date, owner?: PreparationAdmission): Promise<string> {
  if (owner) {
    owner.text(url.href, 16384); owner.headers(headers);
    // Canonical query/URI expansion is admitted before encoding, arrays or sorting.
    let queryBytes = 0, pairs = 0, segments = 1;
    url.searchParams.forEach((value, key) => {
      owner.query(key, value);
      queryBytes += preparationEncodedBytes(key, "aws") + preparationEncodedBytes(value, "aws") + 1 + (pairs++ ? 1 : 0);
      if (queryBytes > 8192) owner.fail();
    });
    for (const character of url.pathname) if (character === "/") segments++;
    if (segments > 64 || preparationEncodedBytes(url.pathname, "aws") - (segments - 1) * 2 > 8192) owner.fail();
    owner.text(region, 16384); owner.text(service, 16384);
    owner.joined(["AWS4", secretAccessKey], 16388);
  }
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), dateStamp = amzDate.slice(0, 8);
  // Fixed-width digest/signature slots allow the complete generated-header plan
  // to be admitted before any payload digest/import/sign invocation.
  const generated: Array<[string, string]> = [["host", url.host], ["x-amz-date", amzDate], ["x-amz-content-sha256", "0".repeat(64)]];
  if (sessionToken) generated.push(["x-amz-security-token", sessionToken]);
  owner?.headerPlan(headers, generated, false);
  const headerNames: string[] = [];
  headers.forEach((_, name) => headerNames.push(name.toLowerCase()));
  for (const [name] of generated) if (!headerNames.includes(name)) headerNames.push(name);
  const signedHeaderNames = headerNames.filter(name => name === "host" || name === "content-type" || name.startsWith("x-amz-") || name.startsWith("x-amzn-")).sort();
  const signedHeaders = signedHeaderNames.join(";");
  owner?.joined([dateStamp, region, service, "aws4_request"], 8192, "/");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  owner?.joined(["AWS4-HMAC-SHA256 Credential=", accessKeyId, "/", scope, ", SignedHeaders=", signedHeaders, ", Signature=", "0".repeat(64)], 8192);
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=`;
  owner?.headerPlan(headers, [...generated, ["authorization", authorization + "0".repeat(64)]]);
  const payloadHash = await sha256Hex(body ?? "");
  headers.set("host", url.host); headers.set("x-amz-date", amzDate); headers.set("x-amz-content-sha256", payloadHash);
  if (sessionToken) headers.set("x-amz-security-token", sessionToken);
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join("");
  const queryEntries: Array<[string, string]> = []; url.searchParams.forEach((value, key) => queryEntries.push([awsEncode(key), awsEncode(value)]));
  const query = queryEntries.sort(([a, av], [b, bv]) => compareAscii(a, b) || compareAscii(av, bv)).map(([key, value]) => `${key}=${value}`).join("&");
  const uri = url.pathname.split("/").map(awsEncode).join("/") || "/";
  const canonicalRequest = `${method}\n${uri}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region), serviceKey = await hmac(regionKey, service), signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  headers.set("authorization", authorization + signature);
  headers.delete("host");
  return region;
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
  // Health is advisory and only bundled providers can appear in readiness.
  // KV bulk reads accept at most 100 keys; avoid a list + serial read per row.
  const keys = snapshot.providers.map((provider) => `health/providers/${provider.id}`);
  for (let offset = 0; offset < keys.length; offset += 100) {
    const records = await env.POLICY_KV.get<ProviderHealth>(keys.slice(offset, offset + 100), "json");
    for (const record of records.values()) if (record) result.set(record.providerId, record);
  }
  return result;
}

// A pool whose grants are only cooling down or awaiting a quota reset is a rate
// limit: answer like a native provider, with the earliest recovery as Retry-After.
function grantPoolUnavailable(provider: CompiledProvider, retryAt: string | undefined): HttpError {
  const message = `provider ${provider.id} has no available scoped upstream grant`;
  const waitMs = retryAt ? Date.parse(retryAt) - Date.now() : NaN;
  if (!Number.isFinite(waitMs)) return new HttpError(503, "upstream_grant_pool_unavailable", message);
  return new HttpError(429, "upstream_grant_pool_unavailable", message, { "retry-after": String(Math.max(1, Math.ceil(waitMs / 1_000))) });
}

async function grantFor(provider: CompiledProvider, auth: AuthorizedIdentity, env: Env, excludedKeys: ReadonlySet<string>, stickyHash: string | null, recordSelection: boolean, pinned?: PinnedGrant, requirement?: GrantRequirement, signal?: AbortSignal, wan?: WanManagedOperation, search?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, owner?: PreparationAdmission): Promise<{ selected: { key: string; grant: UpstreamGrant } | null; hasConfiguredGrant: boolean; retryAt?: string }> {
  const tokenRef = provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? provider.id;
  if (requirement?.endpoint.lifecycle?.protocol === "minimax.video" && (!video || excludedKeys.size || !recordSelection || !miniMaxVideoRequirement(requirement))) miniMaxVideoDenied();
  if (requirement?.endpoint.request_format === "minimax.search" && (!search || excludedKeys.size || !recordSelection)) miniMaxSearchDenied();
  if (wan && (excludedKeys.size || !requirement || provider.id !== "alibaba" || requirement.endpoint.lifecycle?.protocol !== "dashscope.video"))
    throw new HttpError(503, "prediction_owner_unavailable", "Wan cannot reselect an original owner");
  const admitted = recordSelection && requirement ? await admittedGrantSelection(auth, env, requirement, excludedKeys, pinned?.key) : undefined;
  if (video && !admitted) miniMaxVideoDenied();
  if (search && !admitted) miniMaxSearchDenied();
  if (wan && !admitted) throw new HttpError(503, "prediction_owner_unavailable", "Wan requires its original admitted selection");
  if (!admitted && excludedKeys.size && auth.authType === "proxy_key") stickyHash = await grantStickyInput(auth, proxySessionHash(auth));
  const resolution = admitted ?? await resolveGrantSelection(provider.id, auth.policyId, auth.policy.tenantId ?? "default", tokenRef, env, excludedKeys, auth.policy.grantRouting, stickyHash, recordSelection, pinned?.key, requirement, excludedKeys.size ? undefined : proxyAdmission(auth)?.pools[provider.id]);
  // Check the snapshot pin before materialization, then recheck the materialized owner.
  if (admitted) assertPinnedGrant(pinned, resolution.selected);
  if (!resolution.selected) return { selected: null, hasConfiguredGrant: resolution.hasConfiguredGrant, retryAt: resolution.retryAt };
  if (!video && !wan && !search) admitIdentity(resolution.selected, "record");
  const { key, grant } = resolution.selected;
  let materialized: UpstreamGrant;
  try {
    if (video) {
      const { revalidateMiniMaxVideoOwner } = await import("./minimax-video-dispatch.ts");
      const original = miniMaxVideoIdentity(grant);
      const current = await revalidateMiniMaxVideoOwner(env, auth, requirement!, key, grant, video);
      materialized = await materializeGrantCredentials(env, key, current, provider.id, null, false, video.controlSignal, "minimax.video", undefined, undefined, video);
      if (miniMaxVideoIdentity(materialized) !== original) miniMaxVideoDenied();
    } else if (search) {
      const { revalidateMiniMaxSearchOwner } = await import("./minimax-search-dispatch.ts");
      const original = miniMaxSearchIdentity(grant);
      const current = await revalidateMiniMaxSearchOwner(env, auth, requirement!, key, grant, search);
      materialized = await materializeGrantCredentials(env, key, current, provider.id, null, false, search.operation.signal, "minimax.search", undefined, search);
      if (miniMaxSearchIdentity(materialized) !== original) miniMaxSearchDenied();
    } else if (wan) {
      if (grant.provider !== provider.id || grant.kind !== "api_key" || grant.credentialStore !== "durable_object"
        || !Number.isSafeInteger(grant.credentialGeneration) || !grant.credentialLineage)
        throw new HttpError(503, "prediction_owner_unavailable", "Wan requires an original durable key revision");
      wan.pin([key, provider.id, requirement!.endpoint.id, requirement!.model, grant.credentialGeneration, grant.credentialLineage,
        resolveTemplate(provider, provider.base_urls.default, env, owner, 4096)]);
      materialized = await materializeGrantCredentials(env, key, grant, provider.id, null, false, signal, undefined, wan);
      if (materialized.credentialGeneration !== grant.credentialGeneration || materialized.credentialLineage !== grant.credentialLineage)
        throw new HttpError(503, "prediction_owner_unavailable", "Wan owner revision changed");
      wan.pin([key, provider.id, requirement!.endpoint.id, requirement!.model, grant.credentialGeneration, grant.credentialLineage,
        resolveTemplate(provider, provider.base_urls.default, env, owner, 4096)]);
    } else if (requirement?.endpoint.request_format === "minimax.images") {
      // Keep the authenticated dispatch graph off metadata-only provider loads.
      const { revalidateMiniMaxImageOwner } = await import("./minimax-image-dispatch.ts");
      const current = await revalidateMiniMaxImageOwner(env, auth, requirement, key, grant, signal ?? new AbortController().signal);
      materialized = await materializeGrantCredentials(env, key, current, provider.id, null, false, signal, "minimax.images");
    } else if (requirement?.endpoint.request_format === "minimax.music") {
      const { revalidateMiniMaxMusicOwner } = await import("./minimax-media-dispatch.ts");
      const current = await revalidateMiniMaxMusicOwner(env, auth, requirement, key, grant, signal ?? new AbortController().signal);
      materialized = await materializeGrantCredentials(env, key, current, provider.id, null, false, signal, "minimax.music");
    } else materialized = provider.id === "anthropic-vertex" && grant.vertexAnthropicBinding?.source === "service_account"
      ? await refreshGrant(key, grant, provider, env, false, signal)
      : await cachedGrantCredentials(env, key, grant, () => refreshGrant(key, grant, provider, env, false), (state, ms) => recordCredentialWait(auth, state, ms));
  }
  catch (error) { if (isIdentityFailure(error)) throw error; if (!video && !wan && !search) evictGrantCredentials(key); throw selectedCredentialFailure(error, key); }
  if (!video && !wan && !search) admitIdentity(materialized, "record");
  // A shared owner can be replaced after selection. Sharing subscriptions must
  // never authorize a replacement API-key/media transport under that same key.
  if (!grantsVisibleToPolicies([{ key, grant: materialized }], [{ policyId: auth.policyId, policy: auth.policy }]).length)
    throw new HttpError(503, "upstream_grant_changed", "shared subscription owner changed");
  // A proxy-key request that could not select from the admission snapshot ran
  // the legacy read-and-select path. Ask the owner to republish this grant's
  // routing projection so later requests take the local hot path.
  if (!wan && !search && !admitted && recordSelection && !pinned && !excludedKeys.size && auth.authType === "proxy_key") scheduleProjectionRepair(env, key);
  return { selected: { key, grant: materialized }, hasConfiguredGrant: resolution.hasConfiguredGrant, retryAt: resolution.retryAt };
}

const PROJECTION_REPAIR_INTERVAL_MS = 10 * 60_000;
const projectionRepairs = registerHotCache(new Map<string, number>());
function scheduleProjectionRepair(env: Env, key: string): void {
  if (!hotCacheConfig(env).maxAgeMs) return;
  const now = Date.now();
  if ((projectionRepairs.get(key) ?? -Infinity) > now - PROJECTION_REPAIR_INTERVAL_MS) return;
  tryRunInBackground(() => {
    projectionRepairs.delete(key); projectionRepairs.set(key, now);
    if (projectionRepairs.size > 1024) projectionRepairs.delete(projectionRepairs.keys().next().value!);
    return reconcileGrantAttachment(env, key);
  });
}

export async function refreshStoredGrant(env: Env, key: string, signal?: AbortSignal): Promise<UpstreamGrant> {
  const grant = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
  if (!grant?.provider) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered");
  const provider = providerById(grant.provider);
  if (!provider) throw new HttpError(400, "unknown_provider", "upstream grant provider is not registered");
  return refreshGrant(key, grant, provider, env, true, signal);
}

export async function refreshStoredGrantQuota(env: Env, key: string): Promise<void> {
  let grant = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
  if (!grant?.provider || !grant.kind) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered");
  const provider = providerById(grant.provider);
  if (!provider) throw new HttpError(400, "unknown_provider", "upstream grant provider is not registered");
  grant = await refreshGrant(key, grant, provider, env, false);
  await refreshGrantQuota(env, key);
}

async function refreshGrant(key: string, grant: UpstreamGrant, provider: CompiledProvider, env: Env, force: boolean, signal?: AbortSignal): Promise<UpstreamGrant> {
  return materializeGrantCredentials(env, key, grant, provider.id, provider.auth.refresh, force, signal);
}

function grantSatisfiesConfig(provider: CompiledProvider, key: string, grants: GrantRecord[]): boolean {
  if (providerSecretConfigKey(provider, key)) return grants.length > 0;
  const fields: Record<string, string> = { AWS_ACCESS_KEY_ID: "accessKeyId", AWS_SECRET_ACCESS_KEY: "secretAccessKey", AWS_SESSION_TOKEN: "sessionToken" };
  const field = fields[key];
  return !!field && grants.some(({ grant }) => !!grant.credentials?.[field] || grant.credentialFields?.includes(field));
}

async function connectionFor(env: Env, providerId: string): Promise<ProviderConnection> {
  return await resolveConnection(env, providerId) ?? { providerId, enabled: true };
}

function endpointTemplatesConfigured(provider: CompiledProvider, endpoint: CompiledEndpoint, env: Env): boolean {
  const values = [provider.base_urls.default, endpoint.path, ...Object.values(provider.adapter.injectQuery), ...Object.values(endpoint.query)];
  if (!values.every((value) => [...value.matchAll(/\$\{([^}]+)\}/g)].every((match) => templateCandidates(provider, match[1]).some((key) => envValue(env, key)) || endpoint.path_params.includes(match[1])))) return false;
  try {
    for (const value of [...Object.values(provider.adapter.injectHeaders), ...Object.values(endpoint.headers)]) resolveHeaderTemplate(provider, value, env);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === "provider_not_configured") return false;
    throw error;
  }
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> { const cryptoKey = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value))); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function configuredList(provider: CompiledProvider, name: string, env: Env, owner?: PreparationAdmission): string[] {
  let selected: string | null = null;
  const key = templateCandidates(provider, name, owner).find(candidate => (selected = preparationValue(env, candidate, owner, true)));
  return key ? providerConfigurationList(selected!, owner, key, undefined, !!owner) : [];
}

function encodePathParam(value: string, style: string): string {
  if (style === "opaque_segment") {
    if (/^[.]{1,2}$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "invalid_path_param", "opaque path parameter is unsafe");
    return awsEncode(value);
  }
  if (style === "relative_path") {
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new HttpError(400, "invalid_path_param", "relative path parameter is unsafe");
    return segments.map(encodeURIComponent).join("/");
  }
  if (value.includes("/") || value === "." || value === "..") throw new HttpError(400, "invalid_path_param", "path parameter must be one segment");
  return encodeURIComponent(value);
}

// Inactive named provider adapter. The transient permit cannot be supplied by
// wire data and exposes neither authentication nor the selected grant graph.
let ownedHttpSelectionPermits: WeakMap<object, OwnedHttpRequest> | undefined;
let ownedHttpSelectionPermitCount = 0;
export function ownsOwnedHttpSelectionPermit(permit: object, cap: OwnedHttpRequest): boolean {
  return ownedHttpSelectionPermits?.get(permit) === cap;
}
export async function selectOwnedHttpProvider(cap: OwnedHttpRequest, request: Request, env: Env,
  selection: import("./authority-admission.ts").AdmissionSelection, recordSelection = true): Promise<GenerationSelectionHandle> {
  checkOwnedHttpRequest(cap, request, env);
  growOwnedHttpRequest(cap, 2048);
  const permit = Object.freeze({});
  (ownedHttpSelectionPermits ??= new WeakMap()).set(permit, cap); ownedHttpSelectionPermitCount++;
  try {
    if (!ownsOwnedHttpSelectionPermit(permit, cap)) throw ownedHttpIdentityFailure("protocol");
    return await selectOwnedHttpIdentity(cap, request, env, selection, recordSelection, permit);
  } finally {
    ownedHttpSelectionPermits!.delete(permit);
    if (!--ownedHttpSelectionPermitCount) ownedHttpSelectionPermits = undefined;
  }
}


interface OwnedHttpProviderCommand {
  cap?: OwnedHttpRequest; request?: Request; env?: Env; selection?: ProxySelection; query?: ProxyQuery;
  preparation?: PreparationAdmission; selected?: GenerationSelectionHandle;
}
let ownedHttpProviderCommands: WeakMap<object, OwnedHttpProviderCommand> | undefined;
let ownedHttpPreparationCredits: WeakSet<OwnedHttpRequest> | undefined;
let ownedHttpPreparationCreditCount = 0;

// Manifest-derived cells plus the existing bounded preparation profile. This
// component remains under the HTTP request after copies become prepared fields.
function ownedHttpPreparationBytes(selection: ProxySelection): number {
  const provider = selection.provider, endpoint = selection.endpoint;
  let pairs = 0, units = 0;
  const count = (fields: Readonly<Record<string, string>> | undefined) => {
    if (fields) for (const key in fields) if (Object.hasOwn(fields, key)) { pairs++; units += key.length + fields[key].length; }
  };
  count(provider.adapter.injectHeaders); count(provider.adapter.injectQuery); count(endpoint.headers); count(endpoint.query);
  for (const kind in provider.auth.grantTransports) if (Object.hasOwn(provider.auth.grantTransports, kind)) {
    const transport = provider.auth.grantTransports[kind]; count(transport.headers); count(transport.appendHeaders); count(transport.endpointPaths);
  }
  for (const key of provider.config_keys) units += key.length;
  for (const key of provider.optional_config_keys) units += key.length;
  // CSV/facts/substitution/path/query/header limits are the SAME acquired
  // PreparationAdmission profile; no unbounded Env split runs without it.
  return 65536 + 8 * (2048 + 4 * pairs + provider.models.length)
    + 2 * (65536 + 2 * 32768 + 256 * 16384 + 4 * units + 4 * 8192 + 4 * 16384);
}

// Full admission can commit the initial selection. Its known HTTP preparation
// component must therefore be admitted BEFORE that RPC, not on its return.
// The genuine proxy invocation validates this exact borrowed selection.
export function reserveOwnedHttpProviderPreparation(cap: OwnedHttpRequest, request: Request, env: Env,
  selection: ProxySelection): void {
  checkOwnedHttpRequest(cap, request, env); checkOwnedHttpProviderInput(cap, request, env, selection);
  if (ownedHttpPreparationCredits?.has(cap)) throw ownedHttpIdentityFailure("protocol");
  reserveOwnedHttpSerialization(cap, selection.body as Record<string, unknown>);
  growOwnedHttpRequest(cap, ownedHttpPreparationBytes(selection) + 8192);
  (ownedHttpPreparationCredits ??= new WeakSet()).add(cap); ownedHttpPreparationCreditCount++;
}

export function retireOwnedHttpProviderPreparation(cap: OwnedHttpRequest): boolean {
  if (!ownedHttpPreparationCredits?.delete(cap)) return false;
  if (!--ownedHttpPreparationCreditCount) ownedHttpPreparationCredits = undefined;
  // Metadata/copies remain backed by the HTTP owner until its actual retirement.
  return true;
}

/** Closed private attempt: selection -> foreground credential -> preparation. */
export async function prepareOwnedHttpProvider(cap: OwnedHttpRequest, request: Request, env: Env,
  input: import("./authority-admission.ts").AdmissionSelection, selection: ProxySelection, query: ProxyQuery,
  recordSelection = true, force = false): Promise<void> {
  checkOwnedHttpRequest(cap, request, env); checkOwnedHttpProviderInput(cap, request, env, selection);
  // Initial preparation consumes its pre-admission receipt. An alternate owns
  // a new complete component before its own selection/effects can start.
  if (!retireOwnedHttpProviderPreparation(cap)) {
    reserveOwnedHttpSerialization(cap, selection.body as Record<string, unknown>);
    growOwnedHttpRequest(cap, ownedHttpPreparationBytes(selection) + 8192);
  }
  const permit = Object.freeze({}), command: OwnedHttpProviderCommand = { cap, request, env, selection, query };
  (ownedHttpSelectionPermits ??= new WeakMap()).set(permit, cap); ownedHttpSelectionPermitCount++;
  (ownedHttpProviderCommands ??= new WeakMap()).set(permit, command);
  let credential: OwnedHttpCredential | undefined, hasPrimary = false, primary: unknown;
  try {
    const preparation = selection.preparation ??= new PreparationAdmission(); command.preparation = preparation;
    preparation.paths(selection.pathParams, selection.endpoint.path_param_styles);
    reserveOwnedHttpForeground(cap, request, env);
    command.selected = await selectOwnedHttpIdentity(cap, request, env, input, recordSelection, permit);
    credential = prepareOwnedHttpCredential(cap, request, env, command.selected, permit,
      force || selection.provider.id === "anthropic-vertex");
    const original = prepareOwnedHttpGrantCredentials(credential); credential = undefined;
    void original.then(() => undefined, () => undefined); await original;
  } catch (error) { hasPrimary = true; primary = error; }
  const failures: unknown[] = [];
  try { credential?.dispose(); } catch (error) { failures.push(error); }
  command.selected = undefined; command.preparation = undefined; command.query = undefined; command.selection = undefined;
  command.request = undefined; command.env = undefined; command.cap = undefined;
  ownedHttpProviderCommands!.delete(permit); ownedHttpSelectionPermits!.delete(permit);
  if (!--ownedHttpSelectionPermitCount) { ownedHttpSelectionPermits = undefined; ownedHttpProviderCommands = undefined; }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned HTTP provider cleanup");
  if (hasPrimary) throw primary;
}

// Only a genuine provider permit receives this fixed message from the selected
// owner. No caller callback, raw graph getter or fulfilled graph promise exists.
export async function consumeOwnedHttpProviderCredential(permit: object, cap: OwnedHttpRequest,
  auth: AuthorizedIdentity, connection: ProviderConnection | undefined,
  result: import("./grant-eligibility.ts").GrantSelectionResult, grant: UpstreamGrant | null): Promise<void> {
  const command = ownedHttpProviderCommands?.get(permit);
  if (!command || command.cap !== cap || !ownsOwnedHttpSelectionPermit(permit, cap) || !command.selected) throw ownedHttpIdentityFailure("protocol");
  const selection = command.selection!, provider = selection.provider, env = command.env!, preparation = command.preparation!;
  const key = result.selected?.key ?? null;
  if (key !== null && !command.selected.matchesKey(key) || !!key !== !!grant) throw ownedHttpIdentityFailure("protocol");
  if (grant && !grantsVisibleToPolicies([{ key: key!, grant }], [{ policyId: auth.policyId, policy: auth.policy }]).length)
    throw new HttpError(503, "upstream_grant_changed", "shared subscription owner changed");
  const requirement: GrantRequirement = { provider, endpoint: selection.endpoint, mode: "http", model: selectionUpstreamModelForOwned(selection), managedLifecycle: !!selection.endpoint.lifecycle };
  if (!grant && result.hasConfiguredGrant) {
    if (!auth.policy.grantRouting?.environmentFallback) throw grantPoolUnavailable(provider, result.retryAt);
    try { assertOperationConfiguration(requirement, null, env, preparation); configuredUpstream(provider, null, env, undefined, preparation); }
    catch (error) { if (isPreparationLimit(error) || isIdentityFailure(error)) throw error; throw grantPoolUnavailable(provider, result.retryAt); }
  }
  assertOperationConfiguration(requirement, grant, env, preparation);
  let upstream: UpstreamAuth | undefined = configuredUpstream(provider, grant, env, undefined, preparation);
  upstream.grantKey = key; upstream.grantRevision = grant ? grantRevision(grant) : null;
  try {
    await acceptOwnedHttpConfiguredProvider(cap, command.request!, env, selection, command.query!, auth,
      connection ?? { providerId: provider.id, enabled: true }, upstream, preparation, permit, command.selected);
  } finally { upstream = undefined; grant = null; result = undefined as never; auth = undefined as never; connection = undefined; }
}
function selectionUpstreamModelForOwned(selection: ProxySelection): string | null {
  return !Array.isArray(selection.body) && typeof selection.body.model === "string" ? selection.body.model
    : selection.pathParams.model ?? selection.pathParams.deployment ?? selection.pathParams.model_id ?? null;
}
