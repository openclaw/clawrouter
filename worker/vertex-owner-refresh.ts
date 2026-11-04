import { createVertexAssertion, importVertexServiceAccountKey, vertexTokenRequest, decodeVertexAccessToken, vertexScope } from "./provider-vertex.ts";
import { vertexOwnerBinding } from "./vertex-anthropic-binding.ts";
import { HttpOperation } from "./http-operation.ts";
import type { CredentialRecord, MaterializeRequest, OwnerResponse } from "./grant-credential-record.ts";
import { HttpError } from "./utils.ts";

interface Owner {
  order<T>(run: () => Promise<T>): Promise<T>;
  load(key: string): Promise<CredentialRecord | undefined>;
  read(): Promise<CredentialRecord | undefined>;
  save(record: CredentialRecord): Promise<void>;
  materialize(input: MaterializeRequest): Promise<OwnerResponse>;
  result(record: CredentialRecord): OwnerResponse;
  publish(record: CredentialRecord): Promise<void>;
  failure(record: CredentialRecord, persisted: boolean): Promise<CredentialRecord>;
}
const unavailable = () => new HttpError(502, "grant_refresh_at_risk", "Vertex token exchange could not be confirmed; explicit credential replacement is required");
const changed = () => new HttpError(409, "upstream_grant_changed", "original Vertex credential authority changed");
const same = (a: CredentialRecord | undefined, b: CredentialRecord) => !!a && a.enabled === true && !a.revokedAt
  && a.status === "active" && !["ambiguous", "provider_ok_persist_failed"].includes(a.refreshDiagnosis?.failure?.failureClass ?? "") && a.grantKey === b.grantKey && a.providerId === b.providerId && a.generation === b.generation
  && a.lineage === b.lineage && a.refreshAttempt?.id === b.refreshAttempt?.id
  && a.refreshAttempt?.generation === b.generation && JSON.stringify(a.vertexAnthropicBinding) === JSON.stringify(b.vertexAnthropicBinding);

// This is the existing credential owner's refreshAttempt fence. Only reserve,
// start and settle occupy its ordering tail; Google response I/O never does.
export class VertexOwnerRefresh {
  private owner: Owner;
  private active?: { id: string; operation: HttpOperation };
  constructor(owner: Owner) { this.owner = owner; }
  live(record: CredentialRecord): boolean { return !!this.active && this.active.id === record.refreshAttempt?.id; }
  invalidate(): void { this.active?.operation.cancel(); }

  async materialize(input: MaterializeRequest, signal?: AbortSignal): Promise<OwnerResponse> {
    const prepared = await this.owner.order(async () => {
      const record = await this.owner.load(input.key), binding = record && vertexOwnerBinding(record);
      if (binding?.source !== "service_account") return { result: await this.owner.materialize(input) };
      if (!record || record.enabled !== true || record.revokedAt || record.status !== "active" || record.grantKey !== input.key
        || input.providerId !== "anthropic-vertex" || input.grant.provider !== record.providerId || input.grant.kind !== record.kind
        || input.expectedGeneration !== record.generation || input.grant.credentialLineage !== record.lineage) throw changed();
      if (record.refreshAttempt) throw unavailable();
      if (!input.force && record.accessToken && Date.parse(record.expiresAt ?? "") > Date.now() + 300_000)
        return { result: await this.owner.materialize(input) };
      if (!Number.isSafeInteger(record.generation) || record.generation >= Number.MAX_SAFE_INTEGER - 1) throw changed();
      signal?.throwIfAborted();
      const key = await importVertexServiceAccountKey(record.vertexPrivateKey!);
      const assertion = await createVertexAssertion(binding.clientEmail, key, Math.floor(Date.now() / 1000), binding.keyId);
      signal?.throwIfAborted();
      const fenced: CredentialRecord = { ...record, refreshAttempt: { id: crypto.randomUUID(), generation: record.generation } };
      await this.owner.save(fenced); // unknown on restart, before the only exchange
      const operation = new HttpOperation(signal, 30_000);
      this.active = { id: fenced.refreshAttempt!.id, operation };
      const requestedAt = Math.floor(Date.now() / 1000);
      // Even a synchronous fetch throw settles the durable uncertainty fence.
      const response = operation.signal.aborted ? Promise.reject(unavailable()) : (() => {
        try { return operation.wait(fetch(vertexTokenRequest(assertion), { signal: operation.signal }), undefined,
          late => { void late.body?.cancel().catch(() => undefined); }); }
        catch { return Promise.reject(unavailable()); }
      })();
      return { fenced, operation, requestedAt, response };
    });
    if (prepared.result) return prepared.result;
    const { fenced, operation, requestedAt, response } = prepared;
    let committed = false;
    try {
      const token = await readVertexToken(await response, operation.signal, requestedAt);
      return await this.owner.order(async () => {
        const current = await this.owner.read();
        operation.signal.throwIfAborted();
        if (!same(current, fenced) || token.expiresAt * 1000 <= Date.now() + 60_000) throw changed();
        const now = new Date().toISOString();
        const updated: CredentialRecord = { ...current!, generation: current!.generation + 1, accessToken: token.accessToken,
          tokenType: "Bearer", expiresAt: new Date(token.expiresAt * 1000).toISOString(), scopes: [vertexScope],
          refreshAttempt: null, nextRefreshAttemptAt: null, poolSyncPending: true, updatedAt: now,
          refreshDiagnosis: { lastSuccessfulRefreshAt: now, failure: null } };
        try { await this.owner.save(updated); }
        catch {
          // A storage ACK can be lost after commit. Recover that exact row;
          // otherwise retain the original fence. Never repeat the exchange.
          const stored = await this.owner.read();
          if (stored?.generation === updated.generation && stored.lineage === updated.lineage
            && stored.accessToken === updated.accessToken && stored.expiresAt === updated.expiresAt && !stored.refreshAttempt) committed = true;
          if (!committed) {
            if (same(stored, fenced)) await this.owner.failure(fenced, true);
            throw unavailable();
          }
        }
        committed = true;
        await this.owner.publish(updated);
        return this.owner.result(updated);
      });
    } catch (error) {
      if (!committed) await this.owner.order(async () => {
        const current = await this.owner.read();
        if (same(current, fenced) && current?.refreshDiagnosis?.failure?.failureClass !== "provider_ok_persist_failed")
          await this.owner.publish(await this.owner.failure(fenced, false));
      });
      throw error instanceof HttpError ? error : unavailable();
    } finally {
      operation.stop("complete");
      if (this.active?.id === fenced.refreshAttempt?.id) this.active = undefined;
    }
  }
}

async function readVertexToken(response: Response, signal: AbortSignal, requestedAt: number) {
  const limit = 32 * 1024, length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || ![null, "identity"].includes(response.headers.get("content-encoding"))
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined); throw unavailable();
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, reads = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      if (++reads > 8192 || size + chunk.value.byteLength > limit) throw unavailable();
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (length !== null && Number(length) !== size) throw unavailable();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    // Only the codec's token envelope is admitted, never refresh-token or URL
    // instructions. The bounded document has no nested resource authority.
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(name => !["access_token", "token_type", "expires_in", "scope"].includes(name))) throw unavailable();
    return decodeVertexAccessToken(value, requestedAt);
  } catch { await reader.cancel().catch(() => undefined); throw unavailable(); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
