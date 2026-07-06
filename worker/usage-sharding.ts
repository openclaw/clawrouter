export interface UsageSnapshot {
  ledger: string;
  summary: Record<string, number>;
  providers: Array<Record<string, number | string>>;
  daily?: Array<Record<string, number>>;
  events: Array<Record<string, unknown>>;
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

export function emptyUsageSnapshot(ledger = "durable_object_sharded"): UsageSnapshot {
  return {
    ledger,
    summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
    providers: [],
    daily: [],
    events: [],
  };
}

export function mergeUsageSnapshots(values: UsageSnapshot[], limit = 100): UsageSnapshot {
  const merged = emptyUsageSnapshot();
  const dailyComplete = values.every((value) => value.daily !== undefined);
  const providers = new Map<string, Record<string, number | string>>();
  const daily = new Map<number, Record<string, number>>();
  const events = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    for (const [key, amount] of Object.entries(value.summary)) merged.summary[key] = (merged.summary[key] ?? 0) + amount;
    for (const row of value.providers) {
      const id = String(row.provider);
      const target = providers.get(id) ?? { provider: id, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0 };
      for (const [key, amount] of Object.entries(row)) if (key !== "provider") target[key] = Number(target[key] ?? 0) + Number(amount);
      providers.set(id, target);
    }
    for (const row of value.daily ?? []) {
      const dayStartMs = Number(row.dayStartMs);
      if (!Number.isFinite(dayStartMs)) continue;
      const target = daily.get(dayStartMs) ?? { dayStartMs, requestCount: 0, successCount: 0, errorCount: 0, totalTokens: 0, actualCostMicros: 0 };
      for (const [key, amount] of Object.entries(row)) if (key !== "dayStartMs") target[key] = Number(target[key] ?? 0) + Number(amount);
      daily.set(dayStartMs, target);
    }
    for (const event of value.events) {
      const id = typeof event.id === "string" ? event.id : JSON.stringify(event);
      if (!events.has(id)) events.set(id, event);
    }
  }
  merged.providers = [...providers.values()].sort((left, right) => Number(right.requestCount) - Number(left.requestCount));
  if (dailyComplete) merged.daily = [...daily.values()].sort((left, right) => left.dayStartMs - right.dayStartMs);
  else delete merged.daily;
  merged.events = [...events.values()].sort((left, right) => Number(right.occurred_at_ms ?? 0) - Number(left.occurred_at_ms ?? 0)).slice(0, limit);
  return merged;
}
