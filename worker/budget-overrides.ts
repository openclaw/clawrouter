import type { AccessPolicy, BudgetOverride } from "./types";
import { HttpError } from "./utils.ts";

export const budgetFields = ["dailyBudgetMicros", "weeklyBudgetMicros", "monthlyBudgetMicros"] as const;
export function effectiveBudgetPolicy(policyId: string, policy: AccessPolicy, overrides?: Record<string, BudgetOverride>): AccessPolicy {
  const override = policy.budgetScope === "principal" ? overrides?.[policyId] : undefined;
  if (!override) return policy;
  const limits = Object.fromEntries(budgetFields.filter(key => Object.hasOwn(override, key)).map(key => [key, override[key]]));
  return { ...policy, ...limits, budgetOverride: override };
}

// The admin supplies values only. Audit identity/time are owned by the authority.
export function normalizeBudgetOverride(value: unknown): Partial<Pick<BudgetOverride, typeof budgetFields[number]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_budget_override", "budget override must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !budgetFields.includes(key as typeof budgetFields[number]))) throw new HttpError(400, "invalid_budget_override", "unknown budget override field");
  const result: Partial<Pick<BudgetOverride, typeof budgetFields[number]>> = {};
  for (const field of budgetFields) if (Object.hasOwn(input, field)) {
    const amount = input[field];
    if (amount !== null && (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)) throw new HttpError(400, "invalid_budget_override", "caps must be null or non-negative safe integers");
    result[field] = amount as number | null;
  }
  return result;
}
