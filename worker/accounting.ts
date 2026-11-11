import { isMusicCoverControl, musicCoverUnavailable, type MiniMaxMusicCoverControl } from "./minimax-music-cover-control.ts";
import { searchJsonBytes, type MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, BudgetChargeRequest, BudgetReserveRequest, BudgetSettleRequest, Env, ProviderConnection, UsageEvent } from "./types";
import { budgetLedgerAddress, dailyBudgetLedgerAddress, weeklyBudgetLedgerAddress, budgetPrincipal, providerBudgetLedgerAddress } from "./budget-scope.ts";
import { logCorrelationError } from "./correlation.ts";
import { chargeLedgerNamespace, ingestUsageNamespace, settleLedgerNamespace, musicCoverLedgerControl } from "./ledgers.ts";
import { HttpError, randomId } from "./utils.ts";
import { accountingAdmissionFailure, accountingIdentity, admitAccountingJson, accountingNumberCapacity, copyAccountingJson } from "./json-body.ts";
import type { PricingGap } from "./pricing.ts";
import { checkOwnedHttpSinkOwner, ownedHttpReserveAcknowledgment, ownedHttpDispatchAcknowledgment,
  beginOwnedHttpBudgetReserves, claimOwnedHttpBudgetReserve, acceptOwnedHttpBudgetReservation,
  selectOwnedHttpBudgetRollback, selectOwnedHttpBudgetDispatch, finishOwnedHttpBudgetBranch,
  checkOwnedHttpBudgetDispatch, claimOwnedHttpBudgetDispatch, claimOwnedHttpBudgetRollback,
  bindOwnedHttpBudgetRollbackRequest, failedOwnedHttpBudgetRollback, claimOwnedHttpBudgetQueue,
  bindOwnedHttpBudgetRollbackSinks, ownedHttpQueueSend, recordOwnedHttpBudgetDenial, isOwnedHttpBudgetDenial, type OwnedHttpSinkOwner } from "./http-identity-owner.ts";

export interface AccountingSinks {
  readonly budget: Env["BUDGET_LEDGER"];
  readonly usage: Env["USAGE_LEDGER"];
  readonly queue: Env["USAGE_QUEUE"];
  readonly ownedHttp?: OwnedHttpSinkOwner;
}
export function accountingSinks(env: Env, ownedHttp?: OwnedHttpSinkOwner): AccountingSinks {
  if (ownedHttp !== undefined) checkOwnedHttpSinkOwner(ownedHttp);
  return { budget: env.BUDGET_LEDGER, usage: env.USAGE_LEDGER, queue: env.USAGE_QUEUE, ...(ownedHttp !== undefined ? { ownedHttp } : {}) };
}

export interface BudgetReservation {
  reservations: LedgerBudgetReservation[];
  charges?: Array<{ objectName: string; request: Omit<BudgetChargeRequest, "amountMicros"> }>;
  reservedMicros: number;
}

interface LedgerBudgetReservation {
  reservationId: string;
  objectName: string;
  dispatched?: true;
}

interface BudgetSettlementFailure {
  readonly reservationId: string;
  readonly objectName: string;
  readonly ledgerReason: unknown;
  readonly queueReason: unknown;
}
const reservationFailureDiagnostics = Symbol("budgetReservationFailure");
// Only a validated allowed:false response mints a private transport-path denial.
// A thrown HttpError-shaped value from fetch is never this provenance.

export interface BudgetReservationIntent {
  kind: "policy" | "daily" | "weekly" | "provider";
  limitHint?: string | null;
  objectName: string;
  request: BudgetReserveRequest;
}
export interface BudgetReservationPlan {
  reservedMicros: number;
  legs: BudgetReservationIntent[];
}

export interface EstimatedCost {
  reserveMicros: number;
  basis: string;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingGap?: PricingGap;
  requestTariff?: import("./request-tariff.ts").RequestTariff;
}

