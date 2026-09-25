import type { BudgetReservationIntent, BudgetReservationPlan } from "./accounting.ts";
import { accountingReceipt, type AccountingFacts, type AccountingOutcome } from "./proxy-accounting.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import type { UsageIngestReceipt } from "./ledgers.ts";
import type { UsageEvent } from "./types.ts";
import { HttpError } from "./utils.ts";

export const backgroundObservationMs = 60 * 60_000;
export const backgroundAutoRetryMs = 7 * 86_400_000;
export const backgroundReplayMs = 44 * 86_400_000;
export const backgroundRowBytes = 64 * 1024;
export const backgroundActiveLimit = 16;
export const backgroundCapacity = 64;

export type SettlementDisposition = "pending" | "settled" | "missing" | "conflict" | "unavailable";
interface BackgroundLeg {
  intent: BudgetReservationIntent;
  reserve: "never" | "sent" | "accepted" | "denied";
  uncertainReserve: boolean;
  dispatched: boolean;
  settlement: SettlementDisposition;
}
export interface BackgroundAdmission {
  id: string;
  admittedAt: number;
  owner: ContinuationOwner;
  facts: AccountingFacts;
  plan: BudgetReservationPlan;
  route: { pathParams: Record<string, string>; organization: string | null; project: string | null };
  stream: boolean;
}
interface BackgroundSummary {
  id: string;
  admittedAt: number;
  observeUntil: number;
  autoRetryUntil: number;
  replayUntil: number;
  eventId: string;
  requestId: string;
  amount: number | null;
  basis: string | null;
  usage: UsageIngestReceipt["outcome"] | "pending" | "unavailable";
  settlements: SettlementDisposition[];
  lastError: "admission_lost" | "observation_unavailable" | "observation_expired" | "accounting_unavailable" | null;
}
export interface BackgroundJob extends BackgroundSummary {
  phase: "admitting" | "observing" | "outbox";
  owner: ContinuationOwner;
  facts: AccountingFacts | null;
  legs: BackgroundLeg[];
  reservedMicros: number;
  route: BackgroundAdmission["route"] | null;
  stream: boolean;
  responseId: string | null;
  egress: boolean;
  dispatchClaimed: boolean;
  event: UsageEvent | null;
  nextAttemptAt: number;
  attempts: number;
  contentRef: string | null;
}
export interface BackgroundTombstone extends BackgroundSummary { phase: "complete" | "expired" }
export type BackgroundRecord = BackgroundJob | BackgroundTombstone;
export function liveBackground(record: BackgroundRecord): record is BackgroundJob { return record.phase !== "complete" && record.phase !== "expired"; }

// All mutations run in the scoped Responses owner's serialized tail. The same
// 64 rows contain live jobs and evictable summaries; no second recovery index.
export class BackgroundStore {
  private readonly sql: SqlStorage;
  private readonly closeBinding: (id: string) => void;
  constructor(sql: SqlStorage, closeBinding: (id: string) => void = () => undefined) {
    this.sql = sql;
    this.closeBinding = closeBinding;
    sql.exec("CREATE TABLE IF NOT EXISTS responses_background (job_id TEXT PRIMARY KEY, phase TEXT NOT NULL, admitted_at_ms INTEGER NOT NULL, next_action_ms INTEGER, job_json TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS responses_background_due ON responses_background(next_action_ms)");
  }

