import type { AccessPolicy, ProviderRow, UpstreamGrant } from "./ui-types";

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

export function modelHeadroom(grant: UpstreamGrant, family: string, policy: AccessPolicy, now = Date.now()) {
  const applicable = grant.quotaWindows.filter(window => !window.models?.length || window.models.some(token => family.includes(token)));
  const ratios = applicable.map(window => quotaFree(window, now)).filter((value): value is number => value !== null);
  const free = ratios.length ? Math.min(...ratios) : null;
  const fresh = (value: string | null | undefined) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) + policy.grantRouting.staleAfterSeconds * 1000 > now;
  const live = applicable.filter(window => !window.resetAt || Date.parse(window.resetAt) > now);
  const stale = !live.length || !fresh(grant.quotaObservedAt) || live.some(window => !fresh(window.observedAt ?? grant.quotaObservedAt));
  const reserve = grant.kind === "subscription" ? policy.grantRouting.includedQuotaReservePercent ?? 0 : 0;
  const exhausted = applicable.some(window => (!window.resetAt || Date.parse(window.resetAt) > now)
    && (window.remaining === 0 || (quotaFree(window, now) ?? Infinity) <= reserve));
  const eligible = policy.enabled !== false && grant.enabled && grant.usable && grant.credentialStatus !== "reauth_required"
    && !(grant.cooldownUntil && Date.parse(grant.cooldownUntil) > now)
    && !(stale && policy.grantRouting.staleState === "deny") && !exhausted;
  return { free, eligible, stale };
}

export function subscriptionFamilies(grants: UpstreamGrant[]): string[] {
  return [...new Set(["fable", "opus", "sonnet", ...grants.flatMap(grant => grant.quotaWindows.flatMap(window => window.models ?? []))])].sort();
}

export function resetLabel(value: string | null, now = Date.now()): string {
  if (!value) return "Reset unknown";
  const delta = Date.parse(value) - now;
  if (!Number.isFinite(delta)) return "Reset unknown";
  if (delta <= 0) return "Reset passed · awaiting observation";
  const minutes = Math.ceil(delta / 60_000);
  return minutes < 60 ? `in ${minutes}m` : minutes < 1440 ? `in ${Math.ceil(minutes / 60)}h` : `in ${Math.ceil(minutes / 1440)}d`;
}

export function canProbeGrant(grant: UpstreamGrant, provider: ProviderRow | undefined): boolean {
  return grant.enabled && grant.usable && (provider?.quota?.probes?.some(probe => probe.grantKinds?.includes(grant.kind)
    && (!probe.requiresRefreshToken || grant.hasRefreshToken)) ?? false);
}
