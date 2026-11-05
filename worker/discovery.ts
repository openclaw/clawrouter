import { qualifyMiniMaxEnvironmentBinding } from "./native-media-credential.ts";
import { isPublishedMusicInputSupport } from "../shared/native-capabilities.ts";
import { readPublishedInputOrigin } from "./published-input-receipt.ts";
import { manifestOnlyPublicCatalog } from "./public-model-discovery-formats.ts";
import { modelExecutable } from "../shared/route-catalog.ts";
import { fusionAdviserModels } from "../shared/fusion-strategy.ts";
import { nativeModelEligible, nativeModelEligibilityRevision } from "../shared/native-model-eligibility.ts";
import { assertSingleOpenAiAccount } from "./openai-public-account.ts";
import { assertSearchTariff, isStandaloneSearch } from "./standalone-search.ts";
import { allowedServiceTiers } from "../shared/service-tiers.ts";
import { policyAllowsModel } from "./policy-models.ts";
import type { CatalogOffer, ClientCatalog, ClientCatalogProvider, EntitlementsResponse, FusionConfig, SessionResponse } from "../shared/contracts";
import { fusionCatalogReadiness } from "./fusion-readiness";
import { concreteOpenAiSelection, isSelectionFailure, type ProxySelection } from "./proxy-selection";
import { resolveTemplate } from "./provider-templates.ts";
import { listConnections } from "./authority";
import { activeOperationCandidates, policyGrantCandidates, selectPolicyCandidates } from "./grant-selection";
import { assertOperationConfiguration, openRouterPcmModel, type GrantRequirement } from "./provider-auth";
import { budgetPrincipal } from "./budget-scope";
import { budgetStatus, providerBudgetStatus } from "./ledgers";
import { operationAffordability, type OperationAffordability } from "./operation-budget";
import { fetchTimeoutSignal } from "../shared/fetch-timeout.ts";
import { publicSession, sessionPolicies, sessionPolicyIdentity, verifiedAccessSession } from "./access";
import { contentRetentionDefault } from "./content-retention.ts";
import { loadFusionConfig } from "./fusion-config";
import { FUSION_MODEL_ID } from "./fusion";
import { authenticateProxyKey, proxyAdmission } from "./proxy-auth";
import { assertProviderAccess, listHealth, modelRoute, modelSupportsEndpoint, providerReadinessForState, snapshot, unifiedPathForEndpoint, type Readiness } from "./providers";
import type { AccessSession, AuthorizedIdentity, CompiledModel, CompiledProvider, Env } from "./types";
import { errorResponse, HttpError, privateJson, sha256Hex } from "./utils";
import { responsesControl } from "./responses-lifecycle.ts";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache } from "./hot-cache.ts";
import { coloGet, coloPut } from "./colo-cache.ts";
import { copilotPublicRecord, qualifiedPublicModel, type CopilotPublicDiscoveryView } from "./copilot-public-proxy.ts";

// Only compiled metadata lives across requests. Eligibility, health, balances
// and policy projections are always rebuilt from this request's observations.
function staticProviderProjection(provider: CompiledProvider) {
  const models = new Map(provider.models.map(model => {
    const display_name = `${provider.display_name} · ${model.id}`;
    const availability = model.availability ? { availability: structuredClone(model.availability) } : {};
    return [model.id, {
      openai: Object.freeze({ id: model.id, object: "model", owned_by: provider.id, display_name, ...availability }),
      anthropic: Object.freeze({ id: model.id, type: "model", display_name, ...availability, created_at: "1970-01-01T00:00:00Z", capabilities: null, max_input_tokens: model.pricing?.unit != null ? null : model.pricing?.maxInputTokens ?? null, max_tokens: model.pricing?.unit != null ? null : model.pricing?.defaultMaxOutputTokens ?? null }),
    }];
  }));
  const routes = new Map(provider.endpoints.map(endpoint => [endpoint.id, Object.freeze({ ...(endpoint.inputProfile ? { inputProfile: endpoint.inputProfile } : {}), endpoint: endpoint.id, methods: Object.freeze([...endpoint.methods]) as unknown as string[], path: endpoint.path, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming, ...(endpoint.requestPricing ? { requestPricing: structuredClone(endpoint.requestPricing) } : {}) })]));
  return { models, routes, connectionTypes: Object.freeze(connectionTypes(provider)) as unknown as string[] };
}
const compiledProjections = new WeakMap(snapshot.providers.map(provider => [provider, staticProviderProjection(provider)]));
function compiledProjection(provider: CompiledProvider) {
  let projection = compiledProjections.get(provider);
  if (!projection) { projection = staticProviderProjection(provider); compiledProjections.set(provider, projection); }
  return projection;
}

export async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  let entitlements: SessionResponse["entitlements"];
  let entitlementsError: string | undefined;
  try {
    const resolved = await sessionEntitlements(session, env);
    entitlements = { providers: resolved.rows, catalog: catalogProjection(resolved), policies: await sessionPolicyLimits(session, env) };
  }
  catch (error) { entitlementsError = error instanceof Error ? error.message : "entitlements unavailable"; }
  return privateJson({ ...publicSession(session), entitlements, entitlementsError, contentRetention: await retentionView(session, env) } satisfies SessionResponse);
}

