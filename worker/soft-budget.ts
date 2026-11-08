import { searchJsonBytes } from "./minimax-search-operation.ts";
import { musicCoverControlHeader, musicCoverControlVersion, musicCoverUnavailable, type MiniMaxMusicCoverControl } from "./minimax-music-cover-control.ts";
import type { BudgetReservationPlan } from "./accounting.ts";
import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { admitBudgetPlan, planBudgetReservation, type BudgetReservation } from "./accounting.ts";
import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache } from "./hot-cache.ts";
import { HttpError } from "./utils.ts";
import { admitSoftStatusRequest } from "./soft-budget-json.ts";
import { accountingAdmissionFailure, accountingIdentity, accountingNumberCapacity, admitAccountingJson, isAccountingAdmissionFailure } from "./json-body.ts";
import { readSoftStatus } from "./soft-budget-response.ts";

// Soft: ledger status runs concurrently with the upstream request and settlement
// is asynchronous. Stored policies without a mode keep reserve (hard caps); new
// policies are created soft by the admin API and console.
export function softBudgetPolicy(policy: { budgetMode?: "reserve" | "soft" }): boolean {
  return policy.budgetMode === "soft";
}

// Only time spent after upstream headers counts against this grace period.
export const softBudgetGraceMs = 50;

// Recently observed exhausted scopes, per isolate. A hit denies the next request
// before any upstream work; otherwise status never delays the request.
const exhausted = registerHotCache(new HotCache<true>(4096));

type SoftLeg = ReturnType<typeof planBudgetReservation>["legs"][number];
const legId = (leg: SoftLeg) => `${leg.objectName}\n${leg.request.scopeKey}\n${leg.request.windowKey}\n${leg.request.limitMicros}`;

function softDenial(leg: SoftLeg, connection: { providerId: string }, at = Date.now()): HttpError {
  const kind = leg.kind;
  const monthlyReset = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1)).toISOString();
  const message = kind === "daily" ? dailyBudgetMessage(leg.request.limitMicros, at) : kind === "weekly" ? weeklyBudgetMessage(leg.request.limitMicros, at)
    : `${kind === "policy" ? "proxy key budget is exhausted" : `provider ${connection.providerId} monthly budget is exhausted`}; resets at ${monthlyReset}.`;
  return new HttpError(402, kind === "daily" ? "daily_budget_exhausted" : kind === "weekly" ? "weekly_budget_exhausted" : kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted", withLimitHint(message, leg));
}

/** Synchronous pre-dispatch check: zero limits and recently observed exhaustion. */
export function softBudgetPreflight(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection): HttpError | undefined {
  const config = hotCacheConfig(env);
  for (const leg of planBudgetReservation(auth, capability, { reserveMicros: 0, basis: "none", inputTokens: null, outputTokens: null }, connection, Date.now(), true).legs) {
    if (leg.request.limitMicros === 0 || exhausted.peek(legId(leg), config)) return softDenial(leg, connection);
  }
  return undefined;
}

export function prepareSoftBudget(auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, search = false) {
  accountingIdentity(requestId); accountingIdentity(capability); accountingIdentity(connection.providerId);
  const plan = planBudgetReservation(auth, capability, { reserveMicros: 0, basis: "none", inputTokens: null, outputTokens: null }, connection, Date.now(), true);
  if (search) admitBudgetPlan(plan, true);
  const descriptors = plan.legs.map(leg => {
    const limit = String(leg.request.limitMicros);
    if (!search && leg.request.limitMicros !== 0) {
      try { admitSoftStatusRequest(leg.objectName, leg.request.policyId, leg.request.windowKey, leg.request.scopeKey!, limit); }
      catch { accountingAdmissionFailure(); }
    }
    const chargeLength = 7 + requestId.length + leg.request.scopeKey!.length + leg.request.windowKey.length + 2;
    if (chargeLength > 8192) accountingAdmissionFailure();
    const request = { chargeId: `charge:${requestId}:${leg.request.scopeKey}:${leg.request.windowKey}`,
      policyId: leg.request.policyId, windowKey: leg.request.windowKey, scopeKey: leg.request.scopeKey!, capability };
    admitAccountingJson({ kind: "budget_charge", ledger: { objectName: leg.objectName }, request: { ...request, amountMicros: accountingNumberCapacity() } }, "intent");
    if (search) admitAccountingJson({ kind: "budget_charge", ledger: { objectName: leg.objectName }, request: { ...request, amountMicros: accountingNumberCapacity() } }, "search");
    const url = new URL("https://clawrouter.internal/status");
    url.searchParams.set("policy_id", leg.request.policyId); url.searchParams.set("window_key", leg.request.windowKey);
    url.searchParams.set("scope_key", leg.request.scopeKey!); url.searchParams.set("limit_micros", limit);
    return { leg, url: url.href, charge: { objectName: leg.objectName, request } };
  });
  const reservation: BudgetReservation = { reservations: [], reservedMicros: 0, charges: descriptors.map(item => item.charge) };
  admitAccountingJson(reservation, "capsule");
  return { descriptors, reservation, providerId: connection.providerId };
}
export type PreparedSoftBudget = ReturnType<typeof prepareSoftBudget>;

