import { planBudgetReservation, type BudgetReservation } from "./accounting.ts";
import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, Env, ProviderConnection } from "./types";
import { HttpError } from "./utils.ts";

// Only time spent after upstream headers counts against this grace period.
export const softBudgetGraceMs = 50;

export function softBudget(env: Env, auth: AuthorizedIdentity, capability: string, connection: ProviderConnection, requestId: string, abort: (error: HttpError) => void) {
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
      if (leg.request.limitMicros !== 0 && (!status || !Number.isSafeInteger(status.spentMicros) || status.spentMicros < leg.request.limitMicros)) return;
      if (delivered || denial) return;
      const kind = leg.kind, at = Date.now();
      const monthlyReset = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1)).toISOString();
      const message = kind === "daily" ? dailyBudgetMessage(leg.request.limitMicros, at) : kind === "weekly" ? weeklyBudgetMessage(leg.request.limitMicros, at)
        : `${kind === "policy" ? "proxy key budget is exhausted" : `provider ${connection.providerId} monthly budget is exhausted`}; resets at ${monthlyReset}.`;
      denial = new HttpError(402, kind === "daily" ? "daily_budget_exhausted" : kind === "weekly" ? "weekly_budget_exhausted" : kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted", withLimitHint(message, leg));
      abort(denial);
    } catch { /* Soft budget observations fail open. */ }
  })).then(() => { complete = true; });
  return {
    reservation, check,
    get denial() { return denial; },
    async beforeDelivery(): Promise<number> {
      if (complete || denial) { delivered = true; return 0; }
      const start = performance.now();
      if (!complete && !denial) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([check, new Promise<void>(resolve => { timer = setTimeout(resolve, softBudgetGraceMs); })]);
        clearTimeout(timer);
      }
      delivered = true;
      return performance.now() - start;
    },
    close() { delivered = true; },
  };
}
