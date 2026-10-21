import type { ContinuationOwner } from "./continuation-store.ts";
import { isToolKnowledge, type ToolKnowledge } from "./responses-tool-evidence.ts";
import { HttpError, json } from "./utils.ts";

export const compactionWitnessRetentionMs = 30 * 24 * 60 * 60_000;
export const compactionWitnessCapacity = 100_000;
export const compactionWitnessBatchLimit = 16;
export interface WitnessBinding {
  authType: string; tenantId: string; policyId: string; credentialId: string | null; principalId: string | null; model: string;
  owner: ContinuationOwner;
}
export interface CompactionWitness {
  version: 1; itemId: string; ciphertextSha256: string; binding: WitnessBinding; knowledge: ToolKnowledge;
  producerId: string; createdAtMs: number;
}
export type WitnessInput = { action: "witness_register"; witnesses: CompactionWitness[] } | { action: "witness_resolve"; keys: string[] };
type Row = { witness_json: string; expires_at_ms: number };
export const witnessKey = (itemId: string, ciphertextSha256: string) => JSON.stringify([itemId, ciphertextSha256]);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 256;

// This table shares the authorization-scoped continuation DO and its serialized
// alarm. No ciphertext, prompt, completion, token or raw upstream credential is stored.
export class CompactionWitnessStore {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS compaction_witnesses (binding_key TEXT PRIMARY KEY, witness_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS compaction_witness_expiry ON compaction_witnesses(expires_at_ms)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS compaction_witness_count (id INTEGER PRIMARY KEY CHECK(id = 1), count INTEGER NOT NULL)");
    storage.sql.exec("INSERT OR IGNORE INTO compaction_witness_count (id, count) VALUES (1, 0)");
  }
  handle(input: WitnessInput): Response {
    const now = Date.now();
    if (input.action === "witness_resolve") {
      if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > compactionWitnessBatchLimit || input.keys.some(key => !validKey(key))) invalid();
      return json({ witnesses: input.keys.map(key => {
        const row = this.get(key), value = parseWitness(row?.witness_json);
        return value && witnessKey(value.itemId, value.ciphertextSha256) === key && row!.expires_at_ms === value.createdAtMs + compactionWitnessRetentionMs && value.createdAtMs <= now && row!.expires_at_ms > now ? value : null;
      }) });
    }
    if (input.action !== "witness_register" || !Array.isArray(input.witnesses) || !input.witnesses.length || input.witnesses.length > compactionWitnessBatchLimit || input.witnesses.some(value => !validWitness(value) || JSON.stringify(value).length > 4096)) invalid();
    const witnesses = input.witnesses;
    if (new Set(witnesses.map(value => witnessKey(value.itemId, value.ciphertextSha256))).size !== witnesses.length) invalid();
    const outcome = this.storage.transactionSync(() => {
      // Admission time fixes retention. A late producer can never resurrect an
      // expired record or refresh another producer after cleanup/reconstruction.
      if (witnesses.some(value => value.createdAtMs > now || value.createdAtMs + compactionWitnessRetentionMs <= now)) return "unavailable";
      for (const value of witnesses) {
        const row = this.get(witnessKey(value.itemId, value.ciphertextSha256));
        if (row && (row.witness_json !== JSON.stringify(value) || row.expires_at_ms !== value.createdAtMs + compactionWitnessRetentionMs)) return "conflict";
      }
      this.expire(now);
      const missing = witnesses.filter(value => !this.get(witnessKey(value.itemId, value.ciphertextSha256)));
      const count = [...this.storage.sql.exec<{ count: number }>("SELECT count FROM compaction_witness_count WHERE id = 1")][0].count;
      if (count + missing.length > compactionWitnessCapacity) return "capacity";
      for (const value of missing) this.storage.sql.exec("INSERT INTO compaction_witnesses (binding_key, witness_json, expires_at_ms) VALUES (?, ?, ?)", witnessKey(value.itemId, value.ciphertextSha256), JSON.stringify(value), value.createdAtMs + compactionWitnessRetentionMs);
      if (missing.length) this.storage.sql.exec("UPDATE compaction_witness_count SET count = count + ? WHERE id = 1", missing.length);
      return "stored";
    });
    return json({ outcome });
  }
  private get(key: string): Row | null {
    return [...this.storage.sql.exec<Row>("SELECT witness_json, expires_at_ms FROM compaction_witnesses WHERE binding_key = ?", key)][0] ?? null;
  }
  expire(now: number): void {
    const count = [...this.storage.sql.exec("DELETE FROM compaction_witnesses WHERE binding_key IN (SELECT binding_key FROM compaction_witnesses WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 256) RETURNING binding_key", now)].length;
    if (count) this.storage.sql.exec("UPDATE compaction_witness_count SET count = count - ? WHERE id = 1", count);
  }
  nextDeadline(): number | undefined { return [...this.storage.sql.exec<{ expires_at_ms: number }>("SELECT expires_at_ms FROM compaction_witnesses ORDER BY expires_at_ms LIMIT 1")][0]?.expires_at_ms; }
}
function validKey(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 1600) return false;
  try { const key = JSON.parse(value); return Array.isArray(key) && key.length === 2 && text(key[0]) && digest(key[1]) && witnessKey(key[0], key[1]) === value; } catch { return false; }
}
function validBinding(value: WitnessBinding): boolean {
  if (!value || Object.keys(value).length !== 7 || ![value.authType, value.tenantId, value.policyId, value.model].every(text) || ![value.credentialId, value.principalId].every(item => item === null || text(item))) return false;
  const owner = value.owner;
  return !!owner && Object.keys(owner).length === 6 && [owner.providerId, owner.endpointId, owner.policyGeneration].every(text) && digest(owner.routeSha256)
    && (owner.grantKey === null || typeof owner.grantKey === "string" && owner.grantKey.startsWith("oauth/") && owner.grantKey.length <= 1024) && (owner.lineage === null || text(owner.lineage));
}
export function validCompactionWitness(value: unknown): value is CompactionWitness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const witness = value as CompactionWitness;
  return validWitness(witness);
}
function validWitness(value: CompactionWitness): boolean {
  return !!value && Object.keys(value).length === 7 && value.version === 1 && text(value.itemId) && digest(value.ciphertextSha256) && digest(value.producerId)
    && Number.isSafeInteger(value.createdAtMs) && value.createdAtMs >= 0 && value.createdAtMs <= Number.MAX_SAFE_INTEGER - compactionWitnessRetentionMs && validBinding(value.binding) && isToolKnowledge(value.knowledge);
}
function parseWitness(value: string | undefined): CompactionWitness | null {
  if (!value || value.length > 4096) return null;
  try { const parsed = JSON.parse(value); return validCompactionWitness(parsed) ? parsed : null; } catch { return null; }
}
function invalid(): never { throw new HttpError(400, "compaction_witness_invalid", "invalid compaction witness authority request"); }
