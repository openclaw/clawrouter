import { resolveTemplate } from "./provider-templates.ts";
import { listConnections } from "./authority";
import { resolveGrantCandidates } from "./grant-selection";
import { grantSupports } from "./provider-auth";
import { fetchTimeoutSignal } from "../shared/fetch-timeout.ts";
import { publicSession, sessionPolicies, verifiedAccessSession } from "./access";
import { contentRetentionDefault } from "./content-retention.ts";
import { loadFusionConfig } from "./fusion-config";
import { FUSION_MODEL_ID } from "./fusion";
import { authenticateProxyKey } from "./proxy-auth";
import { modelRoute, providerReadinessForPolicies, providerReadinessFromState, snapshot, type Readiness } from "./providers";
import type { AccessPolicyEntry, AccessSession, CompiledProvider, Env, ProviderConnection } from "./types";
import { errorResponse, HttpError, privateJson, sha256Hex } from "./utils";

export async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  let entitlements: { providers: EntitlementRow[] } | undefined;
  let entitlementsError: string | undefined;
  try { entitlements = { providers: await entitlementRows(session, env) }; }
  catch (error) { entitlementsError = error instanceof Error ? error.message : "entitlements unavailable"; }
  return privateJson({ ...publicSession(session), entitlements, entitlementsError, contentRetention: await retentionView(session, env) });
}

export async function entitlementResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "entitlements require a verified Cloudflare Access session", 401);
  return privateJson({ session: publicSession(session), providers: await entitlementRows(session, env), contentRetention: await retentionView(session, env) });
}

export async function avatarResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "avatar access requires a verified Cloudflare Access session", 401);
  const hash = await sha256Hex(session.email.trim().toLowerCase());
  const upstream = await fetch(`https://www.gravatar.com/avatar/${hash}?s=60&d=identicon&r=g`, { signal: fetchTimeoutSignal(request.signal) });
  if (!upstream.ok) return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
  if (!["image/gif", "image/jpeg", "image/png", "image/webp"].includes(type)) return new Response(null, { status: 502 });
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > 1024 * 1024) return new Response(null, { status: 502 });
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, no-store", vary: "cf-access-jwt-assertion" } });
}

export async function modelsResponse(request: Request, env: Env): Promise<Response> {
  const entitlements = await clientEntitlements(request, env);
  if (entitlements instanceof Response) return entitlements;
  const rows = entitlements.rows;
  const inventory = entitlements.inventory;
  if (request.headers.has("anthropic-version")) {
    const data = snapshot.providers.flatMap((provider) => (inventory.get(provider.id)?.models ?? []).filter((model) => model.capabilities.includes("llm.messages")).map((model) => ({
      id: model.id, type: "model", display_name: `${provider.display_name} · ${model.id}`, created_at: "1970-01-01T00:00:00Z",
      capabilities: null, max_input_tokens: model.pricing?.maxInputTokens ?? null, max_tokens: model.pricing?.defaultMaxOutputTokens ?? null,
    })));
    return privateJson({ data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null });
  }
  const data = snapshot.providers.flatMap((provider) => (inventory.get(provider.id)?.models ?? []).flatMap((model) => {
    const capabilities = model.capabilities;
    return capabilities.length ? [{ id: model.id, object: "model", owned_by: provider.id, display_name: `${provider.display_name} · ${model.id}`, capabilities }] : [];
  }));
  const fusion = rows.find((row) => row.provider === "clawrouter");
  if (fusion?.allowed && fusion.readiness.executable) data.unshift({
    id: FUSION_MODEL_ID,
    object: "model",
    owned_by: "clawrouter",
    display_name: "ClawRouter · Fusion",
    capabilities: ["llm.chat"],
  });
  return privateJson({ object: "list", data });
}

