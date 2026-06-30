import { accessMap, effectiveAccess, policyCoversProvider, policyUsageFallback, readinessMap, tenantSummaryFallback } from "./domain";
import { demoCatalog } from "./demo-catalog";
import { demoDisabledProviderIds, demoMissingConfigProviderIds } from "./ui-config";
import { adminOverviewFromPolicies, serviceItems } from "./ui-helpers";
import type {
  AccessPolicy, AccessRole, AccessUser, AssignmentRule, EntitlementsResponse, PolicyBinding,
  ProviderConnection, ProviderReadiness, ProviderRow, ProxyCredential, RouteCatalog, UpstreamGrant,
  UsageAuditEvent, UsageSnapshot,
} from "./ui-types";

export function demoUsageSnapshot(): UsageSnapshot {
  const now = Date.now();
  const events: UsageAuditEvent[] = [
    demoUsageEvent("usage_6", now - 26_000, "admin@example.com", "maintainer_models", "openai", "llm.responses", "gpt-5.4", 200, 842, 1000, "success", 1814, {
      agent_id: "codex/reviewer",
      parent_agent_id: "codex/orchestrator",
      project_id: "clawrouter",
      client: "codex",
      session_id: "session_7fa2",
      cost_basis: "model_pricing",
      pricing_ref: "openai-gpt-5.4-standard-2026-06-19",
    }),
    demoUsageEvent("usage_5", now - 74_000, "maintainer@example.com", "maintainer_models", "anthropic", "llm.messages", "claude-sonnet-4-5", 200, 1180, 1000, "success", 2631, {
      agent_id: "claude/refactor",
      parent_agent_id: "claude/orchestrator",
      project_id: "clawrouter",
      client: "claude-code",
      session_id: "session_293b",
      cost_basis: "model_pricing",
      pricing_ref: "anthropic-claude-sonnet-4-5-standard-2026-06-19",
    }),
    demoUsageEvent("usage_4", now - 146_000, "admin@example.com", "openclaw_tools", "tavily", "web.search", null, 200, 436, 500, "success", 0),
    demoUsageEvent("usage_3", now - 318_000, "research@example.com", "user_research", "google-gemini", "llm.generate", "gemini-default", 429, 218, 0, "provider_error", 0),
    demoUsageEvent("usage_2", now - 522_000, "admin@example.com", "maintainer_models", "openrouter", "llm.chat", "openrouter/auto", 200, 1640, 1000, "success", 3250),
    demoUsageEvent("usage_1", now - 816_000, "maintainer@example.com", "openclaw_tools", "replicate", "media.predict", null, 502, 904, 0, "provider_error", 0),
  ];
  return {
    ledger: "ready",
    summary: { requestCount: 1284, successCount: 1247, errorCount: 37, inputTokens: 1_482_402, outputTokens: 382_151, totalTokens: 1_864_553, actualCostMicros: 8_432_100 },
    providers: [
      { provider: "openai", requestCount: 604, successCount: 596, errorCount: 8, totalTokens: 904_814, actualCostMicros: 3_904_000 },
      { provider: "anthropic", requestCount: 382, successCount: 374, errorCount: 8, totalTokens: 612_201, actualCostMicros: 3_120_000 },
      { provider: "tavily", requestCount: 174, successCount: 170, errorCount: 4, totalTokens: 0, actualCostMicros: 870_000 },
      { provider: "openrouter", requestCount: 88, successCount: 82, errorCount: 6, totalTokens: 347_538, actualCostMicros: 538_100 },
      { provider: "replicate", requestCount: 36, successCount: 25, errorCount: 11, totalTokens: 0, actualCostMicros: 0 },
    ],
    daily: demoDailyUsage(now, 1284, 37, 1_864_553, 8_432_100),
    events,
  };
}

function demoDailyUsage(now: number, requests: number, errors: number, tokens: number, costMicros: number) {
  const dayMs = 86_400_000;
  const today = Math.floor(now / dayMs) * dayMs;
  const weights = [31, 34, 29, 36, 39, 33, 27, 41, 44, 38, 46, 49, 43, 35, 52, 55, 48, 58, 62, 54, 47, 64, 69, 61, 73, 67, 76, 81, 72, 88];
  const requestSeries = distributeTotal(requests, weights);
  const errorSeries = distributeTotal(errors, weights.map((weight, index) => weight * (index % 7 === 2 ? 2 : 1)));
  const tokenSeries = distributeTotal(tokens, weights.map((weight, index) => weight * (index % 5 === 0 ? 1.18 : 1)));
  const costSeries = distributeTotal(costMicros, weights.map((weight, index) => weight * (index % 6 === 4 ? 1.25 : 1)));
  return weights.map((_, index) => ({
    dayStartMs: today - (weights.length - index - 1) * dayMs,
    requestCount: requestSeries[index],
    successCount: requestSeries[index] - errorSeries[index],
    errorCount: errorSeries[index],
    totalTokens: tokenSeries[index],
    actualCostMicros: costSeries[index],
  }));
}

