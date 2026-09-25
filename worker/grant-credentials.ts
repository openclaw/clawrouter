import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import { authorityCall, type GrantAttachmentResult, type GrantAttachmentSnapshot } from "./authority.ts";
import { grantCoolingDown, grantQuotaRatio, observeGrantQuota, observeGrantQuotaProbe } from "./grant-quota.ts";
import { grantUsable } from "./grant-selection.ts";
import { applyProviderCredential, applyTransportHeaders, quotaProbeForGrant, requiredGrantTemplate, transformTransportBody, transportForGrant } from "./provider-auth.ts";
import type { CompiledGrantTransport, CompiledProvider, Env, GrantRuntimeState, ProviderSnapshot, RefreshConfig, UpstreamGrant } from "./types";
import { errorResponse, HttpError, json, readJson } from "./utils.ts";
import { applyTemplateHeaders, resolveTemplate } from "./provider-templates.ts";
import type { GrantPoolReadiness } from "../shared/contracts.ts";
import { accountCredentialView, assertNewAccountRef, grantIntentBody, strictCredentialRecord, type GrantCredentialIntent } from "./grant-credential-intents.ts";
import { assertTokenUsable, REFRESH_MARGIN_MS, tokenDenied, tokenExpired, tokenResponseExpiry } from "./grant-expiry.ts";
import { captureModelDiscovery, completeModelDiscovery, inspectModelInventory } from "./grant-model-inventory.ts";
import { discoverModels } from "./model-discovery.ts";

import { CREDENTIAL_INPUT_FIELDS, normalizeGrant, secretlessGrant, canonicalRecord, nextCredentialGeneration, ownerMetadata, metadataGrant, attachmentStatus, revokedRecord, hasRawCredential, credentialRecord, updatedCredentialRecord, credentialProjection, materializedGrant, hasPrimaryCredential, stripLegacySecrets, isRefreshAuthenticationParameter, boundedSecret, type CredentialRecord, type CredentialProjection } from "./grant-credential-record.ts";
export { secretlessGrant, hasRawCredential, hasPrimaryCredential, type CredentialProjection } from "./grant-credential-record.ts";

const MAX_REFRESH_RESPONSE_BYTES = 128 * 1024;
const MAX_LEGACY_GRANT_BYTES = 3 * 1024 * 1024;
const MIN_ALARM_DELAY_MS = 1_000;
const MAX_MAINTENANCE_FAILURES = 6;
const snapshot = snapshotJson as unknown as ProviderSnapshot;

interface OwnerResponse {
  grant: UpstreamGrant;
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
  credentialInput?: UpstreamGrant;
  // Contribution imports also replace secrets; only the explicit administrator
  // operation may discard corrupt legacy metadata.
  intent?: "replace";
}