export async function catalogResponse(request: Request, env: Env): Promise<Response> {
  const entitlements = await clientEntitlements(request, env);
  if (entitlements instanceof Response) return entitlements;
  const rows = entitlements.rows;
  const inventory = entitlements.inventory;
  const providers = rows.filter((row) => row.allowed && row.provider !== "clawrouter").flatMap((row) => {
    const provider = snapshot.providers.find((candidate) => candidate.id === row.provider);
    if (!provider) return [];
    const view = inventory.get(provider.id)!;
    const endpoints = view.endpoints;
    const executable = endpoints.length > 0;
    return [{
      id: provider.id, displayName: provider.display_name, allowed: true, executable,
      openaiCompatible: executable && provider.class === "openai_compatible", nativeBaseUrl: `/v1/native/${provider.id}`,
      policies: row.policies, readiness: { ...row.readiness, executable, executableEndpoints: endpoints }, connectionTypes: connectionTypes(provider),
      routes: provider.endpoints.filter((endpoint) => endpoint.native_proxy && endpoints.includes(endpoint.id)).map((endpoint) => ({ endpoint: endpoint.id, methods: endpoint.methods, path: endpoint.path, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming, ...(view.websockets.includes(endpoint.id) ? { websocket: endpoint.websocket } : {}) })),
      models: view.models,
    }];
  });
  const fusion = rows.find((row) => row.provider === "clawrouter" && row.allowed);
  if (fusion) providers.unshift({
    id: "clawrouter",
    displayName: "ClawRouter Fusion",
    allowed: true,
    executable: fusion.readiness.executable,
    openaiCompatible: true,
    nativeBaseUrl: "/v1",
    policies: fusion.policies,
    readiness: fusion.readiness,
    connectionTypes: ["compound"],
    routes: [],
    models: fusion.readiness.executable ? [{ id: FUSION_MODEL_ID, upstream: FUSION_MODEL_ID, capabilities: ["llm.chat"], pricing_ref: null, pricing: null }] : [],
  });
  return privateJson({ version: "clawrouter.client-catalog.v1", providers });
}

export async function meResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (session) return privateJson(publicSession(session));
  const auth = await authenticateProxyKey(request.headers, env);
  if (auth instanceof Response) return auth;
  return privateJson({ authenticated: true, auth: "proxy_key", role: "user", email: auth.principalId, subject: null, tenantId: auth.policy.tenantId ?? "default", groups: [] });
}

interface EntitlementRow {
  provider: string;
  displayName: string;
  serviceKind: string;
  allowed: boolean;
  policies: string[];
  readiness: Readiness;
}

async function entitlementRows(session: AccessSession, env: Env): Promise<EntitlementRow[]> {
  return (await entitlementRowsForEntries(await sessionPolicies(session, env), session.tenantId, env)).rows;
}

async function entitlementRowsForEntries(entries: AccessPolicyEntry[], tenantId: string, env: Env): Promise<ClientEntitlements> {
  const connections = await listConnections(env, snapshot.providers.map((provider) => provider.id));
  const readiness = await providerReadinessForPolicies(env, entries, connections);
  const rows = snapshot.providers.map((provider) => {
    const policies = entries.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id))).map((entry) => entry.policyId);
    return { provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: policies.length > 0, policies, readiness: readiness.find((row) => row.id === provider.id)! };
  });
  const inventory = await clientInventory({ rows, entries, tenantId }, env, connections);
  const fusion = await fusionEntitlement(rows, inventory, env);
  return { rows: fusion ? [...rows, fusion] : rows, inventory };
}

