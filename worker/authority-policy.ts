import { readInputPublicationPolicy } from "../shared/input-publication.ts";
import { readUpstreamRetentionPolicy } from "../shared/upstream-retention.ts";
import { normalizeRequestCosts } from "../shared/request-pricing.ts";
import { grantRoutingPolicy, privateGrantRoutingPolicy, planPrivateGrantRouting, privateUniqueStrings } from "./grant-routing.ts";
import type { AccessPolicyEntry } from "./types";

export function normalizePolicyRecord(
  value: Record<string, unknown>,
  retainRequestContentDefault: boolean,
): AccessPolicyEntry["policy"] {
  const inputPublication = readInputPublicationPolicy(value.inputPublication);
  const upstreamRetention = readUpstreamRetentionPolicy(value.upstreamRetention);
  return {
    enabled: value.enabled !== false,
    generation: typeof value.generation === "string" ? value.generation : "legacy",
    providers: Array.isArray(value.providers) ? value.providers.filter((item): item is string => typeof item === "string") : [],
    models: Array.isArray(value.models) ? [...new Set(value.models.filter((item): item is string => typeof item === "string"))].slice(0, 1024) : value.models == null ? null : [],
    poolStatus: value.poolStatus === "visible" ? "visible" : "hidden",
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
    tokenRole: typeof value.tokenRole === "string" ? value.tokenRole : null,
    monthlyBudgetMicros: typeof value.monthlyBudgetMicros === "number" ? value.monthlyBudgetMicros : null,
    dailyBudgetMicros: typeof value.dailyBudgetMicros === "number" ? value.dailyBudgetMicros : null,
    weeklyBudgetMicros: typeof value.weeklyBudgetMicros === "number" ? value.weeklyBudgetMicros : null,
    serviceTiers: value.serviceTiers as AccessPolicyEntry["policy"]["serviceTiers"] ?? null,
    limitHint: typeof value.limitHint === "string" ? value.limitHint : null,
    requestCostMicros: typeof value.requestCostMicros === "number" ? value.requestCostMicros : null,
    requestCostsMicros: normalizeRequestCosts(value.requestCostsMicros),
    budgetScope: value.budgetScope === "principal" ? "principal" : "policy",
    ...(value.budgetMode === "soft" || value.budgetMode === "reserve" ? { budgetMode: value.budgetMode } : {}),
    ...(upstreamRetention ? { upstreamRetention } : {}),
    ...(inputPublication ? { inputPublication } : {}),
    retainRequestContent:
      typeof value.retainRequestContent === "boolean"
        ? value.retainRequestContent
        : retainRequestContentDefault,
    grantRouting: grantRoutingPolicy(value.grantRouting),
  };
}

// PRIVATE bridge normalization. These prechecks prevent the unchanged tiny
// policy readers from building a key vector for a malformed large object.
// Their successful grammars and their null/error dispositions remain unchanged.
function privateKeysAtMost(value: unknown, maximum: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let count = 0; for (const key in value) if (Object.hasOwn(value, key) && ++count > maximum) return false;
  return true;
}
function privateInputPublication(value: unknown) {
  if (value == null) return null;
  if (!privateKeysAtMost(value, 2)) return null;
  const allow = (value as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || allow.length > 2) return null;
  for (const entry of allow) if (!privateKeysAtMost(entry, 6)) return null;
  return readInputPublicationPolicy(value);
}
function privateUpstreamRetention(value: unknown) {
  if (value == null) return null;
  if (!privateKeysAtMost(value, 2)) return null;
  const allow = (value as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || allow.length > 64) return null;
  for (const entry of allow) if (!privateKeysAtMost(entry, 2)) return null;
  return readUpstreamRetentionPolicy(value);
}
function privateRequestCosts(value: unknown) {
  if (value == null) return null;
  if (!privateKeysAtMost(value, 64)) throw new Error("requestCostsMicros must be a capability-to-price object with at most 64 entries");
  return normalizeRequestCosts(value);
}

type PrivatePolicyPlan = ReturnType<typeof import("./identity-admission.ts").identityPlan>;
export function normalizePrivatePolicyRecord(value: Record<string, unknown>, retainRequestContentDefault: boolean,
  admit: (emit: (plan: PrivatePolicyPlan) => void) => void): AccessPolicyEntry["policy"] {
  // Fixed readers are bounded to 2/64 rows and 6/2 keys BEFORE invocation.
  // Their outputs are retained once as part of this prospective result graph.
  const inputPublication = privateInputPublication(value.inputPublication), upstreamRetention = privateUpstreamRetention(value.upstreamRetention);
  const requestCostsMicros = privateRequestCosts(value.requestCostsMicros);
  const scalars = {
    enabled: value.enabled !== false, generation: typeof value.generation === "string" ? value.generation : "legacy",
    poolStatus: value.poolStatus === "visible" ? "visible" as const : "hidden" as const,
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null, tokenRole: typeof value.tokenRole === "string" ? value.tokenRole : null,
    monthlyBudgetMicros: typeof value.monthlyBudgetMicros === "number" ? value.monthlyBudgetMicros : null,
    dailyBudgetMicros: typeof value.dailyBudgetMicros === "number" ? value.dailyBudgetMicros : null,
    weeklyBudgetMicros: typeof value.weeklyBudgetMicros === "number" ? value.weeklyBudgetMicros : null,
    serviceTiers: value.serviceTiers as AccessPolicyEntry["policy"]["serviceTiers"] ?? null,
    limitHint: typeof value.limitHint === "string" ? value.limitHint : null,
    requestCostMicros: typeof value.requestCostMicros === "number" ? value.requestCostMicros : null, requestCostsMicros,
    budgetScope: value.budgetScope === "principal" ? "principal" as const : "policy" as const,
    ...(value.budgetMode === "soft" || value.budgetMode === "reserve" ? { budgetMode: value.budgetMode as "soft" | "reserve" } : {}),
    ...(upstreamRetention ? { upstreamRetention } : {}), ...(inputPublication ? { inputPublication } : {}),
    retainRequestContent: typeof value.retainRequestContent === "boolean" ? value.retainRequestContent : retainRequestContentDefault,
  };
  const anyString = (_value: string) => true;
  admit(plan => plan.object(0, field => {
    field("enabled", scalars.enabled); field("generation", scalars.generation);
    field("providers", undefined, () => plan.array(1, entry => { if (Array.isArray(value.providers)) for (const item of value.providers) if (typeof item === "string") entry(item); }));
    if (value.models == null) field("models", null);
    else field("models", undefined, () => plan.array(1, entry => { if (Array.isArray(value.models)) for (const item of privateUniqueStrings(value.models, 1024, anyString)) entry(item); }));
    for (const key in scalars) if (key !== "enabled" && key !== "generation") field(key, scalars[key as keyof typeof scalars]);
    field("grantRouting", undefined, () => planPrivateGrantRouting(value.grantRouting, plan, 1));
  }));
  const providers: string[] = []; if (Array.isArray(value.providers)) for (const item of value.providers) if (typeof item === "string") providers.push(item);
  const models = Array.isArray(value.models) ? Array.from(privateUniqueStrings(value.models, 1024, anyString)) : value.models == null ? null : [];
  const grantRouting = privateGrantRoutingPolicy(value.grantRouting, emit => admit(plan => emit(plan, 0)));
  // Reproduce original own-property order; do not mutate borrowed input graphs.
  const { enabled, generation, ...rest } = scalars;
  return { enabled, generation, providers, models, ...rest, grantRouting };
}
