import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import { authorityCall } from "./authority.ts";
import { grantCoolingDown, grantQuotaRatio, observeGrantQuota, observeGrantQuotaProbe } from "./grant-quota.ts";
import { applyProviderCredential, applyTransportHeaders, requiredGrantTemplate, transformTransportBody, transportForGrant } from "./provider-auth.ts";
import type { CompiledGrantTransport, CompiledProvider, Env, GrantRuntimeState, ProviderSnapshot, RefreshConfig, UpstreamGrant } from "./types";
import { errorResponse, HttpError, json, readJson } from "./utils.ts";

const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_REFRESH_RESPONSE_BYTES = 128 * 1024;
const MIN_ALARM_DELAY_MS = 1_000;
const MAX_MAINTENANCE_FAILURES = 6;
const snapshot = snapshotJson as unknown as ProviderSnapshot;

interface CredentialRecord {
  version: 1;
  generation: number;
  status: "active" | "reauth_required";
  credential?: string | null;
  credentials?: Record<string, string>;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  refresh?: UpstreamGrant["refresh"];
  createdAt?: string | null;
  updatedAt: string;
  grantKey?: string;
  providerId?: string | null;
  kind?: UpstreamGrant["kind"];
  maintenance?: { keepWarm: boolean };
  nextQuotaProbeAt?: string | null;
  nextKeepWarmAt?: string | null;
  nextRefreshAttemptAt?: string | null;
  quotaFailureCount?: number;
}

export interface CredentialProjection {
  credentialStore: "durable_object";
  credentialGeneration: number;
  credentialStatus: "active" | "reauth_required";
  hasCredential: boolean;
  credentialFields: string[];
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  tokenType?: string;
  expiresAt?: string | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  refresh?: UpstreamGrant["refresh"];
  createdAt?: string | null;
  updatedAt: string;
}

interface OwnerResponse {
  grant: UpstreamGrant;
  projection: CredentialProjection;
  changed: boolean;
  migrated: boolean;
}

interface MaterializeRequest {
  key: string;
  grant: UpstreamGrant;
  legacy?: UpstreamGrant | null;
  providerId: string;
  refresh?: RefreshConfig | null;
  force: boolean;
  expectedGeneration?: number | null;
}

interface PutRequest {
  key: string;
  grant: UpstreamGrant;
  preserveUnspecifiedSecrets: boolean;
}

class OwnerHttpError extends HttpError {
  projection?: CredentialProjection;
}

class ReauthorizationRequired extends HttpError {
  projection: CredentialProjection;

  constructor(message: string, projection: CredentialProjection) {
    super(401, "grant_reauthorization_required", message);
    this.projection = projection;
  }
}

