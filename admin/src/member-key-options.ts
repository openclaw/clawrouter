import { grantedServiceTiers } from "../../shared/service-tiers";
import type { SessionPolicyLimits } from "../../shared/contracts";
export function credentialExpiryLabel(expiresAt?: string | null, at = Date.now()) {
  if (!expiresAt) return { label: "Legacy key · no expiry", warning: false };
  const days = Math.ceil((Date.parse(expiresAt) - at) / 86_400_000);
  return { label: days <= 0 ? `expired on ${expiresAt.slice(0, 10)}` : `expires in ${days} days`, warning: days < 14 };
}
export function keyTierChoices(policy: Pick<SessionPolicyLimits, "serviceTiers" | "models"> | undefined, fast: boolean, ultrafast: boolean): string[] {
  return grantedServiceTiers(policy ?? {}).filter(tier => tier !== "priority" || fast).filter(tier => tier !== "ultrafast" || ultrafast);
}
