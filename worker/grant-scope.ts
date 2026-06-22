import type { AccessPolicyEntry, UpstreamGrant } from "./types";

export interface GrantRecord {
  key: string;
  grant: UpstreamGrant;
}

export function grantsVisibleToPolicies(grants: GrantRecord[], policies: AccessPolicyEntry[]): GrantRecord[] {
  const prefixes = new Set<string>();
  for (const entry of policies) {
    prefixes.add(`oauth/${entry.policyId}/`);
    prefixes.add(`oauth/tenants/${entry.policy.tenantId ?? "default"}/`);
  }
  return grants.filter((entry) => [...prefixes].some((prefix) => entry.key.startsWith(prefix)));
}
