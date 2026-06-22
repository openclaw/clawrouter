export function oauthCallbackStatus() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("oauth");
  const provider = params.get("provider") ?? "provider";
  if (outcome === "connected") return `${provider} connected`;
  if (outcome === "failed") return `${provider} OAuth failed`;
  return null;
}

export function isLocalDemoAllowed() {
  const params = new URLSearchParams(window.location.search);
  return params.has("demo") || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

export function localDemoRole(): AccessRole | null {
  if (!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) return null;
  return new URLSearchParams(window.location.search).get("demo") === "user" ? "user" : null;
}

export async function settled<T>(loader: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await loader() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, credentials: "same-origin", headers });
  if (!response.ok) throw new Error((await response.text()) || `${path} failed with ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`${path} returned a non-JSON response from ${baseUrl}`);
  return response.json() as Promise<T>;
}

export async function playgroundRequest(baseUrl: string, path: string, init: RequestInit = {}): Promise<PlaygroundHttpResponse> {
  const headers = new Headers(init.headers);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, credentials: "same-origin", headers });
  const contentType = response.headers.get("content-type") ?? "";
  const retention = response.headers.get("x-clawrouter-content-retention") ?? "unknown";
  const body = await response.arrayBuffer();
  const text = isTextualResponse(contentType) ? new TextDecoder().decode(body) : "";
  let raw = "";
  if (response.status === 204 || body.byteLength === 0) raw = `HTTP ${response.status} ${response.statusText || "No Content"}`.trim();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      raw = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      raw = text;
    }
  } else if (text) {
    raw = text;
  } else if (!raw) {
    raw = `HTTP ${response.status} ${response.statusText || "OK"}\n${contentType || "binary"} response (${body.byteLength} bytes)`;
  }
  return { ok: response.ok, raw, status: response.status, statusText: response.statusText, contentType, retention };
}

export function createPlaygroundTurn(input: Omit<PlaygroundTurn, "id" | "response" | "rawResponse"> & { raw: string }): PlaygroundTurn {
  return {
    id: crypto.randomUUID(),
    mode: input.mode,
    prompt: input.prompt,
    response: input.error ?? playgroundResponseText(input.raw),
    rawResponse: input.raw,
    request: input.request,
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint,
    status: input.status,
    durationMs: input.durationMs,
    retention: input.retention,
    error: input.error,
  };
}

export function isTextualResponse(contentType: string) {
  return /(^text\/|json|xml|html|csv|yaml|graphql|javascript)/i.test(contentType);
}

export function readyCount(services: ServiceItem[]) {
  return services.filter((service) => service.readiness?.executable).length;
}

export function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function upstreamGrantFormFromGrant(grant: UpstreamGrant): UpstreamGrantForm {
  return {
    scope: grant.scope,
    scopeId: grant.scopeId,
    tokenRef: grant.tokenRef,
    kind: grant.kind,
    provider: grant.provider ?? "",
    label: grant.label ?? "",
    enabled: grant.enabled,
    credential: "",
    credentialBundle: "",
    accessToken: "",
    refreshToken: "",
    accountId: grant.accountId ?? "",
    expiresAt: grant.expiresAt ?? "",
  };
}

export function assignmentRuleFormFromRule(rule: AssignmentRule): AssignmentRuleForm {
  return {
    ruleId: rule.ruleId,
    enabled: rule.enabled,
    kind: rule.kind,
    subject: rule.subject,
    groups: rule.groups.join(", "),
    policyIds: rule.policyIds,
    priority: String(rule.priority),
    revokeOnLoss: rule.revokeOnLoss,
    provenance: rule.provenance,
  };
}

export function demoGrantFromForm(form: UpstreamGrantForm, existing?: UpstreamGrant): UpstreamGrant {
  const key = form.scope === "tenants"
    ? `oauth/tenants/${form.scopeId.trim()}/${form.tokenRef.trim()}`
    : `oauth/${form.scopeId.trim()}/${form.tokenRef.trim()}`;
  const now = new Date().toISOString();
  const hasCredential = Boolean(form.credential.trim()) || Boolean(existing?.hasCredential);
  const credentialFields = Object.keys(parseCredentialBundle(form.credentialBundle)).sort();
  const effectiveCredentialFields = credentialFields.length ? credentialFields : existing?.credentialFields ?? [];
  const hasAccessToken = Boolean(form.accessToken.trim()) || Boolean(existing?.hasAccessToken);
  const hasRefreshToken = Boolean(form.refreshToken.trim()) || Boolean(existing?.hasRefreshToken);
  return {
    key,
    scope: form.scope,
    scopeId: form.scopeId.trim(),
    tokenRef: form.tokenRef.trim(),
    version: 1,
    enabled: form.enabled,
    kind: form.kind,
    provider: form.provider.trim(),
    label: form.label.trim() || null,
    tokenType: existing?.tokenType ?? "Bearer",
    expiresAt: form.expiresAt.trim() || null,
    scopes: existing?.scopes ?? [],
    accountId: form.accountId.trim() || null,
    subscription: existing?.subscription ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    revokedAt: form.enabled ? null : now,
    hasCredential,
    credentialFields: effectiveCredentialFields,
    hasAccessToken,
    hasRefreshToken,
    refreshConfigured: existing?.refreshConfigured ?? hasRefreshToken,
    usable: form.enabled && (form.kind === "api_key" ? hasCredential || effectiveCredentialFields.length > 0 : hasAccessToken || form.kind === "subscription" && hasCredential),
  };
}

export function parseCredentialBundle(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("credential bundle must be a JSON object");
  const credentials: Record<string, string> = {};
  for (const [name, secret] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || typeof secret !== "string" || !secret) throw new Error("credential bundle fields must use non-empty string secrets");
    credentials[name] = secret;
  }
  return credentials;
}

export function demoRuleFromForm(form: AssignmentRuleForm): AssignmentRule {
  const now = new Date().toISOString();
  return {
    ruleId: form.ruleId.trim(),
    version: 1,
    enabled: form.enabled,
    kind: form.kind,
    subject: form.subject.trim().toLowerCase(),
    groups: parseGroups(form.groups),
    policyIds: [...form.policyIds].sort(),
    priority: optionalNumber(form.priority) ?? 100,
    revokeOnLoss: form.revokeOnLoss,
    provenance: form.provenance.trim(),
    generatedGroup: `assignment.${form.ruleId.trim()}`,
    createdAt: now,
    updatedAt: now,
  };
}

export function formatBudget(value: number | null | undefined) {
  if (value === undefined || value === null) return "unlimited";
  if (value === 0) return "blocked";
  return formatMicros(value);
}

export function budgetPercent(row: AdminUsageRow) {
  const limit = row.budget.limitMicros ?? row.monthlyBudgetMicros;
  const spent = row.budget.spentMicros;
  if (row.budget.ledger === "blocked" || limit === 0) return 100;
  if (limit === undefined || limit === null || spent === undefined || spent === null) return null;
  return Math.min(100, Math.max(0, (spent / limit) * 100));
}

export function formatMicros(value: number | null | undefined) {
  if (value === undefined || value === null) return "unknown";
  if (!value) return "none";
  if (value < 10_000) return "<$0.01";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

export function formatCount(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { notation: value !== undefined && value !== null && Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value ?? 0);
}

export function formatDuration(value: number | null | undefined) {
  if (value === undefined || value === null) return "unknown";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function formatTimestamp(value: number, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return full
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "never";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 60_000) return "checked just now";
  if (elapsed < 3_600_000) return `checked ${Math.floor(elapsed / 60_000)}m ago`;
  return `checked ${Math.floor(elapsed / 3_600_000)}h ago`;
}

export function usageEventTone(event: UsageAuditEvent): OutcomeTone {
  if (event.status === "success" || (event.status_code !== undefined && event.status_code !== null && event.status_code < 400)) return "active";
  if (event.status === "denied" || event.status === "provider_error" || event.status === "client_error" || event.status === "timeout" || (event.status_code !== undefined && event.status_code !== null && event.status_code >= 400)) return "revoked";
  return "neutral";
}

export function credentialOutcome(credential: ProxyCredential, policies: AccessPolicy[]): { label: string; tone: OutcomeTone; active: boolean } {
  const policy = policies.find((item) => item.policyId === credential.policyId);
  if (!credential.enabled) return { label: "revoked", tone: "revoked", active: false };
  if (!policy) return { label: "policy missing", tone: "revoked", active: false };
  if (credential.policyEnabled === false || !policy.enabled) return { label: "policy disabled", tone: "revoked", active: false };
  if (credential.generationMatches === false) return { label: "stale", tone: "neutral", active: false };
  if (credential.active === false) return { label: "inactive", tone: "neutral", active: false };
  return { label: "active", tone: "active", active: true };
}

export function usagePolicyId(row: AdminUsageRow) {
  return row.policyId ?? row.kid;
}

export function effectiveProviderCount(providerIds: string[], services: ServiceItem[], allProviders = providerIds.length === 0) {
  return allProviders ? `all ${new Set(services.map((service) => service.provider)).size}` : String(providerIds.length);
}

export function catalogModels(routes: RouteCatalog): CatalogModel[] {
  return routes.openaiCompatible.flatMap((route) => route.models
    .filter((model) => model.capabilities.some((capability) => capability === "llm.chat" || capability === "llm.responses"))
    .map((model) => ({ id: model.id, provider: route.provider, capabilities: model.capabilities })));
}

export function providerName(provider: string, readinessByProvider: Record<string, ProviderReadiness>) {
  return readinessByProvider[provider]?.displayName ?? provider.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export function shortModelName(model: string, provider: string) {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function serviceModelOptions(routes: RouteCatalog["manifestProxy"]) {
  const seen = new Set<string>();
  return [...routes].sort((left, right) => serviceRouteRank(left) - serviceRouteRank(right)).flatMap((route) => (route.models ?? []).flatMap((model) => {
    if (seen.has(model.id)) return [];
    seen.add(model.id);
    return [{
      model: model.id,
      route,
      value: `service-model:${routeKey(route)}:${model.id}`,
    }];
  }));
}

export function serviceRouteRank(route: RouteCatalog["manifestProxy"][number]) {
  if (["messages", "chat", "chat_completions", "generate_content", "responses"].includes(route.endpoint)) return 0;
  if (route.streaming) return 2;
  return 1;
}

export function serviceModelFromForm(form: PlaygroundForm, route?: RouteCatalog["manifestProxy"][number]) {
  if (route?.pathParams?.includes("model")) return form.servicePath;
  try {
    const body = JSON.parse(form.servicePayload) as { model?: unknown };
    return typeof body.model === "string" ? body.model : "";
  } catch {
    return "";
  }
}

export function groupedProviders(providers: ProviderRow[], query: string) {
  const needle = query.trim().toLowerCase();
  const matches = providers.filter((provider) => {
    const text = [provider.id, provider.display_name, provider.service_kind, provider.class, provider.capabilities.map((capability) => capability.id).join(" ")].join(" ").toLowerCase();
    return !needle || text.includes(needle);
  });
  const groups = matches.reduce((acc, provider) => {
    const kind = provider.service_kind;
    acc.set(kind, [...(acc.get(kind) ?? []), provider]);
    return acc;
  }, new Map<string, ProviderRow[]>());
  return Array.from(groups.entries())
    .map(([kind, groupProviders]) => ({ kind, providers: groupProviders.sort((a, b) => a.display_name.localeCompare(b.display_name)) }))
    .sort((a, b) => kindLabel(a.kind).localeCompare(kindLabel(b.kind)));
}

export function policyFormFromPolicy(key: AccessPolicy): PolicyForm {
  return {
    policyId: key.policyId,
    tokenRole: key.tokenRole ?? "",
    tenantId: key.tenantId ?? "default",
    enabled: key.enabled,
    monthlyBudgetMicros: currencyInput(key.monthlyBudgetMicros),
    requestCostMicros: key.requestCostMicros?.toString() ?? "",
    providers: key.providers,
    allProviders: key.providers.length === 0,
    retainRequestContent: key.retainRequestContent,
  };
}

export function adminOverviewFromPolicies(keys: AccessPolicy[], credentials: ProxyCredential[], providers: ProviderRow[], routes: RouteCatalog): AdminOverview {
  const tenants = tenantSummaryFallback(keys, credentials);
  return {
    policiesTotal: keys.length,
    policiesActive: keys.filter((key) => key.enabled).length,
    keysTotal: credentials.length,
    keysActive: credentials.filter((credential) => credentialOutcome(credential, keys).active).length,
    tenantsTotal: tenants.length,
    providerCount: providers.length,
    openaiCompatibleProviders: routes.openaiCompatible.length,
    manifestRoutes: routes.manifestProxy.length,
    monthlyBudgetMicros: keys.reduce((total, key) => total + (key.monthlyBudgetMicros ?? 0), 0),
    requestCostMicros: keys.reduce((total, key) => total + (key.requestCostMicros ?? 0), 0),
  };
}

export function serviceItems(providers: ProviderRow[], routes: RouteCatalog, readinessByProvider: Record<string, ProviderReadiness> = {}, accessByProvider: Map<string, ProviderAccess> = new Map()): ServiceItem[] {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const modelRoutesByProvider = routes.openaiCompatible.reduce((groups, route) => {
    groups.set(route.provider, [...(groups.get(route.provider) ?? []), route]);
    return groups;
  }, new Map<string, RouteCatalog["openaiCompatible"]>());
  const proxyRoutesByProvider = routes.manifestProxy.reduce((groups, route) => {
    groups.set(route.provider, [...(groups.get(route.provider) ?? []), route]);
    return groups;
  }, new Map<string, RouteCatalog["manifestProxy"]>());
  const providerIds = catalogProviderIds(
    providers.map((provider) => provider.id),
    routes.openaiCompatible.map((route) => route.provider),
    routes.manifestProxy.map((route) => route.provider),
  );
  return providerIds.map((providerId) => {
    const provider = providerById.get(providerId);
    const modelRoutes = modelRoutesByProvider.get(providerId) ?? [];
    const providerRoutes = proxyRoutesByProvider.get(providerId) ?? [];
    const models = modelRoutes.flatMap((route) => route.models);
    const modelEndpoints = models.flatMap((model) => model.endpoints);
    const publicRoutes = modelRoutes.flatMap((route) => route.endpoints);
    const proxyRoutes = providerRoutes.map((route) => route.route);
    const routePaths = unique([...publicRoutes, ...modelEndpoints, ...proxyRoutes]);
    return {
      id: `${providerId}:${modelRoutes.length ? "llm" : providerRoutes.length ? "service" : "provider"}`,
      name: provider?.display_name || providerId,
      provider: providerId,
      kind: provider?.service_kind || (modelRoutes.length ? "llm" : "service"),
      category: provider?.class || (modelRoutes.length ? "model route" : "manifest proxy"),
      capabilities: unique([...(provider?.capabilities.map((capability) => capability.id) ?? []), ...models.flatMap((model) => model.capabilities)]),
      surfaces: unique([...publicRoutes, ...modelEndpoints, ...providerRoutes.flatMap((route) => route.methods)]),
      route: routePaths.join(", ") || "/v1/proxy",
      routeCount: routePaths.length,
      models: models.length,
      modelIds: models.map((model) => model.id),
      access: accessByProvider.get(providerId),
      readiness: readinessByProvider[providerId],
      brandIcon: providerBrandIcon(providerId),
    };
  });
}

export function matchesServiceQuery(item: ServiceItem, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.id, item.name, item.provider, item.kind, item.category, item.capabilities.join(" "), item.modelIds.join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export function providerBrandIcon(providerId: string): BrandIcon | undefined {
  return (providerIconManifest.icons as Record<string, BrandIcon>)[providerId];
}

export interface CatalogModel {
  id: string;
  provider: string;
  capabilities: string[];
}

export function playgroundCurl(form: PlaygroundForm, payload: unknown, route?: RouteCatalog["manifestProxy"][number]) {
  const method = "POST";
  const endpoint = playgroundAccessEndpoint(form, route);
  const lines = [`curl -X ${method} '${window.location.origin}${endpoint}' \\`, `  -b '$CLOUDFLARE_ACCESS_COOKIE' \\`, `  -H 'content-type: application/json' \\`, `  -d '${JSON.stringify(payload ?? {}, null, 2).replace(/'/g, `'\\''`)}'`];
  return lines.join("\n");
}

