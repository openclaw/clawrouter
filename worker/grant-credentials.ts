import type { Env, RefreshConfig, UpstreamGrant } from "./types";
import { errorResponse, HttpError, json, readJson } from "./utils.ts";

const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_REFRESH_RESPONSE_BYTES = 128 * 1024;

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
  grant: UpstreamGrant;
  legacy?: UpstreamGrant | null;
  providerId: string;
  refresh?: RefreshConfig | null;
  force: boolean;
  expectedGeneration?: number | null;
}

interface PutRequest {
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

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/put") {
        const current = await this.state.storage.get<CredentialRecord>("credential");
        const input = await readJson<PutRequest>(request);
        const record = current && (input.preserveUnspecifiedSecrets || !hasPrimaryCredential(input.grant))
          ? updatedCredentialRecord(current, input.grant)
          : credentialRecord(input.grant, (current?.generation ?? 0) + 1);
        await this.state.storage.put("credential", record);
        return json({ projection: credentialProjection(record) });
      }
      if (path === "/materialize") return json(await this.materialize(await readJson<MaterializeRequest>(request)));
      if (path === "/revoke") {
        await this.state.storage.delete("credential");
        return new Response("revoked");
      }
      return errorResponse("route_not_found", "route not found", 404);
    } catch (error) {
      if (error instanceof ReauthorizationRequired) return errorResponse(error.code, error.message, error.status, { projection: error.projection });
      if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
      return errorResponse("credential_owner_error", "grant credential operation failed", 500);
    }
  }

  private async materialize(input: MaterializeRequest): Promise<OwnerResponse> {
    let record = await this.state.storage.get<CredentialRecord>("credential");
    let migrated = false;
    if (!record && input.legacy && hasPrimaryCredential(input.legacy)) {
      record = credentialRecord(input.legacy, 1);
      await this.state.storage.put("credential", record);
      migrated = true;
    }
    if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
    if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));

    const expected = input.expectedGeneration;
    const mayForce = input.force && (expected != null ? expected === record.generation : migrated || !input.legacy);
    const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
    const expiring = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
    let changed = false;
    if (mayForce || expiring) {
      if (!record.refreshToken) {
        if (mayForce) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no refresh token");
      } else {
        record = await this.refresh(record, input.providerId, input.refresh ?? null);
        changed = true;
      }
    }
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

    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form,
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
      updatedAt: new Date().toISOString(),
    };
    await this.state.storage.put("credential", updated);
    return updated;
  }
}

export async function putGrantCredentials(env: Env, key: string, grant: UpstreamGrant, preserveUnspecifiedSecrets = false): Promise<UpstreamGrant> {
  const response = await ownerCall<{ projection: CredentialProjection }>(env, key, "/put", { grant, preserveUnspecifiedSecrets });
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
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REFRESH_RESPONSE_BYTES) throw new HttpError(502, "grant_refresh_failed", "provider refresh response was invalid");
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REFRESH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HttpError(502, "grant_refresh_failed", "provider refresh response was invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function permanentRefreshFailure(status: number, code: unknown): boolean {
  return [400, 401].includes(status) && typeof code === "string" && ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(code);
}
