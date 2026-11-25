import type { ClientCatalog, ClientCatalogModel, ClientCatalogProvider } from "./contracts.ts";

// Deliberately open: upstream owns the versioned descriptor schema. Only the
// fields used for router restrictions are interpreted here.
export interface CodexModelInfo {
  [key: string]: unknown;
  slug: string;
  base_instructions?: string | null;
  model_messages?: { [key: string]: unknown; instructions_template?: string | null } | null;
  context_window?: number | null;
  max_context_window?: number | null;
  service_tiers?: { id: string; [key: string]: unknown }[];
  additional_speed_tiers?: string[];
  default_service_tier?: string | null;
  use_responses_lite?: boolean;
}
export interface CodexModelsResponse { [key: string]: unknown; models: CodexModelInfo[] }

// Native export owns prompts, tool contracts, and internal model references.
// The router only chooses reachable slugs and narrows advertised paid tiers.
export function buildCodexCatalog(catalog: ClientCatalog, bundled: CodexModelsResponse, providerId: string) {
  if (catalog.version !== "clawrouter.client-catalog.v1" || catalog.scope?.authType !== "proxy_key" || typeof catalog.scope.credentialId !== "string" || !catalog.scope.credentialId) throw new Error("Codex setup needs a key-scoped operation catalog; update the router and fetch with the issued key");
  const provider = catalog.providers?.find((item) => item.id === providerId && item.allowed === true);
  if (!provider) throw new Error("selected provider is not authorized");
  if (!Array.isArray(provider.offers)) throw new Error("router catalog lacks operation offers; update the router before Codex setup");
  if (provider.nativeBaseUrl !== `/v1/native/${providerId}` || !Array.isArray(provider.policies) || provider.policies.length !== 1 || typeof provider.policies[0] !== "string" || !provider.policies[0]) throw new Error("selected provider needs one key-scoped native policy");
  const offers = provider.offers.filter((offer) => offer.eligible === true && offer.routeKind === "native" && offer.policyId === provider.policies[0] && typeof offer.policyGeneration === "string" && offer.policyGeneration && ["exact-covered", "request-dependent"].includes(offer.affordability));
  const matching = (model: ClientCatalogModel, route: ClientCatalogProvider["routes"][number], transport: "http" | "websocket") => offers.filter((offer) => typeof model.id === "string" && model.id && offer.modelId === model.id && offer.endpoint === route.endpoint && offer.route === `${provider.nativeBaseUrl}${route.path}` && offer.transport === transport);
  const responses = provider.routes?.filter((route) => typeof route.endpoint === "string" && route.endpoint && typeof route.path === "string" && route.path.endsWith("/responses") && route.methods?.includes("POST") && route.requestFormat === "openai.responses" && route.responseFormat === "openai.responses" && route.streaming === "sse" && provider.models?.some((model) => model.capabilities?.includes("llm.responses") && matching(model, route, "http").length));
  if (responses?.length !== 1) throw new Error("selected provider needs one eligible native HTTP Responses route");
  const responseRoute = responses[0];
  if (!Array.isArray(bundled.models) || !bundled.models.length) throw new Error("native Codex export contains no models");
  const official = new Map(bundled.models.map((model) => [model.slug, model]));
  const models: CodexModelInfo[] = [], skipped: { model: string; reason: string }[] = [], mappings: { route: string; upstream: string; descriptor: string }[] = [], standaloneSearchModels: string[] = [], slugs = new Set<string>();
  let generation: string | undefined, supportsWebsockets = responseRoute.websocket === "openai.responses";
  for (const model of provider.models ?? []) {
    if (!model.capabilities?.includes("llm.responses")) continue;
    const http = matching(model, responseRoute, "http");
    if (!http.length) {
      skipped.push({ model: model.id, reason: "no eligible native HTTP Responses offer" });
      continue;
    }
    const upstream = model.upstream;
    const descriptor = official.get(model.codexModel ?? upstream);
    if (typeof upstream !== "string" || !upstream || upstream.includes("${") || !descriptor) {
      skipped.push({ model: model.id, reason: "no exact native Codex descriptor" });
      continue;
    }
    generation ??= http[0].policyGeneration;
    if (http.some((offer) => offer.policyGeneration !== generation)) throw new Error("native Responses offers disagree on the key policy generation; fetch a fresh catalog");
    // Codex enables WS for the entire provider/session, including internal
    // models. One route-wide or main-model offer cannot qualify that flag.
    supportsWebsockets &&= matching(model, responseRoute, "websocket").some((offer) => offer.policyGeneration === generation);
    if (!descriptor.model_messages?.instructions_template && !descriptor.base_instructions) throw new Error(`native descriptor for ${model.id} has no instructions`);
    if (slugs.has(upstream)) throw new Error(`duplicate native model route: ${upstream}`);
    slugs.add(upstream);
    const copy = structuredClone(descriptor);
    copy.slug = upstream;
    const context = descriptor.max_context_window ?? descriptor.context_window;
    const cards = (model.pricing && "serviceTiers" in model.pricing ? model.pricing.serviceTiers ?? [] : []).filter((card) => card.maxInputTokens == null || (typeof context === "number" && card.maxInputTokens >= context));
    const tiers = new Set(cards.flatMap((card) => [card.id, ...(card.aliases ?? [])]));
    copy.service_tiers = (copy.service_tiers ?? []).filter((tier) => tiers.has(tier.id) && http.every(offer => !offer.permittedServiceTiers || offer.permittedServiceTiers.includes(tier.id)));
    const advertised = new Set(copy.service_tiers.map((tier) => tier.id));
    copy.additional_speed_tiers = (copy.additional_speed_tiers ?? []).filter((tier) => advertised.has(tier === "fast" ? "priority" : tier));
    if (copy.default_service_tier != null && !advertised.has(copy.default_service_tier)) copy.default_service_tier = null;
    const searchRoutes = (provider.routes ?? []).filter(route => route.path === "/v1/alpha/search" && route.methods?.includes("POST") && route.requestFormat === "openai.standalone_search" && route.responseFormat === "openai.standalone_search" && !route.streaming);
    if (descriptor.use_responses_lite === true && model.capabilities?.includes("search.web") && searchRoutes.length === 1
      && matching(model, searchRoutes[0], "http").some(offer => offer.policyGeneration === generation)) standaloneSearchModels.push(upstream);
    models.push(copy);
    mappings.push({ route: model.id, upstream, descriptor: descriptor.slug });
  }
  if (!models.length) throw new Error("no authorized Responses model has exact native Codex metadata");
  return { catalog: { ...bundled, models }, skipped, mappings, supportsWebsockets, standaloneSearchModels, nativeBasePath: `${provider.nativeBaseUrl}${responseRoute.path.slice(0, -"/responses".length)}` };
}

