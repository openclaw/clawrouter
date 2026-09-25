import type { GrantPoolReadiness, GrantPoolRepairIssue } from "../shared/contracts.ts";
import { HttpError } from "./utils.ts";

const PAGE_SIZE = 32;
const MAX_ISSUES = 64;
type ScanPhase = "kv" | "index";
export interface GrantPoolScanPage {
  scanRevision: number;
  phase: ScanPhase;
  cursor: string | null;
  nextCursor: string | null;
  count: number;
  issues: GrantPoolRepairIssue[];
}

// This singleton fences the one-time cutover, not individual memberships.
// Per-account generation, admission receipts and revision remain index-owned.
export class GrantPoolReadinessStore {
  private sql: SqlStorage;
  private storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS upstream_grant_pool_readiness (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)");
  }

  status(): GrantPoolReadiness {
    const row = [...this.sql.exec<{ state_json: string }>("SELECT state_json FROM upstream_grant_pool_readiness WHERE singleton = 1")][0];
    const state: GrantPoolReadiness = row ? JSON.parse(row.state_json) : {
      revision: 0, baseline: null, acceptedAt: null, phase: "idle", cursor: null,
      scanRevision: null, scanned: 0, issues: [], overflow: false, activatedAt: null,
    };
    return state;
  }

  mutation(): void {
    const state = this.status();
    state.revision++;
    this.save(state);
  }

  baseline(input: { revision: number; baseline: "fresh" | "existing"; confirmed: boolean }): GrantPoolReadiness {
    return this.storage.transactionSync(() => {
      const state = this.current(input.revision);
      if (state.baseline) conflict("baseline was already accepted; read the current readiness state");
      if (!["fresh", "existing"].includes(input.baseline) || input.confirmed !== true) throw new HttpError(400, "grant_pool_baseline_required", "confirm newly provisioned storage, or stopped legacy writers and a checked account inventory");
      // Authentication authorizes this explicit operator attestation. Neither
      // an empty KV scan nor a newly created authority proves storage is fresh.
      return this.save({ ...state, revision: state.revision + 1, baseline: input.baseline, acceptedAt: new Date().toISOString() });
    });
  }

  begin(input: { revision: number }): GrantPoolReadiness {
    return this.storage.transactionSync(() => {
      const state = this.current(input.revision);
      if (!state.baseline) conflict("accept the storage baseline before scanning");
      if (state.activatedAt) conflict("attachment routing is already active; use bounded repair");
      const revision = state.revision + 1;
      return this.save({ ...state, revision, scanRevision: revision, phase: "kv", cursor: null, scanned: 0, issues: [], overflow: false });
    });
  }

  advance(input: GrantPoolScanPage): GrantPoolReadiness {
    return this.storage.transactionSync(() => {
      const state = this.status();
      if (state.activatedAt || state.scanRevision !== input.scanRevision || state.phase !== input.phase || state.cursor !== input.cursor) conflict("scan page changed; read its current cursor before continuing");
      if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > PAGE_SIZE || !Array.isArray(input.issues) || input.issues.length > PAGE_SIZE) throw new HttpError(400, "invalid_grant_pool_scan", "scan page must contain at most 32 keys");
      if (input.nextCursor !== null && (typeof input.nextCursor !== "string" || input.nextCursor.length > 4096 || input.nextCursor === input.cursor)) throw new HttpError(400, "invalid_grant_pool_scan", "scan cursor did not advance");
      const issues = new Map(state.issues.map(issue => [issue.key, issue]));
      for (const issue of input.issues) {
        if (typeof issue.key !== "string" || issue.key.length > 1024 || !["owner_unavailable", "owner_missing", "identity_unresolved", "repair_failed"].includes(issue.reason)) throw new HttpError(400, "invalid_grant_pool_scan", "invalid repair outcome");
        issues.set(issue.key, issue);
      }
      return this.save({ ...state, phase: input.nextCursor !== null ? input.phase : input.phase === "kv" ? "index" : "complete", cursor: input.nextCursor, scanned: state.scanned + input.count, issues: [...issues.values()].slice(0, MAX_ISSUES), overflow: state.overflow || issues.size > MAX_ISSUES });
    });
  }

  activate(input: { revision: number }): GrantPoolReadiness {
    return this.storage.transactionSync(() => {
      const state = this.current(input.revision);
      if (state.activatedAt) return state;
      const unresolvedIndex = [...this.sql.exec("SELECT 1 FROM upstream_grant_pool_members WHERE status IN ('legacy', 'pending', 'pending_inactive') LIMIT 1")].length > 0;
      if (!state.baseline || state.phase !== "complete" || state.scanRevision !== state.revision || state.issues.length || state.overflow || unresolvedIndex) conflict("attachment activation requires a complete unchanged scan and no unresolved accounts; repair the reported keys and start a new scan");
      return this.save({ ...state, revision: state.revision + 1, activatedAt: new Date().toISOString() });
    });
  }

  keys(input: { cursor?: string | null }): { keys: string[]; cursor: string | null } {
    const cursor = input.cursor ?? "";
    if (typeof cursor !== "string" || cursor.length > 1024) throw new HttpError(400, "invalid_grant_pool_scan", "invalid indexed key cursor");
    // Include legacy rows even when their KV key is missing, and retained
    // version fences even when an owner deliberately remained unattached.
    const page = [...this.sql.exec<{ grant_key: string }>("SELECT grant_key FROM (SELECT grant_key FROM upstream_grant_pool_versions UNION SELECT CASE WHEN scope = 'tenants' THEN 'oauth/tenants/' ELSE 'oauth/' END || scope_id || '/' || token_ref AS grant_key FROM upstream_grant_pool_members) WHERE grant_key > ? ORDER BY grant_key LIMIT ?", cursor, PAGE_SIZE + 1)];
    const keys = page.slice(0, PAGE_SIZE).map(row => row.grant_key);
    return { keys, cursor: page.length > PAGE_SIZE ? keys.at(-1)! : null };
  }

  private current(revision: number): GrantPoolReadiness {
    const state = this.status();
    if (!Number.isSafeInteger(revision) || revision !== state.revision) conflict("readiness revision changed; read the current state before retrying");
    return state;
  }

  private save(state: GrantPoolReadiness): GrantPoolReadiness {
    if (!Number.isSafeInteger(state.revision)) conflict("readiness revision exhausted; operator recovery is required");
    this.sql.exec("INSERT INTO upstream_grant_pool_readiness (singleton, state_json) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET state_json = excluded.state_json", JSON.stringify(state));
    return state;
  }
}

function conflict(message: string): never { throw new HttpError(409, "grant_pool_readiness_changed", message); }
