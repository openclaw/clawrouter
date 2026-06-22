import type {
  AccessForm,
  AccessPolicy,
  AccessUser,
  AdminTenantSummary,
  AdminUsageRow,
  BindingForm,
  PlaygroundForm,
  PolicyBinding,
  ProviderAccess,
  ProviderReadiness,
  RouteCatalog,
  ServiceItem,
  ServiceOutcome,
} from "./ui-types";

export interface CredentialSummary {
  credentialId: string;
  policyId: string;
  enabled: boolean;
  active?: boolean;
}

export interface PlaygroundMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CatalogModel {
  id: string;
  provider: string;
  capabilities: string[];
}

export function preferredPlaygroundEndpoint(model: CatalogModel): PlaygroundForm["endpoint"] {
  return model.capabilities.includes("llm.responses") ? "/v1/responses" : "/v1/chat/completions";
}

export function readinessMap(readiness: ProviderReadiness[]) {
  return Object.fromEntries(readiness.map((item) => [item.id, item]));
}

export function accessMap(entitlements: { providers: ProviderAccess[] } | null) {
  return new Map((entitlements?.providers ?? []).map((item) => [item.provider, item]));
}

export function grantNamesForService(service: ServiceItem, policies: AccessPolicy[] = []) {
  return unique([...policies.map((policy) => policy.policyId), ...(service.access?.policies ?? [])]);
}

export function serviceOutcome(service: ServiceItem): ServiceOutcome {
  if (service.access && !service.access.allowed) {
    return {
      label: "denied",
      detail: "Current Cloudflare Access identity is denied by policy.",
      tone: "revoked",
      playable: false,
      blocked: true,
    };
  }
  if (!service.access) {
    return {
      label: "unknown",
      detail: "Access entitlements are unavailable, so this identity's policy status cannot be determined.",
      tone: "neutral",
      playable: false,
      blocked: false,
    };
  }
  const policyNames = service.access.policies;
  if (!service.readiness) {
    return {
      label: "unknown",
      detail: `Granted by ${policyNames.join(", ") || "session"}, but runtime readiness has not loaded yet.`,
      tone: "neutral",
      playable: false,
      blocked: true,
    };
  }
  if (service.readiness.executable) {
    return {
      label: "usable",
      detail: `Granted by ${policyNames.join(", ") || "session"} and executable in the gateway.`,
      tone: "active",
      playable: true,
      blocked: false,
    };
  }
  const missing = service.readiness.missingConfig.length ? `Missing ${service.readiness.missingConfig.join(", ")}.` : "";
  const oauth = service.readiness.oauthGrantRequired ? "OAuth grant required before calls can run." : "";
  return {
    label: service.readiness.status === "missing_config" ? "missing config" : service.readiness.status === "grant_required" ? "needs OAuth" : readinessLabel(service.readiness),
    detail: [service.readiness.reasons[0], missing, oauth].filter(Boolean).join(" "),
    tone: "revoked",
    playable: false,
    blocked: true,
  };
}

export function readinessLabel(readiness: ProviderReadiness | undefined) {
  if (!readiness) return "unknown";
  return readiness.status.replace(/_/g, " ");
}

export function readinessTone(readiness: ProviderReadiness | undefined): ServiceOutcome["tone"] {
  if (!readiness) return "neutral";
  if (!readiness.executable) return "revoked";
  return readiness.verified ? "active" : "neutral";
}

export function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${value} is not a non-negative safe integer`);
  return parsed;
}

export function optionalCurrencyMicros(value: string) {
  if (!value.trim()) return undefined;
  const normalized = value.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${value} is not a valid budget`);
  return Math.round(parsed * 1_000_000);
}

export function currencyInput(value: number | null | undefined) {
  if (value === undefined || value === null) return "";
  return String(value / 1_000_000);
}

