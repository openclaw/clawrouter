import { HttpError, json, readJson } from "./utils.ts";
import { isToolKnowledge, type ToolKnowledge } from "./responses-tool-evidence.ts";

export interface ContinuationOwner {
  providerId: string;
  endpointId: string;
  grantKey: string | null;
  lineage: string | null;
  routeSha256: string;
  policyGeneration: string;
}
export const continuationRetentionMs = 30 * 24 * 60 * 60_000;
export const continuationCapacity = 1_000_000;
export type PricingEvidence = { version: 1; producerId: string } & ({ state: "pending" } | { state: "final"; knowledge: ToolKnowledge });
export type EvidenceFinalization = { outcome: "qualified" | "producer_conflict" | "conflict" | "unavailable" };
type Input = { action: "resolve" | "register" | "qualify"; keys: string[]; owner?: ContinuationOwner; responseClaim?: { key: string; producerId: string }; knowledge?: ToolKnowledge };
type Row = { owner_json: string; pricing_evidence_json: string | null };

// Each instance lives in an authorization-scoped ACCESS_CONTROL object. Only
// digests, routing ownership and bounded tool knowledge are stored; opaque
// upstream state stays on wire.
export class HttpContinuationStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS http_continuations (binding_key TEXT PRIMARY KEY, owner_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, pricing_evidence_json TEXT)");
    if (![...storage.sql.exec<{ name: string }>("PRAGMA table_info(http_continuations)")].some(column => column.name === "pricing_evidence_json")) storage.sql.exec("ALTER TABLE http_continuations ADD COLUMN pricing_evidence_json TEXT");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS http_continuations_expiry ON http_continuations(expires_at_ms)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS http_continuation_count (id INTEGER PRIMARY KEY CHECK(id = 1), count INTEGER NOT NULL)");
    storage.sql.exec("INSERT OR IGNORE INTO http_continuation_count (id, count) VALUES (1, 0)");
  }

  fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      const input = await readJson<Input>(request);
      if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 2 || input.keys.some(key => !digest(key))) invalid();
      const keys = [...new Set(input.keys)], now = Date.now();
      if (input.action === "resolve") {
        const rows = keys.map(key => this.get(key, now));
        return json({ owners: rows.map(row => row ? JSON.parse(row.owner_json) : null), evidence: rows.map(row => parseEvidence(row?.pricing_evidence_json)) });
      }
      if (!["register", "qualify"].includes(input.action) || !validOwner(input.owner)) invalid();
      const claim = input.responseClaim;
      if (claim && (!keys.includes(claim.key) || !digest(claim.producerId))) invalid();
      const { providerId, endpointId, grantKey, lineage, routeSha256, policyGeneration } = input.owner;
      const owner = JSON.stringify({ providerId, endpointId, grantKey, lineage, routeSha256, policyGeneration });
      if (input.action === "qualify") {
        if (!claim || keys.length !== 1 || !isToolKnowledge(input.knowledge)) invalid();
        const outcome = this.storage.transactionSync(() => {
          const row = this.get(claim.key, now), evidence = parseEvidence(row?.pricing_evidence_json);
          if (!row) return "unavailable";
          if (row.owner_json !== owner) return "conflict";
          if (!evidence || evidence.producerId !== claim.producerId) return "producer_conflict";
          if (evidence.state === "final") return evidence.knowledge === input.knowledge ? "qualified" : "producer_conflict";
          this.storage.sql.exec("UPDATE http_continuations SET pricing_evidence_json = ? WHERE binding_key = ?", JSON.stringify({ ...evidence, state: "final", knowledge: input.knowledge }), claim.key);
          return "qualified";
        });
        return json({ outcome } satisfies EvidenceFinalization);
      }
      const outcome = this.storage.transactionSync(() => {
        // Check conflicts before cleanup or insertion. A mixed-version writer
        // cannot reuse an identity and leave another producer's clean proof live.
        const existing = keys.map(key => this.get(key, now));
        if (existing.some(row => row && row.owner_json !== owner)) return "conflict";
        if (existing.some((row, index) => row?.pricing_evidence_json != null && (!claim || keys[index] !== claim.key || parseEvidence(row.pricing_evidence_json)?.producerId !== claim.producerId))) return "producer_conflict";
        for (const key of keys) {
          const deleted = [...this.storage.sql.exec("DELETE FROM http_continuations WHERE binding_key = ? AND expires_at_ms <= ? RETURNING binding_key", key, now)].length;
          if (deleted) this.storage.sql.exec("UPDATE http_continuation_count SET count = count - 1 WHERE id = 1");
        }
        this.expire(now);
        const missing = keys.filter((_, index) => !existing[index]);
        const count = [...this.storage.sql.exec<{ count: number }>("SELECT count FROM http_continuation_count WHERE id = 1")][0].count;
        if (count + missing.length > continuationCapacity) return "capacity";
        for (const key of missing) this.storage.sql.exec("INSERT INTO http_continuations (binding_key, owner_json, expires_at_ms, pricing_evidence_json) VALUES (?, ?, ?, ?)", key, owner, now + continuationRetentionMs, key === claim?.key ? JSON.stringify({ version: 1, producerId: claim.producerId, state: "pending" }) : null);
        if (missing.length) this.storage.sql.exec("UPDATE http_continuation_count SET count = count + ? WHERE id = 1", missing.length);
        return "stored";
      });
      await this.schedule(now);
      return json({ outcome, ...(outcome === "stored" && claim ? { claim: this.get(claim.key, now)?.pricing_evidence_json === null ? "legacy_unknown" : "owned" } : {}) });
    });
  }

  alarm(): Promise<void> {
    return this.serialize(async () => {
      const now = Date.now();
      this.storage.transactionSync(() => this.expire(now));
      await this.schedule(now);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Include alarm scheduling in this tail: a later write must not postpone an
    // earlier expiry between get/setAlarm awaits. SQL transactions remain sync.
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private get(key: string, now: number): Row | null {
    return [...this.storage.sql.exec<Row>("SELECT owner_json, pricing_evidence_json FROM http_continuations WHERE binding_key = ? AND expires_at_ms > ?", key, now)][0] ?? null;
  }

  private expire(now: number): void {
    const deleted = [...this.storage.sql.exec("DELETE FROM http_continuations WHERE binding_key IN (SELECT binding_key FROM http_continuations WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 256) RETURNING binding_key", now)].length;
    if (deleted) this.storage.sql.exec("UPDATE http_continuation_count SET count = count - ? WHERE id = 1", deleted);
  }

  private async schedule(now: number): Promise<void> {
    const next = [...this.storage.sql.exec<{ expires_at_ms: number }>("SELECT expires_at_ms FROM http_continuations ORDER BY expires_at_ms LIMIT 1")][0]?.expires_at_ms;
    if (next === undefined) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(now + 1000, next));
  }
}

function parseEvidence(value: string | null | undefined): PricingEvidence | null {
  if (!value || value.length > 256) return null;
  try {
    const evidence = JSON.parse(value);
    return evidence?.version === 1 && digest(evidence.producerId) && (evidence.state === "pending" && Object.keys(evidence).length === 3 || evidence.state === "final" && isToolKnowledge(evidence.knowledge) && Object.keys(evidence).length === 4) ? evidence : null;
  } catch { return null; }
}

function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function validOwner(value: unknown): value is ContinuationOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as ContinuationOwner;
  const segment = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 256;
  return Object.keys(owner).length === 6 && segment(owner.providerId) && segment(owner.endpointId) && segment(owner.policyGeneration)
    && (owner.grantKey === null || typeof owner.grantKey === "string" && owner.grantKey.startsWith("oauth/") && owner.grantKey.length <= 1024)
    && (owner.lineage === null || segment(owner.lineage)) && digest(owner.routeSha256);
}
function invalid(): never { throw new HttpError(400, "continuation_request_invalid", "invalid continuation authority request"); }