export type GrantRevokeMetadata = Pick<UpstreamGrant, "kind" | "provider" | "label">;

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
    if (request.method === "POST" && new URL(request.url).pathname === "/models/refresh") return this.refreshModels(request);
    return this.serialize(() => this.handle(request));
  }

  alarm(): Promise<void> {
    return this.serialize(() => this.maintain());
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readCanonical(key: string): Promise<CredentialRecord> {
    const record = await this.state.storage.get<CredentialRecord>("credential");
    if (!record) throw new HttpError(404, "grant_credential_missing", "account owner is not initialized; use explicit replacement or revocation for legacy grants");
    if (!canonicalRecord(record) || record.grantKey !== key) throw new HttpError(409, "grant_owner_initialization_required", "account owner requires explicit replacement or revocation before strict mutations");
    return record;
  }

  private async refreshModels(request: Request): Promise<Response> {
    try {
      const { key, body } = await readJson<{ key: string; body: unknown }>(request);
      const capture = await this.serialize(async () => {
        const record = await this.readCanonical(key);
        return captureModelDiscovery(this.state.storage, record, snapshot.providers.find(provider => provider.id === record.providerId), this.env, body);
      });
      // Do not hold the credential queue across network I/O: revocation and
      // replacement must commit promptly, then invalidate completion by CAS.
      const result = await discoverModels(capture.attempt.adapter, capture.headers);
      return await this.serialize(async () => {
        const record = await this.state.storage.get<CredentialRecord>("credential");
        const provider = snapshot.providers.find(provider => provider.id === record?.providerId);
        completeModelDiscovery(this.state.storage, capture, record, provider, result);
        if (!record || !canonicalRecord(record) || record.grantKey !== key) throw new HttpError(409, "grant_owner_initialization_required", "account owner changed during discovery");
        const view = inspectModelInventory(this.state.storage, record, provider);
        return json(view, view.attempt?.error === "source_changed" ? 409 : view.attempt?.status === "failed" ? 502 : 200);
      });
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
      return errorResponse("model_discovery_failed", "model discovery failed", 500);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return errorResponse("route_not_found", "route not found", 404);
    try {
      if (path === "/read" || path === "/models/read") {
        const { key } = await readJson<{ key: string }>(request);
        const record = await this.readCanonical(key);
        if (path === "/models/read") return json(inspectModelInventory(this.state.storage, record, snapshot.providers.find(provider => provider.id === record.providerId)));
        return json(accountCredentialView(record));
      }
      if (path === "/mutate") return await this.mutate(await readJson<{ key: string; intent: GrantCredentialIntent; body: unknown }>(request));
      if (path === "/put" || path === "/token-exchange") {
        const input = await readJson<PutRequest & { tokenResponse?: Record<string, unknown>; tokenResponseObservedAt: number }>(request);
        const replace = input.intent === "replace";
        if (replace && !hasPrimaryCredential(input.grant)) throw new HttpError(400, "invalid_upstream_grant", "grant replacement requires a fresh primary credential");
        let current = await this.state.storage.get<CredentialRecord>("credential");
        if (current) nextCredentialGeneration(current.generation);
        let attachment: GrantAttachmentSnapshot;
        let previous: UpstreamGrant | null;
        let legacy: UpstreamGrant | null = null;
        if (replace && (!current || !canonicalRecord(current))) {
          // Recover directly into the final mutation. An incomplete old owner
          // must not publish a synthetic migration or adopt newer index facts.
          previous = current ? metadataGrant(current) : await legacyGrantMetadata(this.env, input.key, true);
          attachment = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key: input.key });
          if (current && attachment.generation > current.generation) throw new HttpError(409, "grant_attachment_changed", "attachment is newer than the credential owner; operator recovery is required");
        } else {
          current = await this.loadRecord(input.key, current);
          attachment = current?.poolSyncPending ? (await this.finalize(current, "prepare")).result : (await this.reconcileAttachment(input.key)).result;
          legacy = current ? null : await readLegacyGrant(this.env, input.key);
          previous = current ? metadataGrant(current) : legacyMetadata(legacy);
        }
        if (!current && !previous) {
          // A KV miss cannot erase legacy membership, including generation zero.
          // Reconcile only a proven first proposal before admitting a new owner.
          if (attachment.generation === 0 && attachment.pending) ({ result: attachment } = await this.reconcileAttachment(input.key));
          if (attachment.generation !== 0 || attachment.attached || attachment.pending) throw new HttpError(409, "grant_attachment_changed", "upstream attachment has no recoverable credential metadata; operator recovery is required");
        }
        const admissionGeneration = replace && (current || previous) ? attachment.generation : current?.generation ?? 0;
        const generation = nextCredentialGeneration(current?.generation ?? (replace && previous ? attachment.generation : previous?.credentialGeneration ?? 0));
        let grantInput = input.grant, metadataInput = input.grant, inheritCurrent = true, updateBaseline = current;
        if (input.credentialInput && path === "/put") {
          // Normalize inside the owner: a stale KV projection cannot restore
          // old identity, routing defaults or paused state during publication repair.
          metadataInput = normalizeGrant(input.credentialInput, replace ? null : current ? materializedGrant(metadataGrant(current), current) : legacy);
          grantInput = { ...metadataInput };
          // A first legacy merge has the same credential intent as an existing
          // owner. Keep its baseline transient so only the final mutation commits.
          if (!replace && !current && legacy && hasPrimaryCredential(legacy)) updateBaseline = ownerMetadata(credentialRecord(legacy, generation - 1), legacy, input.key);
          if (updateBaseline && !replace) for (const field of CREDENTIAL_INPUT_FIELDS) {
            delete grantInput[field];
            if (Object.hasOwn(input.credentialInput, field)) Object.assign(grantInput, { [field]:
              field === "tokenType" || field === "scopes" ? metadataInput[field] : input.credentialInput[field],
            });
          }
        } else if (path === "/token-exchange") {
          const baseline = current ? metadataGrant(current) : legacy;
          // A new provider/kind cannot inherit another context's refresh token,
          // endpoint or account claims, even when the callback reuses its key.
          inheritCurrent = !!baseline?.provider && !!baseline.kind && baseline.provider === input.grant.provider && baseline.kind === input.grant.kind;
          metadataInput = inheritCurrent ? { ...baseline, ...input.credentialInput, updatedAt: input.grant.updatedAt } : {
            version: 1, provider: input.grant.provider, kind: input.grant.kind, enabled: true,
            label: baseline?.label ?? input.grant.label, createdAt: baseline?.createdAt ?? input.grant.createdAt, updatedAt: input.grant.updatedAt,
            priority: input.grant.priority, weight: input.grant.weight, tokenType: input.grant.tokenType, scopes: input.grant.scopes,
            ...input.credentialInput,
          };
          if (inheritCurrent && input.credentialInput?.subscription) metadataInput.subscription = { ...baseline?.subscription, ...input.credentialInput.subscription };
          grantInput = metadataInput;
        }
        let record = !replace && inheritCurrent && updateBaseline && !updateBaseline.revokedAt && (input.preserveUnspecifiedSecrets || !hasPrimaryCredential(grantInput))
          ? updatedCredentialRecord(updateBaseline, grantInput)
          : credentialRecord(grantInput, generation);
        record = ownerMetadata(record, metadataInput, input.key);
        // Only the authenticated callback adapter can install token-response
        // evidence. Editable metadata never establishes or clears this fact.
        if (path === "/token-exchange") record = tokenExchangeRecord(record, input.tokenResponse ?? {}, input.tokenResponseObservedAt);
        const grant = metadataGrant(record);
        // Admission reserves capacity without removing the old attachment. A
        // failed store leaves indexed pending work for this owner to reconcile.
        const admitted = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/admit", { key: input.key, generation: admissionGeneration, revision: attachment.revision, provider: record.providerId ?? null, status: attachmentStatus(record) });
        // Only this explicit commit may acknowledge the reservation; later
        // refreshes and legacy imports cannot complete a failed account write.
        record.poolAdmissionRevision = admitted.revision;
        await this.state.storage.put("credential", record);
        await this.finalize(record);
        if (path === "/token-exchange") assertTokenUsable(record);
        return json({ grant });
      }
      if (path === "/materialize") return json(await this.materialize(await readJson<MaterializeRequest>(request)));
      if (path === "/backfill") {
        const { key } = await readJson<{ key: string }>(request);
        const readiness = await authorityCall<GrantPoolReadiness>(this.env, "/grant-pools/readiness", {});
        if (!readiness.baseline || readiness.activatedAt || !["kv", "index"].includes(readiness.phase)) throw new HttpError(409, "grant_pool_migration_required", "backfill requires an accepted baseline and an active migration scan");
        const record = await this.loadRecord(key);
        const result = record ? (await this.finalize(record, "backfill")).result : (await this.reconcileAttachment(key)).result;
        return json({ ...result, ownerPresent: !!record });
      }
      if (path === "/reconcile") {
        const { key } = await readJson<{ key: string }>(request);
        const record = await this.loadRecord(key);
        return json(record ? (await this.finalize(record)).result : (await this.reconcileAttachment(key)).result);
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
        await this.finalize(record);
        return json({ grant: metadataGrant(record) });
      }
      return errorResponse("route_not_found", "route not found", 404);
    } catch (error) {
      if (error instanceof ReauthorizationRequired) return errorResponse(error.code, error.message, error.status, { projection: error.projection });
      if (error instanceof HttpError) {
        let record: CredentialRecord | undefined;
        try { record = await this.state.storage.get<CredentialRecord>("credential"); }
        catch { /* An unavailable read cannot supply a canonical conflict view. */ }
        const detail = record && (path === "/read" || path === "/mutate")
          ? canonicalRecord(record) ? { grant: accountCredentialView(record) } : undefined
          : record ? { projection: credentialProjection(record) } : undefined;
        return errorResponse(error.code, error.message, error.status, detail);
      }
      return errorResponse("credential_owner_error", "grant credential operation failed", 500);
    }
  }

  private async mutate(input: { key: string; intent: GrantCredentialIntent; body: unknown }): Promise<Response> {
    const { key, intent } = input;
    if (!["create", "patch", "replace"].includes(intent)) throw new HttpError(400, "invalid_upstream_grant", "unknown account mutation intent");
    const body = grantIntentBody(input.body, intent);
    if (intent === "create") assertNewAccountRef(key);
    const current = await this.state.storage.get<CredentialRecord>("credential");
    // Refusal precedes migration, finalization and capacity admission. A stale
    // edit cannot repair or overwrite an account it no longer owns.
    if (intent === "create" && current) throw new HttpError(409, "grant_already_exists", "account identity already exists; inspect the retained reference");
    if (intent !== "create") {
      if (!current) throw new HttpError(404, "grant_credential_missing", "account owner is not initialized; use explicit replacement or revocation for legacy grants");
      if (current.generation !== body.expectedCredentialGeneration) throw new HttpError(409, "grant_generation_changed", "account changed; inspect its canonical state before submitting another mutation");
      if (!canonicalRecord(current) || current.grantKey !== key) throw new HttpError(409, "grant_owner_initialization_required", "account owner requires explicit replacement or revocation before strict mutations");
    }
    const record = strictCredentialRecord(key, intent, body, current);
    let indexed: GrantAttachmentSnapshot;
    if (intent === "create") {
      // Caller-known opaque identity is not permission to replace legacy bytes
      // or retained index evidence, even when no strong credential row exists.
      if (await this.env.POLICY_KV.get(key, "text") !== null) throw new HttpError(409, "grant_already_exists", "account identity has legacy metadata; inspect it instead of retrying creation");
      indexed = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key });
      if (indexed.generation || indexed.revision || indexed.attached || indexed.pending) throw new HttpError(409, "grant_already_exists", "account identity has retained attachment evidence; repair it before choosing another identity");
    } else {
      if (current!.poolSyncPending) await this.finalize(current!, "prepare");
      indexed = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key });
    }
    const admitted = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/admit", { key, generation: current?.generation ?? 0, revision: indexed.revision, provider: record.providerId ?? null, status: attachmentStatus(record) });
    record.poolAdmissionRevision = admitted.revision;
    try { await this.state.storage.put("credential", record); }
    catch {
      // A failed ACK is not proof of failure or success. Only the exact attempt
      // read back under this same owner tail can produce a committed receipt.
      let stored: CredentialRecord | undefined;
      try { stored = await this.state.storage.get<CredentialRecord>("credential"); }
      catch { throw new HttpError(503, "grant_mutation_unconfirmed", "account save is unconfirmed; inspect the retained identity before another mutation"); }
      if (JSON.stringify(stored) !== JSON.stringify(record)) throw new HttpError(503, "grant_mutation_unconfirmed", "account save is unconfirmed; inspect the retained identity before another mutation");
      return json({ outcome: "committed", grant: accountCredentialView(record) }, 202);
    }
    try { await this.finalize(record); }
    catch { return json({ outcome: "committed", grant: accountCredentialView({ ...record, poolSyncPending: true }) }, 202); }
    return json({ outcome: "committed", grant: accountCredentialView(record) }, intent === "create" ? 201 : 200);
  }

  private async materialize(input: MaterializeRequest): Promise<OwnerResponse> {
    let record = await this.loadRecord(input.key);
    let migrated = false;
    if (!record && input.legacy && hasPrimaryCredential(input.legacy)) {
      const metadata = await this.env.POLICY_KV.get<UpstreamGrant>(input.key, "json");
      if (metadata?.revokedAt) record = revokedRecord(input.key, metadata);
      else if (metadata && hasPrimaryCredential(metadata)) record = ownerMetadata(credentialRecord(metadata, 1), metadata, input.key);
      if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
      await this.state.storage.put("credential", record);
      migrated = true;
    }
    if (!record) throw new HttpError(404, "grant_credential_missing", "upstream grant credential is not registered");
    if (record.poolSyncPending && record.enabled && record.status === "active") await this.finalize(record, "prepare");
    // Materialization may rotate tokens, but cannot adopt lifecycle state from a
    // stale KV read. Only explicit owner mutations can re-enable or reconnect.
    const stale = input.grant.credentialGeneration !== record.generation || input.grant.enabled !== record.enabled;
    let changed = false, failed = false;
    try {
      assertCredentialEnabled(record);
      if (record.providerId && record.providerId !== input.providerId || record.kind !== input.grant.kind) throw new HttpError(409, "upstream_grant_changed", "upstream grant changed; retry discovery before dispatch");
      record = await this.expireNonrenewable(record);
      if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));

      const expected = input.expectedGeneration;
      const mayForce = input.force && (expected != null ? expected === record.generation : migrated || !input.legacy);
      const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
      const expiring = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + REFRESH_MARGIN_MS;
      const deferredRefresh = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) > Date.now() : false;
      if (mayForce || expiring || record.tokenResponseError) {
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
            changed = true;
            if (record.status !== "reauth_required") {
              record.nextRefreshAttemptAt = new Date(Date.now() + REFRESH_MARGIN_MS).toISOString();
              record.poolSyncPending = true;
              await this.state.storage.put("credential", record);
            }
            throw error;
          }
        }
      }
      record = await this.expireNonrenewable(record);
      if (record.status === "reauth_required") throw new ReauthorizationRequired("upstream grant requires reauthorization", credentialProjection(record));
      assertTokenUsable(record);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // KV permits one write per key per second. Publish the final owner state
      // once. A lost write ACK cannot make the pre-write row authoritative again.
      if (stale || changed || migrated || record.poolSyncPending) try {
        const stored = await this.state.storage.get<CredentialRecord>("credential");
        if (!stored) throw new HttpError(503, "grant_mutation_unconfirmed", "account state is unavailable; inspect the retained identity before another mutation");
        record = stored;
        await this.finalize(record);
      } catch (error) {
        if (!failed) throw error;
      }
    }
    // Publication can await storage/index/KV. Recheck at the actual release
    // boundary so a deadline crossed during finalization never releases secrets.
    assertTokenUsable(record);
    return { grant: materializedGrant(metadataGrant(record), record) };
  }

  private async refresh(record: CredentialRecord, providerId: string, providerRefresh: RefreshConfig | null): Promise<CredentialRecord> {
    assertCredentialEnabled(record);
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
    // Legacy extra parameters cannot replace owner credentials or configured
    // client authentication. Public scope/audience extensions remain available.
    for (const [name, value] of Object.entries(config.extraParams ?? {})) if (!isRefreshAuthenticationParameter(name)) form.set(name, value);

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
    const observedAt = Date.now();
    let payload: Record<string, unknown>;
    try { payload = await boundedRefreshJson(response); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} returned an invalid refresh response`);
    }
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      if (permanentRefreshFailure(response.status, payload.error)) {
        const rejected = { ...record, status: "reauth_required" as const, generation: record.generation + 1, poolSyncPending: true, updatedAt: new Date().toISOString() };
        await this.state.storage.put("credential", rejected);
        throw new ReauthorizationRequired(`provider ${providerId} requires grant reauthorization`, credentialProjection(rejected));
      }
      throw new HttpError(502, "grant_refresh_failed", `provider ${providerId} rejected the refresh request`);
    }

    const updated = tokenExchangeRecord({ ...record, generation: nextCredentialGeneration(record.generation) }, payload, observedAt);
    await this.state.storage.put("credential", updated);
    return updated;
  }

  private async expireNonrenewable(record: CredentialRecord): Promise<CredentialRecord> {
    if (record.status === "reauth_required" || record.tokenResponseError || record.refreshToken || !tokenExpired(record)) return record;
    const expired = { ...record, status: "reauth_required" as const, generation: nextCredentialGeneration(record.generation), poolSyncPending: true, updatedAt: new Date().toISOString() };
    await this.state.storage.put("credential", expired);
    return expired;
  }

  private async maintain(): Promise<void> {
    let record = await this.state.storage.get<CredentialRecord>("credential");
    if (!record) return;
    record = await this.loadRecord(record.grantKey ?? "", record) ?? record;
    if (!record.enabled || !record.grantKey || record.status === "reauth_required") {
      await this.finalize(record);
      return;
    }
    if (record.poolSyncPending) await this.finalize(record, "prepare");
    record = await this.expireNonrenewable(record);
    if (!record.providerId || !record.kind) {
      await this.finalize(record);
      return;
    }
    const provider = snapshot.providers.find((candidate) => candidate.id === record!.providerId);
    const now = Date.now();
    const refreshAt = record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt) : record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN;
    if (record.status !== "reauth_required" && record.refreshToken && Number.isFinite(refreshAt) && refreshAt <= now) {
      try { record = await this.refresh(record, record.providerId!, provider?.auth.refresh ?? null); }
      catch {
        record = await this.state.storage.get<CredentialRecord>("credential") ?? record;
        if (record.status !== "reauth_required") {
          record.nextRefreshAttemptAt = new Date(now + REFRESH_MARGIN_MS).toISOString();
          record.poolSyncPending = true;
          await this.state.storage.put("credential", record);
        }
      }
    }
    record = await this.expireNonrenewable(record);
    const transport = provider ? transportForGrant(provider, materializedGrant({ provider: record.providerId, kind: record.kind }, record)) : null;
    // Renewal and terminal expiry belong to the owner even without a transport.
    // Denied tokens never participate in quota/keep-warm scheduling or egress.
    if (record.status === "reauth_required" || tokenDenied(record) || !provider || !transport) {
      await this.finalize(record);
      return;
    }
    const quotaProbe = quotaProbeForGrant(provider, materializedGrant({ provider: provider.id, kind: record.kind }, record));
    if (!quotaProbe) record.nextQuotaProbeAt = null;
    if (due(record.nextQuotaProbeAt, now) && transport.maintenance.quotaPoll && quotaProbe) {
      try {
        const state = await probeQuota(this.env, provider, record);
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
    record.poolSyncPending = true;
    record = await this.expireNonrenewable(record);
    await this.state.storage.put("credential", record);
    await this.finalize(record);
  }

  private async finalize(record: CredentialRecord, mode: "publish" | "prepare" | "backfill" = "publish"): Promise<{ record: CredentialRecord; result: GrantAttachmentResult }> {
    if (!record.grantKey) throw new HttpError(409, "grant_owner_initialization_required", "account owner requires explicit replacement or revocation before repair");
    // One durable obligation covers scheduling, index and KV. In particular,
    // a paused/tombstoned owner cannot rely on an alarm to finish a failed write.
    if (!record.poolSyncPending) {
      await this.state.storage.put("credential", { ...record, poolSyncPending: true });
      record.poolSyncPending = true;
    }
    await this.schedule(record);
    let { result } = await this.reconcileAttachment(record.grantKey);
    // Establish schedule/index before provider I/O or another owner mutation.
    // Keep the obligation open and publish only the operation's final KV state.
    if (mode === "prepare") return { record, result };
    if (mode === "backfill" && !record.revokedAt && result.outcome === "unattached" && record.providerId) {
      const generation = nextCredentialGeneration(record.generation);
      // Only the accepted migration intent can attach an old canonical owner.
      // Coalesce migration and admission into one final KV projection.
      const admitted = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/admit", { key: record.grantKey, generation: record.generation, revision: result.revision, provider: record.providerId, status: attachmentStatus(record) });
      record = { ...record, generation, poolAdmissionRevision: admitted.revision, poolSyncPending: true };
      await this.state.storage.put("credential", record);
      await this.schedule(record);
      ({ result } = await this.reconcileAttachment(record.grantKey!));
    }
    const projection = JSON.stringify(metadataGrant(record));
    // KV bytes verify publication only, after the authoritative commit. They
    // never initialize owner identity or secrets. Matching bytes recover lost ACKs.
    if (await this.env.POLICY_KV.get(record.grantKey!, "text") !== projection) await this.env.POLICY_KV.put(record.grantKey!, projection);
    await this.state.storage.put("credential", { ...record, poolSyncPending: false });
    record.poolSyncPending = false;
    return { record, result };
  }

  private async reconcileAttachment(key: string): Promise<{ record: CredentialRecord | undefined; result: GrantAttachmentResult }> {
    // Reread inside the owner tail. A failed owner read is unknown, never
    // permission to cancel pending admission or infer absence from KV.
    const record = await this.state.storage.get<CredentialRecord>("credential");
    const indexed = await authorityCall<GrantAttachmentSnapshot>(this.env, "/grant-pools/attachment", { key });
    const result = record
      ? await authorityCall<GrantAttachmentResult>(this.env, "/grant-pools/publish", { key, generation: record.generation, revision: indexed.revision, admissionRevision: record.poolAdmissionRevision, provider: record.providerId ?? null, status: attachmentStatus(record) })
      : await authorityCall<GrantAttachmentResult>(this.env, "/grant-pools/cancel-pending", { key, revision: indexed.revision });
    return { record, result };
  }

  private async schedule(record: CredentialRecord): Promise<void> {
    const denied = tokenDenied(record);
    const provider = snapshot.providers.find((candidate) => candidate.id === record.providerId);
    const grant = materializedGrant({ provider: record.providerId, kind: record.kind }, record);
    const transport = provider ? transportForGrant(provider, grant) : null;
    const recovery = record.refreshToken ? record.nextRefreshAttemptAt ? Date.parse(record.nextRefreshAttemptAt)
      : record.expiresAt ? Date.parse(record.expiresAt) - REFRESH_MARGIN_MS : NaN : NaN;
    const next = (denied ? [record.refreshToken ? recovery : record.tokenResponseError ? NaN : timestamp(record.expiresAt)] : [
      record.refreshToken ? recovery : timestamp(record.expiresAt),
      transport?.maintenance.quotaPoll && provider && quotaProbeForGrant(provider, grant) ? timestamp(record.nextQuotaProbeAt) : NaN,
      record.maintenance?.keepWarm && transport?.maintenance.keepWarm ? timestamp(record.nextKeepWarmAt) : NaN,
    ]).filter(Number.isFinite);
    if (!record.enabled || !next.length || record.status === "reauth_required") {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + MIN_ALARM_DELAY_MS, Math.min(...next)));
  }

  private async loadRecord(key: string, stored?: CredentialRecord): Promise<CredentialRecord | undefined> {
    let record = stored ?? await this.state.storage.get<CredentialRecord>("credential");
    if (!record) return record;
    if (canonicalRecord(record)) return record;
    if (!record.metadata || record.enabled === undefined) {
      const metadata = key ? await legacyGrantMetadata(this.env, key) : null;
      record = { ...record, grantKey: key || record.grantKey, metadata: secretlessGrant(metadata ?? {}), enabled: record.enabled ?? (metadata !== null && metadata.enabled !== false), poolSyncPending: true };
      // Pre-owner CLI commands revoked only KV. Import negative lifecycle facts
      // once, before any provider I/O; later KV reads never regain authority.
      if (metadata?.revokedAt) record = revokedRecord(key, { ...metadataGrant(record), revokedAt: metadata.revokedAt }, record.generation);
      else if (metadata?.enabled === false) record = { ...record, enabled: false, generation: record.generation + (record.enabled === false ? 0 : 1) };
    }
    // Existing owner records acquire a lineage once; caller/KV lineage values
    // never establish identity. Refresh preserves this owner-issued value.
    record = { ...record, lineage: record.lineage ?? crypto.randomUUID(), poolSyncPending: true };
    // Commit the denial before derived publication. The dirty flag survives
    // failure and retries reconciliation before any later provider I/O.
    await this.state.storage.put("credential", record);
    return record;
  }
}

async function probeQuota(env: Env, provider: CompiledProvider, record: CredentialRecord): Promise<GrantRuntimeState> {
  assertCredentialEnabled(record);
  assertTokenUsable(record);
  const grant = materializedGrant({ provider: provider.id, kind: record.kind, maintenance: record.maintenance }, record);
  const probe = quotaProbeForGrant(provider, grant);
  if (!probe) throw new HttpError(400, "grant_quota_probe_unavailable", `provider ${provider.id} has no quota probe for this grant kind`);
  const headers = new Headers({ accept: "application/json" });
  const url = new URL(probe.url);
  applyProviderCredential(provider, grant, env, headers, url.searchParams);
  for (const [name, value] of Object.entries(probe.headers)) headers.set(name, requiredGrantTemplate(value, grant, "grant_quota_probe_unavailable"));
  let response: Response;
  assertTokenUsable(record);
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
  assertCredentialEnabled(record);
  assertTokenUsable(record);
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
  applyTemplateHeaders(provider, provider.adapter.injectHeaders, env, headers);
  applyTemplateHeaders(provider, endpoint.headers, env, headers);
  applyTransportHeaders(headers, transport, grant);
  const path = transport.endpointPaths[endpoint.id] ?? endpoint.path;
  const url = new URL(`${(transport.baseUrl ?? resolveTemplate(provider, provider.base_urls.default, env)).replace(/\/$/, "")}${resolveTemplate(provider, path, env)}`);
  query.forEach((value, name) => url.searchParams.set(name, value));
  const body = transformTransportBody(transport, structuredClone(config.body));
  let response: Response;
  assertTokenUsable(record);
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

export async function putGrantCredentials(env: Env, key: string, grant: UpstreamGrant, preserveUnspecifiedSecrets = false, intent?: "replace", credentialInput?: UpstreamGrant): Promise<UpstreamGrant> {
  return (await ownerCall<OwnerResponse>(env, key, "/put", { key, grant, preserveUnspecifiedSecrets, intent, credentialInput })).grant;
}

export async function installOAuthTokenResponse(env: Env, key: string, grant: UpstreamGrant, tokenResponse: Record<string, unknown>, identity: Pick<UpstreamGrant, "provider" | "kind" | "enabled" | "priority" | "weight" | "accountId" | "subscription"> = {}, observedAt = Date.now()): Promise<UpstreamGrant> {
  const credentialInput: UpstreamGrant = { ...identity, accessToken: boundedSecret(tokenResponse.access_token, "access token") };
  if (typeof tokenResponse.refresh_token === "string" && tokenResponse.refresh_token) credentialInput.refreshToken = tokenResponse.refresh_token;
  return (await ownerCall<OwnerResponse>(env, key, "/token-exchange", { key, grant, credentialInput, tokenResponse, tokenResponseObservedAt: observedAt, preserveUnspecifiedSecrets: true })).grant;
}

function tokenExchangeRecord(record: CredentialRecord, payload: Record<string, unknown>, observedAt: number): CredentialRecord {
  const now = Date.now();
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token ? boundedSecret(payload.refresh_token, "refresh token") : record.refreshToken;
  // Body parsing and the serialized owner queue consume token lifetime; neither
  // may restart the provider's expires_in clock at the eventual storage write.
  const expiry = tokenResponseExpiry(payload, observedAt);
  return {
    ...record, ...expiry, status: !refreshToken && tokenExpired(expiry, now) ? "reauth_required" : "active", poolSyncPending: true,
    accessToken: boundedSecret(payload.access_token, "access token"), refreshToken,
    tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : record.tokenType,
    scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean).slice(0, 128) : record.scopes,
    nextRefreshAttemptAt: refreshToken && tokenDenied(expiry, now) ? new Date(now + REFRESH_MARGIN_MS).toISOString() : null,
    updatedAt: new Date(now).toISOString(),
  };
}

export async function accountCredentialResponse(env: Env, key: string, intent: GrantCredentialIntent | "read", body?: unknown): Promise<Response> {
  // Carry the owner's exact safe receipt and HTTP status through the adapter.
  // Runtime/quota enrichment after commit could fail or observe a later account.
  const response = await ownerFetch(env, key, intent === "read" ? "/read" : "/mutate", { key, intent, body });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function accountModelInventoryResponse(env: Env, key: string, refresh: boolean, body?: unknown): Promise<Response> {
  const response = await ownerFetch(env, key, refresh ? "/models/refresh" : "/models/read", { key, body });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function reconcileGrantAttachment(env: Env, key: string): Promise<GrantAttachmentResult> {
  return ownerCall<GrantAttachmentResult>(env, key, "/reconcile", { key });
}

export async function backfillGrantAttachment(env: Env, key: string): Promise<GrantAttachmentResult & { ownerPresent: boolean }> {
  return ownerCall(env, key, "/backfill", { key });
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

async function ownerCall<T>(env: Env, key: string, path: string, body: unknown): Promise<T> {
  const response = await ownerFetch(env, key, path, body);
  const text = await response.text();
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string; detail?: { projection?: CredentialProjection } } } = {};
    try { payload = JSON.parse(text); } catch { /* redacted internal error */ }
    throw new HttpError(response.status, payload.error?.code ?? "credential_owner_error", payload.error?.message ?? "grant credential operation failed");
  }
  return text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) as T : text as T;
}

function ownerFetch(env: Env, key: string, path: string, body: unknown): Promise<Response> {
  const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key));
  return stub.fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
}

async function legacyGrantMetadata(env: Env, key: string, recover = false): Promise<UpstreamGrant | null> {
  return readLegacyGrant(env, key, recover, true);
}

async function readLegacyGrant(env: Env, key: string, recover = false, metadataOnly = false): Promise<UpstreamGrant | null> {
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
  return metadataOnly ? legacyMetadata(value as UpstreamGrant) : value as UpstreamGrant;
}

function legacyMetadata(legacy: UpstreamGrant | null): UpstreamGrant | null {
  if (legacy === null) return null;
  const metadata = stripLegacySecrets(legacy) as Record<string, unknown>;
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
