import { observeGrantQuota, quotaRuntime } from "./grant-quota.ts";
import type { CompiledQuotaConfig, CompiledQuotaWindow, GrantRuntimeState } from "./types";

// Anthropic's unified rejection can describe a model/overage claim while the
// account-wide windows remain allowed. Keep that signal out of account cooldown.
// No plan-name inference or paid fallback.
export function observeProviderGrantQuota(providerId: string | undefined, response: Pick<Response, "status" | "headers">, quota: CompiledQuotaConfig, model?: string | null, nowMs = Date.now(), creditExhausted = false): GrantRuntimeState | null {
  // A rejected prepaid balance has no published reset. Recheck after five
  // minutes through normal selection; no probe or permanent credential disable.
  if (creditExhausted) return quotaRuntime([{ id: "credit-balance", kind: "credits", remaining: 0, limit: null, unit: null, window: null, resetAt: new Date(nowMs + 300_000).toISOString() }], "provider_response", nowMs);
  if (providerId !== "anthropic" || ![200, 429].includes(response.status)) return observeGrantQuota(response, quota, nowMs);
  const headers = new Headers(response.headers), prefix = "anthropic-ratelimit-unified-";
  const value = (name: string) => headers.get(prefix + name)?.trim().toLowerCase() ?? "";
  const allowed = (status: string) => ["allowed", "allowed_warning"].includes(status);
  const healthy = (name: string) => /^\d+(?:\.\d+)?$/.test(value(name)) && Number(value(name)) < 1;
  const sharedHealthy = (window: string, absentAllowed = false) => (allowed(value(window + "-status"))
    || !value(window + "-status") && (healthy(window + "-utilization") || absentAllowed && !headers.has(prefix + window + "-utilization")))
    && (!headers.has(prefix + window + "-utilization") || healthy(window + "-utilization"));
  for (const window of ["5h", "7d"]) if (value(window + "-status") === "rejected") headers.set(prefix + window + "-utilization", "1");
  const normalized = { status: response.status, headers };
  const generic = observeGrantQuota(normalized, quota, nowMs);
  const modelOnly = response.status === 429 && value("status") === "rejected"
    && value("7d_oi-status") === "rejected"
    && sharedHealthy("7d") && sharedHealthy("5h", true);
  if (!modelOnly || !model || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(model)) return generic;

  const scoped: CompiledQuotaWindow = { id: "subscription-seven-day-" + model, kind: "subscription", unit: "percent", window: "seven_day_scoped", fixedLimit: 100, metricScale: 100,
    limitHeaders: [], remainingHeaders: [], usedHeaders: [prefix + "7d_oi-utilization"], resetHeaders: [prefix + "7d_oi-reset"] };
  // The explicitly rejected model window, not an overage billing boundary, owns this reset.
  headers.set(prefix + "7d_oi-utilization", "1");
  const parsed = observeGrantQuota({ status: 200, headers }, { responseHeaders: [scoped], probes: [] }, nowMs)!.windows[0];
  const retry = headers.get("retry-after");
  const retryMs = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? nowMs + Number(retry) * 1000 : Date.parse(retry ?? "");
  const resets = [parsed.resetAt ? Date.parse(parsed.resetAt) : NaN, retryMs].filter(time => Number.isFinite(time) && time > nowMs && Number.isFinite(new Date(time).getTime()));
  if (!resets.length) return generic; // Unknown recovery: retain the bounded conservative cooldown.
  const windows = [...(generic?.windows ?? []), { ...parsed, models: [model], resetAt: new Date(Math.max(...resets)).toISOString() }];
  return quotaRuntime(windows, "provider_response", nowMs);
}

export function providerCreditExhausted(providerId: string, status: number, body: string | undefined): boolean {
  if (providerId !== "anthropic" || status !== 400 || body === undefined) return false;
  try {
    const payload = JSON.parse(body);
    return payload?.type === "error" && payload.error?.type === "invalid_request_error"
      && typeof payload.error.message === "string" && /^Your credit balance is too low to access the Anthropic API\b/i.test(payload.error.message);
  } catch { return false; }
}