function distributeTotal(total: number, weights: number[]) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const values = weights.map((weight) => Math.floor((total * weight) / sum));
  let remainder = total - values.reduce((value, amount) => value + amount, 0);
  for (let index = values.length - 1; remainder > 0; index = (index - 1 + values.length) % values.length) {
    values[index] += 1;
    remainder -= 1;
  }
  return values;
}

export function demoUsageEvent(id: string, occurredAt: number, principal: string, policy: string, providerId: string, capability: string, model: string | null, statusCode: number, durationMs: number, cost: number, status: string, tokens: number, attribution: Partial<UsageAuditEvent> = {}): UsageAuditEvent {
  return {
    id,
    type: "clawrouter.usage.v1",
    occurred_at_ms: occurredAt,
    tenant_id: principal === "research@example.com" ? "research" : "openclaw",
    policy_id: policy,
    credential_id: null,
    principal_id: principal,
    auth_type: "access",
    key_id: "",
    request_id: `req_${id.slice(-1)}`,
    provider: providerId,
    capability,
    model,
    input_tokens: tokens ? Math.round(tokens * 0.7) : null,
    output_tokens: tokens ? Math.round(tokens * 0.3) : null,
    total_tokens: tokens,
    reserved_cost_micros: cost,
    actual_cost_micros: cost,
    status_code: statusCode,
    duration_ms: durationMs,
    status,
    ...attribution,
  };
}