async function fusionEntitlement(rows: EntitlementRow[], inventory: ClientInventory, env: Env): Promise<EntitlementRow | null> {
  const config = await loadFusionConfig(env);
  if (!config.enabled) return null;
  const aggregator = modelRoute(config.aggregatorModel, "llm.chat");
  const aggregatorAccess = aggregator ? rows.find((row) => row.provider === aggregator.provider.id) : undefined;
  const advisers = config.adviserModels.map((model) => modelRoute(model, "llm.chat")).filter((route): route is NonNullable<ReturnType<typeof modelRoute>> => !!route);
  const readyAdvisers = advisers.filter((route) => routeExecutable(route, inventory));
  const allowed = aggregatorAccess?.allowed === true;
  const executable = !!aggregator && routeExecutable(aggregator, inventory);
  const reasons = [
    ...(!allowed ? ["No active policy grants the configured fusion aggregator provider."] : []),
    ...(allowed && !executable ? ["The configured fusion aggregator is unavailable under the selected policy, provider budget, or grant."] : []),
    ...(readyAdvisers.length < advisers.length ? [`${readyAdvisers.length}/${advisers.length} advisers are currently executable; unavailable advisers fail open.`] : []),
  ];
  const readiness: Readiness = {
    id: "clawrouter",
    displayName: "ClawRouter Fusion",
    class: "virtual_router",
    serviceKind: "model_router",
    requiredConfig: [],
    optionalConfig: [],
    missingConfig: [],
    configPresent: true,
    connectionEnabled: true,
    oauthGrantRequired: false,
    oauthGrantCount: 0,
    upstreamGrantCount: aggregatorAccess?.readiness.upstreamGrantCount ?? 0,
    openaiCompatible: true,
    manifestRoutes: 1,
    executableEndpoints: executable ? ["chat_completions"] : [],
    modelCount: 1,
    executable,
    verified: executable && aggregatorAccess?.readiness.verified === true,
    lastCheckedAt: aggregatorAccess?.readiness.lastCheckedAt ?? null,
    latencyMs: aggregatorAccess?.readiness.latencyMs ?? null,
    status: executable ? "configured" : "unavailable",
    reasons,
  };
  return {
    provider: "clawrouter",
    displayName: "ClawRouter Fusion",
    serviceKind: "model_router",
    allowed,
    policies: aggregatorAccess?.policies ?? [],
    readiness,
  };
}

function routeExecutable(route: NonNullable<ReturnType<typeof modelRoute>>, inventory: ClientInventory): boolean {
  // Prefix-routed models may not have a static catalog row. Project the exact
  // configured route through the same selected-policy eligibility as that catalog.
  return inventory.get(route.provider.id)?.eligibleModels([route.model]).some(model => model.capabilities.includes("llm.chat")) === true;
}

type ClientInventory = Awaited<ReturnType<typeof clientInventory>>;
interface ClientEntitlements {
  rows: EntitlementRow[];
  inventory: ClientInventory;
}

async function clientEntitlements(request: Request, env: Env): Promise<ClientEntitlements | Response> {
  const hasKey = ["authorization", "x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.get(name)?.includes("clawrouter-") || request.headers.get(name)?.includes("ocpk_"));
  if (hasKey) {
    const auth = await authenticateProxyKey(request.headers, env);
    if (auth instanceof Response) return auth;
    const entries = [{ policyId: auth.policyId, policy: auth.policy }];
    return entitlementRowsForEntries(entries, auth.policy.tenantId ?? "default", env);
  }
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("client_auth_required", "a valid ClawRouter proxy key or Cloudflare Access session is required", 401);
  const entries = await sessionPolicies(session, env);
  return entitlementRowsForEntries(entries, session.tenantId, env);
}

export function catalogModels(provider: CompiledProvider, endpoints: string[], proxyPolicy: AccessPolicyEntry["policy"] | null, providerBudget: number | null = null, endpointPolicies?: Map<string, AccessPolicyEntry["policy"]>) {
  return provider.models.flatMap((model) => {
    const capabilities = executableCapabilities(provider, model.capabilities, endpoints).filter((capability) => {
      if (capability === "llm.count_tokens") return true; // Same zero-cost admission as reserveBudget.
      const endpoint = provider.capabilities.find((candidate) => candidate.id === capability)!.endpoint;
      const policy = endpointPolicies?.get(endpoint) ?? proxyPolicy;
      if (policy?.monthlyBudgetMicros === 0 || providerBudget === 0) return false;
      const requiresPricing = (policy?.monthlyBudgetMicros != null || providerBudget != null) && policy?.requestCostMicros == null;
      return !requiresPricing || model.pricing != null;
    });
    return capabilities.length ? [{ id: model.id, upstream: model.upstream, ...(model.codexModel ? { codexModel: model.codexModel } : {}), capabilities, ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}), pricing_ref: model.pricing_ref, pricing: model.pricing }] : [];
  });
}

