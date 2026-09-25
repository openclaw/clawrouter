import type { AccessPolicy, AuthorizedIdentity } from "./types.ts";

type BudgetIdentity = Pick<AuthorizedIdentity, "credentialId" | "principalId"> & { policy: Pick<AccessPolicy, "budgetScope"> };

export function budgetPrincipal(auth: BudgetIdentity): string | null {
  if (auth.policy.budgetScope !== "principal") return null;
  const principal = auth.principalId ?? auth.credentialId;
  if (!principal) throw new Error("principal-scoped budget requires an authenticated principal");
  return principal;
}

export function budgetLedgerAddress(policyId: string, policy: Pick<AccessPolicy, "tenantId" | "budgetScope">, principal?: string | null, at = Date.now()) {
  const tenant = policy.tenantId ?? "default";
  const scopedPrincipal = policy.budgetScope === "principal" ? principal ?? null : null;
  const suffix = scopedPrincipal ? `:${scopedPrincipal}` : "";
  const path = scopedPrincipal ? `/${scopedPrincipal}` : "";
  return {
    tenant,
    scopeKey: JSON.stringify(scopedPrincipal ? ["principal", tenant, policyId, scopedPrincipal] : ["policy", tenant, policyId]),
    // Keep the physical shard and window stable for existing balances and receipts.
    objectName: `${tenant}:${policyId}${suffix}`,
    policyId: `${tenant}/${policyId}${path}`,
    windowKey: `${tenant}/${policyId}${path}/${new Date(at).toISOString().slice(0, 7)}`,
  };
}

export function providerBudgetLedgerAddress(providerId: string, at = Date.now()) {
  const month = new Date(at).toISOString().slice(0, 7);
  return {
    tenant: "default",
    scopeKey: JSON.stringify(["provider", providerId]),
    objectName: `provider:${providerId}`,
    policyId: `provider/${providerId}`,
    windowKey: `provider/${providerId}/${month}`,
  };
}
