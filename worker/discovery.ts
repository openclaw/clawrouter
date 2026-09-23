import { resolveTemplate } from "./provider-templates.ts";
import { listConnections } from "./authority";
import { grantPriority, policyGrantCandidates, selectPolicyCandidates } from "./grant-selection";
import type { GrantRequirement } from "./provider-auth";
import { budgetPrincipal } from "./budget-scope";
import { budgetStatus, providerBudgetStatus } from "./ledgers";
import { operationAffordability } from "./operation-budget";
import { fetchTimeoutSignal } from "../shared/fetch-timeout.ts";
import { publicSession, sessionPolicies, sessionPolicyIdentity, verifiedAccessSession } from "./access";
import { contentRetentionDefault } from "./content-retention.ts";
import { loadFusionConfig } from "./fusion-config";
import { FUSION_MODEL_ID } from "./fusion";
import { authenticateProxyKey } from "./proxy-auth";
import { assertOperationConfiguration, assertProviderAccess, modelRoute, modelSupportsEndpoint, providerReadinessForState, snapshot, unifiedPathForEndpoint, type Readiness } from "./providers";
import type { AccessSession, AuthorizedIdentity, CompiledModel, CompiledProvider, Env, ProviderConnection } from "./types";
import { errorResponse, HttpError, privateJson, sha256Hex } from "./utils";

export async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  let entitlements: { providers: EntitlementRow[]; catalog: ReturnType<typeof catalogProjection> } | undefined;
  let entitlementsError: string | undefined;
  try {
    const resolved = await sessionEntitlements(session, env);
    entitlements = { providers: resolved.rows, catalog: catalogProjection(resolved) };
  }
  catch (error) { entitlementsError = error instanceof Error ? error.message : "entitlements unavailable"; }
  return privateJson({ ...publicSession(session), entitlements, entitlementsError, contentRetention: await retentionView(session, env) });
}

export async function entitlementResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "entitlements require a verified Cloudflare Access session", 401);
  const resolved = await sessionEntitlements(session, env);
  return privateJson({ session: publicSession(session), providers: resolved.rows, catalog: catalogProjection(resolved), contentRetention: await retentionView(session, env) });
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
  return entitlements instanceof Response ? entitlements : privateJson(catalogProjection(entitlements));
}

function catalogProjection(entitlements: ClientEntitlements) {
  const rows = entitlements.rows;
  const inventory = entitlements.inventory;
  const providers = rows.filter((row) => row.allowed && row.provider !== "clawrouter").flatMap((row) => {
    const provider = snapshot.providers.find((candidate) => candidate.id === row.provider);
    if (!provider) return [];
    const view = inventory.get(provider.id)!;
    if (!view.configured) return [];
    const endpoints = view.endpoints;
    const executable = view.offers.some((offer) => offer.eligible);
    return [{
      id: provider.id, displayName: provider.display_name, allowed: true, executable,
      openaiCompatible: executable && provider.class === "openai_compatible", nativeBaseUrl: entitlements.scope.authType === "proxy_key" ? `/v1/native/${provider.id}` : null,
      policies: row.policies, readiness: row.readiness, connectionTypes: connectionTypes(provider),
      routes: provider.endpoints.filter((endpoint) => endpoint.native_proxy && (endpoints.includes(endpoint.id) || view.websockets.includes(endpoint.id))).map((endpoint) => ({ endpoint: endpoint.id, methods: endpoint.methods, path: endpoint.path, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming, ...(view.websockets.includes(endpoint.id) ? { websocket: endpoint.websocket } : {}) })),
      models: view.models, offers: view.offers,
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
    offers: [],
    models: fusion.readiness.executable ? [{ id: FUSION_MODEL_ID, upstream: FUSION_MODEL_ID, capabilities: ["llm.chat"], pricing_ref: null, pricing: null }] : [],
  });
  return { version: "clawrouter.client-catalog.v1", observedAt: entitlements.observedAt, scope: entitlements.scope, providers };
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

async function sessionEntitlements(session: AccessSession, env: Env): Promise<ClientEntitlements> {
  return entitlementRowsForEntries((await sessionPolicies(session, env)).map((entry) => sessionPolicyIdentity(session, entry)), env);
}

async function entitlementRowsForEntries(identities: AuthorizedIdentity[], env: Env): Promise<ClientEntitlements> {
  const observedAt = new Date().toISOString();
  const connections = await listConnections(env, snapshot.providers.map((provider) => provider.id));
  const inventory = await clientInventory(identities, env, connections);
  const rows = snapshot.providers.map((provider) => {
    const policies = identities.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id))).map((entry) => entry.policyId);
    return { provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: policies.length > 0, policies, readiness: inventory.get(provider.id)!.readiness };
  });
  const fusion = await fusionEntitlement(rows, inventory, env);
  return { rows: fusion ? [...rows, fusion] : rows, inventory, observedAt, scope: { authType: identities[0]?.authType ?? "access", credentialId: identities[0]?.credentialId ?? null, principalId: identities[0]?.principalId ?? null } };
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
  observedAt: string;
  scope: Pick<AuthorizedIdentity, "authType" | "credentialId" | "principalId">;
}