// Existing standalone callers pass the factory's cost into reserveBudget.
// Bind their complete private capsule without retaining caller Env/options or
// changing that public API. Unowned legacy costs keep their existing behavior.
const accountingPlanAdmissions = new WeakMap<EstimatedCost, (plan: BudgetReservationPlan) => void>();
export function bindAccountingPlan(cost: EstimatedCost, admit: (plan: BudgetReservationPlan) => void): void {
  accountingPlanAdmissions.set(cost, admit);
}

/** @internal Called only after a genuine private accounting owner clears its facts. */
export function unbindOwnedAccountingPlan(cost: EstimatedCost): void { accountingPlanAdmissions.delete(cost); }

// Shared with read-only availability. Passing this guard never replaces the
// atomic reservation; the return value only says whether a ledger is required.
export function validateBudgetReservation(capability: string, cost: EstimatedCost, policyLimit: number | null | undefined, connection?: ProviderConnection, dailyLimit?: number | null, limitHint?: string | null, weeklyLimit?: number | null): boolean {
  accountingIdentity(capability); accountingIdentity(limitHint); accountingIdentity(connection?.providerId);
  if (dailyLimit === 0) throw new HttpError(402, "daily_budget_exhausted", withLimitHint(dailyBudgetMessage(0), { limitHint }));
  if (weeklyLimit === 0) throw new HttpError(402, "weekly_budget_exhausted", withLimitHint(weeklyBudgetMessage(0), { limitHint }));
  if (capability === "llm.count_tokens") return false;
  const providerLimit = connection?.monthlyBudgetMicros;
  // Unmetered callers retain upstream tier selection; only an enforced budget
  // needs a provable reservation price before dispatch.
  if (policyLimit == null && providerLimit == null && dailyLimit == null && weeklyLimit == null) return false;
  if (policyLimit === 0) throw new HttpError(402, "budget_exhausted", withLimitHint("proxy key budget is exhausted", { limitHint }));
  if (providerLimit === 0) throw new HttpError(402, "provider_budget_exhausted", `provider ${connection?.providerId ?? "unknown"} monthly budget is exhausted`);
  if (cost.basis === "unpriced_modifier") throw new HttpError(400, "pricing_required", "Anthropic speed, inference geography or service tier is unsupported or has no published price; use supported modifiers or configure a fixed policy request price");
  if (cost.basis === "unpriced_service_tier") throw new HttpError(400, "pricing_required", "requested service tier has no versioned manifest price; select a declared tier or configure a fixed policy request price");
  if (cost.pricingGap === "audio_upload_bound") throw new HttpError(400, "pricing_required", "transcription uploads have no source-qualified whole-request token ceiling; enforced budgets require a qualified envelope or explicit fixed policy price");
  if (cost.pricingGap === "opaque_input_bound") throw new HttpError(400, "pricing_required", "request input has no qualified whole-request price bound; use a qualified manifest tariff or a fixed policy request price");
  if (cost.pricingGap === "retained_tool_unknown") throw new HttpError(400, "pricing_required", "retained response tools have no qualified bounded price; start a token-priced request without previous_response_id or configure a fixed policy request price");
  if (cost.pricingGap) throw new HttpError(400, "pricing_required", `${cost.pricingGap === "model_request_fee" ? "model request fees" : cost.pricingGap === "hosted_tool_fee" ? "hosted tool fees" : "hosted tool usage"} have no complete bounded price; choose a token-priced request or configure a fixed policy request price`);
  if (cost.basis === "flat_fallback") throw new HttpError(400, "pricing_required", "budgeted requests require versioned manifest pricing or a fixed policy request price");
  return true;
}

