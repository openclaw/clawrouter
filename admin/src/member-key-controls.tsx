import { grantedServiceTiers } from "../../shared/service-tiers";
import type { SessionPolicyLimits } from "../../shared/contracts";

export { credentialExpiryLabel, keyTierChoices } from "./member-key-options";
export function KeyTierControls({ policy, fast, ultrafast, onFast, onUltrafast }: { policy?: Pick<SessionPolicyLimits, "serviceTiers" | "models">; fast: boolean; ultrafast: boolean; onFast: (value: boolean) => void; onUltrafast: (value: boolean) => void }) {
  const models = Object.entries(policy?.serviceTiers?.models ?? {}).filter(([model, tiers]) => tiers.includes("ultrafast") && (policy?.models == null || policy.models.includes(model))).map(([model]) => model);
  const grants = grantedServiceTiers(policy ?? {});
  return <>
    <label className="checkLabel keyTierControl"><input type="checkbox" checked={fast} disabled={!grants.includes("priority")} onChange={event => onFast(event.target.checked)} /><span>Fast (priority)</span></label>
    {grants.includes("ultrafast") ? <label className="checkLabel keyTierControl"><input type="checkbox" checked={ultrafast} onChange={event => onUltrafast(event.target.checked)} /><span>Ultrafast · {models.join(", ") || "all allowed models"}</span></label> : null}
  </>;
}
