import { authorizationTimestamp, refreshExpiryFromSeconds } from "../shared/refresh-expiry.ts";
import { credentialProjection, materializedGrant, hasFreshPrimaryCredentials, type CredentialRecord, type CredentialProjection, type OwnerResponse, type MaterializeRequest, type PutRequest } from "./grant-credential-record.ts";
export type { CredentialProjection } from "./grant-credential-record.ts";
import { claimRefreshOwnership, reserveRefreshOwnership, OWNERSHIP_CLAIM, OWNERSHIP_CURRENT } from "./refresh-ownership.ts";
import { normalizedScopes, validTimestamp, envValue, boundedSecret, optionalSecret, boundedRefreshJson, boundedResponseJson, MAX_REFRESH_RESPONSE_BYTES, permanentRefreshFailure, safeOAuthError, refreshRetryAt } from "./grant-refresh-diagnosis.ts";
import { routingProjection } from "./grant-projection.ts";
import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import { authorityCall, type GrantAttachmentResult, type GrantAttachmentSnapshot, type GrantAttachmentStatus } from "./authority.ts";
import { grantCoolingDown, grantQuotaExhausted, grantQuotaRatio, observeGrantQuota, observeGrantQuotaProbe, quotaRuntime } from "./grant-quota.ts";
import { grantUsable, REFRESH_MARGIN_MS } from "./grant-selection.ts";
import { applyProviderCredential, applyTransportHeaders, quotaProbeForGrant, quotaProbesForGrant, requiredGrantTemplate, transformTransportBody, transportForGrant } from "./provider-auth.ts";
import type { CompiledGrantTransport, CompiledProvider, Env, GrantRuntimeState, ProviderSnapshot, RefreshConfig, UpstreamGrant } from "./types";
import { errorResponse, HttpError, json, readJson } from "./utils.ts";
import { applyTemplateHeaders, resolveTemplate } from "./provider-templates.ts";
import type { ResponseControlDispatch } from "./responses-control-dispatch.ts";
import { HttpOperation } from "./http-operation.ts";

const MAX_LEGACY_GRANT_BYTES = 3 * 1024 * 1024;
const MIN_ALARM_DELAY_MS = 1_000;
const MAX_MAINTENANCE_FAILURES = 6;
const snapshot = snapshotJson as unknown as ProviderSnapshot;

export type GrantRevokeMetadata = Pick<UpstreamGrant, "kind" | "provider" | "label">;