// Construct before I/O so a durable caller can record the exact IDs, scopes and
// month before an acknowledgment is lost. Physical shard aliases remain two legs.
export function planBudgetReservation(auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection, at = Date.now(), soft = false): BudgetReservationPlan {
  if (soft ? capability === "llm.count_tokens" : !validateBudgetReservation(capability, cost, auth.policy.monthlyBudgetMicros, connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros)) return { reservedMicros: 0, legs: [] };
  const policyLimit = auth.policy.monthlyBudgetMicros;
  const providerLimit = connection?.monthlyBudgetMicros;
  const legs: BudgetReservationIntent[] = [];
  const add = (kind: BudgetReservationIntent["kind"], address: ReturnType<typeof budgetLedgerAddress>, limitMicros: number) => legs.push({
    kind, objectName: address.objectName, limitHint: kind === "provider" ? null : auth.policy.limitHint ?? null,
    request: { policyId: address.policyId, windowKey: address.windowKey, scopeKey: address.scopeKey, limitMicros,
      costMicros: cost.reserveMicros, reservationId: randomId("budget"), capability },
  });
  if (policyLimit != null) {
    add("policy", budgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), policyLimit);
  }
  if (auth.policy.dailyBudgetMicros != null) add("daily", dailyBudgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), auth.policy.dailyBudgetMicros);
  if (auth.policy.weeklyBudgetMicros != null) add("weekly", weeklyBudgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), auth.policy.weeklyBudgetMicros);
  if (providerLimit != null && connection) add("provider", providerBudgetLedgerAddress(connection.providerId, at), providerLimit);
  const plan = { reservedMicros: cost.reserveMicros, legs };
  admitBudgetPlan(plan);
  accountingPlanAdmissions.get(cost)?.(plan);
  return plan;
}

/** All four plans and every terminal message variant precede the first reserve. */
export function admitBudgetPlan(plan: BudgetReservationPlan, control = false): void {
  if (plan.legs.length > 4) accountingAdmissionFailure();
  const amount = accountingNumberCapacity();
  for (const leg of plan.legs) {
    accountingIdentity(leg.objectName, 8192); accountingIdentity(leg.limitHint);
    admitAccountingJson(leg, "intent");
    if (control) {
      admitAccountingJson({ ...leg.request, dispatched: true }, "search");
      admitAccountingJson({ reservationId: leg.request.reservationId }, "search");
      admitAccountingJson({ kind: "budget_settlement", ledger: { objectName: leg.objectName },
        request: { reservationId: leg.request.reservationId, actualCostMicros: amount } }, "search");
    }
    admitAccountingJson({ ...leg.request, dispatched: true }, "intent");
    admitAccountingJson({ kind: "budget_settlement", ledger: { objectName: leg.objectName },
      request: { reservationId: leg.request.reservationId, actualCostMicros: amount } }, "intent");
    admitAccountingJson({ reservationId: leg.request.reservationId }, "intent");
  }
  admitAccountingJson(plan, "capsule");
  if (control) admitAccountingJson(plan, "search");
}

export async function reserveBudget(env: Env, auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection, observe?: (intent: BudgetReservationIntent, state: "attempted" | "denied") => void, options: { dispatched?: boolean; search?: MiniMaxSearchOperation; preparedPlan?: BudgetReservationPlan; ownedHttp?: OwnedHttpSinkOwner } = {}): Promise<BudgetReservation> {
  if (options.ownedHttp !== undefined) checkOwnedHttpSinkOwner(options.ownedHttp);
  const plan = options.preparedPlan ?? planBudgetReservation(auth, capability, cost, connection);
  if (options.search) admitBudgetPlan(plan, true);
  if (options.ownedHttp !== undefined) beginOwnedHttpBudgetReserves(options.ownedHttp, env, plan);
  const reservation: BudgetReservation = { reservations: [], reservedMicros: plan.reservedMicros };
  const results = await Promise.allSettled(plan.legs.map(async (leg, ordinal) => {
    if (options.dispatched) leg.request.dispatched = true;
    // A caller owning cancellation can retain the exact attempted ID before
    // I/O; a committed reservation can lose its acknowledgement.
    observe?.(leg, "attempted");
    try {
      return await reserveLedgerIntent(env, leg, options.search?.operation.signal, options.search, options.ownedHttp, ordinal);
    } catch (error) {
      if (options.ownedHttp !== undefined ? isOwnedHttpBudgetDenial(options.ownedHttp, error) : error instanceof HttpError && error.status === 402) observe?.(leg, "denied");
      throw error;
    }
  }));
  for (const result of results) if (result.status === "fulfilled") reservation.reservations.push(result.value);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    if (options.ownedHttp !== undefined) selectOwnedHttpBudgetRollback(options.ownedHttp, plan, reservation);
    try {
    if (reservation.reservations.length) {
      const cleanupFailures: BudgetSettlementFailure[] = [];
      try { await settleBudgetInternal(options.ownedHttp !== undefined ? ownedBudgetRollbackSinks(env, options.ownedHttp)
        : accountingSinks(env, options.ownedHttp), reservation, 0, options.search, cleanupFailures); }
      catch {
        const error = new HttpError(503, "accounting_unavailable", "Budget reservation rollback could not finish; retry after accounting recovers.");
        Object.defineProperty(error, reservationFailureDiagnostics, { value: Object.freeze({
          reservationReason: failed.reason,
          cleanupFailures: Object.freeze(cleanupFailures.filter(item => item !== undefined)),
        }) });
        throw error;
      }
    }
    throw failed.reason;
    } finally { if (options.ownedHttp !== undefined) finishOwnedHttpBudgetBranch(options.ownedHttp, reservation); }
  }
  if (options.ownedHttp !== undefined) selectOwnedHttpBudgetDispatch(options.ownedHttp, plan, reservation);
  return reservation;
}
function ownedBudgetRollbackSinks(env: Env, sink: OwnedHttpSinkOwner): AccountingSinks {
  const sinks = accountingSinks(env, sink);
  bindOwnedHttpBudgetRollbackSinks(sink, env, sinks); return sinks;
}