export async function entitlementResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "entitlements require a verified Cloudflare Access session", 401);
  const resolved = await sessionEntitlements(session, env);
  return privateJson({ session: publicSession(session), providers: resolved.rows, catalog: catalogProjection(resolved), policies: await sessionPolicyLimits(session, env), contentRetention: await retentionView(session, env) } satisfies EntitlementsResponse);
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

export function modelsResponse(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const anthropic = request.headers.has("anthropic-version");
  if (new URL(request.url).searchParams.getAll("provider").includes("github-copilot")) {
    if (!context) return Promise.resolve(errorResponse("copilot_public_unavailable", "Discovery retirement owner required", 503));
    return import("./copilot-public-proxy.ts").then(({ proxyCopilotDiscovery }) => proxyCopilotDiscovery(request, env, context,
      view => copilotDiscoveryPieces(view, anthropic ? "models-anthropic" : "models")));
  }
  return discoveryResponse(request, env, anthropic ? "models-anthropic" : "models", entitlements => modelsBody(entitlements, anthropic));
}

function modelsBody(entitlements: ClientEntitlements, anthropic: boolean): unknown {
  const rows = entitlements.rows;
  const inventory = entitlements.inventory;
  if (anthropic) {
    const data = snapshot.providers.flatMap((provider) => (inventory.get(provider.id)?.models ?? []).filter((model) => model.capabilities.includes("llm.messages")).map((model) => compiledProjection(provider).models.get(model.id)?.anthropic ?? ({
      id: model.id, type: "model", display_name: `${provider.display_name} · ${model.id}`, created_at: "1970-01-01T00:00:00Z",
      capabilities: null, max_input_tokens: model.pricing?.unit != null ? null : model.pricing?.maxInputTokens ?? null, max_tokens: model.pricing?.unit != null ? null : model.pricing?.defaultMaxOutputTokens ?? null,
    })));
    return { data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null };
  }
  const data = snapshot.providers.flatMap((provider) => (inventory.get(provider.id)?.models ?? []).flatMap((model) => {
    const capabilities = model.capabilities;
    const compiled = compiledProjection(provider).models.get(model.id)?.openai;
    return capabilities.length ? [{ ...(compiled ?? { id: model.id, object: "model", owned_by: provider.id, display_name: `${provider.display_name} · ${model.id}` }), capabilities }] : [];
  }));
  const fusion = rows.find((row) => row.provider === "clawrouter");
  if (fusion?.allowed && fusion.readiness.executable) data.unshift({
    id: FUSION_MODEL_ID,
    object: "model",
    owned_by: "clawrouter",
    display_name: "ClawRouter · Fusion",
    capabilities: ["llm.chat"],
  });
  return { object: "list", data };
}

export function catalogResponse(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  if (new URL(request.url).searchParams.getAll("provider").includes("github-copilot")) {
    if (!context) return Promise.resolve(errorResponse("copilot_public_unavailable", "Discovery retirement owner required", 503));
    return import("./copilot-public-proxy.ts").then(({ proxyCopilotDiscovery }) => proxyCopilotDiscovery(request, env, context,
      view => copilotDiscoveryPieces(view, "catalog")));
  }
  return discoveryResponse(request, env, "catalog", catalogProjection);
}

