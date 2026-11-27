import type { AccessPolicy, ProviderConnection } from "./types";

export function realtimeCapacityMissing(
  policy: Pick<AccessPolicy, "budgetMode" | "monthlyBudgetMicros" | "dailyBudgetMicros" | "weeklyBudgetMicros">,
  connection?: Pick<ProviderConnection, "monthlyBudgetMicros"> | null,
): boolean {
  return policy.budgetMode !== "soft" && [
    policy.monthlyBudgetMicros, policy.dailyBudgetMicros, policy.weeklyBudgetMicros, connection?.monthlyBudgetMicros,
  ].every(value => value == null);
}