export async function reserveLedgerIntent(env: Env, intent: BudgetReservationIntent, signal?: AbortSignal, search?: MiniMaxSearchOperation, ownedHttp?: OwnedHttpSinkOwner, ordinal?: number): Promise<LedgerBudgetReservation> {
  if (ownedHttp !== undefined) {
    checkOwnedHttpSinkOwner(ownedHttp);
    const right = claimOwnedHttpBudgetReserve(ownedHttp, intent, ordinal!);
    const result = await ownedHttpReserveAcknowledgment(ownedHttp, env.BUDGET_LEDGER, intent.objectName, intent.request, signal, right);
    if (!result.ok) throw new Error(`budget reserve returned ${result.status}`);
    if (typeof result.allowed !== "boolean") throw new Error("budget reserve was not acknowledged");
    if (!result.allowed) {
      const denial = new HttpError(402, intent.kind === "weekly" ? "weekly_budget_exhausted" : intent.kind === "daily" ? "daily_budget_exhausted" : intent.kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted",
        withLimitHint(intent.kind === "weekly" ? weeklyBudgetMessage(intent.request.limitMicros) : intent.kind === "daily" ? dailyBudgetMessage(intent.request.limitMicros) : intent.kind === "policy" ? "proxy key budget is exhausted" : `provider ${intent.request.policyId.slice("provider/".length)} monthly budget is exhausted`, intent));
      recordOwnedHttpBudgetDenial(ownedHttp, denial); throw denial;
    }
    const reservation: LedgerBudgetReservation = { reservationId: intent.request.reservationId, objectName: intent.objectName, ...(result.dispatched === true ? { dispatched: true } : {}) };
    acceptOwnedHttpBudgetReservation(ownedHttp, right, reservation); return reservation;
  }
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(intent.objectName));
  const result = search
    ? await search.controlJson<{ allowed: boolean; chargedMicros: number; dispatched?: boolean }>(intent.request, (body, active) => stub.fetch("https://clawrouter.internal/reserve", { method: "POST", body, signal: active }), false, signal)
    : await (async () => {
      const response = await stub.fetch("https://clawrouter.internal/reserve", { method: "POST", body: JSON.stringify(intent.request), signal });
      if (!response.ok) throw new Error(`budget reserve returned ${response.status}`);
      return response.json<{ allowed: boolean; chargedMicros: number; dispatched?: boolean }>();
    })();
  if (typeof result?.allowed !== "boolean") throw new Error("budget reserve was not acknowledged");
  if (!result.allowed) throw new HttpError(402, intent.kind === "weekly" ? "weekly_budget_exhausted" : intent.kind === "daily" ? "daily_budget_exhausted" : intent.kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted",
    withLimitHint(intent.kind === "weekly" ? weeklyBudgetMessage(intent.request.limitMicros) : intent.kind === "daily" ? dailyBudgetMessage(intent.request.limitMicros) : intent.kind === "policy" ? "proxy key budget is exhausted" : `provider ${intent.request.policyId.slice("provider/".length)} monthly budget is exhausted`, intent));
  return { reservationId: intent.request.reservationId, objectName: intent.objectName, ...(result.dispatched === true ? { dispatched: true } : {}) };
}

