import { HttpError, json, readJson } from "./utils.ts";

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
type Input = { action: "resolve" | "register"; keys: string[]; owner?: ContinuationOwner };

// Each instance lives in an authorization-scoped ACCESS_CONTROL object. Only
// digests and routing ownership are stored; opaque upstream state stays on wire.
export class HttpContinuationStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS http_continuations (binding_key TEXT PRIMARY KEY, owner_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
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
        const owners = keys.map(key => this.get(key, now));
        return json({ owners });
      }
      if (input.action !== "register" || !validOwner(input.owner)) invalid();
      const { providerId, endpointId, grantKey, lineage, routeSha256, policyGeneration } = input.owner;
      const owner = JSON.stringify({ providerId, endpointId, grantKey, lineage, routeSha256, policyGeneration });
      const outcome = this.storage.transactionSync(() => {
        for (const key of keys) {
          const deleted = [...this.storage.sql.exec("DELETE FROM http_continuations WHERE binding_key = ? AND expires_at_ms <= ? RETURNING binding_key", key, now)].length;
          if (deleted) this.storage.sql.exec("UPDATE http_continuation_count SET count = count - 1 WHERE id = 1");
        }
        this.expire(now);
        const existing = keys.map(key => this.get(key, now));
        if (existing.some(value => value && JSON.stringify(value) !== owner)) return "conflict";
        const missing = keys.filter((_, index) => !existing[index]);
        const count = [...this.storage.sql.exec<{ count: number }>("SELECT count FROM http_continuation_count WHERE id = 1")][0].count;
        if (count + missing.length > continuationCapacity) return "capacity";
        for (const key of missing) this.storage.sql.exec("INSERT INTO http_continuations (binding_key, owner_json, expires_at_ms) VALUES (?, ?, ?)", key, owner, now + continuationRetentionMs);
        if (missing.length) this.storage.sql.exec("UPDATE http_continuation_count SET count = count + ? WHERE id = 1", missing.length);
        return "stored";
      });
      await this.schedule(now);
      return json({ outcome });
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

  private get(key: string, now: number): ContinuationOwner | null {
    const row = [...this.storage.sql.exec<{ owner_json: string }>("SELECT owner_json FROM http_continuations WHERE binding_key = ? AND expires_at_ms > ?", key, now)][0];
    return row ? JSON.parse(row.owner_json) : null;
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
