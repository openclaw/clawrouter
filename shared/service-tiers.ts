export interface PolicyServiceTiers { allowed: string[]; models?: Record<string, string[]> }
export const defaultServiceTiers = ["default", "flex", "priority"];
export function normalizeServiceTier(tier: string | undefined): string {
  const value = tier?.toLowerCase();
  return !value || value === "auto" ? "default" : value === "fast" ? "priority" : value;
}
export function allowedServiceTiers(policy: { serviceTiers?: PolicyServiceTiers | null }, model: string | null, credential?: string[] | null): string[] {
  const policyTiers = (model ? policy.serviceTiers?.models?.[model] : undefined) ?? policy.serviceTiers?.allowed ?? defaultServiceTiers;
  return credential == null ? [...policyTiers] : policyTiers.filter(tier => credential.includes(tier));
}
export function grantedServiceTiers(policy: { serviceTiers?: PolicyServiceTiers | null; models?: string[] | null; providers?: string[] }): string[] {
  if (policy.models != null) return [...new Set(policy.models.filter(model => !policy.providers?.length || policy.providers.includes(model.split("/")[0])).flatMap(model => allowedServiceTiers(policy, model)))];
  const config = policy.serviceTiers;
  return [...new Set([...(config?.allowed ?? defaultServiceTiers), ...Object.entries(config?.models ?? {}).filter(([model]) => !policy.providers?.length || policy.providers.includes(model.split("/")[0])).flatMap(([, tiers]) => tiers)])];
}
