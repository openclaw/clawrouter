import { markBudgetDispatched, reserveLedgerIntent } from "./accounting.ts";
import { collectBackground } from "./background-collection.ts";
import { BackgroundStore, liveBackground, type BackgroundAdmission, type BackgroundJob, type SettlementDisposition } from "./background-store.ts";
import { HttpContinuationStore, type ContinuationInput } from "./continuation-store.ts";
import { HttpOperation } from "./http-operation.ts";
import { BudgetSettlementError, ingestUsage, settleLedger } from "./ledgers.ts";
import type { AccountingOutcome } from "./proxy-accounting.ts";
import type { ResponsesObservation } from "./token-usage.ts";
import type { Env } from "./types.ts";
import { HttpError, json, readJson } from "./utils.ts";

type Input = { action: "get" | "list" | "admit" | "dispatch" | "identity" | "freeze" | "replay"; id: string; admission?: BackgroundAdmission; responseId?: string; contentRef?: string | null; outcome?: Omit<AccountingOutcome, "reservation">; after?: string };

// Continuation cleanup, collection and financial recovery share the object's
// only alarm and serialized mutation tail. Network waits never hold that tail.
export class ResponsesScopeStore {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly continuations: HttpContinuationStore;
  private readonly jobs: BackgroundStore;
  private tail: Promise<void> = Promise.resolve();

  constructor(storage: DurableObjectStorage, env: Env) {
    this.storage = storage; this.env = env;
    this.continuations = new HttpContinuationStore(storage);
    this.jobs = new BackgroundStore(storage.sql, id => this.continuations.closeBackground(id));
  }

  async continuation(request: Request): Promise<Response> {
    const input = await readJson<ContinuationInput>(request);
    return this.serial(() => {
      const job = input.backgroundJobId ? this.jobs.get(input.backgroundJobId) : null;
      if (input.backgroundJobId && (!job || liveBackground(job) && JSON.stringify(job.owner) !== JSON.stringify(input.owner))) {
        throw new HttpError(409, "background_owner_conflict", "response publication does not belong to this admitted job");
      }
      return this.continuations.handle(input, !!job && (!liveBackground(job) || !!job.event), !!job && !liveBackground(job));
    }, input.action !== "resolve");
  }

  async fetch(request: Request): Promise<Response> {
    const input = await readJson<Input>(request);
    if (input.action === "get") return this.serial(() => json(this.jobs.get(input.id)), false);
    if (input.action === "list") return this.serial(() => json({ records: this.jobs.list(input.after) }), false);
    if (input.action === "admit" && input.admission) return json(await this.admit(input.admission));
    if (input.action === "dispatch") { await this.dispatch(input.id, input.contentRef ?? null); return json({ dispatched: true }); }
    if (input.action === "replay") {
      const work = await this.mutate(() => this.jobs.claim(Date.now(), input.id));
      await Promise.all(work.map(job => this.process(job, false)));
      return json(await this.mutate(() => this.jobs.get(input.id)));
    }
    return this.mutate(() => {
      if (input.action === "identity" && typeof input.responseId === "string") { this.jobs.identity(input.id, input.responseId); return json({ stored: true }); }
      if (input.action === "freeze" && input.outcome) return json(this.freeze(input.id, input.outcome));
      throw new HttpError(400, "background_request_invalid", "invalid background owner action");
    });
  }

  async alarm(): Promise<void> {
    const work = await this.mutate(() => {
      const now = Date.now();
      this.continuations.expire(now);
      const jobs = this.jobs.claim(now);
      return jobs;
    }, true);
    await Promise.all(work.map(job => this.process(job)));
  }

  private async admit(input: BackgroundAdmission): Promise<{ admitted: true }> {
    const job = await this.mutate(() => this.jobs.admit(input));
    for (let index = 0; index < job.legs.length; index++) {
      const intent = await this.mutate(() => this.jobs.beginReserve(job.id, index));
      try {
        await bounded(signal => reserveLedgerIntent(this.env, intent, signal));
        await this.mutate(() => this.jobs.reserved(job.id, index, true));
      } catch (error) {
        await this.mutate(() => {
          if (error instanceof HttpError && error.status === 402) this.jobs.reserved(job.id, index, false);
          this.freeze(job.id, { occurredAtMs: Date.now(), statusCode: error instanceof HttpError ? error.status : 503, status: error instanceof HttpError && error.status === 402 ? "denied" : "provider_error", billable: false, tokens: null, contentRef: null });
        });
        throw error instanceof HttpError ? error : new HttpError(503, "accounting_unavailable", "background admission could not confirm budget ownership; recovery remains pending");
      }
    }
    return { admitted: true };
  }

