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
    events,
  };
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
  const providers = [
    provider("anthropic", "Anthropic", "anthropic_compatible", "model_provider", ["llm.messages"]),
    provider("aws-bedrock", "AWS Bedrock", "custom_adapter", "model_provider", ["llm.invoke", "llm.stream"]),
    provider("azure-openai", "Azure OpenAI", "openai_compatible", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("cloudflare-ai-gateway", "Cloudflare AI Gateway", "cloudflare_ai_gateway", "gateway_platform", ["llm.chat", "llm.responses"]),
    provider("cohere", "Cohere", "rest_json", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("deepseek", "DeepSeek", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("fireworks", "Fireworks AI", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("google-gemini", "Google Gemini", "rest_json", "model_provider", ["llm.generate", "llm.stream"]),
    provider("groq", "Groq", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("huggingface", "Hugging Face", "rest_json", "model_provider", ["llm.invoke"]),
    provider("minimax", "MiniMax", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("mistral", "Mistral AI", "openai_compatible", "model_provider", ["llm.chat", "llm.embeddings"]),
    provider("openai", "OpenAI", "openai_compatible", "model_provider", ["llm.responses", "llm.chat", "llm.embeddings"], "subscription"),
    provider("openrouter", "OpenRouter", "openai_compatible", "gateway_platform", ["llm.chat"]),
    provider("perplexity", "Perplexity", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("replicate", "Replicate", "rest_json", "tool_provider", ["media.predict", "media.prediction.read"]),
    provider("tavily", "Tavily", "rest_json", "tool_provider", ["web.search", "web.extract", "web.crawl"]),
    provider("together", "Together AI", "openai_compatible", "model_provider", ["llm.chat"]),
    provider("xai", "xAI", "openai_compatible", "model_provider", ["llm.chat"]),
  ];
  const routes: RouteCatalog = {
    openaiCompatible: [
      modelRoute("anthropic", ["/v1/messages"], [modelEntry("anthropic/default", ["llm.messages"], ["/v1/messages"])]),
      modelRoute("aws-bedrock", ["/model/{model}/invoke", "/model/{model}/invoke-with-response-stream"], [modelEntry("bedrock/model", ["llm.invoke", "llm.stream"], ["/model/{model}/invoke", "/model/{model}/invoke-with-response-stream"])]),
      modelRoute("azure-openai", ["/openai/deployments/{deployment}/chat/completions", "/openai/deployments/{deployment}/embeddings"], [modelEntry("azure-openai/deployment", ["llm.chat", "llm.embeddings"], ["/openai/deployments/{deployment}/chat/completions", "/openai/deployments/{deployment}/embeddings"])]),
      modelRoute("cloudflare-ai-gateway", ["/"], [modelEntry("cloudflare-ai-gateway/auto", ["llm.chat", "llm.responses"], ["/"])]),
      modelRoute("cohere", ["/v2/chat", "/v2/embed"], [modelEntry("cohere/default", ["llm.chat", "llm.embeddings"], ["/v2/chat", "/v2/embed"])]),
      modelRoute("deepseek", ["/chat/completions"], [modelEntry("deepseek/default", ["llm.chat"], ["/chat/completions"])]),
      modelRoute("fireworks", ["/v1/chat/completions"], [modelEntry("fireworks/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("google-gemini", ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"], [modelEntry("google/gemini-default", ["llm.generate", "llm.stream"], ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"])]),
      modelRoute("groq", ["/v1/chat/completions"], [modelEntry("groq/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("huggingface", ["/models/{model}"], [modelEntry("huggingface/model", ["llm.invoke"], ["/models/{model}"])]),
      modelRoute("minimax", ["/v1/chat/completions"], [modelEntry("minimax/MiniMax-M3", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("mistral", ["/v1/chat/completions", "/v1/embeddings"], [modelEntry("mistral/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("openai", ["/v1/responses", "/v1/chat/completions", "/v1/embeddings"], [modelEntry("openai/gpt-4.1-mini", ["llm.responses", "llm.chat"], ["/v1/responses", "/v1/chat/completions"]), modelEntry("openai/text-embedding-3-large", ["llm.embeddings"], ["/v1/embeddings"])]),
      modelRoute("openrouter", ["/v1/chat/completions"], [modelEntry("openrouter/auto", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("perplexity", ["/chat/completions"], [modelEntry("perplexity/default", ["llm.chat"], ["/chat/completions"])]),
      modelRoute("together", ["/v1/chat/completions"], [modelEntry("together/default", ["llm.chat"], ["/v1/chat/completions"])]),
      modelRoute("xai", ["/v1/chat/completions"], [modelEntry("xai/default", ["llm.chat"], ["/v1/chat/completions"])]),
    ],
    manifestProxy: [
      manifestRoute("openai", "responses", "/v1/proxy/openai/responses", ["POST"], [], "openai.responses", "openai/gpt-4.1-mini"),
      manifestRoute("replicate", "predictions", "/v1/proxy/replicate/predictions", ["POST"], [], "replicate.prediction_create", "replicate/predictions"),
      manifestRoute("replicate", "prediction", "/v1/proxy/replicate/prediction", ["GET"], ["prediction_id"], "replicate.prediction_get", "replicate/predictions"),
      manifestRoute("tavily", "search", "/v1/proxy/tavily/search", ["POST"], [], "tavily.search", "tavily/search"),
      manifestRoute("tavily", "extract", "/v1/proxy/tavily/extract", ["POST"], [], "tavily.extract", "tavily/extract"),
      manifestRoute("tavily", "crawl", "/v1/proxy/tavily/crawl", ["POST"], [], "tavily.crawl", "tavily/search"),
    ],
  };
  const keys: AccessPolicy[] = [
    { policyId: "maintainer_models", enabled: true, providers: ["anthropic", "aws-bedrock", "azure-openai", "cloudflare-ai-gateway", "cohere", "deepseek", "fireworks", "google-gemini", "groq", "huggingface", "minimax", "mistral", "openai", "openrouter", "perplexity", "together", "xai"], tenantId: "openclaw", tokenRole: "maintainer", monthlyBudgetMicros: 250000000, requestCostMicros: 1000, retainRequestContent: true },
    { policyId: "openclaw_tools", enabled: true, providers: ["replicate", "tavily"], tenantId: "openclaw", tokenRole: "tooling", monthlyBudgetMicros: 75000000, requestCostMicros: 500, retainRequestContent: true },
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

export function modelRoute(provider: string, endpoints: string[], models: RouteCatalog["openaiCompatible"][number]["models"]): RouteCatalog["openaiCompatible"][number] {
  return { provider, endpoints, models };
}

export function modelEntry(id: string, capabilities: string[], endpoints: string[]) {
  return { id, capabilities, endpoints };
}

export function manifestRoute(provider: string, endpoint: string, route: string, methods: string[], pathParams: string[] = [], requestFormat?: string, sampleModel?: string): RouteCatalog["manifestProxy"][number] {
  return { provider, endpoint, route, methods, pathParams, requestFormat, sampleModel };
}

export function provider(id: string, display_name: string, providerClass: string, service_kind: string, capabilities: string[], authorizationKind?: "oauth" | "subscription"): ProviderRow {
  return { id, display_name, class: providerClass, service_kind, meter: "request", capabilities: capabilities.map((capability) => ({ id: capability })), auth: authorizationKind ? { authorization: { grantKind: authorizationKind } } : undefined };
}
import { accessMap, effectiveAccess, policyCoversProvider, policyUsageFallback, readinessMap, tenantSummaryFallback } from "./domain";
import { demoDisabledProviderIds, demoMissingConfigProviderIds } from "./ui-config";
import { adminOverviewFromPolicies, serviceItems } from "./ui-helpers";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "./ui-types";

