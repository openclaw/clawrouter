import type { ProviderRow, UpstreamGrant } from "./ui-types";

export { policyGrants, planLabel, quotaFree, modelHeadroom } from "../../shared/subscription-pool";

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
