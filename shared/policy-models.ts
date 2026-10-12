export function policyAllowsModel(policy: { providers: string[]; models?: string[] | null }, providerId: string, modelId: string): boolean {
  return (!policy.providers.length || policy.providers.includes(providerId)) && (policy.models == null || policy.models.includes(modelId));
}