async function clientEntitlements(request: Request, env: Env): Promise<ClientEntitlements | Response> {
  const hasKey = ["authorization", "x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.get(name)?.includes("clawrouter-") || request.headers.get(name)?.includes("ocpk_"));
  if (hasKey) {
    const auth = await authenticateProxyKey(request.headers, env);
    if (auth instanceof Response) return auth;
    return entitlementRowsForEntries([auth], env);
  }
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("client_auth_required", "a valid ClawRouter proxy key or Cloudflare Access session is required", 401);
  const entries = (await sessionPolicies(session, env)).map((entry) => sessionPolicyIdentity(session, entry));
  return entitlementRowsForEntries(entries, env);
}

interface CatalogOffer {
  endpoint: string;
  modelId: string | null;
  transport: "http" | "websocket";
  routeKind: "unified" | "native" | "manifest" | "playground";
  route: string;
  policyId: string;
  policyGeneration: string;
  eligible: boolean;
  affordability: "exact-covered" | "exact-blocked" | "request-dependent";
  reasonCode?: string;
}

async function clientInventory(identities: AuthorizedIdentity[], env: Env, connections: ProviderConnection[]) {
  const policyBalances = new Map<string, ReturnType<typeof budgetStatus>>();
  const views = await Promise.all(snapshot.providers.map(async (provider) => {
    const entries = identities.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id)));
    const pools = await Promise.all(entries.map((entry) => policyGrantCandidates(entry, provider.id, env, provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? provider.id)));
    const savedConnection = connections.find((connection) => connection.providerId === provider.id);
    const connection = savedConnection ?? { providerId: provider.id, enabled: true };
    const keyScope = entries[0]?.authType === "proxy_key";
    let configured = !!savedConnection || pools.some((pool) => pool.candidates.hasConfiguredGrant)
      || provider.config_keys.some((key) => typeof env[key] === "string" && (env[key] as string).trim());
    let providerBalance: ReturnType<typeof providerBudgetStatus> | undefined;
    const contexts = await Promise.all(provider.endpoints.flatMap((endpoint) => (keyScope && endpoint.websocket ? ["http", "websocket"] as const : ["http"] as const).map(async (mode) => {
      const requirement: GrantRequirement = { provider, endpoint, mode };
      const selected = selectPolicyCandidates(pools, requirement);
      if (!selected) return null;
      const auth = selected.entry;
      let reasonCode: string | undefined;
      try {
        await assertProviderAccess(provider, auth, env, connection);
        const available = selected.candidates.available;
        if (!available.length && selected.candidates.hasConfiguredGrant) throw new HttpError(503, "upstream_grant_pool_unavailable", "no scoped grant supports this operation");
        const priority = available.length ? Math.min(...available.map(({ grant }) => grantPriority(grant))) : null;
        const candidates = available.length ? available.filter(({ grant }) => grantPriority(grant) === priority).map(({ grant }) => grant) : [null];
        let failure: unknown;
        for (const grant of candidates) {
          try { assertOperationConfiguration(requirement, grant, env); failure = undefined; configured = true; break; }
          catch (error) { failure = error; }
        }
        if (failure) throw failure;
      } catch (error) {
        reasonCode = error instanceof HttpError ? error.code : "provider_not_configured";
      }
      let observation;
      if (!reasonCode) {
        // Request-local observations retain the selected identity. They never
        // participate in policy choice or authorize a later dispatch.
        if (!policyBalances.has(auth.policyId)) policyBalances.set(auth.policyId, budgetStatus(env, auth.policyId, auth.policy, budgetPrincipal(auth)));
        if (connection.monthlyBudgetMicros != null) providerBalance ??= providerBudgetStatus(env, provider.id, connection.monthlyBudgetMicros);
        const [policy, providerBudget] = await Promise.all([policyBalances.get(auth.policyId)!, providerBalance]);
        observation = { policyRemaining: policy.remainingMicros, providerRemaining: providerBudget?.remainingMicros ?? null };
      }
      return { endpoint, mode, auth, reasonCode, observation };
    })));
    const effective = contexts.filter((context): context is NonNullable<typeof context> => context !== null);
    const eligibility = (context: typeof effective[number], model: CompiledModel | null, capability: string) => {
      if (context.reasonCode) return { status: "exact-blocked" as const, reasonCode: context.reasonCode };
      if (model) {
        try { resolveTemplate(provider, model.upstream, env); }
        catch (error) { if (error instanceof HttpError) return { status: "exact-blocked" as const, reasonCode: error.code }; throw error; }
      }
      return operationAffordability(context.auth, connection, model, capability, context.endpoint.request_format, context.observation);
    };
    const eligibleModels = (models = provider.models) => models.flatMap((model) => {
      const capabilities = model.capabilities.filter((capability) => effective.some((context) => provider.capabilities.some((item) => item.id === capability && item.endpoint === context.endpoint.id) && eligibility(context, model, capability).status !== "exact-blocked"));
      return capabilities.length ? [{ ...model, capabilities }] : [];
    });
    const offers: CatalogOffer[] = effective.flatMap((context) => {
      const { endpoint, mode, auth } = context;
      const models = provider.models.filter((model) => modelSupportsEndpoint(provider, model, endpoint));
      const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
      return (mode === "websocket" ? models : [...models, null]).flatMap((model) => {
        const availability = eligibility(context, model, capability);
        const common = { endpoint: endpoint.id, modelId: model?.id ?? null, transport: mode, policyId: auth.policyId, policyGeneration: auth.policy.generation, eligible: availability.status !== "exact-blocked", affordability: availability.status, ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {}) };
        const native: CatalogOffer = { ...common, routeKind: keyScope ? endpoint.native_proxy ? "native" : "manifest" : "playground", route: keyScope && endpoint.native_proxy ? `/v1/native/${provider.id}${endpoint.path}` : `/v1/${keyScope ? "" : "playground/"}proxy/${provider.id}/${endpoint.id}` };
        const unified = model && unifiedPathForEndpoint(provider, endpoint);
        return [...(mode === "http" || endpoint.native_proxy ? [native] : []), ...(unified ? [{ ...common, routeKind: "unified" as const, route: keyScope ? unified : `/v1/playground${unified}` }] : [])];
      });
    });
    const endpoints = [...new Set(offers.filter((offer) => offer.eligible && offer.transport === "http").map((offer) => offer.endpoint))];
    const websockets = [...new Set(offers.filter((offer) => offer.eligible && offer.transport === "websocket").map((offer) => offer.endpoint))];
    const grants = [...new Map(pools.flatMap(({ candidates }) => candidates.available.map(({ key, grant }) => [key, { key, grant }] as const))).values()];
    const executable = offers.some((offer) => offer.eligible);
    const readiness = { ...providerReadinessForState(provider, env, grants, connection), executableEndpoints: [...new Set([...endpoints, ...websockets])], executable, status: !connection.enabled ? "disabled" : executable ? "configured" : configured ? "unavailable" : "unconfigured", reasons: [...new Set(offers.flatMap((offer) => offer.reasonCode ? [offer.reasonCode] : []))] };
    return [provider.id, { configured: !!configured, endpoints, websockets, models: eligibleModels(), eligibleModels, offers, readiness }] as const;
  }));
  return new Map(views);
}


async function retentionView(session: AccessSession, env: Env) {
  const enabledByPolicy = (await sessionPolicies(session, env)).some((entry) => entry.policy.retainRequestContent !== false);
  return { enabled: enabledByPolicy && !session.contentRetentionDisabled, retentionDays: 30, policyEnabled: enabledByPolicy, userExempt: session.contentRetentionDisabled, defaultEnabled: contentRetentionDefault(env) };
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