  admit(input: BackgroundAdmission): BackgroundJob {
    if (!/^bg_[0-9a-f]{32}$/.test(input.id) || !Number.isSafeInteger(input.admittedAt) || Math.abs(Date.now() - input.admittedAt) > 60_000) invalid();
    if (this.get(input.id)) throw new HttpError(409, "background_job_exists", "background admission already exists");
    const job: BackgroundJob = {
      id: input.id, admittedAt: input.admittedAt, observeUntil: input.admittedAt + backgroundObservationMs,
      autoRetryUntil: input.admittedAt + backgroundAutoRetryMs, replayUntil: input.admittedAt + backgroundReplayMs,
      eventId: input.facts.event.id, requestId: input.facts.event.request_id,
      amount: null, basis: null, usage: "pending", settlements: input.plan.legs.map(() => "pending"), lastError: null,
      phase: "admitting", owner: input.owner, facts: input.facts, reservedMicros: input.plan.reservedMicros,
      legs: input.plan.legs.map(intent => ({ intent, reserve: "never", uncertainReserve: false, dispatched: false, settlement: "pending" })),
      route: input.route, stream: input.stream, responseId: null, egress: false, dispatchClaimed: false, event: null,
      nextAttemptAt: input.admittedAt + 60_000, attempts: 0, contentRef: null,
    };
    encode(job);
    const active = [...this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM responses_background WHERE phase IN ('admitting', 'observing')")][0].count;
    if (active >= backgroundActiveLimit) capacity();
    const count = [...this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM responses_background")][0].count;
    if (count >= backgroundCapacity) {
      const evicted = [...this.sql.exec("DELETE FROM responses_background WHERE job_id IN (SELECT job_id FROM responses_background WHERE phase IN ('complete', 'expired') ORDER BY admitted_at_ms, job_id LIMIT 1) RETURNING job_id")];
      if (!evicted.length) capacity();
    }
    this.save(job);
    return job;
  }

  get(id: string): BackgroundRecord | null {
    const row = [...this.sql.exec<{ job_json: string }>("SELECT job_json FROM responses_background WHERE job_id = ?", id)][0];
    return row ? JSON.parse(row.job_json) : null;
  }

  list(after = ""): BackgroundRecord[] {
    return [...this.sql.exec<{ job_json: string }>("SELECT job_json FROM responses_background WHERE job_id > ? ORDER BY job_id LIMIT 16", after)].map(row => JSON.parse(row.job_json));
  }

  beginReserve(id: string, index: number): BudgetReservationIntent {
    const job = this.admitting(id), leg = job.legs[index];
    if (!leg || leg.reserve === "accepted" || leg.reserve === "denied") invalid();
    if (leg.reserve === "sent") leg.uncertainReserve = true;
    leg.reserve = "sent"; this.save(job);
    return leg.intent;
  }

  reserved(id: string, index: number, allowed: boolean): void {
    const job = this.admitting(id), leg = job.legs[index];
    if (!leg || leg.reserve !== "sent") invalid();
    leg.reserve = allowed ? "accepted" : "denied"; this.save(job);
  }

  dispatched(id: string, index: number): void {
    const job = this.admitting(id), leg = job.legs[index];
    if (!leg || leg.reserve !== "accepted") invalid();
    leg.dispatched = true; this.save(job);
  }

  beginEgress(id: string): BackgroundJob {
    const job = this.admitting(id);
    if (job.legs.some(leg => leg.reserve !== "accepted" || !leg.dispatched)) invalid();
    job.egress = true; job.phase = "observing"; job.nextAttemptAt = Date.now() + 5_000;
    this.save(job); return job;
  }

  identity(id: string, responseId: string): void {
    const job = this.job(id);
    if (job.event || Date.now() >= job.observeUntil) return;
    if (job.phase !== "observing") invalid();
    if (!responseId || new TextEncoder().encode(responseId).byteLength > 256) invalid();
    if (job.responseId && job.responseId !== responseId) throw new HttpError(502, "background_identity_conflict", "upstream changed the background response identity");
    job.responseId = responseId; job.nextAttemptAt = Math.min(job.nextAttemptAt, Date.now() + 5_000); this.save(job);
  }

  beginDispatch(id: string, contentRef: string | null): BackgroundJob {
    const job = this.admitting(id);
    if (job.dispatchClaimed) throw new HttpError(409, "background_dispatch_claimed", "background dispatch was already claimed; never repeat generation");
    job.dispatchClaimed = true; job.contentRef = contentRef; this.save(job); return job;
  }

  freeze(id: string, outcome: Omit<AccountingOutcome, "reservation">): BackgroundRecord {
    const current = this.get(id);
    if (!current) missing();
    if (!liveBackground(current) || current.event) return current;
    const job = current;
    job.event = accountingReceipt(job.facts!, { ...outcome, contentRef: outcome.contentRef ?? job.contentRef, reservation: { reservedMicros: job.reservedMicros, reservations: job.legs.map(({ intent }) => ({ objectName: intent.objectName, reservationId: intent.request.reservationId })) } });
    job.amount = job.event.actual_cost_micros; job.basis = job.event.cost_basis;
    job.phase = "outbox"; job.facts = null; job.route = null; job.responseId = null;
    for (const leg of job.legs) if (leg.reserve === "never" || leg.reserve === "denied" && !leg.uncertainReserve) leg.settlement = "settled";
    job.settlements = job.legs.map(leg => leg.settlement); job.nextAttemptAt = Date.now();
    this.save(job); this.closeBinding(id); return job;
  }

  acknowledge(id: string, eventId: string, sink: number | "usage", disposition: SettlementDisposition | BackgroundSummary["usage"]): void {
    const job = this.get(id);
    if (!job) missing();
    if (!liveBackground(job)) return;
    if (!job.event || job.event.id !== eventId || Date.now() >= job.replayUntil) return;
    if (sink === "usage") {
      if (job.usage === "stored" || job.usage === "duplicate" || job.usage === "expired_by_retention") return;
      if (!["stored", "duplicate", "expired_by_retention", "unavailable"].includes(disposition)) invalid();
      job.usage = disposition as BackgroundSummary["usage"];
    } else {
      if (!job.legs[sink] || !["settled", "missing", "conflict", "unavailable"].includes(disposition)) invalid();
      if (job.legs[sink].settlement === "settled") return;
      job.legs[sink].settlement = disposition as SettlementDisposition;
      job.settlements = job.legs.map(leg => leg.settlement);
    }
    if (job.settlements.every(value => value === "settled") && ["stored", "duplicate", "expired_by_retention"].includes(job.usage)) this.save(tombstone(job, "complete"));
    else this.save(job);
  }

  // Claim before network I/O. A crash merely delays the same immutable receipt;
  // another alarm can never replay a generation POST.
  claim(now: number, id?: string): BackgroundJob[] {
    const rows = id ? [this.get(id)].filter((job): job is BackgroundRecord => !!job)
      : [...this.sql.exec<{ job_json: string }>("SELECT job_json FROM responses_background WHERE next_action_ms <= ? ORDER BY next_action_ms LIMIT 4", now)].map(row => JSON.parse(row.job_json) as BackgroundRecord);
    const work: BackgroundJob[] = [];
    for (const record of rows) {
      if (!liveBackground(record)) continue;
      let job = record;
      if (id && !job.event) throw new HttpError(409, "background_not_final", "manual recovery can only replay a frozen financial receipt");
      if (now >= job.replayUntil) { this.save(tombstone(job, "expired")); continue; }
      if (job.phase === "admitting" || !job.event && now >= job.observeUntil) {
        job.lastError = job.phase === "admitting" ? "admission_lost" : "observation_expired";
        this.save(job);
        job = this.freeze(job.id, { occurredAtMs: now, statusCode: null, status: "provider_error", billable: job.egress, tokens: null, contentRef: null }) as BackgroundJob;
      }
      if (now >= job.autoRetryUntil && !id) { job.nextAttemptAt = job.autoRetryUntil; this.save(job); continue; }
      job.attempts++; job.nextAttemptAt = now + 30_000; this.save(job); work.push(job);
    }
    return work;
  }

  retry(id: string, error: BackgroundSummary["lastError"], attempt: number): void {
    const record = this.get(id);
    if (!record || !liveBackground(record) || record.attempts !== attempt) return;
    record.lastError = error;
    // Healthy collection must not inherit financial backoff and miss temporary
    // provider retention. Attempts remain monotonic for the late-result fence.
    const backoff = 5_000 * 2 ** Math.min(record.attempts, 10);
    const delay = record.event ? Math.min(60 * 60_000, backoff) : error ? Math.min(30_000, backoff) : 5_000;
    record.nextAttemptAt = Date.now() + delay;
    this.save(record);
  }

  nextDeadline(): number | undefined {
    return [...this.sql.exec<{ next_action_ms: number }>("SELECT next_action_ms FROM responses_background WHERE next_action_ms IS NOT NULL ORDER BY next_action_ms LIMIT 1")][0]?.next_action_ms;
  }

  private admitting(id: string): BackgroundJob {
    const job = this.job(id);
    if (job.phase !== "admitting" || Date.now() >= job.admittedAt + 60_000) throw new HttpError(409, "background_admission_expired", "background admission is no longer available");
    return job;
  }
  private job(id: string): BackgroundJob {
    const record = this.get(id);
    if (!record) missing();
    if (!liveBackground(record)) throw new HttpError(409, "background_closed", "background financial recovery is closed");
    return record;
  }
  private save(record: BackgroundRecord): void {
    const encoded = encode(record);
    const next = liveBackground(record) ? Math.min(record.replayUntil,
      ...(!record.event ? [record.observeUntil] : []),
      ...(record.nextAttemptAt < record.autoRetryUntil ? [!record.event && !record.responseId && record.phase === "observing" ? record.observeUntil : record.nextAttemptAt] : [])) : null;
    this.sql.exec("INSERT INTO responses_background (job_id, phase, admitted_at_ms, next_action_ms, job_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET phase = excluded.phase, next_action_ms = excluded.next_action_ms, job_json = excluded.job_json", record.id, record.phase, record.admittedAt, next, encoded);
  }
}

function tombstone(job: BackgroundJob, phase: BackgroundTombstone["phase"]): BackgroundTombstone {
  const { id, admittedAt, observeUntil, autoRetryUntil, replayUntil, eventId, requestId, amount, basis, usage, settlements, lastError } = job;
  return { id, admittedAt, observeUntil, autoRetryUntil, replayUntil, eventId, requestId, amount, basis, usage, settlements, lastError, phase };
}
function encode(record: BackgroundRecord): string {
  const value = JSON.stringify(record);
  if (new TextEncoder().encode(value).byteLength > backgroundRowBytes) throw new HttpError(413, "background_metadata_too_large", "background recovery metadata exceeds 64 KiB");
  return value;
}
function capacity(): never { throw new HttpError(503, "background_capacity", "background recovery scope has no admission capacity"); }
function invalid(): never { throw new HttpError(400, "background_request_invalid", "invalid background recovery transition"); }
function missing(): never { throw new HttpError(404, "background_unavailable", "background recovery record is unavailable; this does not confirm settlement"); }
