import { planBudgetReservation, type BudgetReservation } from "./accounting.ts";
import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache } from "./hot-cache.ts";
import { HttpError } from "./utils.ts";

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

function softDenial(leg: SoftLeg, connection: ProviderConnection, at = Date.now()): HttpError {
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

export function softBudget(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, abort?: (error: HttpError) => void) {
  const config = hotCacheConfig(env);
  const plan = planBudgetReservation(auth, capability, { reserveMicros: 0, basis: "none", inputTokens: null, outputTokens: null }, connection, Date.now(), true);
  const reservation: BudgetReservation = { reservations: [], reservedMicros: 0, charges: plan.legs.map(({ objectName, request }) => ({ objectName, request: {
    chargeId: `charge:${requestId}:${request.scopeKey}:${request.windowKey}`, policyId: request.policyId, windowKey: request.windowKey, scopeKey: request.scopeKey!, capability,
  } })) };
  let denial: HttpError | undefined;
  let delivered = false;
  let complete = false;
  const check = Promise.all(plan.legs.map(async leg => {
    try {
      const url = new URL("https://clawrouter.internal/status");
      url.searchParams.set("policy_id", leg.request.policyId);
      url.searchParams.set("window_key", leg.request.windowKey);
      url.searchParams.set("scope_key", leg.request.scopeKey!);
      url.searchParams.set("limit_micros", String(leg.request.limitMicros));
      const response = leg.request.limitMicros === 0 ? null : await env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(leg.objectName)).fetch(url);
      const status = response?.ok ? await response.json<{ spentMicros: number }>() : null;
      // Zero is a configured block even when its reporting ledger is unavailable.
      if (leg.request.limitMicros !== 0 && (!status || !Number.isSafeInteger(status.spentMicros) || status.spentMicros < leg.request.limitMicros)) {
        exhausted.delete(legId(leg));
        return;
      }
      // Remember for the fresh window so later requests stop before dispatch.
      exhausted.set(legId(leg), true, config, hotCacheNow() + config.freshMs);
      // Shared WebSocket lanes cannot abort one turn; only deny later creates.
      if (!abort || delivered || denial) return;
      denial = softDenial(leg, connection);
      abort(denial);
    } catch { /* Soft budget observations fail open. */ }
  })).then(() => { complete = true; });
  return {
    reservation, check,
    get denial() { return denial; },
    // Reads start at dispatch, so this only waits when the ledger is slower than
    // the provider's own time to headers; late results inform later requests.
    async beforeDelivery(): Promise<number> {
      if (complete || denial) { delivered = true; return 0; }
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([check, new Promise<void>(resolve => { timer = setTimeout(resolve, softBudgetGraceMs); })]);
      clearTimeout(timer);
      delivered = true;
      return performance.now() - start;
    },
    close() { delivered = true; },
  };
}