class SupersededRefresh extends Error {
  readonly current: CredentialRecord;
  constructor(current: CredentialRecord) { super("refresh generation superseded"); this.current = current; }
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
    if (request.method === "POST" && new URL(request.url).pathname === OWNERSHIP_CURRENT) {
      return this.state.storage.get<CredentialRecord>("credential").then(record => json({ exists: !!record, refreshToken: record?.refreshToken ?? null }));
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/responses/control") {
      const operation = this.tail.then(async () => {
        let preparation = new HttpOperation(request.signal, 10_000);
        try {
          const input = await preparation.wait(readJson<ResponseControlDispatch>(request));
          const { prepareResponseControl, assertControlDeadline } = await import("./responses-control-dispatch.ts");
          const { assertControlCallerLive, authorizeResponseControl } = await import("./response-control-authorization.ts");
          assertControlDeadline(input);
          if (input.deadline !== undefined) {
            preparation.stop("complete");
            preparation = new HttpOperation(request.signal, Math.min(10_000, input.deadline - Date.now()));
          }
          const record = await preparation.wait(this.state.storage.get<CredentialRecord>("credential"));
          // Jobs are admitted only after materialization. Polling never imports
          // legacy KV, adopts another lineage, or reselects a pool account.
          if (!record || !canonicalRecord(record) || record.grantKey !== input.owner.grantKey
            || record.providerId !== input.owner.providerId || record.lineage !== input.owner.lineage
            || record.enabled !== true || record.revokedAt || record.status !== "active" || !record.kind) {
            throw new HttpError(409, "response_owner_unavailable", "the original response credential is unavailable or changed");
          }
          const outbound = await preparation.wait(prepareResponseControl(this.env, input, materializedGrant(metadataGrant(record), record)));
          await preparation.wait(authorizeResponseControl(this.env, input.authorization, input.owner, preparation.signal));
          preparation.signal.throwIfAborted();
          assertControlDeadline(input);
          assertControlCallerLive(input.authorization);
          if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
            throw new HttpError(409, "response_owner_unavailable", "the original response credential has expired");
          }
          // Start egress before releasing the serialized credential check, but
          // never make revocation wait for the remote response or stream.
          return { response: fetch(outbound, { signal: request.signal }) };
        } catch (error) {
          return { response: Promise.resolve(error instanceof HttpError ? errorResponse(error.code, error.message, error.status)
            : errorResponse("response_owner_unavailable", "response control dispatch failed", 503)) };
        } finally { preparation.stop("complete"); }
      });
      this.tail = operation.then(() => undefined, () => undefined);
      return operation.then(result => result.response);
    }
    const operation = this.tail.then(() => this.handle(request));
    this.tail = operation.then(() => undefined, () => undefined);
    // Rotation settlement belongs to the DO, not the observing HTTP caller.
    this.state.waitUntil?.(this.tail);
    return operation;
  }

  alarm(): Promise<void> {
    const operation = this.tail.then(() => this.maintain());
    this.tail = operation.then(() => undefined, () => undefined);
    // Rotation settlement belongs to the DO, not the observing HTTP caller.
    this.state.waitUntil?.(this.tail);
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === OWNERSHIP_CLAIM) return await reserveRefreshOwnership(this.state.storage, this.env, request);
      if (path === "/put") {
        const input = await readJson<PutRequest>(request);
        const replace = input.intent === "replace";
        if (replace && !hasPrimaryCredential(input.grant)) throw new HttpError(400, "invalid_upstream_grant", "grant replacement requires a fresh primary credential");
        let current = await this.state.storage.get<CredentialRecord>("credential");
        if (current) nextCredentialGeneration(current.generation);
        let attachment: GrantAttachmentSnapshot;
        let previous: UpstreamGrant | null;
        if (replace && (!current || !canonicalRecord(current))) {
          // Recover directly into the final mutation. An incomplete old owner
          // must not publish a synthetic migration or adopt newer index facts.
          previous = current ? metadataGrant(current) : await legacyGrantMetadata(this.env, input.key, true);
          attachment = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key: input.key });
          if (current && attachment.generation > current.generation) throw new HttpError(409, "grant_attachment_changed", "attachment is newer than the credential owner; operator recovery is required");
        } else {
          await this.loadRecord(input.key, current, false);
          ({ record: current, result: attachment } = await this.reconcileAttachment(input.key));
          previous = current ? metadataGrant(current) : await legacyGrantMetadata(this.env, input.key);
        }
        if (!current && !previous) {
          // A KV miss cannot erase legacy membership, including generation zero.
          // Reconcile only a proven first proposal before admitting a new owner.
          if (attachment.generation === 0 && attachment.pending) ({ result: attachment } = await this.reconcileAttachment(input.key));
          if (attachment.generation !== 0 || attachment.attached || attachment.pending) throw new HttpError(409, "grant_attachment_changed", "upstream attachment has no recoverable credential metadata; operator recovery is required");
        }
        const admissionGeneration = replace && (current || previous) ? attachment.generation : current?.generation ?? 0;
        const generation = nextCredentialGeneration(current?.generation ?? (replace && previous ? attachment.generation : previous?.credentialGeneration ?? 0));
        let record = !replace && current && !current.revokedAt && (input.preserveUnspecifiedSecrets || !hasPrimaryCredential(input.grant))
          ? updatedCredentialRecord(current, input.grant)
          : credentialRecord(input.grant, generation);
        record = ownerMetadata(record, input.grant, input.key);
        if (record.refreshToken) await claimRefreshOwnership(this.env, input.key, record.refreshToken, { current: current?.refreshToken === record.refreshToken && (!current.refreshAttempt || input.grant.refreshToken === undefined) });
        const freshAuthority = !current || record.refreshToken !== current.refreshToken;
        record.credentialProvenance = freshAuthority ? input.provenance ?? "imported" : current?.credentialProvenance ?? "imported";
        // Access-only/metadata edits and same-token replacement cannot erase
        // the refresh authority's fence, rejection, diagnosis or retry floor.
        // Removing only refresh authority is not a fresh access credential.
        const retainsFailedAccess = current && (current.refreshAttempt || current.status === "reauth_required") && !record.refreshToken && !hasFreshPrimaryCredentials(current, record);
        if (current && (record.refreshToken && !freshAuthority || retainsFailedAccess)) {
          record.status = current.status; record.refreshAttempt = current.refreshAttempt;
          record.refreshDiagnosis = current.refreshDiagnosis; record.nextRefreshAttemptAt = current.nextRefreshAttemptAt;
        }
        const grant = metadataGrant(record);
        // Admission reserves capacity without removing the old attachment. A
        // failed store leaves indexed pending work for this owner to reconcile.
        const admitted = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/admit", { key: input.key, generation: admissionGeneration, revision: attachment.revision, provider: record.providerId ?? null, status: attachmentStatus(record) });
        // Only this explicit commit may acknowledge the reservation; later
        // refreshes and legacy imports cannot complete a failed account write.
        record.poolAdmissionRevision = admitted.revision;
        await this.state.storage.put("credential", record);
        await this.schedule(record);
        await this.publishProjection(record);
        return json({ grant });
      }
      if (path === "/inspect") {
        let record = await this.state.storage.get<CredentialRecord>("credential");
        if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
        record = await this.diagnoseUnsettled(record);
        if (canonicalRecord(record) && record.poolSyncPending) {
          // A derived-index outage must not conceal the owner's diagnosis.
          try { await this.publishProjection(record); } catch { /* durable pending state retries later */ }
        }
        return json({ grant: canonicalRecord(record) ? metadataGrant(record) : credentialProjection(record) });
      }
      if (path === "/materialize") return json(await this.materialize(await readJson<MaterializeRequest>(request)));
      if (path === "/quota-refresh") {
        const { key } = await readJson<{ key: string }>(request);
        await this.loadRecord(key, undefined, false);
        const { record } = await this.reconcileAttachment(key);
        if (!record || !record.providerId) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered");
        const provider = snapshot.providers.find(provider => provider.id === record.providerId);
        if (!provider) throw new HttpError(400, "unknown_provider", "upstream provider is not registered");
        const before = JSON.stringify(credentialProjection(record));
        try {
          const runtime = await this.probeQuota(provider, record);
          const transport = transportForGrant(provider, materializedGrant(metadataGrant(record), record));
          if (transport?.maintenance.quotaPoll) record.nextQuotaProbeAt = new Date(Date.now() + quotaInterval(transport, runtime)).toISOString();
          return json({ refreshed: true });
        } finally {
          await this.state.storage.put("credential", record);
          await this.schedule(record);
          if (record.poolSyncPending || before !== JSON.stringify(credentialProjection(record))) await this.publishProjection(record);
        }
      }
      if (path === "/reconcile") {
        const { key } = await readJson<{ key: string }>(request);
        await this.loadRecord(key, undefined, false);
        const { record, result } = await this.reconcileAttachment(key);
        if (record) await this.publishProjection(record);
        return json(result);
      }
      if (path === "/revoke") {
        const { key, metadata } = await readJson<{ key: string; metadata?: GrantRevokeMetadata }>(request);
        // An unavailable index must not block deleting an owner's secrets.
        const current = await this.state.storage.get<CredentialRecord>("credential");
        const legacy = !current || !current.metadata || current.enabled === undefined ? await legacyGrantMetadata(this.env, key, true) : null;
        // Old owner identity wins over KV and hints. Prepare missing metadata
        // in memory so the first durable write already contains no secrets.
        const previous = current ? metadataGrant({ ...current, metadata: current.metadata ?? legacy ?? {}, revokedAt: current.revokedAt ?? legacy?.revokedAt }) : legacy;
        if (!previous) throw new HttpError(404, "unknown_upstream_grant", "upstream grant is not registered");
        // Legacy CLI hints identify a record that has no owner. Once owned, its
        // canonical identity and an existing tombstone cannot be overwritten.
        // A failed reconnect can leave pending admission after a clean revoke.
        const generation = current?.generation ?? (await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key })).generation;
        if (!current?.revokedAt) nextCredentialGeneration(generation);
        const record = current?.revokedAt
          ? { ...current, metadata: current.metadata ?? stripLegacySecrets(previous) as UpstreamGrant, lineage: current.lineage ?? crypto.randomUUID(), poolSyncPending: true }
          : revokedRecord(key, current ? previous : { ...previous, ...metadata }, generation);
        // Never erase the tombstone or restore secrets when a derived write fails.
        // Retrying revoke republishes this same generation after partial failure.
        await this.state.storage.put("credential", record);
        await this.state.storage.deleteAlarm();
        await this.publishProjection(record);
        return json({ grant: metadataGrant(record) });
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
    let record = await this.loadRecord(input.key);
    let migrated = false;
    if (!record && input.legacy && hasPrimaryCredential(input.legacy)) {
      const metadata = await this.env.POLICY_KV.get<UpstreamGrant>(input.key, "json");
      if (metadata?.revokedAt) record = revokedRecord(input.key, metadata);
      else if (metadata && hasPrimaryCredential(metadata)) record = ownerMetadata(credentialRecord(metadata, 1), metadata, input.key);
      if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
      if (record.refreshToken) await claimRefreshOwnership(this.env, input.key, record.refreshToken);
      await this.state.storage.put("credential", record);
      record = (await this.reconcileAttachment(input.key)).record!;
      migrated = true;
    }
    if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
    // Materialization may rotate tokens, but cannot adopt lifecycle state from a
    // stale KV read. Only explicit owner mutations can re-enable or reconnect.
    const stale = input.grant.credentialGeneration !== record.generation || input.grant.enabled !== record.enabled;
    let changed = false;
    try {
      assertCredentialEnabled(record);
      if (record.providerId && record.providerId !== input.providerId || record.kind !== input.grant.kind) throw new HttpError(409, "upstream_grant_changed", "upstream grant changed; retry discovery before dispatch");
      if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));

      if (record.refreshAttempt) throw new HttpError(502, "grant_refresh_at_risk", "refresh outcome is uncertain; replace with a fresh dedicated login, do not replay the stored token");
      const expected = input.expectedGeneration;
      const mayForce = input.force && (expected != null ? expected === record.generation : migrated || !input.legacy);
      const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
      const expiring = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
      const deferredRefresh = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) > Date.now() : false;
      if (mayForce || expiring) {
        if (!record.refreshToken) {
          if (mayForce) throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no refresh token");
        } else if (!mayForce && deferredRefresh) {
          throw new HttpError(502, "grant_refresh_failed", `provider ${input.providerId} refresh is waiting for its retry window`);
        } else {
          try {
            record = await this.refresh(record, input.providerId, input.refresh ?? null);
            changed = true;
            assertCredentialEnabled(record);
            if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));
          } catch (error) {
            record = await this.state.storage.get<CredentialRecord>("credential") ?? record;
            changed = true;
            if (record.status !== "reauth_required") {
              await this.deferRefresh(record);
            } else await this.state.storage.deleteAlarm();
            throw error;
          }
        }
      }
      if (changed || migrated) await this.schedule(record);
      return { grant: materializedGrant(metadataGrant(record), record) };
    } finally {
      // KV permits one write per key per second. Publish the final owner state
      // once, including failed refreshes and stale disabled/revoked reads.
      if (stale || changed || migrated || record.poolSyncPending) await this.publishProjection(record);
    }
  }

  private async refresh(record: CredentialRecord, providerId: string, providerRefresh: RefreshConfig | null): Promise<CredentialRecord> {
    try { return await this.performRefresh(record, providerId, providerRefresh); }
    catch (error) { if (error instanceof SupersededRefresh) return error.current; throw error; }
  }

  private async performRefresh(record: CredentialRecord, providerId: string, providerRefresh: RefreshConfig | null): Promise<CredentialRecord> {
    assertCredentialEnabled(record);
    // Re-read authority before every attempt; a pending marker after restart is
    // an ambiguous send, never permission to replay the old refresh token.
    const current = await this.state.storage.get<CredentialRecord>("credential");
    if (!current || current.generation !== record.generation) return current ?? record;
    if (current.refreshAttempt) {
      if (!current.refreshDiagnosis?.failure || !["ambiguous", "provider_ok_persist_failed"].includes(current.refreshDiagnosis.failure.failureClass)) {
        await this.recordRefreshFailure(current, null, "outcome_unknown", "ambiguous");
      }
      throw new HttpError(502, "grant_refresh_at_risk", "refresh outcome is uncertain; replace with a fresh dedicated login, do not replay the stored token");
    }
    if (timestamp(current.nextRefreshAttemptAt) > Date.now()) throw new HttpError(502, "grant_refresh_failed", "refresh is waiting for its retry window");
    const config = record.refresh ?? providerRefresh;
    if (!config?.tokenUrl) {
      await this.recordRefreshFailure(record, null, "invalid_client");
      throw new HttpError(400, "grant_refresh_unavailable", "upstream grant has no approved refresh configuration");
    }
    const clientId = config.clientId ?? (config.clientIdConfig ? envValue(this.env, config.clientIdConfig) : null);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken! });
    if (clientId) form.set("client_id", clientId);
    if (config.clientSecretConfig) {
      const secret = envValue(this.env, config.clientSecretConfig);
      if (!secret) {
        await this.recordRefreshFailure(record, null, "invalid_client");
        throw new HttpError(503, "provider_not_configured", `missing refresh client secret ${config.clientSecretConfig}`);
      }
      form.set("client_secret", secret);
    }
    for (const [name, value] of Object.entries(config.extraParams ?? {})) form.set(name, value);

    if (record.grantKey && record.refreshToken) await claimRefreshOwnership(this.env, record.grantKey, record.refreshToken, { current: true, consume: true });
    record = { ...record, refreshAttempt: { id: crypto.randomUUID(), generation: record.generation } };
    // Durable before egress. A crash or an unpersistable result leaves a fence.
    await this.state.storage.put("credential", record);
    const requestFormat = config.requestFormat ?? "form";
    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "content-type": requestFormat === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
        body: requestFormat === "json" ? JSON.stringify(Object.fromEntries(form)) : form,
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      });
    } catch {
      await this.recordRefreshFailure(record, null, "network_error", "ambiguous");
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }
    // A redirect is a transient endpoint failure, never evidence of token revocation.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      await this.recordRefreshFailure(record, response.status, "invalid_response", "transient", response.headers.get("retry-after"));
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }
    let payload: Record<string, unknown>;
    try { payload = await boundedRefreshJson(response); }
    catch (error) {
      await this.recordRefreshFailure(record, response.status, "invalid_response", response.ok ? "ambiguous" : undefined, response.headers.get("retry-after"));
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} returned an invalid refresh response`);
    }
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      const rejected = await this.recordRefreshFailure(record, response.status, payload.error ?? "invalid_response", response.ok ? "ambiguous" : undefined, response.headers.get("retry-after"));
      if (rejected.status === "reauth_required") {
        throw new ReauthorizationRequired(`provider ${providerId} requires grant reauthorization`, credentialProjection(rejected));
      }
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }

    let updated: CredentialRecord;
    try { updated = {
      ...record,
      status: "active",
      refreshAttempt: null,
      generation: record.generation + 1,
      poolSyncPending: true,
      accessToken: boundedSecret(payload.access_token, "access token"),
      refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token
        ? boundedSecret(payload.refresh_token, "refresh token")
        : record.refreshToken,
      tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : record.tokenType,
      scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean).slice(0, 128) : record.scopes,
      expiresAt: typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1_000).toISOString()
        : record.expiresAt,
      // Claude Code preserves the known absolute deadline when a rotation
      // omits it. Missing/invalid metadata must not invent a new lifetime.
      refreshTokenExpiresAt: refreshExpiryFromSeconds(payload.refresh_token_expires_in) ?? record.refreshTokenExpiresAt ?? null,
      nextRefreshAttemptAt: null,
      refreshDiagnosis: { lastSuccessfulRefreshAt: new Date().toISOString(), failure: null },
      updatedAt: new Date().toISOString(),
    }; } catch {
      await this.recordRefreshFailure(record, response.status, "invalid_response", response.ok ? "ambiguous" : undefined, response.headers.get("retry-after"));
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} returned an invalid refresh response`);
    }
    try {
      if (updated.grantKey && updated.refreshToken) await claimRefreshOwnership(this.env, updated.grantKey, updated.refreshToken, { current: updated.refreshToken === record.refreshToken });
      const latest = await this.state.storage.get<CredentialRecord>("credential");
      if (!sameRefreshAttempt(latest, record)) return latest ?? record;
      await this.state.storage.put("credential", updated);
    } catch {
      await this.recordRefreshFailure(record, response.status, "persistence_failed", "provider_ok_persist_failed");
      throw new HttpError(502, "grant_refresh_persist_failed", "provider refreshed credentials but durable settlement failed; a fresh dedicated login may be required");
    }
    return updated;
  }

  private async maintain(): Promise<void> {
    let record = await this.state.storage.get<CredentialRecord>("credential");
    if (!record) return;
    const previous = record;
    const before = JSON.stringify(credentialProjection(record));
    record = await this.loadRecord(record.grantKey ?? "", record) ?? record;
    if (!record.enabled || !record.grantKey || !record.providerId || !record.kind || record.status === "reauth_required") {
      await this.state.storage.deleteAlarm();
      if (record !== previous || record.poolSyncPending) await this.publishProjection(record);
      return;
    }
    const provider = snapshot.providers.find((candidate) => candidate.id === record!.providerId);
    const transport = provider ? transportForGrant(provider, materializedGrant({ provider: record.providerId, kind: record.kind }, record)) : null;
    if (!provider || !transport) return;
    const now = Date.now();
    const quotaProbe = quotaProbeForGrant(provider, materializedGrant({ provider: provider.id, kind: record.kind }, record));
    if (!quotaProbe) record.nextQuotaProbeAt = null;
    const refreshAt = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) : record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN;
    if (record.refreshToken && !record.refreshAttempt && Number.isFinite(refreshAt) && refreshAt <= now) {
      try { record = { ...await this.refresh(record, provider.id, provider.auth.refresh), nextRefreshAttemptAt: null }; }
      catch {
        record = await this.state.storage.get<CredentialRecord>("credential") ?? record;
        if (record.status !== "reauth_required") await this.deferRefresh(record);
      }
      if (record.status === "reauth_required") {
        await this.publishProjection(record);
        await this.state.storage.deleteAlarm();
        return;
      }
    }
    if (due(record.nextQuotaProbeAt, now) && transport.maintenance.quotaPoll && quotaProbe) {
      try {
        const state = await this.probeQuota(provider, record);
        record.quotaFailureCount = 0;
        record.nextQuotaProbeAt = new Date(now + quotaInterval(transport, state)).toISOString();
      } catch {
        record.quotaFailureCount = Math.min(MAX_MAINTENANCE_FAILURES, (record.quotaFailureCount ?? 0) + 1);
        const normal = transport.maintenance.quotaPoll.normalIntervalSeconds * 1_000;
        record.nextQuotaProbeAt = new Date(now + Math.min(transport.maintenance.quotaPoll.exhaustedIntervalSeconds * 1_000, normal * 2 ** record.quotaFailureCount)).toISOString();
      }
    }
    if ((record as CredentialRecord).status === "reauth_required") {
      await this.state.storage.put("credential", record);
      await this.publishProjection(record);
      await this.state.storage.deleteAlarm();
      return;
    }
    if (record.maintenance?.keepWarm && due(record.nextKeepWarmAt, now) && transport.maintenance.keepWarm) {
      try { await keepWarm(this.env, provider, transport, record); }
      catch { /* the next regular interval retries without making alarm delivery hot-loop */ }
      record.nextKeepWarmAt = new Date(now + transport.maintenance.keepWarm.intervalSeconds * 1_000).toISOString();
    }
    await this.state.storage.put("credential", record);
    await this.schedule(record);
    if (record.poolSyncPending || before !== JSON.stringify(credentialProjection(record))) await this.publishProjection(record);
  }

  private async probeQuota(provider: CompiledProvider, record: CredentialRecord): Promise<GrantRuntimeState> {
    assertCredentialEnabled(record);
    if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));
    // Already inside the owner tail: do not recursively call /materialize.
    return probeQuota(this.env, provider, record, async () => {
      const current = await this.state.storage.get<CredentialRecord>("credential");
      if (!current) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
      assertCredentialEnabled(current);
      if (current.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(current));
      try {
        const recovered = current.generation === record.generation
          ? await this.refresh(current, provider.id, provider.auth.refresh)
          : current;
        Object.assign(record, recovered);
      } catch (error) {
        // The refresh failure and its diagnosis are durable already. Never let
        // the quota caller's finally block write the rejected snapshot over it.
        Object.assign(record, await this.state.storage.get<CredentialRecord>("credential") ?? current);
        if (record.status !== "reauth_required") await this.deferRefresh(record);
        throw error;
      }
    });
  }

  private async diagnoseUnsettled(record: CredentialRecord): Promise<CredentialRecord> {
    // Only reached inside the owner tail, after any live refresh finished. A
    // remaining pending marker means its result was not durably settled.
    if (record.refreshAttempt && !["ambiguous", "provider_ok_persist_failed"].includes(record.refreshDiagnosis?.failure?.failureClass ?? "")) {
      return this.recordRefreshFailure(record, null, "outcome_unknown", "ambiguous");
    }
    // Older canonical owners already diagnosed the failure, but neither pool
    // index knows the new availability field. Repair both once, before use.
    if (!record.refreshRoutingPublished && canonicalRecord(record) && (record.refreshAttempt || record.nextRefreshAttemptAt)) {
      record = { ...record, poolSyncPending: true };
      await this.state.storage.put("credential", record);
    }
    return record;
  }

  private async deferRefresh(record: CredentialRecord): Promise<void> {
    if (!record.refreshAttempt && !(timestamp(record.nextRefreshAttemptAt) > Date.now())) {
      record.poolSyncPending = true;
      record.nextRefreshAttemptAt = refreshRetryAt(record.refreshDiagnosis?.failure?.attemptCount ?? 1, record.expiresAt);
      if (record.refreshDiagnosis?.failure) record.refreshDiagnosis.failure.nextRetryAt = record.nextRefreshAttemptAt;
      await this.state.storage.put("credential", record);
    }
    await this.schedule(record);
  }

  private async recordRefreshFailure(record: CredentialRecord, status: number | null, code: unknown,
    outcome?: NonNullable<NonNullable<UpstreamGrant["refreshDiagnosis"]>["failure"]>["failureClass"], retryAfter?: string | null): Promise<CredentialRecord> {
    const current = await this.state.storage.get<CredentialRecord>("credential");
    if (!current) throw new HttpError(409, "grant_credential_missing", "refresh owner no longer exists");
    if (current.generation !== record.generation || record.refreshAttempt && !sameRefreshAttempt(current, record)) throw new SupersededRefresh(current);
    const permanent = status !== null && permanentRefreshFailure(status, code);
    const failureClass = outcome ?? (permanent ? "permanent" : status === 429 || retryAfter ? "retry_after" : "transient");
    const atRisk = failureClass === "ambiguous" || failureClass === "provider_ok_persist_failed";
    const now = new Date(Date.now()).toISOString();
    const previous = current.refreshDiagnosis?.failure;
    const attemptCount = Math.min(Number.MAX_SAFE_INTEGER, (previous?.attemptCount ?? 0) + 1);
    const nextRetryAt = permanent || atRisk ? null : refreshRetryAt(attemptCount, current.expiresAt, retryAfter);
    const rejected: CredentialRecord = {
      ...current,
      status: permanent ? "reauth_required" : current.status,
      generation: permanent ? current.generation + 1 : current.generation,
      refreshAttempt: atRisk ? current.refreshAttempt : null,
      poolSyncPending: true,
      updatedAt: permanent ? now : current.updatedAt,
      nextRefreshAttemptAt: nextRetryAt,
      refreshDiagnosis: {
        lastSuccessfulRefreshAt: current.refreshDiagnosis?.lastSuccessfulRefreshAt ?? null,
        failure: { oauthError: safeOAuthError(code), httpStatus: status, failureClass,
          firstFailureAt: previous?.firstFailureAt ?? now, lastFailureAt: now, attemptCount, nextRetryAt },
      },
    };
    await this.state.storage.put("credential", rejected);
    await this.schedule(rejected);
    return rejected;
  }

  private async publishProjection(record: CredentialRecord): Promise<void> {
    if (!record.grantKey) return;
    if (record.poolSyncPending) await this.reconcileAttachment(record.grantKey);
    await this.env.POLICY_KV.put(record.grantKey, JSON.stringify(metadataGrant(record)));
    // Authority ACK alone cannot retire publication: KV-backed selection must
    // also see the outcome, including newly diagnosed abandoned attempts.
    if (record.poolSyncPending || !record.refreshRoutingPublished) {
      record.poolSyncPending = false;
      record.refreshRoutingPublished = true;
      await this.state.storage.put("credential", record);
    }
  }

  private async reconcileAttachment(key: string): Promise<{ record: CredentialRecord | undefined; result: GrantAttachmentResult }> {
    // Reread inside the owner tail. A failed owner read is unknown, never
    // permission to cancel pending admission or infer absence from KV.
    const record = await this.state.storage.get<CredentialRecord>("credential");
    const indexed = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key });
    const result = record
      ? await authorityCall<GrantAttachmentResult>(this.env, "/grant-pools/publish", { key, generation: record.generation, revision: indexed.revision, admissionRevision: record.poolAdmissionRevision, provider: record.providerId ?? null, status: attachmentStatus(record), projection: routingProjection(metadataGrant(record)) })
      : await authorityCall<GrantAttachmentResult>(this.env, "/grant-pools/cancel-pending", { key, revision: indexed.revision });
    return { record, result };
  }

  private async schedule(record: CredentialRecord): Promise<void> {
    const next = [
      record.refreshAttempt ? NaN : record.refreshToken && record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) : record.refreshToken && record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN,
      timestamp(record.nextQuotaProbeAt),
      record.maintenance?.keepWarm ? timestamp(record.nextKeepWarmAt) : NaN,
    ].filter(Number.isFinite);
    if (!record.enabled || !next.length || record.status === "reauth_required") {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + MIN_ALARM_DELAY_MS, Math.min(...next)));
  }

  private async loadRecord(key: string, stored?: CredentialRecord, repair = true): Promise<CredentialRecord | undefined> {
    let record = stored ?? await this.state.storage.get<CredentialRecord>("credential");
    if (!record) return record;
    record = await this.diagnoseUnsettled(record);
    if (canonicalRecord(record)) return repair && record.poolSyncPending ? (await this.reconcileAttachment(key)).record : record;
    if (!record.metadata || record.enabled === undefined) {
      const metadata = key ? await legacyGrantMetadata(this.env, key) : null;
      record = { ...record, grantKey: key || record.grantKey, metadata: metadata ?? {}, enabled: record.enabled ?? (metadata !== null && metadata.enabled !== false), poolSyncPending: true };
      // Pre-owner CLI commands revoked only KV. Import negative lifecycle facts
      // once, before any provider I/O; later KV reads never regain authority.
      if (metadata?.revokedAt) record = revokedRecord(key, { ...metadataGrant(record), revokedAt: metadata.revokedAt }, record.generation);
      else if (metadata?.enabled === false) record = { ...record, enabled: false, generation: record.generation + (record.enabled === false ? 0 : 1) };
    }
    // Existing owner records acquire a lineage once; caller/KV lineage values
    // never establish identity. Refresh preserves this owner-issued value.
    record = { ...record, lineage: record.lineage ?? crypto.randomUUID() };
    // Commit the denial before derived publication. The dirty flag survives
    // failure and retries reconciliation before any later provider I/O.
    await this.state.storage.put("credential", record);
    if (!record.enabled) await this.state.storage.deleteAlarm();
    return repair && record.poolSyncPending ? (await this.reconcileAttachment(key)).record : record;
  }
}