export function softBudget(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  return startSoftBudget(env, prepareSoftBudget(auth, capability, connection, requestId, !!search), abort, search);
}
export function startSoftBudget(env: Env, prepared: PreparedSoftBudget, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  return observeSoftBudget(env.BUDGET_LEDGER, hotCacheConfig(env), prepared, abort, search);
}
function observeSoftBudget(namespace: Env["BUDGET_LEDGER"], config: ReturnType<typeof hotCacheConfig>,
  { descriptors, reservation, providerId }: PreparedSoftBudget, abort?: (error: HttpError) => void, search?: MiniMaxSearchOperation) {
  let denial: HttpError | undefined;
  let admissionFailure: HttpError | undefined;
  let delivered = false;
  let complete = false;
  const check = Promise.allSettled(descriptors.map(async ({ leg, url }) => {
    try {
      const status = leg.request.limitMicros === 0 ? null : search
        ? await search.controlJson<{ spentMicros: number }>({}, (_body, signal) => namespace.get(namespace.idFromName(leg.objectName)).fetch(url, { signal }))
        : await readSoftStatus(() => namespace.get(namespace.idFromName(leg.objectName)).fetch(url)) as { spentMicros: number } | null;
      // Zero is a configured block even when its reporting ledger is unavailable.
      if (leg.request.limitMicros !== 0 && (!status || !Number.isSafeInteger(status.spentMicros) || status.spentMicros < leg.request.limitMicros)) {
        exhausted.delete(legId(leg));
        return;
      }
      // Remember for the fresh window so later requests stop before dispatch.
      exhausted.set(legId(leg), true, config, hotCacheNow() + config.freshMs);
      // Shared WebSocket lanes cannot abort one turn; only deny later creates.
      if (!abort || delivered || denial) return;
      denial = softDenial(leg, { providerId });
      abort(denial);
    } catch (error) { if (isAccountingAdmissionFailure(error)) throw error; /* Existing observation errors fail open. */ }
  })).then(outcomes => {
    complete = true;
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) { if (isAccountingAdmissionFailure(failed.reason)) admissionFailure = failed.reason; throw failed.reason; }
  });
  return {
    reservation, check,
    get denial() { return denial; },
    // Reads start at dispatch, so this only waits when the ledger is slower than
    // the provider's own time to headers; late results inform later requests.
    async beforeDelivery(): Promise<number> {
      if (admissionFailure) throw admissionFailure;
      if (complete || denial) { delivered = true; return 0; }
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([check, new Promise<void>(resolve => { timer = setTimeout(resolve, softBudgetGraceMs); })]); }
      finally { clearTimeout(timer); }
      delivered = true;
      return performance.now() - start;
    },
    close() { delivered = true; },
  };
}

// Cover completes and physically retires every observation BEFORE its final
// authority tail. No grace-period, cache or post-dispatch background work.
export async function musicCoverSoftBudget(env: Env, plan: BudgetReservationPlan, connection: ProviderConnection, owner: MiniMaxMusicCoverControl): Promise<void> {
  if (plan.legs.length > 4) musicCoverUnavailable();
  searchJsonBytes(plan);
  for (const leg of plan.legs) {
    if (leg.request.limitMicros === 0) throw softDenial(leg, connection);
    const status = await owner.controlJson<{ spentMicros: number }>({}, (_body, signal) => {
      const url = new URL("https://clawrouter.internal/status");
      for (const [key, value] of Object.entries({ policy_id: leg.request.policyId, window_key: leg.request.windowKey,
        scope_key: leg.request.scopeKey!, limit_micros: String(leg.request.limitMicros) })) url.searchParams.set(key, value);
      if (url.href.length > 4096) musicCoverUnavailable();
      return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(leg.objectName)).fetch(url, { signal, redirect: "manual",
        headers: { [musicCoverControlHeader]: musicCoverControlVersion } });
    });
    if (!Number.isSafeInteger(status.spentMicros) || status.spentMicros < 0) musicCoverUnavailable();
    if (status.spentMicros >= leg.request.limitMicros) throw softDenial(leg, connection);
  }
}