async function clientInventory(entitlements: { rows: EntitlementRow[]; entries: AccessPolicyEntry[]; tenantId: string }, env: Env, connections: ProviderConnection[]) {
  const environment = new Map(providerReadinessFromState(env, [], connections, new Map()).map((row) => [row.id, row.executableEndpoints]));
  const views = await Promise.all(snapshot.providers.map(async (provider) => {
    const entries = entitlements.entries.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id)));
    const pools = await Promise.all(entries.map(async (entry) => ({ entry, ...await resolveGrantCandidates(provider.id, entry.policyId, entry.policy.tenantId ?? entitlements.tenantId, provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? provider.id, env, new Set(), entry.policy.grantRouting) })));
    const readiness = entitlements.rows.find((row) => row.provider === provider.id)!;
    const endpointPolicies = new Map<string, AccessPolicyEntry["policy"]>(), websockets: string[] = [];
    for (const endpoint of provider.endpoints) {
      if (!readiness.readiness.executableEndpoints.includes(endpoint.id)) continue;
      for (const mode of ["http", "websocket"] as const) {
        const requirement = { provider, endpoint, mode };
        // Match selectProviderPolicy independently per transport: an HTTP-only
        // subscription in the first policy must not mask another policy's WS grant.
        const selected = pools.find((pool) => pool.available.some(({ grant }) => grantSupports(requirement, grant))) ?? pools[0];
        if (!selected) continue;
        const grantAllowed = selected.available.some(({ grant }) => grantSupports(requirement, grant));
        const environmentAllowed = !selected.hasConfiguredGrant && (environment.get(provider.id) ?? []).includes(endpoint.id) && grantSupports(requirement, null);
        if (!grantAllowed && !environmentAllowed) continue;
        if (mode === "http") endpointPolicies.set(endpoint.id, selected.entry.policy);
        else websockets.push(endpoint.id);
      }
    }
    const endpoints = [...endpointPolicies.keys()];
    const eligibleModels = (models = provider.models) => catalogModels({ ...provider, models }, endpoints, null, connections.find((connection) => connection.providerId === provider.id)?.monthlyBudgetMicros ?? null, endpointPolicies).filter((model) => {
      // Native callers can supply path parameters even when a catalog model's default is absent.
      try { resolveTemplate(provider, model.upstream, env); return true; }
      catch (error) { if (error instanceof HttpError && error.code === "provider_not_configured") return false; throw error; }
    });
    return [provider.id, { endpoints, websockets, models: eligibleModels(), eligibleModels }] as const;
  }));
  return new Map(views);
}

async function retentionView(session: AccessSession, env: Env) {
  const enabledByPolicy = (await sessionPolicies(session, env)).some((entry) => entry.policy.retainRequestContent !== false);
  return { enabled: enabledByPolicy && !session.contentRetentionDisabled, retentionDays: 30, policyEnabled: enabledByPolicy, userExempt: session.contentRetentionDisabled, defaultEnabled: contentRetentionDefault(env) };
}

function executableCapabilities(provider: CompiledProvider, capabilities: string[], endpoints: string[]): string[] {
  return capabilities.filter((capability) => endpoints.includes(provider.capabilities.find((candidate) => candidate.id === capability)?.endpoint ?? ""));
}

function connectionTypes(provider: CompiledProvider): string[] {
  const types = new Set<string>();
  for (const scheme of provider.auth.schemes) {
    if (scheme.type === "oauth") { types.add("oauth"); types.add("subscription"); }
    else if (["bearer", "api_key", "query_api_key"].includes(scheme.type)) { types.add("api_key"); types.add("oauth"); types.add("subscription"); }
    else if (scheme.type === "sig_v4") types.add("api_key");
    else types.add("cloudflare_binding");
  }
  return [...types].sort();
}