function canonicalRecord(record: CredentialRecord): boolean {
  return !!record.metadata && record.enabled !== undefined && !!record.lineage;
}

function nextCredentialGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER - 1) throw new HttpError(409, "grant_generation_exhausted", "account generation is exhausted; operator recovery is required");
  return generation + 1;
}

function ownerMetadata(record: CredentialRecord, grant: UpstreamGrant, key: string): CredentialRecord {
  const now = Date.now();
  const providerId = grant.provider ?? record.providerId ?? null;
  const kind = grant.kind ?? record.kind;
  const provider = providerId ? snapshot.providers.find((candidate) => candidate.id === providerId) : undefined;
  const transport = provider && kind ? provider.auth.grantTransports[kind] : null;
  const quotaProbe = provider && kind ? quotaProbeForGrant(provider, materializedGrant({ provider: provider.id, kind }, record)) : null;
  const keepWarm = grant.maintenance?.keepWarm ?? record.maintenance?.keepWarm ?? false;
  return {
    ...record,
    enabled: grant.enabled ?? record.enabled ?? true,
    grantKey: key,
    providerId,
    kind,
    maintenance: { keepWarm },
    nextQuotaProbeAt: transport?.maintenance.quotaPoll && quotaProbe
      ? record.nextQuotaProbeAt ?? new Date(now + transport.maintenance.quotaPoll.normalIntervalSeconds * 1_000).toISOString()
      : null,
    nextKeepWarmAt: keepWarm && transport?.maintenance.keepWarm
      ? record.nextKeepWarmAt ?? new Date(now + transport.maintenance.keepWarm.intervalSeconds * 1_000).toISOString()
      : null,
    quotaFailureCount: record.quotaFailureCount ?? 0,
    nextRefreshAttemptAt: record.nextRefreshAttemptAt ?? null,
    revokedAt: null,
    metadata: secretlessGrant(grant),
  };
}