export function playgroundRequestPreview(form: PlaygroundForm, mode: "json" | "curl", route?: RouteCatalog["manifestProxy"][number]) {
  try {
    const payload = playgroundPayload(form, route);
    return mode === "json" ? JSON.stringify(payload, null, 2) : playgroundCurl(form, payload, route);
  } catch (error) {
    return errorMessage(error);
  }
}
import providerIconManifest from "./provider-icons.json";
import { catalogProviderIds, currencyInput, errorMessage, optionalNumber, parseGroups, playgroundAccessEndpoint, playgroundPayload, playgroundResponseText, playgroundServicePreset, routeKey, tenantSummaryFallback, unique } from "./domain";
import { kindLabel } from "./components";
import type { AccessForm,AccessPolicy,AccessRole,AccessTab,AccessUser,AdminOverview,AdminTenantSummary,AdminUsageRow,AssignmentRule,AssignmentRuleForm,BindingForm,BrandIcon,BudgetStatus,ContentRetention,CredentialForm,EntitlementsResponse,IconComponent,OutcomeTone,PlaygroundForm,PlaygroundHttpResponse,PlaygroundTurn,PolicyBinding,PolicyForm,ProviderAccess,ProviderConnection,ProviderReadiness,ProviderResponse,ProviderRow,ProviderUsageSummary,ProxyCredential,RefreshOptions,RetainedRequestContent,RouteCatalog,ServiceItem,ServiceOutcome,SessionResponse,UpstreamGrant,UpstreamGrantForm,UsageAuditEvent,UsageSnapshot,UsageSummary,View } from "./ui-types";