// A compact observation filters only registered server metadata. Produce one
// closed record at a time in BOTH the counting and delivery passes; no second
// catalog graph, model/offer archive or serialized document is retained.
export function* copilotDiscoveryPieces(view: CopilotPublicDiscoveryView, variant: "catalog" | "models" | "models-anthropic"): Generator<string> {
  const { registry, observation, policy, connection } = view, provider = registry.provider;
  const auth = { ...view.auth, policy };
  const admitted = (index: number, api: number) => observation.permits(index, api)
    && qualifiedPublicModel(registry, provider.models[index], api, policy);
  const capability = (api: number) => ["llm.chat", "llm.responses", "llm.messages"][api];
  const affordable = (index: number, api: number) => operationAffordability(auth, connection, provider.models[index], capability(api), registry.endpoints[api], undefined, {}, provider.id);
  let count = 0, firstId: string | null = null, lastId: string | null = null;
  const executable = new Set<string>();
  for (let index = 0; index < provider.models.length; index++) {
    let visible = false;
    for (let api = 0; api < 3; api++) if (admitted(index, api) && affordable(index, api).status !== "exact-blocked") {
      executable.add(registry.endpoints[api].id);
      if (variant !== "models-anthropic" || api === 2) visible = true;
    }
    if (visible) { count++; firstId ??= provider.models[index].id; lastId = provider.models[index].id; }
  }
  if (variant !== "catalog") {
    yield variant === "models" ? '{"object":"list","data":[' : '{"data":[';
    let comma = false;
    for (let index = 0; index < provider.models.length; index++) {
      const model = provider.models[index], capabilities = [0, 1, 2].filter(api => (variant !== "models-anthropic" || api === 2)
        && admitted(index, api) && affordable(index, api).status !== "exact-blocked").map(capability);
      if (!capabilities.length) continue;
      if (comma) yield ","; comma = true;
      yield copilotPublicRecord(variant === "models" ? { id: model.id, object: "model", owned_by: provider.id, display_name: `${provider.display_name} · ${model.id}`, capabilities }
        : { id: model.id, type: "model", display_name: `${provider.display_name} · ${model.id}`, created_at: "1970-01-01T00:00:00Z", capabilities: null, max_input_tokens: null, max_tokens: null });
    }
    yield variant === "models" ? "]}" : '],"first_id":' + copilotPublicRecord(firstId) + ',"last_id":' + copilotPublicRecord(lastId) + ',"has_more":false}';
    return;
  }
  yield '{"version":"clawrouter.client-catalog.v1","observedAt":' + copilotPublicRecord(new Date(observation.observedAt).toISOString())
    + ',"scope":' + copilotPublicRecord({ authType: "proxy_key", credentialId: auth.credentialId, principalId: auth.principalId }) + ',"providers":[';
  const header = { id: provider.id, displayName: provider.display_name, allowed: true, executable: executable.size > 0,
    openaiCompatible: false, nativeBaseUrl: `/v1/native/${provider.id}`, policies: [auth.policyId], connectionTypes: ["oauth"],
    readiness: { id: provider.id, displayName: provider.display_name, class: provider.class, serviceKind: provider.service_kind,
      requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, oauthGrantRequired: true, oauthGrantCount: 1,
      upstreamGrantCount: 1, openaiCompatible: false, manifestRoutes: 3, modelCount: count, connectionEnabled: connection.enabled,
      executable: executable.size > 0, executableEndpoints: [...executable], verified: false, lastCheckedAt: null, latencyMs: null,
      status: executable.size ? "configured" : "unavailable", reasons: executable.size ? [] : ["No current model/API offer is executable."] } };
  yield copilotPublicRecord(header).slice(0, -1) + ',"routes":[';
  for (let api = 0; api < 3; api++) {
    if (api) yield ",";
    const endpoint = registry.endpoints[api];
    yield copilotPublicRecord({ endpoint: endpoint.id, methods: ["POST"], path: endpoint.path, requestFormat: endpoint.request_format,
      responseFormat: endpoint.response_format, streaming: endpoint.streaming });
  }
  yield '],"models":['; let comma = false;
  for (let index = 0; index < provider.models.length; index++) {
    const model = provider.models[index], capabilities = [0, 1, 2].filter(api => admitted(index, api)).map(capability);
    if (!capabilities.length) continue;
    if (comma) yield ","; comma = true;
    yield copilotPublicRecord({ id: model.id, upstream: model.upstream, capabilities, pricing_ref: null, pricing: null });
  }
  yield '],"offers":['; comma = false;
  for (let index = 0; index < provider.models.length; index++) for (let api = 0; api < 3; api++) {
    if (!admitted(index, api)) continue;
    const model = provider.models[index], endpoint = registry.endpoints[api], availability = affordable(index, api);
    if (comma) yield ","; comma = true;
    yield copilotPublicRecord({ endpoint: endpoint.id, modelId: model.id, transport: "http", policyId: auth.policyId,
      policyGeneration: policy.generation, routeKind: endpoint.native_proxy ? "native" : "manifest",
      route: endpoint.native_proxy ? `/v1/native/${provider.id}${endpoint.path}` : `/v1/proxy/${provider.id}/${endpoint.id}`,
      eligible: availability.status !== "exact-blocked", affordability: availability.status, ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {}) });
  }
  yield "]}]}";
}

// The compiler validates declarations; retain a fail-closed projection for
// unknown snapshot versions/tool values. Never infer from model names.
function supportsHostedSearch(provider: CompiledProvider, model: CompiledModel, endpointId: string): boolean {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === endpointId);
  const facts = model.nativeCapabilities?.endpoints[endpointId];
  return provider.id === "openai" && endpointId === "responses" && endpoint?.path === "/v1/responses"
    && endpoint.method === "POST" && endpoint.request_format === "openai.responses" && endpoint.response_format === "openai.responses"
    && model.capabilities.includes("llm.responses") && modelSupportsEndpoint(provider, model, endpoint)
    && model.nativeCapabilities?.version === "clawrouter.native-capabilities.v1"
    && Array.isArray(facts?.hostedTools) && facts.hostedTools.length === 1 && facts.hostedTools[0] === "web_search"
    && Array.isArray(facts.sources) && facts.sources.length > 0 && facts.sources.every(source => typeof source === "string" && source.startsWith("https://"))
    && typeof facts.checkedAt === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(facts.checkedAt);
}

function supportsPublishedMusicInput(provider: CompiledProvider, model: CompiledModel, endpointId: string): boolean {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === endpointId);
  const facts = model.nativeCapabilities?.endpoints[endpointId];
  const capabilities = provider.capabilities.filter(capability => capability.endpoint === endpointId);
  return isPublishedMusicInputSupport(facts?.publishedInput)
    && provider.id === "openrouter" && endpointId === "music_generate"
    && Object.values(provider.base_urls).length > 0 && Object.values(provider.base_urls).every(base => base === "https://openrouter.ai/api")
    && ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"].includes(model.upstream)
    && model.id === `openrouter/${model.upstream}` && model.availability?.status !== "upstream_alias"
    && model.capabilities.length === 1 && model.capabilities[0] === "music.generate"
    && capabilities.length === 1 && capabilities[0].id === "music.generate" && Array.isArray(capabilities[0].methods) && capabilities[0].methods.length === 1 && capabilities[0].methods[0] === "POST"
    && endpoint?.method === "POST" && Array.isArray(endpoint.methods) && endpoint.methods.length === 1 && endpoint.methods[0] === "POST" && endpoint.path === "/v1/chat/completions"
    && endpoint.request_format === "openai.chat_completions" && endpoint.response_format === "openai.chat_completions"
    && endpoint.streaming === "sse" && !endpoint.path_params.length && !Object.keys(endpoint.query).length
    && !endpoint.upstreamPath && !endpoint.websocket && !endpoint.lifecycle && !endpoint.responsesLifecycle
    && !endpoint.modelPassthrough && !endpoint.requestPricing && !endpoint.inputProfile
    && model.nativeCapabilities?.version === "clawrouter.native-capabilities.v1"
    && facts?.input?.length === 2 && facts.input.includes("text") && facts.input.includes("image");
}