function metadataGrant(record: CredentialRecord): UpstreamGrant {
  return { ...record.metadata, ...credentialProjection(record), enabled: record.enabled === true, provider: record.providerId, kind: record.kind, maintenance: record.maintenance, revokedAt: record.revokedAt ?? null };
}

function attachmentStatus(record: CredentialRecord): GrantAttachmentStatus | null {
  if (record.revokedAt) return null;
  if (!record.enabled) return "paused";
  return record.status === "reauth_required" || !hasPrimaryCredential(record) ? "reauth_required" : "active";
}

function revokedRecord(key: string, metadata: UpstreamGrant | null, generation = metadata?.credentialGeneration ?? 0): CredentialRecord {
  // Tagged CLI grants could contain nested secret fields in refresh metadata.
  // A tombstone must discard these too, including when the owner predates it.
  metadata = stripLegacySecrets(metadata) as UpstreamGrant | null;
  const revokedAt = metadata?.revokedAt ?? new Date().toISOString();
  return {
    version: 1, generation: generation + 1, lineage: crypto.randomUUID(), enabled: false, status: "active", poolSyncPending: true,
    grantKey: key, providerId: metadata?.provider, kind: metadata?.kind,
    refreshTokenExpiresAt: metadata?.refreshTokenExpiresAt, lastManualAuthorizationAt: metadata?.lastManualAuthorizationAt,
    tokenType: metadata?.tokenType, expiresAt: metadata?.expiresAt, scopes: metadata?.scopes,
    accountId: metadata?.accountId, subscription: metadata?.subscription, refresh: metadata?.refresh,
    maintenance: { keepWarm: metadata?.maintenance?.keepWarm === true },
    createdAt: metadata?.createdAt, updatedAt: revokedAt, revokedAt, metadata: secretlessGrant(metadata ?? {}),
  };
}