export function finalizeAccounting(env: Env, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent, search?: MiniMaxSearchOperation): Promise<boolean> {
  return finalizeOwnedAccounting(accountingSinks(env), reservation, actualCostMicros, event, search);
}

export async function finalizeOwnedAccounting(sinks: AccountingSinks, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent, search?: MiniMaxSearchOperation): Promise<boolean> {
  if (search) {
    searchJsonBytes(event);
    let success = true;
    for (const run of [() => reservation.charges ? chargeBudget(sinks, reservation, actualCostMicros, search) : settleOwnedBudget(sinks, reservation, actualCostMicros, search),
      () => publishUsage(sinks, event, search)]) {
      try { await run(); } catch { success = false; logCorrelationError("accounting finalization failed", event.request_id); }
    }
    return success;
  }
  const results = await Promise.allSettled([
    reservation.charges ? chargeBudget(sinks, reservation, actualCostMicros) : settleOwnedBudget(sinks, reservation, actualCostMicros),
    publishUsage(sinks, event),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logCorrelationError("accounting finalization failed", event.request_id);
  }
  // HTTP has already delivered its response; persistent sessions must stop
  // accepting work if either durable settlement recovery or usage delivery fails.
  return results.every((result) => result.status === "fulfilled");
}

export async function markBudgetDispatched(env: Env, reservation: BudgetReservation, signal?: AbortSignal, search?: MiniMaxSearchOperation, ownedHttp?: OwnedHttpSinkOwner): Promise<void> {
  if (ownedHttp !== undefined) { checkOwnedHttpSinkOwner(ownedHttp); checkOwnedHttpBudgetDispatch(ownedHttp, reservation); }
  const results = await Promise.allSettled(reservation.reservations.filter(item => !item.dispatched).map(async (item) => {
    if (ownedHttp !== undefined) {
      const right = claimOwnedHttpBudgetDispatch(ownedHttp, item);
      const response = await ownedHttpDispatchAcknowledgment(ownedHttp, env.BUDGET_LEDGER, item.objectName, item.reservationId, signal, right);
      if (!response.ok || response.dispatched !== true) throw new Error("budget dispatch was not acknowledged");
      return;
    }
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(item.objectName));
    if (search) {
      const result = await search.controlJson<{ dispatched: boolean }>({ reservationId: item.reservationId }, (body, active) => stub.fetch("https://clawrouter.internal/dispatch", { method: "POST", body, signal: active }), false, signal);
      if (result.dispatched !== true) throw new Error("budget dispatch was not acknowledged");
    } else {
    const response = await stub.fetch("https://clawrouter.internal/dispatch", { method: "POST", body: JSON.stringify({ reservationId: item.reservationId }), signal });
    if (!response.ok || (await response.json<{ dispatched: boolean }>()).dispatched !== true) throw new Error("budget dispatch was not acknowledged");
    }
  }));
  if (ownedHttp !== undefined) finishOwnedHttpBudgetBranch(ownedHttp, reservation);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw new HttpError(503, "accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.");
}

async function publishUsage(sinks: AccountingSinks, event: UsageEvent, search?: MiniMaxSearchOperation): Promise<void> {
  try { if (sinks.ownedHttp !== undefined) await ownedHttpQueueSend(sinks.ownedHttp, sinks.queue, event); else if (search) await search.task(() => sinks.queue.send(event), true); else await sinks.queue.send(event); }
  catch {
    // A rejected send can still have been accepted. Reuse the event ID so
    // direct recovery and later queue delivery converge on one stored row.
    await ingestUsageNamespace(sinks.usage, event, undefined, search, undefined, sinks.ownedHttp);
  }
}

