import { admitAccountingJson, accountingObjectProjection, accountingStringCapacity, accountingNumberCapacity } from "./json-body.ts";
import { admitBudgetPlan, type BudgetReservationIntent, type BudgetReservationPlan } from "./accounting.ts";
import { admitAccountingFacts, prospectiveAccountingEvent, type AccountingFacts } from "./proxy-accounting.ts";
import type { ManagedInputAllocation, ManagedInputReceipt } from "./managed-input-receipt.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import type { UsageIngestReceipt } from "./ledgers.ts";
import type { ManagedFileDescriptor, ManagedObservationLoss, ManagedProtocol } from "./managed-lifecycle-types.ts";
import type { UsageEvent } from "./types.ts";

export const backgroundObservationMs = 60 * 60_000;
export const backgroundAutoRetryMs = 7 * 86_400_000;
export const backgroundReplayMs = 44 * 86_400_000;

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
  managed?: ManagedAdmission;
}
export interface ManagedAdmission {
  protocol: ManagedProtocol;
  providerId?: string;
  idempotencyKey: string | null;
  requestDigest: string;
  requestedVersion: string;
  // Secret-free selected API base for qualifying only this job's output descriptors.
  fileBaseUrl?: string;
}
export interface ManagedState extends ManagedAdmission {
  observationUnavailable?: ManagedObservationLoss;
  files?: ManagedFileDescriptor[];
  route?: BackgroundAdmission["route"];
  policyGeneration: string;
  submission: "pending" | "submission_unknown" | "bound";
  upstreamId: string | null;
  terminal: "succeeded" | "failed" | "canceled" | "aborted" | null;
}
export interface BackgroundSummary {
  inputReceipt?: ManagedInputReceipt;
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
  managed?: ManagedState;
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

/** Complete paired NEW admission, shared by caller and durable owner. */
export function admitInputAllocation(input: ManagedInputAllocation): void {
  admitAccountingJson(input, "capsule");
  admitBackgroundAdmission(input.admission);
  const uploadInput = { ...input.admission, managed: undefined, ...input.upload };
  admitBackgroundAdmission(uploadInput);
  const prospective = newBackgroundJob(input.admission);
  const uploadJob = newBackgroundJob(uploadInput);
  prospective.inputReceipt = { binding: input.binding, state: "pending", imageId: null, createClaimed: false, upload: uploadJob };
  admitAccountingJson(prospective, "capsule");
  for (const parent of [prospective, prospectiveBackgroundJob(prospective), prospectiveBackgroundJob(prospective, true)]) for (const upload of [uploadJob, prospectiveBackgroundJob(uploadJob), prospectiveBackgroundJob(uploadJob, true)]) {
    admitAccountingJson(accountingObjectProjection(parent, { inputReceipt: { ...prospective.inputReceipt,
      state: "dispatch_unknown", imageId: accountingStringCapacity(16), upload } }), "capsule");
  }
}

/** NEW admissions only. Receipt/outbox recovery never re-enters admission. */
export function admitBackgroundAdmission(input: BackgroundAdmission): void {
  admitAccountingJson(input, "capsule");
  admitBudgetPlan(input.plan);
  admitAccountingFacts(input.facts, input.plan);
  // Maps below have at most four already-admitted entries; the borrowed facts
  // remain references until the COMPLETE prospective row has passed.
  const job = newBackgroundJob(input);
  admitAccountingJson(job, "capsule");
  admitAccountingJson(prospectiveBackgroundJob(job), "capsule");
  admitAccountingJson(prospectiveBackgroundJob(job, true), "capsule");
}

function prospectiveBackgroundJob(job: BackgroundJob, terminal = false): Record<string, unknown> {
  const number = accountingNumberCapacity();
  const legs = job.legs.map(leg => ({ ...leg, reserve: "accepted", settlement: "unavailable", uncertainReserve: false, dispatched: false }));
  const event = prospectiveAccountingEvent(job.facts!);
  return { ...job, phase: "observing", amount: number, basis: accountingStringCapacity(Math.max(64, job.facts!.cost.basis.length)),
    usage: "expired_by_retention", settlements: job.settlements.map(() => "unavailable"), lastError: "observation_unavailable",
    legs, responseId: accountingStringCapacity(256), nextAttemptAt: number, attempts: number, contentRef: accountingStringCapacity(40),
    // These are separate complete serialized states, not GC/heap credit. The
    // existing freeze nulls facts/route before save; earlier graphs may remain.
    facts: terminal ? null : job.facts, route: terminal ? null : job.route,
    event: terminal ? event : null, managed: job.managed ? { ...job.managed, submission: "submission_unknown", upstreamId: accountingStringCapacity(128),
      terminal: "succeeded", observationUnavailable: "canceled_or_deleted" } : undefined };
}

export function newBackgroundJob(input: BackgroundAdmission): BackgroundJob {
  return {
      id: input.id, admittedAt: input.admittedAt, observeUntil: input.admittedAt + backgroundObservationMs,
      autoRetryUntil: input.admittedAt + backgroundAutoRetryMs, replayUntil: input.admittedAt + backgroundReplayMs,
      eventId: input.facts.event.id, requestId: input.facts.event.request_id,
      amount: null, basis: null, usage: "pending", settlements: input.plan.legs.map(() => "pending"), lastError: null,
      phase: "admitting", owner: input.owner, facts: input.facts, reservedMicros: input.plan.reservedMicros,
      legs: input.plan.legs.map(intent => ({ intent, reserve: "never", uncertainReserve: false, dispatched: false, settlement: "pending" })),
      route: input.route, stream: input.stream, responseId: null, egress: false, dispatchClaimed: false, event: null,
      nextAttemptAt: input.admittedAt + 60_000, attempts: 0, contentRef: null,
      ...(input.managed ? { managed: { ...input.managed, providerId: input.owner.providerId, route: input.route, policyGeneration: input.owner.policyGeneration, submission: "pending", upstreamId: null, terminal: null } as ManagedState } : {}),
  };
}