async function probeQuota(env: Env, provider: CompiledProvider, record: CredentialRecord, recover: () => Promise<void>): Promise<GrantRuntimeState> {
  assertCredentialEnabled(record);
  let grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
  const probes = quotaProbesForGrant(provider, grant);
  if (!probes.length) throw new HttpError(400, "grant_quota_probe_unavailable", `provider ${provider.id} has no quota probe for this grant kind`);
  const states = await authorityCall<{ states: Record<string, GrantRuntimeState> }>(env, "/grant-pools/states", { keys: [record.grantKey] });
  const stored = states.states[record.grantKey!];
  const previous = stored?.grantRevision === record.updatedAt ? stored : undefined;
  let windows = previous?.windows ?? [];
  let facts = previous ? { account: previous.account, extraUsage: previous.extraUsage } : {};
  let quotaUpdated = false;
  let quotaObservedAt: string | undefined;
  let successful = false;
  let recovered = false;
  for (const probe of probes) {
    if (Date.parse(record.quotaRetryAt?.[probe.url] ?? "") > Date.now()) continue;
    const headers = new Headers({ accept: "application/json" });
    const url = new URL(probe.url);
    applyProviderCredential(provider, grant, env, headers, url.searchParams);
    for (const [name, value] of Object.entries(probe.headers)) headers.set(name, requiredGrantTemplate(value, grant, "grant_quota_probe_unavailable"));
    const probeStartedAt = Date.now();
    let response: Response;
    try { response = await fetch(url, { method: probe.method, headers, signal: AbortSignal.timeout(10_000), redirect: "manual" }); }
    catch { if (probe.windows.length) throw new HttpError(502, "grant_quota_probe_failed", `provider ${provider.id} quota probe failed`); else continue; }
    if (response.status === 401 && record.refreshToken && !recovered) {
      recovered = true;
      await response.body?.cancel().catch(() => undefined);
      await recover();
      grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
      applyProviderCredential(provider, grant, env, headers, url.searchParams);
      for (const [name, value] of Object.entries(probe.headers)) headers.set(name, requiredGrantTemplate(value, grant, "grant_quota_probe_unavailable"));
      try { response = await fetch(url, { method: probe.method, headers, signal: AbortSignal.timeout(10_000), redirect: "manual" }); }
      catch { throw new HttpError(502, "grant_quota_probe_failed", `provider ${provider.id} quota probe failed`); }
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const until = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
      (record.quotaRetryAt ??= {})[probe.url] = new Date(Number.isFinite(until) ? Math.max(Date.now() + 1000, until) : Date.now() + 60_000).toISOString();
      await response.body?.cancel().catch(() => undefined);
      continue; // Poll throttling says nothing about inference quota; retain the reading.
    }
    if (!response.ok) {
      const failure = observeGrantQuota(response, { responseHeaders: [], probes: [] });
      if (failure) await publishRuntime(env, record, { ...failure, source: "provider_probe", windows });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 && !record.refreshToken) record.status = "reauth_required";
      if (probe.windows.length || response.status === 401 || response.status === 403) throw new HttpError(502, "grant_quota_probe_failed", `provider ${provider.id} quota probe returned ${response.status}`);
      continue;
    }
    let payload: unknown;
    try { payload = await boundedResponseJson(response, MAX_REFRESH_RESPONSE_BYTES); }
    catch (error) { if (probe.windows.length) throw error; else continue; }
    const state = observeGrantQuotaProbe(payload, probe, probeStartedAt);
    if (!state) { if (probe.windows.length) throw new HttpError(502, "grant_quota_probe_empty", `provider ${provider.id} quota probe returned no recognized windows`); else continue; }
    successful = true;
    delete record.quotaRetryAt?.[probe.url];
    facts = { ...facts, ...(state.account ? { account: state.account } : {}), ...(state.extraUsage ? { extraUsage: state.extraUsage } : {}) };
    if (state.windows.length) {
      windows = [...windows.filter(window => !probe.windows.some(definition => definition.collection ? window.id.startsWith(`${definition.id}-`) : window.id === definition.id)), ...state.windows];
      quotaUpdated = true;
      quotaObservedAt = state.observedAt;
    }
  }
  const observed = { ...quotaRuntime(windows.slice(0, 128), "provider_probe", quotaObservedAt ? Date.parse(quotaObservedAt) : Date.now()), ...facts, grantRevision: record.updatedAt };
  if (!quotaUpdated && previous) Object.assign(observed, { observedAt: previous.observedAt, status: previous.status, cooldownUntil: previous.cooldownUntil, lastSignal: previous.lastSignal });
  if (successful) await publishRuntime(env, record, observed);
  return observed;
}

