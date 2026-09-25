import type { AccountModelInventory, ModelDiscoveryAttempt, ModelInventorySnapshot, ModelInventorySource } from "../shared/contracts.ts";
import { canonicalRecord, materializedGrant, metadataGrant, nextCredentialGeneration, type CredentialRecord } from "./grant-credential-record.ts";
import { tokenDenied } from "./grant-expiry.ts";
import { applyProviderCredential } from "./provider-auth.ts";
import type { CompiledProvider, Env } from "./types.ts";
import { HttpError } from "./utils.ts";
import type { ModelDiscoveryResult } from "./model-discovery.ts";

interface Capture {
  attempt: ModelDiscoveryAttempt;
  key: string;
  lineage: string;
  headers: Headers;
}
interface InventoryState { attempt: ModelDiscoveryAttempt | null; snapshot: ModelInventorySnapshot | null }

// Additive, lazy SQLite state in the existing per-account owner. Each table
// contains at most one row; inspect must never create tables or heal an account.
function ensure(storage: DurableObjectStorage): void {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS model_discovery_attempt (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS model_discovery_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
}
function read(storage: DurableObjectStorage): InventoryState {
  const tables = new Set([...storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('model_discovery_attempt', 'model_discovery_snapshot')")].map(row => row.name));
  const attempt = tables.has("model_discovery_attempt") ? [...storage.sql.exec<{ payload: string }>("SELECT payload FROM model_discovery_attempt WHERE id = 1")][0] : null;
  const snapshot = tables.has("model_discovery_snapshot") ? [...storage.sql.exec<{ payload: string }>("SELECT payload FROM model_discovery_snapshot WHERE id = 1")][0] : null;
  return { attempt: attempt ? JSON.parse(attempt.payload) as ModelDiscoveryAttempt : null, snapshot: snapshot ? JSON.parse(snapshot.payload) as ModelInventorySnapshot : null };
}
function saveAttempt(storage: DurableObjectStorage, attempt: ModelDiscoveryAttempt): void {
  storage.sql.exec("INSERT INTO model_discovery_attempt (id, payload) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload", JSON.stringify(attempt));
}
function usable(record: CredentialRecord): boolean {
  return record.enabled === true && !record.revokedAt && record.status === "active" && record.kind === "api_key" && !tokenDenied(record);
}
function sameSource(source: ModelInventorySource, record: CredentialRecord, provider: CompiledProvider | undefined): boolean {
  return source.credentialGeneration === record.generation && source.providerId === record.providerId && source.adapter === provider?.modelDiscovery?.adapter;
}

export function inspectModelInventory(storage: DurableObjectStorage, record: CredentialRecord, provider: CompiledProvider | undefined): AccountModelInventory {
  const { attempt, snapshot } = read(storage), sourceMatches = !!snapshot && sameSource(snapshot, record, provider);
  return {
    key: record.grantKey!, providerId: record.providerId ?? null, credentialGeneration: record.generation, adapter: provider?.modelDiscovery?.adapter ?? null,
    attempt, snapshot, sourceMatches,
    stale: !sourceMatches || !usable(record) || attempt?.attemptGeneration !== snapshot?.attemptGeneration || attempt?.status !== "succeeded",
  };
}

export function captureModelDiscovery(storage: DurableObjectStorage, record: CredentialRecord, provider: CompiledProvider | undefined, env: Env, body: unknown): Capture {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "expectedCredentialGeneration")) throw new HttpError(400, "invalid_model_discovery", "model discovery requires only expectedCredentialGeneration");
  const expected = (body as Record<string, unknown>).expectedCredentialGeneration;
  if (!Number.isSafeInteger(expected) || (expected as number) < 1) throw new HttpError(400, "invalid_model_discovery", "expectedCredentialGeneration must be a positive safe integer");
  if (expected !== record.generation) throw new HttpError(409, "grant_generation_changed", "account changed; inspect it before refreshing models");
  if (!provider?.modelDiscovery || record.kind !== "api_key") throw new HttpError(400, "model_discovery_unsupported", "model discovery requires a stored API key and a declared discovery adapter");
  if (!usable(record)) throw new HttpError(409, "model_discovery_unavailable", "account is disabled, revoked, expired or requires reauthorization");
  const headers = new Headers(), query = new URLSearchParams();
  applyProviderCredential(provider, materializedGrant(metadataGrant(record), record), env, headers, query);
  const header = provider.modelDiscovery.adapter === "openai.models" ? "authorization" : "x-goog-api-key";
  const credential = headers.get(header);
  if (!credential || [...query].length) throw new HttpError(400, "model_discovery_unsupported", "discovery adapter requires its declared API key header");
  const attempt: ModelDiscoveryAttempt = {
    providerId: provider.id, credentialGeneration: record.generation, adapter: provider.modelDiscovery.adapter,
    attemptGeneration: nextCredentialGeneration(read(storage).attempt?.attemptGeneration ?? 0),
    startedAt: new Date().toISOString(), completedAt: null, status: "running", error: null,
  };
  ensure(storage);
  saveAttempt(storage, attempt);
  return { attempt, key: record.grantKey!, lineage: record.lineage!, headers: new Headers({ [header]: credential }) };
}

export function modelDiscoveryAuthority(storage: DurableObjectStorage, capture: Capture, record: CredentialRecord | undefined, provider: CompiledProvider | undefined): { current: InventoryState; sourceChanged: boolean } {
  const current = read(storage);
  if (current.attempt?.attemptGeneration !== capture.attempt.attemptGeneration || current.attempt.status !== "running") throw new HttpError(409, "model_discovery_superseded", "a newer model refresh owns this result; inspect the current attempt");
  const sourceChanged = !record || !canonicalRecord(record) || capture.key !== record.grantKey || capture.lineage !== record.lineage || !sameSource(capture.attempt, record, provider) || !usable(record);
  return { current, sourceChanged };
}

export function completeModelDiscovery(storage: DurableObjectStorage, capture: Capture, record: CredentialRecord | undefined, provider: CompiledProvider | undefined, result: ModelDiscoveryResult): void {
  storage.transactionSync(() => {
    const { current, sourceChanged } = modelDiscoveryAuthority(storage, capture, record, provider);
    const error = sourceChanged ? "source_changed" : result.error;
    const completedAt = new Date().toISOString();
    if (!error && result.models) {
      const previous = current.snapshot;
      const ids = new Set(result.models.map(model => model.id));
      const snapshot: ModelInventorySnapshot = {
        providerId: capture.attempt.providerId, credentialGeneration: capture.attempt.credentialGeneration, adapter: capture.attempt.adapter,
        snapshotGeneration: nextCredentialGeneration(previous?.snapshotGeneration ?? 0), attemptGeneration: capture.attempt.attemptGeneration,
        observedAt: completedAt, models: result.models,
        removedIds: previous && sameSource(previous, record!, provider) ? previous.models.filter(model => !ids.has(model.id)).map(model => model.id) : [],
      };
      storage.sql.exec("INSERT INTO model_discovery_snapshot (id, payload) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload", JSON.stringify(snapshot));
    }
    saveAttempt(storage, { ...capture.attempt, completedAt, status: error ? "failed" : "succeeded", error });
  });
}