function projectCatalogModel(provider: CompiledProvider, model: CompiledModel, capabilities: string[], visibleEndpoints: ReadonlySet<string>): CompiledModel {
  const { nativeCapabilities, requestParameters, ...base } = model;
  const nativeEndpoints = Object.fromEntries(Object.entries(nativeCapabilities?.endpoints ?? {}).filter(([id]) => visibleEndpoints.has(id)).map(([id, facts]) => {
    const { hostedTools, publishedInput, ...baseFacts } = facts;
    return [id, { ...baseFacts, ...(supportsPublishedMusicInput(provider, model, id) ? { publishedInput } : {}), ...(supportsHostedSearch(provider, model, id) ? { hostedTools: ["web_search" as const] } : {}) }];
  }));
  const parameters = Object.fromEntries(Object.entries(requestParameters ?? {}).filter(([id]) => visibleEndpoints.has(id)));
  return { ...base, capabilities,
    ...(nativeCapabilities && Object.keys(nativeEndpoints).length ? { nativeCapabilities: { version: nativeCapabilities.version, endpoints: nativeEndpoints } } : {}),
    ...(Object.keys(parameters).length ? { requestParameters: parameters } : {}),
  };
}

function catalogProjection(entitlements: ClientEntitlements, publicOrigin: string | null = null): ClientCatalog {
  const rows = entitlements.rows;
  const inventory = entitlements.inventory;
  // Route formats describe both native and manifest payloads. Only scoped
  // offers choose a callable route and convey caller eligibility.
  const providers: ClientCatalogProvider[] = rows.filter((row) => row.allowed && row.provider !== "clawrouter").flatMap((row) => {
    const provider = snapshot.providers.find((candidate) => candidate.id === row.provider);
    if (!provider) return [];
    const view = inventory.get(provider.id)!;
    if (!view.configured) return [];
    const endpoints = view.endpoints;
    const executable = view.offers.some((offer) => offer.eligible);
    return [{
      id: provider.id, displayName: provider.display_name, allowed: true, executable,
      openaiCompatible: executable && provider.class === "openai_compatible", nativeBaseUrl: `/v1/native/${provider.id}`,
      policies: row.policies, readiness: row.readiness, connectionTypes: compiledProjection(provider).connectionTypes,
      routes: provider.endpoints.filter((endpoint) => endpoints.includes(endpoint.id) || view.websockets.includes(endpoint.id)).map((endpoint) => ({ ...compiledProjection(provider).routes.get(endpoint.id)!, ...(view.websockets.includes(endpoint.id) ? { websocket: endpoint.websocket } : {}) })),
      models: view.models, offers: view.offers.map(offer => {
        const model = view.models.find(model => model.id === offer.modelId);
        return publicOrigin && offer.eligible && offer.transport === "http" && (offer.routeKind === "native" || offer.routeKind === "manifest")
          && model && supportsPublishedMusicInput(provider, model, offer.endpoint)
          ? { ...offer, publishedInputOrigin: { version: "clawrouter.published-input.v1" as const, origin: publicOrigin } } : offer;
      }),
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
    offers: entitlements.fusionOffers,
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
  const identities = (await sessionPolicies(session, env)).map((entry) => sessionPolicyIdentity(session, entry));
  return entitlementRowsForEntries(identities, env, { authType: "access", credentialId: null, principalId: session.email });
}

async function entitlementRowsForEntries(identities: AuthorizedIdentity[], env: Env, scope: ClientEntitlements["scope"]): Promise<ClientEntitlements> {
  const observedAt = new Date().toISOString();
  const [inventory, fusionConfig] = await Promise.all([clientInventory(identities, env), loadFusionConfig(env)]);
  const rows = snapshot.providers.map((provider) => {
    const policies = identities.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id))).map((entry) => entry.policyId);
    return { provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: policies.length > 0, policies, readiness: inventory.get(provider.id)!.readiness };
  });
  const fusion = fusionEntitlement(rows, inventory, env, fusionConfig);
  // Authentication still identifies the caller after the last policy is removed.
  return { rows: fusion ? [...rows, fusion.row] : rows, fusionOffers: fusion?.offers ?? [], inventory, observedAt, scope };
}

function fusionEntitlement(rows: EntitlementRow[], inventory: ClientInventory, env: Env, config: FusionConfig): { row: EntitlementRow; offers: CatalogOffer[] } | null {
  if (!config.enabled) return null;
  const aggregator = modelRoute(config.aggregatorModel, "llm.chat");
  const aggregatorAccess = aggregator ? rows.find((row) => row.provider === aggregator.provider.id) : undefined;
  const state = fusionCatalogReadiness(config, (body) => {
    const selection = concreteOpenAiSelection("/v1/chat/completions", body, env);
    return isSelectionFailure(selection) ? null : inventory.get(selection.provider.id)?.operation(selection) ?? null;
  });
  const allowed = aggregatorAccess?.allowed === true;
  const executable = state.offers.some((offer) => offer.eligible);
  const reasons = [
    ...(!allowed ? ["No active policy grants the configured fusion aggregator provider."] : []),
    ...(allowed && !executable ? ["The configured fusion aggregator is unavailable under the selected policy, provider budget, or grant."] : []),
    ...(state.readyAdviserCount < fusionAdviserModels(config).length ? [`${state.readyAdviserCount}/${fusionAdviserModels(config).length} advisers are currently executable; unavailable advisers fail open.`] : []),
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
    row: {
      provider: "clawrouter",
      displayName: "ClawRouter Fusion",
      serviceKind: "model_router",
      allowed,
      policies: state.synthesizer ? [state.synthesizer.auth.policyId] : [],
      readiness,
    },
    offers: state.offers,
  };
}

type ClientInventory = Awaited<ReturnType<typeof clientInventory>>;
interface ClientEntitlements {
  rows: EntitlementRow[];
  inventory: ClientInventory;
  fusionOffers: CatalogOffer[];
  observedAt: string;
  scope: Pick<AuthorizedIdentity, "authType" | "credentialId" | "principalId">;
}

const entitlementCache = registerHotCache(new HotCache<ClientEntitlements>(512));
const loads = new WeakMap<ClientEntitlements, { started: number; published: Set<string> }>();

// Proxy-key discovery. Authentication is re-checked per request; the derived
// inventory (health, grant eligibility, balances) is reused within the hot-cache
// bounds, and any change to the authorized identity or its policy is a new key.
// A cold isolate first adopts a sibling's rendered body from the same location:
// it is exactly what this caller receives, so it is secretless, unlike the
// inventory (selectors, grants). It keeps the load's start time and fence.
async function discoveryResponse(request: Request, env: Env, variant: string, render: (entitlements: ClientEntitlements, publicOrigin: string | null) => unknown): Promise<Response> {
  // Freeze the configured value once for both cache identity and projection.
  // Request/forwarded origins and publication response URLs cannot supply it.
  const publicOrigin = readPublishedInputOrigin(env.CLAWROUTER_PUBLIC_ORIGIN);
  const hasKey = ["authorization", "x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.get(name)?.includes("clawrouter-") || request.headers.get(name)?.includes("ocpk_"));
  if (!hasKey) {
    const session = await verifiedAccessSession(request, env);
    if (!session) return errorResponse("client_auth_required", "a valid ClawRouter proxy key or Cloudflare Access session is required", 401);
    return privateJson(render(await sessionEntitlements(session, env), publicOrigin));
  }
  const auth = await authenticateProxyKey(request.headers, env, snapshot.providers.map(provider => ({ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id })), true);
  if (auth instanceof Response) return auth;
  const mediaProvider = snapshot.providers.find(provider => provider.id === "minimax"
    && provider.endpoints.some(endpoint => ["minimax.speech", "minimax.music"].includes(endpoint.request_format))
    && (!auth.policy.providers.length || auth.policy.providers.includes(provider.id)));
  const mediaEnvironment = mediaProvider ? await qualifyMiniMaxEnvironmentBinding(mediaProvider, env) : null;
  // A rotated server key cannot reuse an eligible discovery body from either
  // isolate or colo caches. No credential bytes enter the cache identity.
  const musicEnvironment = mediaProvider ? await qualifyMiniMaxEnvironmentBinding(mediaProvider, env, "minimax.music") : null;
  const mediaRevision = mediaProvider ? [mediaEnvironment ? await sha256Hex(mediaEnvironment.binding) : null,
    musicEnvironment ? await sha256Hex(musicEnvironment.binding) : null] : [];
  const key = JSON.stringify([auth.credentialId, auth.principalId, auth.policyId, auth.serviceTiers ?? null, auth.contentRetentionDisabled, auth.policy, nativeModelEligibilityRevision(), ["clawrouter.published-input.v1", publicOrigin], ...mediaRevision]);
  const config = hotCacheConfig(env), shared = `${variant}\n${key}`;
  if (!entitlementCache.peek(key, config)) {
    const adopted = await coloGet<unknown>("discovery", shared, config);
    if (adopted) return privateJson(adopted.value);
  }
  const { value } = await entitlementCache.get(key, config, async () => {
    const started = hotCacheNow();
    const value = await entitlementRowsForEntries([auth], env, { authType: auth.authType, credentialId: auth.credentialId, principalId: auth.principalId });
    loads.set(value, { started, published: new Set() });
    return { value, cacheable: true };
  });
  const body = render(value, publicOrigin);
  // Each variant of a loaded inventory is published once, stamped with the
  // load's start, whichever request first renders it in this isolate.
  const load = loads.get(value);
  if (load && !load.published.has(variant)) { load.published.add(variant); coloPut("discovery", shared, body, load.started, config); }
  return privateJson(body);
}

async function clientInventory(identities: AuthorizedIdentity[], env: Env) {
  // Authentication and policy resolution have finished. These independent,
  // request-local observations must not serialize behind advisory KV health.
  const admission = identities.length === 1 ? proxyAdmission(identities[0]) : undefined;
  if (admission?.connectionsUnavailable) throw new Error("admission connection resolution failed");
  const [health, connections, providerPools] = await Promise.all([
    listHealth(env),
    admission ? Promise.resolve(admission.connections) : listConnections(env, snapshot.providers.map((provider) => provider.id)),
    Promise.all(snapshot.providers.map((provider) => {
      const entries = identities.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id)));
      return Promise.all(entries.map((entry) => policyGrantCandidates(entry, provider.id, env, provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? provider.id, undefined, proxyAdmission(entry)?.pools[provider.id])));
    })),
  ]);
  const policyBalances = new Map<string, ReturnType<typeof budgetStatus>>();
  const views = await Promise.all(snapshot.providers.map(async (provider, index) => {
    const pools = providerPools[index];
    const savedConnection = connections.find((connection) => connection.providerId === provider.id);
    const connection = savedConnection ?? { providerId: provider.id, enabled: true };
    if (provider.id === "github-copilot") {
      const readiness = providerReadinessForState(provider, env, [], connection, undefined, {
        executableEndpoints: [], executable: false, status: "unavailable", reasons: ["copilot_public_discovery_required"],
      });
      return [provider.id, { configured: false, endpoints: [], websockets: [], models: [], offers: [], readiness,
        operation: (_selection: ProxySelection) => null }] as const;
    }
    const keyScope = pools[0]?.entry.authType === "proxy_key";
    let configured = !!savedConnection || pools.some((pool) => pool.candidates.hasConfiguredGrant)
      || provider.config_keys.some((key) => typeof env[key] === "string" && (env[key] as string).trim());
    let providerBalance: ReturnType<typeof providerBudgetStatus> | undefined;
    // Group models by their ordered eligible policies, not policies by allowlist.
    // Each model gets one policy choice before affordability is observed.
    const grouped = new Map<string, { pools: typeof pools; modelIds: Set<string | null>; passthrough: boolean; modelRequirement?: string }>();
    for (const model of [...provider.models, null, undefined]) {
      const matching = model === undefined ? pools.filter(pool => pool.entry.policy.models == null) : model ? pools.filter(pool => policyAllowsModel(pool.entry.policy, provider.id, model.id)) : pools;
      // PCM key authority and Vertex model/location support depend on the
      // selected model even when multiple models share one endpoint.
      const modelRequirement = model && (provider.id === "anthropic-vertex" || provider.id === "minimax" && ["image-01", "music-2.6", "music-2.6-free"].includes(model.upstream) || openRouterPcmModel(provider, model.id)) ? model.id : undefined;
      const key = JSON.stringify([matching.map(pool => pool.entry.policyId), modelRequirement ?? null]);
      const group = grouped.get(key) ?? { pools: matching, modelIds: new Set<string | null>(), passthrough: false, modelRequirement };
      if (model === undefined) group.passthrough = true;
      else group.modelIds.add(model?.id ?? null);
      grouped.set(key, group);
    }
    const poolGroups = [...grouped.values()];
    const contexts = await Promise.all(provider.endpoints.filter((endpoint) => !responsesControl(provider, endpoint)).flatMap((endpoint) => (keyScope && endpoint.websocket ? ["http", "websocket"] as const : ["http"] as const).flatMap(mode => poolGroups.map(async group => {
      const requirement: GrantRequirement = { provider, endpoint, mode, model: group.modelRequirement };
      const candidates = endpoint.request_format === "cloudflare_ai_gateway.universal" ? group.pools.filter(pool => pool.entry.policy.models == null) : group.pools;
      const selected = selectPolicyCandidates(candidates, requirement);
      if (!selected) return null;
      const inspect = async (selection: NonNullable<typeof selected>) => {
        const auth = selection.entry;
        let reasonCode: string | undefined;
        let temporarilyUnavailable = false;
        try {
          await assertProviderAccess(provider, auth, env, connection);
          const available = activeOperationCandidates(selection.candidates.available, env, requirement);
          // Recovering candidates have already passed credential, scope and
          // stale-state checks. Requalify this exact operation's configuration;
          // the generic pool-unavailable reason alone cannot retain inventory.
          const configuredGrants = available.length ? available : activeOperationCandidates((selection.candidates.recovering ?? []).map(({ entry }) => entry), env, requirement);
          if (!available.length) {
            if (selection.candidates.hasConfiguredGrant) {
              if (!configuredGrants.length) throw new HttpError(503, "upstream_grant_pool_unavailable", "no scoped grant supports this operation");
              temporarilyUnavailable = true;
            } else {
              assertOperationConfiguration(requirement, null, env);
              if (endpoint.request_format === "minimax.speech" && !await qualifyMiniMaxEnvironmentBinding(provider, env))
                throw new HttpError(403, "native_media_authorization_required", "Global MiniMax speech requires matching original credential authorization");
              if (endpoint.request_format === "minimax.music" && !await qualifyMiniMaxEnvironmentBinding(provider, env, "minimax.music"))
                throw new HttpError(403, "minimax_music_authorization_required", "Global MiniMax music requires matching original credential authorization");
            }
          }
          if (endpoint.inputProfile !== undefined) {
            if (!keyScope) throw new HttpError(403, "managed_input_profile_required", "composed input is available only through its native authenticated route");
            await (await import("./pixverse-inputs.ts")).qualifyPixVerseInputCatalog(provider, endpoint, auth, env);
          }
          if (isStandaloneSearch(endpoint)) {
            assertSearchTariff(auth);
            await assertSingleOpenAiAccount(auth, env, { transport: null, grantKey: configuredGrants[0]?.key ?? null, grant: configuredGrants[0]?.grant ?? null }, "search");
          }
          configured = true;
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
          observation = { policyRemaining: policy.remainingMicros, dailyRemaining: policy.daily.remainingMicros, weeklyRemaining: policy.weekly.remainingMicros, providerRemaining: providerBudget?.remainingMicros ?? null };
        }
        return { endpoint, mode, auth, reasonCode, temporarilyUnavailable, observation, modelIds: group.modelIds, passthrough: group.passthrough };
      };
      const execution = await inspect(selected);
      // When every compatible pool is cooling, execution still falls back to
      // its original first policy. Inventory separately retains the ordered
      // owner that would be selected after a known recovery, never by budget.
      const inventoryOwner = !selected.candidates.available.length ? selectPolicyCandidates(candidates.map(pool => ({
        ...pool, candidates: { ...pool.candidates, available: [...pool.candidates.available, ...(pool.candidates.recovering ?? []).map(({ entry }) => entry)] },
      })), requirement) : selected;
      const inventory = inventoryOwner && inventoryOwner.entry !== selected.entry
        ? await inspect(selectPolicyCandidates(candidates.filter(pool => pool.entry === inventoryOwner.entry), requirement)!) : execution;
      return { execution, inventory };
    }))));
    const resolved = contexts.filter((context): context is NonNullable<typeof context> => context !== null);
    const effective = resolved.map(context => context.execution);
    // Recovery augments current identity; environment-backed execution has no
    // pooled candidates and must not be replaced by a blocked recovering owner.
    const inventoryContexts = resolved.flatMap(context => context.inventory === context.execution ? [context.execution] : [context.execution, context.inventory]);
    const contextHasModel = (context: typeof effective[number], model: CompiledModel | null) => context.modelIds.has(model?.id ?? null)
      || !!model && context.passthrough && !provider.models.some(candidate => candidate.id === model.id);
    const eligibility = (context: typeof effective[number], model: CompiledModel | null, capability: string, inventory = false) => {
      if (!nativeModelEligible(context.endpoint.request_format, model?.upstream)) return { status: "exact-blocked" as const, reasonCode: "model_capability_unsupported" };
      if (model && !modelExecutable(provider, model)) return { status: "exact-blocked" as const, reasonCode: "model_unavailable" };
      if (!contextHasModel(context, model)) return { status: "exact-blocked" as const, reasonCode: "model_not_allowed" };
      if (context.auth.policy.models != null && context.endpoint.request_format === "cloudflare_ai_gateway.universal") return { status: "exact-blocked" as const, reasonCode: "model_not_allowed" };
      if (model && !policyAllowsModel(context.auth.policy, provider.id, model.id)) return { status: "exact-blocked" as const, reasonCode: "model_not_allowed" };
      if (!model && context.auth.policy.models != null && (capability.startsWith("llm.") || context.endpoint.request_format === "cloudflare_ai_gateway.universal") && !provider.models.some(candidate => policyAllowsModel(context.auth.policy, provider.id, candidate.id))) return { status: "exact-blocked" as const, reasonCode: "model_not_allowed" };
      if (context.reasonCode) return { status: "exact-blocked" as const, reasonCode: context.reasonCode };
      if (context.temporarilyUnavailable && !inventory) return { status: "exact-blocked" as const, reasonCode: "upstream_grant_pool_unavailable" };
      if (model) {
        try { resolveTemplate(provider, model.upstream, env); }
        catch (error) { if (error instanceof HttpError) return { status: "exact-blocked" as const, reasonCode: error.code }; throw error; }
      }
      return operationAffordability(context.auth, connection, model, capability, context.endpoint, context.observation, {}, provider.id);
    };
    const models = provider.models.filter(model => modelExecutable(provider, model) && pools.some(pool => policyAllowsModel(pool.entry.policy, provider.id, model.id))).flatMap((model) => {
      const capabilities = model.capabilities.filter((capability) => inventoryContexts.some((context) => provider.capabilities.some((item) => item.id === capability && item.endpoint === context.endpoint.id) && eligibility(context, model, capability, true).status !== "exact-blocked"));
      if (!capabilities.length) return [];
      const visibleEndpoints = new Set(inventoryContexts.filter(context => modelSupportsEndpoint(provider, model, context.endpoint)
        && provider.capabilities.some(item => item.endpoint === context.endpoint.id && capabilities.includes(item.id))
        && eligibility(context, model, provider.capabilities.find(item => item.endpoint === context.endpoint.id)!.id, true).status !== "exact-blocked").map(context => context.endpoint.id));
      return [projectCatalogModel(provider, model, capabilities, visibleEndpoints)];
    });
    const inventoryEndpoints = { http: new Set<string>(), websocket: new Set<string>() };
    for (const context of inventoryContexts) {
      const { endpoint, mode } = context;
      const models = provider.models.filter(model => context.modelIds.has(model.id) && modelSupportsEndpoint(provider, model, endpoint));
      const capability = provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id;
      if ((mode === "websocket" ? models : [...models, null]).some(model => eligibility(context, model, capability, true).status !== "exact-blocked")) inventoryEndpoints[mode].add(endpoint.id);
    }
    const offers: CatalogOffer[] = effective.flatMap((context) => {
      const { endpoint, mode, auth } = context;
      const models = provider.models.filter((model) => context.modelIds.has(model.id) && modelSupportsEndpoint(provider, model, endpoint));
      const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
      const assessed = (mode === "websocket" ? models : [...models, null]).map((model) => ({ model, availability: eligibility(context, model, capability) }));
      const selectableModel = assessed.some(({ model, availability }) => model && availability.status !== "exact-blocked");
      return assessed.filter(({ model }) => context.modelIds.has(model?.id ?? null) && (!model || policyAllowsModel(auth.policy, provider.id, model.id))).flatMap(({ model, availability: resolved }) => {
        // A form can defer model selection without declaring a model-less
        // request priced. Selected models still use their own admission facts.
        const availability: OperationAffordability = !model && resolved.reasonCode === "pricing_required" && selectableModel ? { status: "request-dependent" } : resolved;
        const supportedTiers = model?.nativeCapabilities?.endpoints[endpoint.id]?.supportedServiceTiers;
        const permittedServiceTiers = supportedTiers?.filter(tier => availability.status !== "exact-blocked" && allowedServiceTiers(auth.policy, model!.id, auth.serviceTiers).includes(tier));
        const common = { ...(endpoint.inputProfile ? { inputProfile: endpoint.inputProfile } : {}), ...(endpoint.requestPricing ? { requestPricing: structuredClone(endpoint.requestPricing) } : {}), endpoint: endpoint.id, modelId: model?.id ?? null, transport: mode, policyId: auth.policyId, policyGeneration: auth.policy.generation, eligible: availability.status !== "exact-blocked", affordability: availability.status, ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {}), ...(permittedServiceTiers ? { permittedServiceTiers } : {}) };
        const nativeEnabled = endpoint.native_proxy && !manifestOnlyPublicCatalog(endpoint.request_format) && endpoint.request_format !== "featherless.catalog";
        const native: CatalogOffer = { ...common, routeKind: keyScope ? nativeEnabled ? "native" : "manifest" : "playground", route: keyScope && nativeEnabled ? `/v1/native/${provider.id}${endpoint.path}` : `/v1/${keyScope ? "" : "playground/"}proxy/${provider.id}/${endpoint.id}` };
        const unified = !manifestOnlyPublicCatalog(endpoint.request_format) && endpoint.request_format !== "featherless.catalog" && model && unifiedPathForEndpoint(provider, endpoint);
        let hostedToolAdmission: CatalogOffer["hostedToolAdmission"];
        if (keyScope && mode === "http" && common.eligible && model && unified === "/v1/responses" && supportsHostedSearch(provider, model, endpoint.id)) {
          const hosted = operationAffordability(auth, connection, model, capability, endpoint, context.observation, { tools: [{ type: "web_search" }] }, provider.id);
          if (hosted.status !== "exact-blocked" || hosted.reasonCode === "pricing_required") hostedToolAdmission = {
            version: "clawrouter.hosted-tool-admission.v1", web_search: hosted.reasonCode === "pricing_required" ? "pricing_required" : "admitted",
          };
        }
        return [...(mode === "http" || nativeEnabled ? [native] : []), ...(unified ? [{ ...common, ...(hostedToolAdmission ? { hostedToolAdmission } : {}), routeKind: "unified" as const, route: keyScope ? unified : `/v1/playground${unified}` }] : [])];
      });
    });
    const endpoints = [...new Set(offers.filter((offer) => offer.eligible && offer.transport === "http").map((offer) => offer.endpoint))];
    const websockets = [...new Set(offers.filter((offer) => offer.eligible && offer.transport === "websocket").map((offer) => offer.endpoint))];
    const grants = [...new Map(pools.flatMap(({ candidates }) => candidates.available.map(({ key, grant }) => [key, { key, grant }] as const))).values()];
    const executable = offers.some((offer) => offer.eligible);
    const readiness = providerReadinessForState(provider, env, grants, connection, health.get(provider.id), {
      executableEndpoints: [...new Set([...endpoints, ...websockets])], executable,
      status: !connection.enabled ? "disabled" : executable ? "configured" : configured ? "unavailable" : "unconfigured",
      reasons: [...new Set(offers.flatMap((offer) => offer.reasonCode ? [offer.reasonCode] : []))],
    });
    const operation = (selection: ProxySelection) => {
      const context = effective.find(context => context.mode === "http" && context.endpoint.id === selection.endpoint.id && !!selection.model && contextHasModel(context, selection.model));
      if (!context || !selection.model || Array.isArray(selection.body)) return null;
      return { ...context, providerId: provider.id, model: selection.model, body: selection.body, connection, availability: eligibility(context, selection.model, selection.capability) };
    };
    return [provider.id, { configured: !!configured, endpoints: [...inventoryEndpoints.http], websockets: [...inventoryEndpoints.websocket], models, operation, offers, readiness }] as const;
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

async function sessionPolicyLimits(session: AccessSession, env: Env) {
  return Promise.all((await sessionPolicies(session, env)).map(async ({ policyId, policy }) => ({ policyId, models: policy.models ?? null, serviceTiers: policy.serviceTiers ?? null, limitHint: policy.limitHint ?? null, dailyBudgetMicros: policy.dailyBudgetMicros ?? null, weeklyBudgetMicros: policy.weeklyBudgetMicros ?? null, budget: await budgetStatus(env, policyId, policy, policy.budgetScope === "principal" ? session.email : null) })));
}