export async function refreshGrantQuota(env: Env, key: string): Promise<void> {
  await ownerCall(env, key, "/quota-refresh", { key });
}

async function keepWarm(env: Env, provider: CompiledProvider, transport: CompiledGrantTransport, record: CredentialRecord): Promise<void> {
  assertCredentialEnabled(record);
  const config = transport.maintenance.keepWarm;
  if (!config || !record.grantKey) return;
  const states = await authorityCall<{ states: Record<string, GrantRuntimeState> }>(env, "/grant-pools/states", { keys: [record.grantKey] });
  const runtime = states.states[record.grantKey];
  const model = typeof config.body.model === "string" ? config.body.model : null;
  if (grantCoolingDown(runtime) || grantQuotaExhausted(runtime, model) || (grantQuotaRatio(runtime, Date.now(), undefined, model) ?? 1) <= 0.1) return;
  const endpoint = provider.endpoints.find((candidate) => candidate.id === config.endpoint);
  if (!endpoint) throw new HttpError(500, "grant_maintenance_invalid", `provider ${provider.id} keep-warm endpoint is unavailable`);
  const grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
  const headers = new Headers({ "content-type": "application/json" });
  const query = new URLSearchParams();
  applyProviderCredential(provider, grant, env, headers, query);
  applyTemplateHeaders(provider, provider.adapter.injectHeaders, env, headers);
  applyTemplateHeaders(provider, endpoint.headers, env, headers);
  applyTransportHeaders(headers, transport, grant);
  const path = transport.endpointPaths[endpoint.id] ?? endpoint.path;
  const url = new URL(`${(transport.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env)).replace(/\/$/, "")}${resolveTemplate(provider, path, env)}`);
  query.forEach((value, name) => url.searchParams.set(name, value));
  const body = transformTransportBody(transport, structuredClone(config.body));
  let response: Response;
  try { response = await fetch(url, { method: endpoint.method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "manual" }); }
  catch { throw new HttpError(502, "grant_keep_warm_failed", `provider ${provider.id} keep-warm request failed`); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "grant_keep_warm_failed", `provider ${provider.id} keep-warm request returned ${response.status}`);
  }
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

