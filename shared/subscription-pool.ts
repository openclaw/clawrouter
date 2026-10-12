import type { AccessPolicy, UpstreamGrant } from "./contracts.ts";
import { grantCoolingDown, grantQuotaExhausted, grantRuntimeFresh, windowApplies } from "./grant-quota";
type PoolGrantInput = Pick<UpstreamGrant, "quotaObservedAt" | "cooldownUntil" | "quotaWindows" | "kind" | "enabled" | "usable" | "credentialStatus">;
type PoolPolicyInput = Pick<AccessPolicy, "enabled" | "grantRouting">;
export type PoolEligibility = "eligible" | "exhausted" | "cooldown" | "stale" | "reauth_required";

export function policyGrants(policy: AccessPolicy | undefined, grants: UpstreamGrant[]): UpstreamGrant[] {
  if (!policy) return [];
  return grants.filter(grant => !!grant.provider && (grant.scope === "policies" ? grant.scopeId === policy.policyId : grant.scopeId === (policy.tenantId ?? "default"))
    && (!policy.providers.length || policy.providers.includes(grant.provider))
    && (!Object.hasOwn(policy.grantRouting.eligibleGrants, grant.provider) || policy.grantRouting.eligibleGrants[grant.provider].includes(grant.tokenRef)));
}

export function planLabel(tier?: string): string {
  if (!tier) return "Plan unknown";
  const max = tier.match(/claude_max_(\d+)x/);
  return max ? `Max ${max[1]}x` : /claude_pro/.test(tier) ? "Pro" : tier.replace(/^default_/, "").replaceAll("_", " ");
}

export function quotaFree(window: UpstreamGrant["quotaWindows"][number], now = Date.now()): number | null {
  if (window.resetAt && Date.parse(window.resetAt) <= now) return null;
  return window.limit && window.remaining !== null ? Math.max(0, Math.min(100, window.remaining / window.limit * 100)) : null;
}

export function modelHeadroom(grant: PoolGrantInput, family: string, policy: PoolPolicyInput, now = Date.now()) {
  const state = { observedAt: grant.quotaObservedAt ?? "", cooldownUntil: grant.cooldownUntil, windows: grant.quotaWindows };
  const applicable = grant.quotaWindows.filter(window => windowApplies(window, family));
  const ratios = applicable.map(window => quotaFree(window, now)).filter((value): value is number => value !== null);
  const free = ratios.length ? Math.min(...ratios) : null;
  const stale = !grantRuntimeFresh(state, policy.grantRouting.staleAfterSeconds * 1000, now, family);
  const status = modelEligibility(grant, family, policy, now);
  return { free, eligible: status === "eligible", stale };
}

export function modelEligibility(grant: PoolGrantInput, model: string, policy: PoolPolicyInput, now = Date.now()): PoolEligibility {
  const state = { observedAt: grant.quotaObservedAt ?? "", cooldownUntil: grant.cooldownUntil, windows: grant.quotaWindows };
  if (!grant.usable || grant.credentialStatus === "reauth_required") return "reauth_required";
  if (policy.enabled === false || !grant.enabled) return "exhausted";
  if (grantCoolingDown(state, now)) return "cooldown";
  if (grantQuotaExhausted(state, model, grant.kind === "subscription" ? policy.grantRouting.includedQuotaReservePercent ?? 0 : 0, grant.kind === "subscription", now)) return "exhausted";
  if (policy.grantRouting.staleState === "deny" && !grantRuntimeFresh(state, policy.grantRouting.staleAfterSeconds * 1000, now, model)) return "stale";
  return "eligible";
}