export function settleBudget(env: Env, reservation: BudgetReservation, actualCostMicros: number, search?: MiniMaxSearchOperation): Promise<void> {
  return settleOwnedBudget(accountingSinks(env), reservation, actualCostMicros, search);
}

export async function settleOwnedBudget(sinks: AccountingSinks, reservation: BudgetReservation, actualCostMicros: number, search?: MiniMaxSearchOperation): Promise<void> {
  return settleBudgetInternal(sinks, reservation, actualCostMicros, search);
}

async function settleBudgetInternal(sinks: AccountingSinks, reservation: BudgetReservation, actualCostMicros: number, search?: MiniMaxSearchOperation, cleanupFailures?: BudgetSettlementFailure[]): Promise<void> {
  const settle = (item: LedgerBudgetReservation, index: number) => settleReservation(sinks, item, actualCostMicros, search,
    cleanupFailures ? failure => { cleanupFailures[index] = failure; } : undefined);
  if (search) {
    let failure: unknown, failed = false;
    for (let index = 0; index < reservation.reservations.length; index++) {
      try { await settle(reservation.reservations[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
    if (failed) throw failure;
    return;
  }
  const results = await Promise.allSettled(reservation.reservations.map(settle));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function settleReservation(sinks: AccountingSinks, reservation: LedgerBudgetReservation, actualCostMicros: number, search?: MiniMaxSearchOperation, failed?: (failure: BudgetSettlementFailure) => void): Promise<void> {
  const recovery = sinks.ownedHttp !== undefined ? claimOwnedHttpBudgetRollback(sinks.ownedHttp, reservation, actualCostMicros) : undefined;
  const reservationId = reservation.reservationId;
  const body: BudgetSettleRequest = { reservationId, actualCostMicros };
  if (recovery) bindOwnedHttpBudgetRollbackRequest(sinks.ownedHttp!, recovery, body);
  const objectName = reservation.objectName;
  let ledgerReason: unknown;
  try {
    await settleLedgerNamespace(sinks.budget, objectName, body, undefined, search, undefined, sinks.ownedHttp, recovery);
    return;
  } catch (error) {
    ledgerReason = error;
    if (recovery) failedOwnedHttpBudgetRollback(sinks.ownedHttp!, recovery);
    // The durable queue is the recovery boundary for thrown and non-2xx ledger failures.
  }
  if (recovery) claimOwnedHttpBudgetQueue(sinks.ownedHttp!, recovery);
  const message = { kind: "budget_settlement" as const, ledger: { objectName }, request: body };
  try {
    if (sinks.ownedHttp !== undefined) await ownedHttpQueueSend(sinks.ownedHttp, sinks.queue, message, recovery); else if (search) await search.task(() => sinks.queue.send(message), true); else await sinks.queue.send(message);
  } catch (queueReason) {
    failed?.(Object.freeze({ reservationId, objectName, ledgerReason, queueReason }));
    throw queueReason;
  }
}

export function emptyReservation(): BudgetReservation { return { reservations: [], reservedMicros: 0 }; }

async function chargeBudget(sinks: AccountingSinks, reservation: BudgetReservation, amountMicros: number, search?: MiniMaxSearchOperation): Promise<void> {
  if (search) {
    let failure: unknown, failed = false;
    for (const item of reservation.charges ?? []) {
      const request = { ...item.request, amountMicros };
      try {
        try { await chargeLedgerNamespace(sinks.budget, item.objectName, request, search); }
        catch { await search.task(() => sinks.queue.send({ kind: "budget_charge", ledger: { objectName: item.objectName }, request }), true); }
      } catch (error) { if (!failed) failure = error; failed = true; }
    }
    if (failed) throw failure;
    return;
  }
  const results = await Promise.allSettled((reservation.charges ?? []).map(async item => {
    const request = { ...item.request, amountMicros };
    try { await chargeLedgerNamespace(sinks.budget, item.objectName, request, undefined, undefined, sinks.ownedHttp); }
    catch {
      const message = { kind: "budget_charge" as const, ledger: { objectName: item.objectName }, request };
      if (sinks.ownedHttp !== undefined) await ownedHttpQueueSend(sinks.ownedHttp, sinks.queue, message); else await sinks.queue.send(message);
    }
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

// Sole inactive-cover finalizer. IDs and all four possible attempts exist before
// I/O. Unlike reserveBudget, this branch NEVER starts an internal rollback.
export function musicCoverAccounting(env: Env, owner: MiniMaxMusicCoverControl, plan: BudgetReservationPlan, event: UsageEvent, soft = false) {
  return ownedMusicCoverAccounting(accountingSinks(env), owner, plan, event, undefined, soft);
}
interface CoverDispatchFacts { invoked: boolean; success: boolean; soft: boolean; fixed: number | null }
export function musicCoverCompositionAccounting(env: Env, owner: MiniMaxMusicCoverControl, plan: BudgetReservationPlan,
  event: UsageEvent, soft: boolean, fixed: number | null) {
  if (fixed !== null && (!Number.isSafeInteger(fixed) || fixed < 0)) musicCoverUnavailable();
  const dispatch: CoverDispatchFacts = { invoked: false, success: false, soft, fixed };
  const accounting = ownedMusicCoverAccounting(accountingSinks(env), owner, plan, event, dispatch, soft);
  return Object.freeze({ ...accounting,
    invoked() { dispatch.invoked = true; },
    succeeded() { if (!dispatch.invoked) musicCoverUnavailable(); dispatch.success = true; },
  });
}
function ownedMusicCoverAccounting(sinks: AccountingSinks, owner: MiniMaxMusicCoverControl, plan: BudgetReservationPlan, event: UsageEvent,
  dispatch?: CoverDispatchFacts, soft = false) {
  if (!isMusicCoverControl(owner) || plan.legs.length > 4) musicCoverUnavailable();
  admitBudgetPlan(plan, true);
  if (soft) for (const leg of plan.legs) {
    const fields = { policy_id: leg.request.policyId, window_key: leg.request.windowKey, scope_key: leg.request.scopeKey ?? "", limit_micros: String(leg.request.limitMicros) };
    admitAccountingJson(fields, "search");
    let encoded = "https://clawrouter.internal/status?policy_id=&window_key=&scope_key=&limit_micros=".length;
    for (const key in fields) for (let i = 0, value = fields[key as keyof typeof fields]; i < value.length; i++) {
      const code = value.charCodeAt(i), next = value.charCodeAt(i + 1);
      if (code === 32 || code === 42 || code === 45 || code === 46 || code === 95 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122) encoded++;
      else if (code < 128) encoded += 3;
      else if (code < 2048) encoded += 6;
      else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { encoded += 12; i++; }
      else encoded += 9;
      if (encoded > 4096) accountingAdmissionFailure();
    }
  }
  const amount = accountingNumberCapacity();
  admitAccountingJson({ plan, event: { ...event, actual_cost_micros: amount, status_code: amount, duration_ms: amount, cost_basis: "unpriced_request", status: "provider_error" } }, "capsule");
  admitAccountingJson({ ...event, actual_cost_micros: amount, status_code: amount, duration_ms: amount, cost_basis: "unpriced_request", status: "provider_error" }, "search");
  for (const leg of plan.legs) {
    const message = { kind: "budget_charge", ledger: { objectName: leg.objectName }, request: {
      chargeId: leg.request.reservationId, policyId: leg.request.policyId, windowKey: leg.request.windowKey,
      scopeKey: leg.request.scopeKey ?? "", amountMicros: amount, capability: leg.request.capability,
    } };
    admitAccountingJson(message, "intent"); admitAccountingJson(message, "search");
  }
  plan = copyAccountingJson(plan, "capsule"); event = copyAccountingJson(event, "capsule");
  searchJsonBytes(plan); searchJsonBytes(event);
  const attempts = plan.legs.map(leg => ({ leg, attempted: false, denied: false, acknowledged: false, dispatched: false }));
  let finalization: Promise<void> | undefined;
  return Object.freeze({
    async reserve(): Promise<void> {
      for (const attempt of attempts) {
        attempt.attempted = true;
        const result = await musicCoverLedgerControl<{ allowed: boolean; chargedMicros: number }>(sinks.budget, attempt.leg.objectName, "/reserve", attempt.leg.request, owner);
        if (result.allowed === false && result.chargedMicros === 0) { attempt.denied = true; throw new HttpError(402, "budget_exhausted", "Cover budget is exhausted"); }
        if (result.allowed !== true || result.chargedMicros !== attempt.leg.request.costMicros) musicCoverUnavailable();
        attempt.acknowledged = true;
      }
    },
    async dispatchAdmission(): Promise<void> {
      for (const attempt of attempts) {
        if (!attempt.acknowledged) musicCoverUnavailable();
        const reply = await musicCoverLedgerControl<{ dispatched: boolean }>(sinks.budget, attempt.leg.objectName, "/dispatch", { reservationId: attempt.leg.request.reservationId }, owner);
        if (reply.dispatched !== true) musicCoverUnavailable();
        attempt.dispatched = true;
      }
    },
    finish(): Promise<void> {
      if (finalization) return finalization;
      finalization = (async () => {
        // This joins actual original ordinary responses, not public timeout.
        // It cannot join this finalizer: mandatory tickets have a separate lane.
        await owner.retireOrdinary();
        let failed = false;
        const amount = dispatch?.invoked ? dispatch.fixed ?? 0 : 0;
        if (dispatch?.invoked) {
          // The numeric accumulator cannot represent unknown USD. The basis
          // and nullable reporting value preserve unknown; zero is not a quote.
          event.actual_cost_micros = amount; event.reporting_known_cost_micros = null;
          event.cost_basis = dispatch.fixed === null ? "unpriced_request" : "policy_fixed";
          event.status = dispatch.success ? "success" : "provider_error";
          event.status_code = dispatch.success ? 200 : null;
          event.duration_ms = Math.max(0, Date.now() - event.occurred_at_ms);
        }
        searchJsonBytes(event);
        for (const attempt of attempts) {
          if (dispatch?.soft) {
            if (!dispatch.invoked) continue;
            const original = attempt.leg.request;
            const request: BudgetChargeRequest = { chargeId: original.reservationId, policyId: original.policyId,
              windowKey: original.windowKey, scopeKey: original.scopeKey ?? "", amountMicros: amount, capability: original.capability };
            try {
              try { await chargeLedgerNamespace(sinks.budget, attempt.leg.objectName, request, undefined, owner); }
              catch {
                const message = { kind: "budget_charge" as const, ledger: { objectName: attempt.leg.objectName }, request };
                await owner.task(message, () => sinks.queue.send(message), true);
              }
            } catch { failed = true; }
            continue;
          }
          if (!attempt.attempted || attempt.denied) continue;
          const request: BudgetSettleRequest = { reservationId: attempt.leg.request.reservationId, actualCostMicros: amount };
          try {
            try { await settleLedgerNamespace(sinks.budget, attempt.leg.objectName, request, undefined, undefined, owner); }
            catch {
              const message = { kind: "budget_settlement" as const, ledger: { objectName: attempt.leg.objectName }, request };
              await owner.task(message, () => sinks.queue.send(message), true);
            }
          } catch { failed = true; }
        }
        // The legacy preparation remains known-unsent. Composition changes
        // this event only from its original, synchronous invocation record.
        try {
          try { await owner.task(event, () => sinks.queue.send(event), true); }
          catch { await ingestUsageNamespace(sinks.usage, event, undefined, undefined, owner); }
        } catch { failed = true; }
        if (failed) throw new HttpError(503, "accounting_unavailable", "Cover preparation finalization is unavailable");
      })();
      return finalization;
    },
    snapshot: () => attempts.map(attempt => Object.freeze({ id: attempt.leg.request.reservationId, attempted: attempt.attempted,
      denied: attempt.denied, acknowledged: attempt.acknowledged, dispatched: attempt.dispatched })),
  });
}