function timestamp(value: string | null | undefined): number {
  return value ? Date.parse(value) : NaN;
}

function due(value: string | null | undefined, now: number): boolean {
  const parsed = timestamp(value);
  return Number.isFinite(parsed) && parsed <= now;
}

function assertCredentialEnabled(record: CredentialRecord): void {
  if (record.enabled !== true) throw new HttpError(409, "grant_disabled", "upstream grant is disabled");
}

export async function inspectGrantCredentials(env: Env, key: string): Promise<UpstreamGrant> {
  return (await ownerCall<OwnerResponse>(env, key, "/inspect", {})).grant;
}

export async function putGrantCredentials(env: Env, key: string, grant: UpstreamGrant, preserveUnspecifiedSecrets = false, intent?: "replace", provenance?: "clawrouter_oauth"): Promise<UpstreamGrant> {
  return (await ownerCall<OwnerResponse>(env, key, "/put", { key, grant, preserveUnspecifiedSecrets, intent, provenance })).grant;
}

export async function reconcileGrantAttachment(env: Env, key: string): Promise<GrantAttachmentResult> {
  return ownerCall<GrantAttachmentResult>(env, key, "/reconcile", { key });
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
  return (await ownerCall<OwnerResponse>(env, key, "/materialize", {
    key,
    grant,
    legacy,
    providerId,
    refresh,
    force,
    expectedGeneration: grant.credentialGeneration ?? null,
  })).grant;
}

