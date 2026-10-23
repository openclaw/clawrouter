/** Request, token, and spend totals overall, per provider, and per UTC day. */
export interface UsageTotals {
  summary: Record<string, number>;
  providers: Array<Record<string, number | string>>;
  daily?: Array<Record<string, number>>;
}

/** Totals for one principal, or for one credential's events without a principal. */
export interface PrincipalUsage {
  principalId: string | null;
  credentialId: string | null;
  summary: Record<string, number>;
}

/**
 * A usage ledger read. Shared totals cover every event in the authorized policies.
 * `personal` holds the caller's own totals on personal reads; `principals` holds the
 * per-principal breakdown on admin reads.
 */
export interface UsageSnapshot extends UsageTotals {
  ledger: string;
  events: Array<Record<string, unknown>>;
  personal?: UsageTotals;
  principals?: PrincipalUsage[];
}

export const usageDayMs = 86_400_000;

export function usageCutoffs(now = Date.now(), days = 30) {
  return {
    rolling: now - days * usageDayMs,
    daily: Math.floor(now / usageDayMs) * usageDayMs - (days - 1) * usageDayMs,
  };
}

export function usageShardName(tenantId: string, policyId: string): string {
  return `policy:${tenantId}:${policyId}`;
}

function emptySummary(): Record<string, number> {
  return { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 0 };
}

export function emptyUsageSnapshot(ledger = "durable_object_sharded"): UsageSnapshot {
  return { ledger, summary: emptySummary(), providers: [], daily: [], events: [] };
}

/**
 * Combines per-shard snapshots into one response. Totals are summed, recent events are
 * deduplicated and trimmed to `limit`, and the optional personal and per-principal
 * sections are kept only when every shard reported them.
 */
export function mergeUsageSnapshots(values: UsageSnapshot[], limit = 100): UsageSnapshot {
  const merged: UsageSnapshot = { ledger: "durable_object_sharded", ...mergeUsageTotals(values), events: [] };
  const events = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    for (const event of value.events) {
      const id = typeof event.id === "string" ? event.id : JSON.stringify(event);
      if (!events.has(id)) events.set(id, event);
    }
  }
  merged.events = [...events.values()].sort((left, right) => Number(right.occurred_at_ms ?? 0) - Number(left.occurred_at_ms ?? 0)).slice(0, limit);
  const personal = values.map((value) => value.personal);
  if (values.length && personal.every((value) => value !== undefined)) merged.personal = mergeUsageTotals(personal as UsageTotals[]);
  const principals = values.map((value) => value.principals);
  if (values.length && principals.every((value) => value !== undefined)) merged.principals = mergePrincipalUsage((principals as PrincipalUsage[][]).flat());
  return merged;
}

// Sums summary, provider, and daily totals. Daily rows are dropped unless every input has them,
// so a partial trend is never presented as complete.
function mergeUsageTotals(values: UsageTotals[]): UsageTotals {
  const merged: UsageTotals = { summary: emptySummary(), providers: [], daily: [] };
  const dailyComplete = values.every((value) => value.daily !== undefined);
  const providers = new Map<string, Record<string, number | string>>();
  const daily = new Map<number, Record<string, number>>();
  for (const value of values) {
    addCounts(merged.summary, value.summary);
    for (const row of value.providers) {
      const id = String(row.provider);
      const target = providers.get(id) ?? { provider: id, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 0 };
      for (const [key, amount] of Object.entries(row)) if (key !== "provider") target[key] = Number(target[key] ?? 0) + Number(amount);
      providers.set(id, target);
    }
    for (const row of value.daily ?? []) {
      const dayStartMs = Number(row.dayStartMs);
      if (!Number.isFinite(dayStartMs)) continue;
      const target = daily.get(dayStartMs) ?? { dayStartMs, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 0 };
      for (const [key, amount] of Object.entries(row)) if (key !== "dayStartMs") target[key] = Number(target[key] ?? 0) + Number(amount);
      daily.set(dayStartMs, target);
    }
  }
  merged.providers = [...providers.values()].sort((left, right) => Number(right.requestCount) - Number(left.requestCount));
  if (dailyComplete) merged.daily = [...daily.values()].sort((left, right) => left.dayStartMs - right.dayStartMs);
  else delete merged.daily;
  return merged;
}

/** Sums rows for the same principal (or unattributed credential), largest request count first. */
export function mergePrincipalUsage(rows: PrincipalUsage[]): PrincipalUsage[] {
  const merged = new Map<string, PrincipalUsage>();
  for (const row of rows) {
    const id = JSON.stringify([row.principalId, row.principalId === null ? row.credentialId : null]);
    const target = merged.get(id) ?? { principalId: row.principalId, credentialId: row.principalId === null ? row.credentialId : null, summary: emptySummary() };
    addCounts(target.summary, row.summary);
    merged.set(id, target);
  }
  return [...merged.values()].sort((left, right) => (right.summary.requestCount ?? 0) - (left.summary.requestCount ?? 0) || principalSortKey(left).localeCompare(principalSortKey(right)));
}

// Orders ties by principal, then credential, with unattributed rows last.
function principalSortKey(row: PrincipalUsage): string {
  return row.principalId ?? `\uffff${row.credentialId ?? "\uffff"}`;
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, amount] of Object.entries(source)) target[key] = (target[key] ?? 0) + amount;
}
