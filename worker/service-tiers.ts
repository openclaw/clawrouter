import { allowedServiceTiers, normalizeServiceTier, type PolicyServiceTiers } from "../shared/service-tiers.ts";
import type { AuthorizedIdentity, CompiledGrantTransport } from "./types";
import type { ProxySelection } from "./proxy-selection";
import { extractServiceTier } from "./token-usage.ts";
import { withLimitHint } from "./policy-limits.ts";
import { HttpError } from "./utils.ts";

export function normalizeTierList(value: unknown, code = "invalid_policy"): string[] {
  if (!Array.isArray(value) || value.some(tier => typeof tier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tier) || normalizeServiceTier(tier) !== tier)) throw new HttpError(400, code, "service tiers must be lowercase canonical tier ids (use priority for fast and default for auto)");
  const tiers = [...new Set(value)] as string[];
  if (tiers.length > 8) throw new HttpError(400, code, "at most 8 service tiers are allowed");
  return tiers;
}
export function normalizePolicyTiers(value: unknown, catalog: ReadonlySet<string>): PolicyServiceTiers | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_policy", "serviceTiers must be an object");
  const config = value as Record<string, unknown>, allowed = normalizeTierList(config.allowed);
  const rawModels = config.models ?? {};
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels) || Object.keys(rawModels).length > 32) throw new HttpError(400, "invalid_policy", "serviceTiers.models must contain at most 32 catalog model entries");
  const models: Record<string, string[]> = {};
  for (const [model, tiers] of Object.entries(rawModels)) {
    if (!catalog.has(model)) throw new HttpError(400, "invalid_policy", `unknown service-tier catalog model: ${model}`);
    models[model] = normalizeTierList(tiers);
  }
  return { allowed, models };
}
export function assertServiceTier(auth: Pick<AuthorizedIdentity, "policy" | "serviceTiers">, selection: Pick<ProxySelection, "provider" | "endpoint" | "model" | "body">, transport?: CompiledGrantTransport | null): void {
  if (!selection.endpoint.request_format.startsWith("openai.") || Array.isArray(selection.body)) return;
  const body = selection.body;
  const raw = body.service_tier;
  // Invalid values must not become an omitted/default tier through extraction.
  const normalized = typeof raw === "string" ? normalizeServiceTier(extractServiceTier({ service_tier: raw.toLowerCase() }) ?? raw.toLowerCase()) : raw == null ? "default" : "invalid";
  const pricing = selection.model?.pricing;
  const tier = pricing && pricing.unit !== "character" ? pricing.serviceTiers?.find(card => card.aliases.includes(normalized))?.id ?? normalized : normalized;
  const model = selection.model?.id ?? (typeof body.model === "string" ? body.model : "unknown");
  const allowed = allowedServiceTiers(auth.policy, model, auth.serviceTiers);
  if (!allowed.includes(tier)) throw new HttpError(400, "service_tier_not_allowed", withLimitHint(`Service tier ${tier} is not allowed for ${model} on this key; allowed tiers: ${allowed.join(", ") || "none"}.`, auth.policy));
  // Only a resolved API transport can pin the project default; subscription
  // transports and the preliminary allowlist check retain the caller's tier.
  const supportsTier = selection.endpoint.request_format === "openai.responses" || selection.endpoint.request_format === "openai.chat_completions";
  if (supportsTier && selection.provider.id === "openai" && transport === null && normalized === "default" && (raw == null || typeof raw === "string" && raw.toLowerCase() === "auto")) {
    selection.body = { ...body, service_tier: "default" };
  }
}