export async function revokeGrantCredentials(env: Env, key: string, metadata?: GrantRevokeMetadata): Promise<UpstreamGrant> {
  return (await ownerCall<OwnerResponse>(env, key, "/revoke", { key, metadata })).grant;
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
    lineage: crypto.randomUUID(),
    poolSyncPending: true,
    enabled: grant.enabled ?? true,
    status: "active",
    credential: optionalSecret(grant.credential, "credential"),
    credentials,
    accessToken: optionalSecret(grant.accessToken, "access token"),
    refreshToken: optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType,
    expiresAt: validTimestamp(grant.expiresAt),
    refreshTokenExpiresAt: validAuthorizationTimestamp(grant.refreshTokenExpiresAt),
    lastManualAuthorizationAt: validAuthorizationTimestamp(grant.lastManualAuthorizationAt),
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
    poolSyncPending: true,
    enabled: grant.enabled ?? current.enabled ?? true,
    status: current.status,
    credential: grant.credential === undefined ? current.credential : optionalSecret(grant.credential, "credential"),
    credentials: grant.credentials && Object.keys(grant.credentials).length ? normalizedCredentials(grant.credentials) : current.credentials,
    accessToken: grant.accessToken === undefined ? current.accessToken : optionalSecret(grant.accessToken, "access token"),
    refreshToken: grant.refreshToken === undefined ? current.refreshToken : optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType ?? current.tokenType,
    expiresAt: grant.expiresAt === undefined ? current.expiresAt : validTimestamp(grant.expiresAt),
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt === undefined ? current.refreshTokenExpiresAt : validAuthorizationTimestamp(grant.refreshTokenExpiresAt),
    lastManualAuthorizationAt: grant.lastManualAuthorizationAt === undefined ? current.lastManualAuthorizationAt : validAuthorizationTimestamp(grant.lastManualAuthorizationAt),
    scopes: grant.scopes === undefined ? current.scopes : normalizedScopes(grant.scopes),
    accountId: grant.accountId === undefined ? current.accountId : grant.accountId,
    subscription: grant.subscription === undefined ? current.subscription : grant.subscription,
    refresh: grant.refresh === undefined ? current.refresh : grant.refresh,
    updatedAt: grant.updatedAt ?? new Date().toISOString(),
  };
  if (![updated.credential, updated.accessToken, ...Object.values(updated.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  const replaced = ["credential", "accessToken", "refreshToken"].some(key => {
    const value = updated[key as keyof CredentialRecord];
    return typeof value === "string" && value !== current[key as keyof CredentialRecord];
  }) || JSON.stringify(Object.entries(updated.credentials ?? {}).sort()) !== JSON.stringify(Object.entries(current.credentials ?? {}).sort());
  if (replaced && (!current.refreshAttempt || updated.refreshToken !== current.refreshToken || !updated.refreshToken && hasFreshPrimaryCredentials(current, updated))) { updated.status = "active"; updated.refreshDiagnosis = null; updated.refreshAttempt = null; updated.nextRefreshAttemptAt = null; }
  // Explicit credential/account replacement is not a refresh, even when the
  // operator keeps the same account label. Refresh-token replacement also can
  // change the next upstream account, so it invalidates continuation ownership.
  if (["credential", "accessToken", "refreshToken", "accountId"].some(key => updated[key as keyof CredentialRecord] !== current[key as keyof CredentialRecord])
    || JSON.stringify(Object.entries(updated.credentials ?? {}).sort()) !== JSON.stringify(Object.entries(current.credentials ?? {}).sort())
    || updated.subscription?.subject !== current.subscription?.subject
    || JSON.stringify(updated.refresh) !== JSON.stringify(current.refresh)
    || grant.provider !== undefined && grant.provider !== current.providerId || grant.kind !== undefined && grant.kind !== current.kind) updated.lineage = crypto.randomUUID();
  if (updated.refreshToken !== current.refreshToken) {
    // Replacing refresh authority cannot inherit dates from the old login.
    // Access-only edits retain the existing refresh token and its deadline.
    updated.refreshTokenExpiresAt = validAuthorizationTimestamp(grant.refreshTokenExpiresAt);
    updated.lastManualAuthorizationAt = validAuthorizationTimestamp(grant.lastManualAuthorizationAt);
  }
  return updated;
}



async function ownerCall<T>(env: Env, key: string, path: string, body: unknown): Promise<T> {
  const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key));
  const response = await stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; detail?: { projection?: CredentialProjection } } } = {};
    try { payload = JSON.parse(text); } catch { /* redacted internal error */ }
    throw new HttpError(response.status, payload.error?.code ?? "credential_owner_error", payload.error?.message ?? "grant credential operation failed");
  }
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

export function hasPrimaryCredential(grant: UpstreamGrant): boolean {
  return [grant.credential, grant.accessToken, ...Object.values(grant.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0);
}

async function legacyGrantMetadata(env: Env, key: string, recover = false): Promise<UpstreamGrant | null> {
  const raw = await env.POLICY_KV.get(key, "text");
  if (raw === null) return null;
  // Explicit replacement/revocation needs only proof that an old record exists.
  // A failed read remains unknown; corrupt bytes never become owner metadata.
  if (new TextEncoder().encode(raw).byteLength > MAX_LEGACY_GRANT_BYTES) {
    if (recover) return {};
    throw new HttpError(400, "invalid_upstream_grant", "legacy grant metadata exceeds the migration limit");
  }
  let value: unknown = {};
  if (raw.trim().startsWith("{")) {
    try { value = JSON.parse(raw); }
    catch {
      if (recover) return {};
      throw new HttpError(400, "invalid_upstream_grant", "legacy grant metadata is invalid JSON");
    }
  }
  const metadata = stripLegacySecrets(value) as Record<string, unknown>;
  const legacy = value as UpstreamGrant;
  // Compensation needs the old grant's eligibility after its secrets are
  // stripped. Preserve existing owner status; never revive a denied projection.
  if (legacy.credentialStore !== "durable_object") Object.assign(metadata, {
    credentialStore: "durable_object", credentialStatus: grantUsable(legacy) ? "active" : "reauth_required",
    hasCredential: !!legacy.credential || Object.keys(legacy.credentials ?? {}).length > 0,
    hasAccessToken: !!legacy.accessToken, hasRefreshToken: !!legacy.refreshToken,
  });
  for (const [canonical, alias] of [["tokenType", "token_type"], ["expiresAt", "expires_at"], ["accountId", "account_id"], ["createdAt", "created_at"], ["updatedAt", "updated_at"], ["revokedAt", "revoked_at"]]) {
    if (metadata[canonical] === undefined && metadata[alias] !== undefined) metadata[canonical] = metadata[alias];
    delete metadata[alias];
  }
  return metadata as UpstreamGrant;
}

function stripLegacySecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLegacySecrets);
  if (!value || typeof value !== "object") return value;
  const secrets = new Set(["accessToken", "access_token", "refreshToken", "refresh_token", "credential", "credentials", "apiKey", "api_key", "token", "secret", "clientSecret", "client_secret", "password"]);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !secrets.has(name)).map(([name, item]) => [name, stripLegacySecrets(item)]));
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

function sameRefreshAttempt(current: CredentialRecord | undefined, attempted: CredentialRecord): boolean {
  return !!current && current.generation === attempted.generation && current.refreshAttempt?.id === attempted.refreshAttempt?.id;
}

function validAuthorizationTimestamp(value: unknown): string | null {
  const timestamp = authorizationTimestamp(value);
  if (value != null && timestamp === null) throw new HttpError(400, "invalid_upstream_grant", "authorization timestamp must be ISO-8601 or epoch milliseconds");
  return timestamp;
}