export function demoData() {
  const { providers, routes } = demoCatalog();
  const keys: AccessPolicy[] = [
    { policyId: "maintainer_models", enabled: true, providers: ["anthropic", "aws-bedrock", "azure-openai", "cloudflare-ai-gateway", "cohere", "deepseek", "fireworks", "google-gemini", "groq", "huggingface", "minimax", "mistral", "openai", "openrouter", "perplexity", "together", "xai"], tenantId: "openclaw", tokenRole: "maintainer", monthlyBudgetMicros: 250000000, requestCostMicros: 1000, retainRequestContent: true },
    { policyId: "openclaw_tools", enabled: true, providers: ["firecrawl", "replicate", "tavily"], tenantId: "openclaw", tokenRole: "tooling", monthlyBudgetMicros: 75000000, requestCostMicros: 500, retainRequestContent: true },
    { policyId: "user_research", enabled: true, providers: ["openai", "google-gemini", "tavily"], tenantId: "research", tokenRole: "user", monthlyBudgetMicros: 50000000, requestCostMicros: 1000, retainRequestContent: true },
    { policyId: "sandbox_eval", enabled: false, providers: ["openai"], tenantId: "sandbox", tokenRole: "sandbox", monthlyBudgetMicros: 5000000, requestCostMicros: 500, retainRequestContent: true },
  ];
  const credentials: ProxyCredential[] = [
    { credentialId: "maintainer_cli", policyId: "maintainer_models", enabled: true, principalId: "maintainer@example.com" },
    { credentialId: "openclaw_tools_ci", policyId: "openclaw_tools", enabled: true },
    { credentialId: "research_notebook", policyId: "user_research", enabled: false, principalId: "research@example.com" },
  ];
  const connections: ProviderConnection[] = providers.map((item) => ({ providerId: item.id, enabled: !demoDisabledProviderIds.has(item.id) }));
  const upstreamGrants: UpstreamGrant[] = [
    { key: "oauth/maintainer_models/openai", scope: "policies", scopeId: "maintainer_models", tokenRef: "openai", version: 1, enabled: true, kind: "subscription", provider: "openai", label: "maintainer subscription", tokenType: "Bearer", scopes: ["openid", "profile"], accountId: "acct_demo", subscription: { plan: "plus" }, createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z", hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, usable: true },
    { key: "oauth/tenants/openclaw/anthropic", scope: "tenants", scopeId: "openclaw", tokenRef: "anthropic", version: 1, enabled: true, kind: "api_key", provider: "anthropic", label: "shared Anthropic key", tokenType: "Bearer", scopes: [], createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z", hasCredential: true, credentialFields: [], hasAccessToken: false, hasRefreshToken: false, refreshConfigured: false, usable: true },
  ];
  const assignmentRules: AssignmentRule[] = [
    { ruleId: "maintainers", version: 1, enabled: true, kind: "email_domain", subject: "example.com", groups: ["maintainers"], policyIds: ["maintainer_models", "openclaw_tools"], priority: 10, revokeOnLoss: true, provenance: "cloudflare_access", generatedGroup: "assignment.maintainers", createdAt: "2026-06-16T00:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z" },
  ];
  const users: AccessUser[] = [
    { email: "admin@example.com", role: "admin", tenantId: "openclaw", enabled: true, groups: ["maintainers"], contentRetentionDisabled: false },
    { email: "maintainer@example.com", role: "user", tenantId: "docs", enabled: true, groups: ["maintainers"], contentRetentionDisabled: false },
    { email: "research@example.com", role: "user", tenantId: "research", enabled: true, groups: [], contentRetentionDisabled: true },
  ];
  const bindings: PolicyBinding[] = [
    { policyId: "maintainer_models", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 },
    { policyId: "openclaw_tools", principalType: "group", principalId: "maintainers", enabled: true, priority: 20 },
    { policyId: "user_research", principalType: "user", principalId: "research@example.com", enabled: true, priority: 100 },
  ];
  const models = routes.openaiCompatible.flatMap((route) => route.models.map((model) => ({ ...model, provider: route.provider })));
  const contentRetention = { enabled: true, retentionDays: 30, policyEnabled: true, userExempt: false };
  const session = { authenticated: true, auth: "demo", role: "admin" as AccessRole, email: "admin@example.com", tenantId: "openclaw", groups: ["maintainers"], contentRetention };
  const sessionPolicies = effectiveAccess(users[0], keys, bindings, []).policies;
  const entitlements: EntitlementsResponse = {
    session,
    contentRetention,
    providers: providers.map((item) => {
      const policies = sessionPolicies.filter((key) => policyCoversProvider(key, item.id)).map((key) => key.policyId);
      return {
        provider: item.id,
        displayName: item.display_name,
        serviceKind: item.service_kind,
        allowed: policies.length > 0,
        policies,
        readiness: demoReadiness(item, routes),
      };
    }),
  };
  const accessByProvider = accessMap(entitlements);
  const readinessByProvider = readinessMap(entitlements.providers.map((item) => item.readiness));
  const usageRows = keys.map(policyUsageFallback);
  const usage = demoUsageSnapshot();
  const tenants = tenantSummaryFallback(keys, credentials);
  const overview = adminOverviewFromPolicies(keys, credentials, providers, routes);
  return { session, providers, routes, keys, credentials, connections, upstreamGrants, assignmentRules, users, bindings, overview, tenants, usageRows, usage, entitlements, services: serviceItems(providers, routes, readinessByProvider, accessByProvider), models };
}

export function demoReadiness(provider: ProviderRow, routes: RouteCatalog): ProviderReadiness {
  const openaiRoute = routes.openaiCompatible.find((route) => route.provider === provider.id);
  const manifestRoutes = routes.manifestProxy.filter((route) => route.provider === provider.id);
  const grantRequired = provider.class.includes("oauth");
  const declared = Boolean(openaiRoute || manifestRoutes.length);
  const connectionEnabled = !demoDisabledProviderIds.has(provider.id);
  const missingConfig = demoMissingConfigProviderIds.has(provider.id);
  const status = !connectionEnabled ? "disabled" : missingConfig ? "missing_config" : grantRequired ? "grant_required" : declared ? "verified" : "declared";
  return {
    id: provider.id,
    displayName: provider.display_name,
    class: provider.class,
    serviceKind: provider.service_kind,
    requiredConfig: missingConfig ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    optionalConfig: [],
    missingConfig: missingConfig ? [`${provider.id.toUpperCase().replace(/-/g, "_")}_CONFIG`] : [],
    configPresent: !missingConfig,
    connectionEnabled,
    oauthGrantRequired: grantRequired,
    oauthGrantCount: 0,
    upstreamGrantCount: 0,
    openaiCompatible: Boolean(openaiRoute),
    manifestRoutes: manifestRoutes.length,
    modelCount: openaiRoute?.models.length ?? 0,
    executable: status === "verified",
    verified: status === "verified",
    lastCheckedAt: status === "verified" ? new Date(Date.now() - 45_000).toISOString() : null,
    latencyMs: status === "verified" ? 184 : null,
    status,
    reasons: status === "verified" ? [] : status === "disabled" ? ["Provider connection is disabled by an administrator."] : status === "grant_required" ? ["OAuth grant required before service calls can run."] : status === "missing_config" ? ["Provider config is not present in the runtime environment."] : ["Provider is declared but has no executable route."],
  };
}
