import { normalizeBudgetOverride } from "./budget-overrides.ts";
import type { AccessControlUser, AccessPolicyEntry, Env } from "./types";
import { HttpError, json, readJson } from "./utils.ts";

interface BudgetAuthority {
  user(email: string): AccessControlUser | null;
  policy(id: string): AccessPolicyEntry | null;
  putUser(user: AccessControlUser): void;
  putPolicy(policy: AccessPolicyEntry): void;
}

export async function mutateBudgetCaps(path: string, request: Request, authority: BudgetAuthority): Promise<Response> {
  const input = await readJson<{ email: string; policyId: string; limits: unknown; updatedBy: string; expectedUpdatedAt?: string | null }>(request);
  const entry = authority.policy(input.policyId);
  if (!entry) throw new HttpError(404, "unknown_policy", "policy does not exist");
  const limits = normalizeBudgetOverride(input.limits);
  // No await between the canonical read and write: unrelated edits are preserved.
  if (path === "/policies/budget-limits") {
    const updated = { ...entry, policy: { ...entry.policy, ...limits } };
    authority.putPolicy(updated);
    return json(updated);
  }
  const user = authority.user(input.email);
  if (!user) throw new HttpError(404, "budget_override_target_missing", "user does not exist");
  const previous = user.record.budgetOverrides?.[input.policyId];
  if (input.expectedUpdatedAt != null && input.expectedUpdatedAt !== (previous?.updatedAt ?? "absent")) throw new HttpError(409, "budget_override_changed", "member caps changed; refresh before saving");
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(previous?.updatedAt ?? "") + 1 || 0)).toISOString();
  const budgetOverrides = { ...user.record.budgetOverrides, [input.policyId]: { ...limits, updatedBy: input.updatedBy, updatedAt } };
  const updated = { ...user, record: { ...user.record, budgetOverrides } };
  authority.putUser(updated);
  return json(updated);
}

export async function budgetCapsCall<T>(env: Env, path: string, body: unknown): Promise<T> {
  const response = await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings")).fetch(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json<{ error?: { code?: string; message?: string } }>().catch(() => null);
    if ([400, 404, 409].includes(response.status) && result?.error?.code && result.error.message) throw new HttpError(response.status, result.error.code, result.error.message);
    throw new HttpError(503, "budget_caps_unavailable", "budget caps are temporarily unavailable");
  }
  return response.json<T>();
}