  private async dispatch(id: string, contentRef: string | null): Promise<void> {
    // A duplicate loses before any RPC or rollback handler. It must not turn
    // another caller's already authorized generation into a known-unsent refund.
    const job = await this.mutate(() => this.jobs.beginDispatch(id, contentRef));
    try {
      for (let index = 0; index < job.legs.length; index++) {
        const leg = job.legs[index];
        await bounded(signal => markBudgetDispatched(this.env, { reservedMicros: job.reservedMicros, reservations: [{ objectName: leg.intent.objectName, reservationId: leg.intent.request.reservationId }] }, signal));
        await this.mutate(() => this.jobs.dispatched(id, index));
      }
      await this.mutate(() => this.jobs.beginEgress(id));
    } catch (error) {
      await this.mutate(() => this.freeze(id, { occurredAtMs: Date.now(), statusCode: 503, status: "provider_error", billable: false, tokens: null, contentRef }));
      throw error;
    }
  }

  private freeze(id: string, outcome: Omit<AccountingOutcome, "reservation">) {
    return this.jobs.freeze(id, outcome);
  }

  private async observe(job: BackgroundJob, fact: ResponsesObservation, status: number): Promise<void> {
    await this.mutate(() => {
      const current = this.jobs.get(job.id);
      if (!current || !liveBackground(current) || current.event || current.attempts !== job.attempts || Date.now() >= current.observeUntil) return;
      this.jobs.identity(job.id, fact.id);
      if (fact.terminal) this.freeze(job.id, { occurredAtMs: Date.now(), statusCode: status, status: fact.status === "completed" || fact.status === "incomplete" ? "success" : "provider_error", billable: true, tokens: fact.tokens, contentRef: current.contentRef });
    });
  }

  private async process(claimed: BackgroundJob, automatic = true): Promise<void> {
    const until = automatic ? Math.min(claimed.autoRetryUntil, claimed.replayUntil) : claimed.replayUntil;
    if (Date.now() >= until) return;
    try {
      if (!claimed.event) await collectBackground(this.env, claimed, (fact, status) => this.observe(claimed, fact, status));
      const current = await this.mutate(() => this.jobs.get(claimed.id));
      if (!current || !liveBackground(current) || current.attempts !== claimed.attempts || Date.now() >= current.replayUntil) return;
      if (!current.event) { await this.mutate(() => this.jobs.retry(current.id, null, claimed.attempts)); return; }
      const event = current.event;
      await Promise.all([
        ...current.legs.map(async (leg, index) => {
          if (leg.settlement === "settled") return;
          let disposition: SettlementDisposition = "settled";
          try { await bounded(signal => settleLedger(this.env, leg.intent.objectName, { reservationId: leg.intent.request.reservationId, actualCostMicros: event.actual_cost_micros }, signal), until); }
          catch (error) { disposition = error instanceof BudgetSettlementError ? error.disposition : "unavailable"; }
          await this.mutate(() => this.jobs.acknowledge(current.id, event.id, index, disposition));
        }),
        (async () => {
          if (["stored", "duplicate", "expired_by_retention"].includes(current.usage)) return;
          let disposition: "stored" | "duplicate" | "expired_by_retention" | "unavailable";
          try { disposition = (await bounded(signal => ingestUsage(this.env, event, signal), until)).outcome; }
          catch { disposition = "unavailable"; }
          await this.mutate(() => this.jobs.acknowledge(current.id, event.id, "usage", disposition));
        })(),
      ]);
      await this.mutate(() => this.jobs.retry(current.id, "accounting_unavailable", claimed.attempts));
    } catch {
      await this.mutate(() => this.jobs.retry(claimed.id, "observation_unavailable", claimed.attempts));
    }
  }

  private mutate<T>(operation: () => T, alarm = false): Promise<T> { return this.serial(() => this.storage.transactionSync(operation), true, alarm); }
  private serial<T>(operation: () => T | Promise<T>, schedule = true, alarm = false): Promise<T> {
    const result = this.tail.then(async () => {
      try { return await operation(); }
      finally {
        if (schedule) {
          const deadlines = [this.continuations.nextDeadline(), this.jobs.nextDeadline()].filter((value): value is number => value !== undefined);
          if (deadlines.length) {
            const next = Math.max(Date.now() + 1_000, Math.min(...deadlines)), current = alarm ? null : await this.storage.getAlarm();
            if (current === null || current > next) await this.storage.setAlarm(next);
          }
          else await this.storage.deleteAlarm();
        }
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, until = Date.now() + 10_000): Promise<T> {
  if (Date.now() >= until) throw new Error("background operation deadline passed");
  const lifetime = new HttpOperation(undefined, Math.min(10_000, until - Date.now()));
  try { return await lifetime.wait(operation(lifetime.signal)); }
  finally { lifetime.stop("complete"); }
}
