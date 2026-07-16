import type { AccessPolicy, AuthorizedIdentity } from "./types.ts";

type BudgetIdentity = Pick<AuthorizedIdentity, "credentialId" | "principalId"> & { policy: Pick<AccessPolicy, "budgetScope"> };

export function budgetPrincipal(auth: BudgetIdentity): string | null {
  if (auth.policy.budgetScope !== "principal") return null;
  const principal = auth.principalId ?? auth.credentialId;
  if (!principal) throw new Error("principal-scoped budget requires an authenticated principal");
  return principal;
}

export function budgetLedgerAddress(policyId: string, policy: Pick<AccessPolicy, "tenantId" | "budgetScope">, principal?: string | null) {
  const tenant = policy.tenantId ?? "default";
  const scopedPrincipal = policy.budgetScope === "principal" ? principal ?? null : null;
  const suffix = scopedPrincipal ? `:${scopedPrincipal}` : "";
  const path = scopedPrincipal ? `/${scopedPrincipal}` : "";
  return {
    tenant,
    objectName: `${tenant}:${policyId}${suffix}`,
    policyId: `${tenant}/${policyId}${path}`,
    windowKey: `${tenant}/${policyId}${path}/${new Date().toISOString().slice(0, 7)}`,
  };
}