export function optionalDecimal(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${value} is not a number`);
  return parsed;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function policyCoversProvider(policy: AccessPolicy, providerId: string) {
  return policy.providers.length === 0 || policy.providers.includes(providerId);
}

export function accessFormFromUser(user: AccessUser, bindings: PolicyBinding[]): AccessForm {
  return {
    email: user.email,
    tenantId: user.tenantId,
    enabled: user.enabled,
    groups: user.groups.join(", "),
    contentRetentionDisabled: user.contentRetentionDisabled,
    policyIds: bindings
      .filter((binding) => binding.enabled && binding.principalType === "user" && binding.principalId === user.email)
      .sort((a, b) => a.priority - b.priority || a.policyId.localeCompare(b.policyId))
      .map((binding) => binding.policyId),
  };
}

export function bindingKey(binding: PolicyBinding | undefined) {
  return binding ? `${binding.principalType}:${binding.principalId}:${binding.policyId}` : "";
}

export function bindingFormFromBinding(binding: PolicyBinding): BindingForm {
  return {
    policyId: binding.policyId,
    principalType: binding.principalType,
    principalId: binding.principalId,
    enabled: binding.enabled,
    priority: String(binding.priority),
  };
}

export function effectiveAccess(user: AccessUser | undefined, policies: AccessPolicy[], bindings: PolicyBinding[], services: ServiceItem[]) {
  if (!user || !user.enabled) return { policies: [] as AccessPolicy[], services: [] as ServiceItem[] };
  const groupIds = new Set(user.groups);
  const policyIds = new Set(bindings
    .filter((binding) => binding.enabled && (binding.principalType === "user" ? binding.principalId === user.email : groupIds.has(binding.principalId)))
    .sort((a, b) => a.priority - b.priority || a.policyId.localeCompare(b.policyId))
    .map((binding) => binding.policyId));
  const userPolicies = policies.filter((policy) => policy.enabled && policyIds.has(policy.policyId));
  const hasWildcardPolicy = userPolicies.some((policy) => policy.providers.length === 0);
  const providerIds = new Set(userPolicies.flatMap((policy) => policy.providers));
  return { policies: userPolicies, services: services.filter((service) => hasWildcardPolicy || providerIds.has(service.provider)) };
}

export function parseGroups(value: string) {
  return unique(value.split(/[,\n]+/).map((group) => group.trim().toLowerCase()).filter(Boolean)).sort();
}

export function reconcileDirectUserBindings(current: PolicyBinding[], email: string, policies: AccessPolicy[], policyIds: string[]) {
  const desired = new Set(policyIds);
  const existing = new Map(current
    .filter((binding) => binding.principalType === "user" && binding.principalId === email)
    .map((binding) => [binding.policyId, binding]));
  const other = current.filter((binding) => binding.principalType !== "user" || binding.principalId !== email);
  const direct = policies.flatMap((policy) => {
    const binding = existing.get(policy.policyId);
    if (!binding && !desired.has(policy.policyId)) return [];
    return [{
      policyId: policy.policyId,
      principalType: "user" as const,
      principalId: email,
      enabled: desired.has(policy.policyId),
      priority: binding?.priority ?? 100,
    }];
  });
  return [...other, ...direct];
}

export function directUserBindingChanges(current: PolicyBinding[], email: string, policies: AccessPolicy[], policyIds: string[]) {
  const existing = new Map(current
    .filter((binding) => binding.principalType === "user" && binding.principalId === email)
    .map((binding) => [binding.policyId, binding]));
  const changes = reconcileDirectUserBindings(current, email, policies, policyIds)
    .filter((binding) => binding.principalType === "user" && binding.principalId === email)
    .filter((binding) => existing.get(binding.policyId)?.enabled !== binding.enabled);
  return {
    removals: changes.filter((binding) => !binding.enabled),
    additions: changes.filter((binding) => binding.enabled),
  };
}

export function policyUsageFallback(policy: AccessPolicy): AdminUsageRow {
  const limit = policy.monthlyBudgetMicros;
  const blocked = limit === 0;
  const unmetered = limit === undefined || limit === null;
  return {
    policyId: policy.policyId,
    kid: policy.policyId,
    tenantId: policy.tenantId ?? "default",
    enabled: policy.enabled,
    providers: policy.providers,
    tokenRole: policy.tokenRole,
    monthlyBudgetMicros: policy.monthlyBudgetMicros,
    requestCostMicros: policy.requestCostMicros,
    budget: {
      configured: !unmetered,
      ledger: blocked ? "blocked" : unmetered ? "unmetered" : "untracked",
      limitMicros: limit,
      spentMicros: blocked ? 0 : null,
      remainingMicros: blocked ? 0 : limit,
    },
  };
}

export function tenantSummaryFallback(policies: AccessPolicy[], credentials: CredentialSummary[] = []): AdminTenantSummary[] {
  const groups = policies.reduce((acc, policy) => {
    const tenantId = policy.tenantId ?? "default";
    const current = acc.get(tenantId) ?? { tenantId, policies: 0, activePolicies: 0, keys: 0, activeKeys: 0, providers: new Set<string>(), allProviders: false, monthlyBudgetMicros: 0, requestCostMicros: 0 };
    current.policies += 1;
    if (policy.enabled) {
      current.activePolicies += 1;
      if (policy.providers.length) {
        policy.providers.forEach((provider) => current.providers.add(provider));
      } else {
        current.allProviders = true;
      }
    }
    current.monthlyBudgetMicros += policy.monthlyBudgetMicros ?? 0;
    current.requestCostMicros += policy.requestCostMicros ?? 0;
    acc.set(tenantId, current);
    return acc;
  }, new Map<string, { tenantId: string; policies: number; activePolicies: number; keys: number; activeKeys: number; providers: Set<string>; allProviders: boolean; monthlyBudgetMicros: number; requestCostMicros: number }>());
  const policyById = new Map(policies.map((policy) => [policy.policyId, policy]));
  for (const credential of credentials) {
    const policy = policyById.get(credential.policyId);
    if (!policy) continue;
    const tenant = groups.get(policy.tenantId ?? "default");
    if (!tenant) continue;
    tenant.keys += 1;
    if (credential.active ?? (credential.enabled && policy.enabled)) tenant.activeKeys += 1;
  }
  return Array.from(groups.values()).map((tenant) => ({
    ...tenant,
    providers: Array.from(tenant.providers).sort(),
  }));
}

export function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function catalogProviderIds(providerIds: string[], modelProviderIds: string[], proxyProviderIds: string[]) {
  return unique([...providerIds, ...modelProviderIds, ...proxyProviderIds]).sort();
}

export function knownPolicyProviders(selected: string[], available: string[]) {
  const known = new Set(available);
  return unique(selected.filter((provider) => known.has(provider))).sort();
}

export function playgroundPayload(form: PlaygroundForm, route?: RouteCatalog["manifestProxy"][number], conversation: PlaygroundMessage[] = []) {
  if (form.mode === "service") {
    const body = form.servicePayload.trim() ? JSON.parse(form.servicePayload) : {};
    return {
      method: form.serviceMethod,
      pathParams: pathParamsForRoute(route, form.servicePath),
      body,
    };
  }
  const maxTokens = optionalNumber(form.maxTokens);
  const temperature = playgroundSupportsTemperature(form.model) ? optionalDecimal(form.temperature) : undefined;
  const messages = [...conversation, { role: "user" as const, content: form.prompt }];
  if (form.endpoint === "/v1/responses") {
    return { model: form.model, input: messages, instructions: form.system || undefined, max_output_tokens: maxTokens, temperature };
  }
  return { model: form.model, messages: [...(form.system ? [{ role: "system", content: form.system }] : []), ...messages], max_tokens: maxTokens, temperature };
}

export function playgroundSupportsTemperature(model: string) {
  return !/^openai\/gpt-5\.(?:4|5)(?:$|-)/.test(model);
}

export function playgroundResponseText(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!value || typeof value !== "object") return raw;
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.output === "string") return record.output;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  if (typeof choice?.text === "string") return choice.text;

  const content = Array.isArray(record.content) ? record.content : [];
  const contentText = textFromContent(content);
  if (contentText) return contentText;

  const output = Array.isArray(record.output) ? record.output : [];
  const outputText = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    return textFromContent(Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : []) || [];
  }).join("\n");
  return outputText || raw;
}

function textFromContent(content: unknown[]) {
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
}

export function playgroundServicePreset(route?: RouteCatalog["manifestProxy"][number], selectedModel?: string) {
  const model = selectedModel ?? route?.sampleModel ?? `${route?.provider ?? "provider"}/default`;
  const format = route?.requestFormat ?? `${route?.provider ?? ""}.${route?.endpoint ?? ""}`;
  let body: unknown = {};

  if (format === "anthropic.messages") {
    body = {
      model,
      messages: [{ role: "user", content: "Reply with ok." }],
      ...(route?.endpoint === "messages" ? { max_tokens: 16 } : {}),
    };
  } else if (format === "aws_bedrock.invoke") {
    body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with ok." }],
    };
  } else if (format === "cloudflare_ai_gateway.universal") {
    body = [{ provider: "workers-ai", endpoint: "@cf/meta/llama-3.1-8b-instruct", query: { prompt: "Reply with ok." } }];
  } else if (format === "cohere.chat") {
    body = { model, messages: [{ role: "user", content: "Reply with ok." }] };
  } else if (format === "cohere.embed") {
    body = { model, texts: ["OpenClaw"], input_type: "search_document", embedding_types: ["float"] };
  } else if (format === "firecrawl.scrape") {
    body = { url: "https://example.com", formats: ["markdown"] };
  } else if (format === "google.generate_content") {
    body = { contents: [{ parts: [{ text: "Reply with ok." }] }] };
  } else if (format === "openai.chat_completions") {
    body = { model, messages: [{ role: "user", content: "Reply with ok." }], max_tokens: 16 };
  } else if (format === "openai.embeddings") {
    body = { model, input: "OpenClaw" };
  } else if (format === "openai.responses") {
    body = { model, input: "Reply with ok.", max_output_tokens: 16 };
  } else if (format === "replicate.prediction_create") {
    body = { version: "MODEL_VERSION", input: { prompt: "A small red crab." } };
  } else if (format === "tavily.search") {
    body = { query: "OpenClaw", max_results: 1 };
  } else if (format === "tavily.extract") {
    body = { urls: ["https://example.com"] };
  } else if (format === "tavily.crawl") {
    body = { url: "https://example.com", max_depth: 1, limit: 1 };
  }

  const pathParam = route?.pathParams?.[0];
  return {
    serviceRoute: routeKey(route),
    serviceMethod: route?.methods[0] ?? "POST",
    servicePath: pathParam === "model" || pathParam === "deployment" ? model : pathParam ? pathParam.replaceAll("_", "-") : "",
    servicePayload: JSON.stringify(body, null, 2),
  };
}

export function playgroundAccessEndpoint(form: PlaygroundForm, route?: RouteCatalog["manifestProxy"][number]) {
  if (form.mode === "service") {
    return resolveProxyRoute(route).replace(/^\/v1\/proxy/, "/v1/playground/proxy");
  }
  return `/v1/playground${form.endpoint}`;
}

export function playgroundBlocker(form: PlaygroundForm, model: CatalogModel | undefined, route: RouteCatalog["manifestProxy"][number] | undefined, accessByProvider: Map<string, ProviderAccess>, readinessByProvider: Record<string, ProviderReadiness>) {
  if (form.mode === "model" && !model) return "select a model";
  if (form.mode === "service" && !route) return "select a service route";
  const provider = form.mode === "model" ? model?.provider : route?.provider;
  if (!provider) return null;
  const access = accessByProvider.get(provider);
  if (!access?.allowed) return "Cloudflare Access identity is not granted this provider";
  const readiness = readinessByProvider[provider];
  if (!readiness) return "provider readiness is unknown";
  if (!readiness.executable) return readiness.reasons[0] ?? `provider is ${readinessLabel(readiness)}`;
  return null;
}

export function playgroundBlockedForService(service: ServiceItem) {
  const outcome = serviceOutcome(service);
  if (!outcome.playable) return outcome.detail;
  if (service.readiness && !service.readiness.executable) return service.readiness.reasons[0] ?? `service is ${readinessLabel(service.readiness)}`;
  if (!service.models && service.surfaces.includes("provider")) return "no executable model or proxy route declared";
  return null;
}

export function routeKey(route: RouteCatalog["manifestProxy"][number] | undefined) {
  return route ? `${route.provider}:${route.endpoint}:${route.route}` : "";
}

export function resolveProxyRoute(route: RouteCatalog["manifestProxy"][number] | undefined) {
  if (!route) return "/v1/proxy";
  return route.route;
}

export function pathParamsForRoute(route: RouteCatalog["manifestProxy"][number] | undefined, value: string) {
  const params: Record<string, string> = {};
  for (const param of route?.pathParams ?? []) {
    params[param] = value.trim() || "demo";
  }
  return params;
}