export class GrantCredentialObject implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private tail: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const operation = this.tail.then(() => this.handle(request));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  alarm(): Promise<void> {
    const operation = this.tail.then(() => this.maintain());
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/put") {
        const current = await this.state.storage.get<CredentialRecord>("credential");
        const input = await readJson<PutRequest>(request);
        let record = current && (input.preserveUnspecifiedSecrets || !hasPrimaryCredential(input.grant))
          ? updatedCredentialRecord(current, input.grant)
          : credentialRecord(input.grant, (current?.generation ?? 0) + 1);
        record = ownerMetadata(record, input.grant, input.key);
        await this.state.storage.put("credential", record);
        await this.schedule(record);
        return json({ projection: credentialProjection(record) });
      }
      if (path === "/materialize") return json(await this.materialize(await readJson<MaterializeRequest>(request)));
      if (path === "/revoke") {
        await this.state.storage.delete("credential");
        await this.state.storage.deleteAlarm();
        return new Response("revoked");
      }
      return errorResponse("route_not_found", "route not found", 404);
    } catch (error) {
      if (error instanceof ReauthorizationRequired) return errorResponse(error.code, error.message, error.status, { projection: error.projection });
      if (error instanceof HttpError) {
        const record = await this.state.storage.get<CredentialRecord>("credential");
        return errorResponse(error.code, error.message, error.status, record ? { projection: credentialProjection(record) } : undefined);
      }
      return errorResponse("credential_owner_error", "grant credential operation failed", 500);
    }
  }

  private async materialize(input: MaterializeRequest): Promise<OwnerResponse> {
    let record = await this.state.storage.get<CredentialRecord>("credential");
    let migrated = false;
    if (!record && input.legacy && hasPrimaryCredential(input.legacy)) {
      record = ownerMetadata(credentialRecord(input.legacy, 1), input.legacy, input.key);
      await this.state.storage.put("credential", record);
      migrated = true;
    }
    if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
    if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));
    const adopted = ownerMetadata(record, input.grant, input.key);
    const metadataChanged = maintenanceMetadataChanged(record, adopted);
    if (metadataChanged) {
      record = adopted;
      await this.state.storage.put("credential", record);
    }

    const expected = input.expectedGeneration;
    const mayForce = input.force && (expected != null ? expected === record.generation : migrated || !input.legacy);
    const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
    const expiring = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
    const deferredRefresh = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) > Date.now() : false;
    let changed = false;
    if (mayForce || expiring) {
      if (!record.refreshToken) {
        if (mayForce) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no refresh token");
      } else if (!mayForce && deferredRefresh) {
        throw new HttpError(502, "grant_refresh_failed", `provider ${input.providerId} refresh is waiting for its retry window`);
      } else {
        try {
          record = await this.refresh(record, input.providerId, input.refresh ?? null);
          changed = true;
        } catch (error) {
          record = await this.state.storage.get<CredentialRecord>("credential") ?? record;
          if (record.status !== "reauth_required") {
            record.nextRefreshAttemptAt = new Date(Date.now() + REFRESH_MARGIN_MS).toISOString();
            await this.state.storage.put("credential", record);
            await this.schedule(record);
          } else await this.state.storage.deleteAlarm();
          throw error;
        }
      }
    }
    if (changed || migrated || metadataChanged) await this.schedule(record);
    return { grant: materializedGrant(input.grant, record), projection: credentialProjection(record), changed, migrated };
  }

  private async refresh(record: CredentialRecord, providerId: string, providerRefresh: RefreshConfig | null): Promise<CredentialRecord> {
    const config = record.refresh ?? providerRefresh;
    if (!config?.tokenUrl) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no approved refresh configuration");
    const clientId = config.clientId ?? (config.clientIdConfig ? envValue(this.env, config.clientIdConfig) : null);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken! });
    if (clientId) form.set("client_id", clientId);
    if (config.clientSecretConfig) {
      const secret = envValue(this.env, config.clientSecretConfig);
      if (!secret) throw new HttpError(503, "provider_not_configured", `missing refresh client secret ${config.clientSecretConfig}`);
      form.set("client_secret", secret);
    }
    for (const [name, value] of Object.entries(config.extraParams ?? {})) form.set(name, value);

    const requestFormat = config.requestFormat ?? "form";
    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "content-type": requestFormat === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
        body: requestFormat === "json" ? JSON.stringify(Object.fromEntries(form)) : form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }
    let payload: Record<string, unknown>;
    try { payload = await boundedRefreshJson(response); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} returned an invalid refresh response`);
    }
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      if (permanentRefreshFailure(response.status, payload.error)) {
        const rejected = { ...record, status: "reauth_required" as const, generation: record.generation + 1, updatedAt: new Date().toISOString() };
        await this.state.storage.put("credential", rejected);
        throw new ReauthorizationRequired(`provider ${providerId} requires grant reauthorization`, credentialProjection(rejected));
      }
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }

    const updated: CredentialRecord = {
      ...record,
      status: "active",
      generation: record.generation + 1,
      accessToken: boundedSecret(payload.access_token, "access token"),
      refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token
        ? boundedSecret(payload.refresh_token, "refresh token")
        : record.refreshToken,
      tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : record.tokenType,
      scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean).slice(0, 128) : record.scopes,
      expiresAt: typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1_000).toISOString()
        : record.expiresAt,
      nextRefreshAttemptAt: null,
      updatedAt: new Date().toISOString(),
    };
    await this.state.storage.put("credential", updated);
    return updated;
  }

  private async maintain(): Promise<void> {
    let record = await this.state.storage.get<CredentialRecord>("credential");
    if (!record?.grantKey || !record.providerId || !record.kind || record.status === "reauth_required") return;
    const provider = snapshot.providers.find((candidate) => candidate.id === record!.providerId);
    const transport = provider ? transportForGrant(provider, materializedGrant({ provider: record.providerId, kind: record.kind }, record)) : null;
    if (!provider || !transport) return;
    const now = Date.now();
    const refreshAt = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) : record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN;
    if (record.refreshToken && Number.isFinite(refreshAt) && refreshAt <= now) {
      try { record = { ...await this.refresh(record, provider.id, provider.auth.refresh), nextRefreshAttemptAt: null }; }
      catch {
        record = await this.state.storage.get<CredentialRecord>("credential") ?? record;
        if (record.status !== "reauth_required") {
          record.nextRefreshAttemptAt = new Date(now + REFRESH_MARGIN_MS).toISOString();
          await this.state.storage.put("credential", record);
        }
      }
      await this.publishProjection(record);
      if (record.status === "reauth_required") {
        await this.state.storage.deleteAlarm();
        return;
      }
    }
    if (due(record.nextQuotaProbeAt, now) && transport.maintenance.quotaPoll) {
      try {
        const state = await probeQuota(this.env, provider, transport, record);
        record.quotaFailureCount = 0;
        record.nextQuotaProbeAt = new Date(now + quotaInterval(transport, state)).toISOString();
      } catch {
        record.quotaFailureCount = Math.min(MAX_MAINTENANCE_FAILURES, (record.quotaFailureCount ?? 0) + 1);
        const normal = transport.maintenance.quotaPoll.normalIntervalSeconds * 1_000;
        record.nextQuotaProbeAt = new Date(now + Math.min(transport.maintenance.quotaPoll.exhaustedIntervalSeconds * 1_000, normal * 2 ** record.quotaFailureCount)).toISOString();
      }
    }
    if (record.maintenance?.keepWarm && due(record.nextKeepWarmAt, now) && transport.maintenance.keepWarm) {
      try { await keepWarm(this.env, provider, transport, record); }
      catch { /* the next regular interval retries without making alarm delivery hot-loop */ }
      record.nextKeepWarmAt = new Date(now + transport.maintenance.keepWarm.intervalSeconds * 1_000).toISOString();
    }
    await this.state.storage.put("credential", record);
    await this.schedule(record);
  }

  private async publishProjection(record: CredentialRecord): Promise<void> {
    if (!record.grantKey) return;
    const metadata = await this.env.POLICY_KV.get<UpstreamGrant>(record.grantKey, "json");
    if (metadata) await this.env.POLICY_KV.put(record.grantKey, JSON.stringify(secretlessGrant(metadata, credentialProjection(record))));
  }

  private async schedule(record: CredentialRecord): Promise<void> {
    const next = [
      record.refreshToken && record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) : record.refreshToken && record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN,
      timestamp(record.nextQuotaProbeAt),
      record.maintenance?.keepWarm ? timestamp(record.nextKeepWarmAt) : NaN,
    ].filter(Number.isFinite);
    if (!next.length || record.status === "reauth_required") {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + MIN_ALARM_DELAY_MS, Math.min(...next)));
  }
}

function ownerMetadata(record: CredentialRecord, grant: UpstreamGrant, key: string): CredentialRecord {
  const now = Date.now();
  const providerId = grant.provider ?? record.providerId ?? null;
  const kind = grant.kind ?? record.kind;
  const provider = providerId ? snapshot.providers.find((candidate) => candidate.id === providerId) : undefined;
  const transport = provider && kind ? provider.auth.grantTransports[kind] : null;
  const keepWarm = grant.maintenance?.keepWarm ?? record.maintenance?.keepWarm ?? false;
  return {
    ...record,
    grantKey: key,
    providerId,
    kind,
    maintenance: { keepWarm },
    nextQuotaProbeAt: transport?.maintenance.quotaPoll
      ? record.nextQuotaProbeAt ?? new Date(now + transport.maintenance.quotaPoll.normalIntervalSeconds * 1_000).toISOString()
      : null,
    nextKeepWarmAt: keepWarm && transport?.maintenance.keepWarm
      ? record.nextKeepWarmAt ?? new Date(now + transport.maintenance.keepWarm.intervalSeconds * 1_000).toISOString()
      : null,
    quotaFailureCount: record.quotaFailureCount ?? 0,
    nextRefreshAttemptAt: record.nextRefreshAttemptAt ?? null,
  };
}

function maintenanceMetadataChanged(left: CredentialRecord, right: CredentialRecord): boolean {
  return left.grantKey !== right.grantKey
    || left.providerId !== right.providerId
    || left.kind !== right.kind
    || left.maintenance?.keepWarm !== right.maintenance?.keepWarm
    || left.nextQuotaProbeAt !== right.nextQuotaProbeAt
    || left.nextKeepWarmAt !== right.nextKeepWarmAt
    || left.nextRefreshAttemptAt !== right.nextRefreshAttemptAt
    || left.quotaFailureCount !== right.quotaFailureCount;
}

async function probeQuota(env: Env, provider: CompiledProvider, transport: CompiledGrantTransport, record: CredentialRecord): Promise<GrantRuntimeState> {
  const grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
  const probe = provider.quota.probes.find((candidate) => candidate.grantKinds.includes(record.kind!));
  if (!probe) throw new HttpError(400, "grant_quota_probe_unavailable", `provider ${provider.id} has no quota probe for this grant kind`);
  const headers = new Headers({ accept: "application/json" });
  const url = new URL(probe.url);
  applyProviderCredential(provider, grant, env, headers, url.searchParams);
  for (const [name, value] of Object.entries(probe.headers)) headers.set(name, requiredGrantTemplate(value, grant, "grant_quota_probe_unavailable"));
  let response: Response;
  try { response = await fetch(url, { method: probe.method, headers, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new HttpError(502, "grant_quota_probe_failed", `provider ${provider.id} quota probe failed`); }
  if (!response.ok) {
    const failure = observeGrantQuota(response, { responseHeaders: [], probes: [] });
    if (failure) await publishRuntime(env, record, { ...failure, source: "provider_probe" });
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "grant_quota_probe_failed", `provider ${provider.id} quota probe returned ${response.status}`);
  }
  const payload = await boundedResponseJson(response, MAX_REFRESH_RESPONSE_BYTES);
  const state = observeGrantQuotaProbe(payload, probe);
  if (!state) throw new HttpError(502, "grant_quota_probe_empty", `provider ${provider.id} quota probe returned no recognized windows`);
  const observed = { ...state, grantRevision: record.updatedAt };
  await publishRuntime(env, record, observed);
  return observed;
}

async function keepWarm(env: Env, provider: CompiledProvider, transport: CompiledGrantTransport, record: CredentialRecord): Promise<void> {
  const config = transport.maintenance.keepWarm;
  if (!config || !record.grantKey) return;
  const states = await authorityCall<{ states: Record<string, GrantRuntimeState> }>(env, "/grant-pools/states", { keys: [record.grantKey] });
  const runtime = states.states[record.grantKey];
  if (grantCoolingDown(runtime) || (grantQuotaRatio(runtime) ?? 1) <= 0.1) return;
  const endpoint = provider.endpoints.find((candidate) => candidate.id === config.endpoint);
  if (!endpoint) throw new HttpError(500, "grant_maintenance_invalid", `provider ${provider.id} keep-warm endpoint is unavailable`);
  const grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
  const headers = new Headers({ "content-type": "application/json" });
  const query = new URLSearchParams();
  applyProviderCredential(provider, grant, env, headers, query);
  for (const [name, value] of Object.entries(provider.adapter.injectHeaders)) headers.set(name, resolveProviderTemplate(provider, value, env));
  for (const [name, value] of Object.entries(endpoint.headers)) headers.set(name, resolveProviderTemplate(provider, value, env));
  applyTransportHeaders(headers, transport, grant);
  const path = transport.endpointPaths[endpoint.id] ?? endpoint.path;
  const url = new URL(`${(transport.baseUrl ?? resolveProviderTemplate(provider, provider.base_urls.default, env)).replace(/\/$/, "")}${resolveProviderTemplate(provider, path, env)}`);
  query.forEach((value, name) => url.searchParams.set(name, value));
  const body = transformTransportBody(transport, structuredClone(config.body));
  let response: Response;
  try { response = await fetch(url, { method: endpoint.method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
  catch { throw new HttpError(502, "grant_keep_warm_failed", `provider ${provider.id} keep-warm request failed`); }
  const state = observeGrantQuota(response, provider.quota);
  if (state) await publishRuntime(env, record, state);
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new HttpError(502, "grant_keep_warm_failed", `provider ${provider.id} keep-warm request returned ${response.status}`);
}

async function publishRuntime(env: Env, record: CredentialRecord, state: GrantRuntimeState): Promise<void> {
  if (!record.grantKey) return;
  await authorityCall(env, "/grant-pools/feedback", { key: record.grantKey, state: { ...state, grantRevision: record.updatedAt } });
}

function quotaInterval(transport: CompiledGrantTransport, state: GrantRuntimeState): number {
  const config = transport.maintenance.quotaPoll!;
  if (state.status === "cooldown") return config.exhaustedIntervalSeconds * 1_000;
  const ratio = grantQuotaRatio(state, Date.now(), Number.MAX_SAFE_INTEGER);
  return (ratio !== null && ratio * 100 <= config.urgentRemainingPercent ? config.urgentIntervalSeconds : config.normalIntervalSeconds) * 1_000;
}

function resolveProviderTemplate(provider: CompiledProvider, value: string, env: Env): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const normalized = name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    const key = provider.config_keys.find((candidate) => candidate === normalized || candidate.endsWith(`_${normalized}`));
    const resolved = key ? envValue(env, key) : null;
    if (!resolved) throw new HttpError(503, "provider_not_configured", `missing Cloudflare config value ${name} for provider ${provider.id}`);
    return resolved;
  });
}

function timestamp(value: string | null | undefined): number {
  return value ? Date.parse(value) : NaN;
}

function due(value: string | null | undefined, now: number): boolean {
  const parsed = timestamp(value);
  return Number.isFinite(parsed) && parsed <= now;
}

export async function putGrantCredentials(env: Env, key: string, grant: UpstreamGrant, preserveUnspecifiedSecrets = false): Promise<UpstreamGrant> {
  const response = await ownerCall<{ projection: CredentialProjection }>(env, key, "/put", { key, grant, preserveUnspecifiedSecrets });
  return secretlessGrant(grant, response.projection);
}

export async function materializeGrantCredentials(
  env: Env,
  key: string,
  grant: UpstreamGrant,
  providerId: string,
  refresh: RefreshConfig | null,
  force: boolean,
): Promise<UpstreamGrant> {
  const legacy = hasRawCredential(grant) ? grant : null;
  try {
    const response = await ownerCall<OwnerResponse>(env, key, "/materialize", {
      key,
      grant,
      legacy,
      providerId,
      refresh,
      force,
      expectedGeneration: grant.credentialGeneration ?? null,
    });
    if (response.changed || response.migrated || grant.credentialGeneration !== response.projection.credentialGeneration) {
      await env.POLICY_KV.put(key, JSON.stringify(secretlessGrant(grant, response.projection)));
    }
    return response.grant;
  } catch (error) {
    if (error instanceof OwnerHttpError && error.projection) {
      await env.POLICY_KV.put(key, JSON.stringify(secretlessGrant(grant, error.projection)));
    }
    throw error;
  }
}

export async function revokeGrantCredentials(env: Env, key: string): Promise<void> {
  await ownerCall(env, key, "/revoke", {});
}

export function secretlessGrant(grant: UpstreamGrant, projection?: CredentialProjection): UpstreamGrant {
  const { credential: _credential, credentials: _credentials, accessToken: _accessToken, refreshToken: _refreshToken, ...safe } = grant;
  return projection ? { ...safe, ...projection } : safe;
}

export function hasRawCredential(grant: UpstreamGrant): boolean {
  return grant.credential != null || grant.accessToken != null || grant.refreshToken != null || Object.keys(grant.credentials ?? {}).length > 0;
}

function credentialRecord(grant: UpstreamGrant, generation: number): CredentialRecord {
  if (!hasPrimaryCredential(grant)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  const now = new Date().toISOString();
  const credentials = grant.credentials && Object.keys(grant.credentials).length ? normalizedCredentials(grant.credentials) : undefined;
  return {
    version: 1,
    generation,
    status: "active",
    credential: optionalSecret(grant.credential, "credential"),
    credentials,
    accessToken: optionalSecret(grant.accessToken, "access token"),
    refreshToken: optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType,
    expiresAt: validTimestamp(grant.expiresAt),
    scopes: normalizedScopes(grant.scopes),
    accountId: grant.accountId,
    subscription: grant.subscription,
    refresh: grant.refresh,
    createdAt: grant.createdAt ?? now,
    updatedAt: grant.updatedAt ?? now,
  };
}

function updatedCredentialRecord(current: CredentialRecord | undefined, grant: UpstreamGrant): CredentialRecord {
  if (!current) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  const updated: CredentialRecord = {
    ...current,
    generation: current.generation + 1,
    status: "active",
    credential: grant.credential === undefined ? current.credential : optionalSecret(grant.credential, "credential"),
    credentials: grant.credentials && Object.keys(grant.credentials).length ? normalizedCredentials(grant.credentials) : current.credentials,
    accessToken: grant.accessToken === undefined ? current.accessToken : optionalSecret(grant.accessToken, "access token"),
    refreshToken: grant.refreshToken === undefined ? current.refreshToken : optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType ?? current.tokenType,
    expiresAt: grant.expiresAt === undefined ? current.expiresAt : validTimestamp(grant.expiresAt),
    scopes: grant.scopes === undefined ? current.scopes : normalizedScopes(grant.scopes),
    accountId: grant.accountId === undefined ? current.accountId : grant.accountId,
    subscription: grant.subscription === undefined ? current.subscription : grant.subscription,
    refresh: grant.refresh === undefined ? current.refresh : grant.refresh,
    updatedAt: grant.updatedAt ?? new Date().toISOString(),
  };
  if (![updated.credential, updated.accessToken, ...Object.values(updated.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  return updated;
}

function credentialProjection(record: CredentialRecord): CredentialProjection {
  return {
    credentialStore: "durable_object",
    credentialGeneration: record.generation,
    credentialStatus: record.status,
    hasCredential: !!record.credential || Object.keys(record.credentials ?? {}).length > 0,
    credentialFields: Object.keys(record.credentials ?? {}).sort(),
    hasAccessToken: !!record.accessToken,
    hasRefreshToken: !!record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    scopes: record.scopes,
    accountId: record.accountId,
    subscription: record.subscription,
    refresh: record.refresh,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function materializedGrant(metadata: UpstreamGrant, record: CredentialRecord): UpstreamGrant {
  return {
    ...metadata,
    credential: record.credential,
    credentials: record.credentials,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    scopes: record.scopes,
    accountId: record.accountId,
    subscription: record.subscription,
    refresh: record.refresh,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    credentialGeneration: record.generation,
    credentialStatus: record.status,
  };
}

async function ownerCall<T>(env: Env, key: string, path: string, body: unknown): Promise<T> {
  const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key));
  const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; detail?: { projection?: CredentialProjection } } } = {};
    try { payload = JSON.parse(text); } catch { /* redacted internal error */ }
    const error = new OwnerHttpError(response.status, payload.error?.code ?? "credential_owner_error", payload.error?.message ?? "grant credential operation failed");
    error.projection = payload.error?.detail?.projection;
    throw error;
  }
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

function hasPrimaryCredential(grant: UpstreamGrant): boolean {
  return [grant.credential, grant.accessToken, ...Object.values(grant.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0);
}

function normalizedCredentials(value: Record<string, string>): Record<string, string> {
  if (Array.isArray(value) || typeof value !== "object") throw new HttpError(400, "invalid_upstream_grant", "credential bundle must be an object");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) throw new HttpError(400, "invalid_upstream_grant", "credential bundle must contain 1 to 32 fields");
  return Object.fromEntries(entries.map(([name, secret]) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new HttpError(400, "invalid_upstream_grant", "credential bundle contains an invalid field name");
    return [name, boundedSecret(secret, `credential ${name}`)];
  }));
}

function normalizedScopes(value: string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128 || value.some((scope) => typeof scope !== "string" || !scope || scope.length > 512)) throw new HttpError(400, "invalid_upstream_grant", "grant scopes are invalid");
  return [...new Set(value)];
}

function optionalSecret(value: string | null | undefined, name: string): string | null | undefined {
  return value == null ? value : boundedSecret(value, name);
}

function boundedSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) throw new HttpError(400, "invalid_upstream_grant", `${name} must be a non-empty bounded string`);
  return value;
}

function validTimestamp(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (!Number.isFinite(Date.parse(value))) throw new HttpError(400, "invalid_upstream_grant", "grant expiry is invalid");
  return new Date(value).toISOString();
}

function envValue(env: Env, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function boundedRefreshJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await boundedResponseJson(response, MAX_REFRESH_RESPONSE_BYTES);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    throw new HttpError(502, "grant_refresh_failed", "provider refresh response was invalid");
  }
}

async function boundedResponseJson(response: Response, limit: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new HttpError(502, "grant_response_invalid", "provider response was invalid");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(502, "grant_response_invalid", "provider response was invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const value = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

function permanentRefreshFailure(status: number, code: unknown): boolean {
  return [400, 401].includes(status) && typeof code === "string" && ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(code);
}
