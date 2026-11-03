import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Validator } from "@cfworker/json-schema";
import { parse } from "yaml";

const optionalRateFields = ["cachedInputMicrosPerMillion", "cacheWriteInputMicrosPerMillion", "cacheWrite5mInputMicrosPerMillion", "cacheWrite1hInputMicrosPerMillion"];
const decisionContracts = new Map([
  ["baseten-systemone", { provider: "baseten", format: "baseten.systemone" }],
  ["openai-decisions", { provider: "openai", format: "openai.decisions" }],
  ["levanto-sage", { provider: "levanto", format: "levanto.sage" }],
  ["liquid-ai-systemone", { provider: "liquid-ai", format: "liquid.systemone" }],
  ["typesafe-systemone", { provider: "typesafe", format: "typesafe.systemone" }],
  ["subq-decisions", { provider: "subq", format: "subq.decisions" }],
]);
const manifestSchema = JSON.parse(readFileSync(new URL("../providers/_schema/service-provider.schema.json", import.meta.url), "utf8"));
const manifestValidator = new Validator(manifestSchema, "2020-12");


export function compileProviderSnapshot(manifests) {
  const ids = new Set();
  const providers = manifests.map((manifest) => compileProvider(manifest, ids));
  const capability_index = {};
  const model_index = {};
  for (const provider of providers) {
    for (const capability of provider.capabilities) {
      (capability_index[capability.id] ??= []).push({
        provider: provider.id,
        endpoint: capability.endpoint,
        methods: capability.methods,
      });
    }
    for (const model of provider.models) {
      if (model_index[model.id]) throw new Error(`duplicate model id ${model.id}`);
      model_index[model.id] = {
        provider: provider.id,
        upstream: model.upstream,
        capabilities: model.capabilities,
        ...(model.availability ? { availability: structuredClone(model.availability) } : {}),
        ...(model.codexModel ? { codexModel: model.codexModel } : {}),
        ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
        ...(model.requestParameters ? { requestParameters: model.requestParameters } : {}),
        ...(model.nativeCapabilities ? { nativeCapabilities: model.nativeCapabilities } : {}),
        ...(model.endpointPricing ? { endpointPricing: model.endpointPricing } : {}),
        pricing_ref: model.pricing_ref,
        pricing: model.pricing,
      };
    }
  }
  return { version: "clawrouter.provider-snapshot.v1", providers, capability_index, model_index };
}

function compileProvider(manifest, ids) {
  validateManifest(manifest);
  if (ids.has(manifest.id)) throw new Error(`duplicate provider id ${manifest.id}`);
  ids.add(manifest.id);
  const capabilities = (manifest.capabilities ?? []).map((capability) => ({
    id: capability.id,
    endpoint: capability.endpoint,
    methods: capability.methods?.length ? capability.methods : [manifest.endpoints[capability.endpoint]?.method ?? "POST"],
  }));
  const endpoints = Object.entries(manifest.endpoints).sort(([a], [b]) => a.localeCompare(b)).map(([id, endpoint]) => ({
    id,
    method: endpoint.method ?? "POST",
    methods: unique([endpoint.method ?? "POST", ...capabilities.filter((item) => item.endpoint === id).flatMap((item) => item.methods)]),
    path: endpoint.path,
    ...(endpoint.upstreamPath ? { upstreamPath: endpoint.upstreamPath } : {}),
    native_proxy: endpoint.nativeProxy ?? true,
    auth: endpoint.auth ?? null,
    headers: endpoint.headers ?? {},
    request_headers: endpoint.requestHeaders ?? [],
    response_headers: endpoint.responseHeaders ?? [],
    query: endpoint.query ?? {},
    path_params: endpoint.pathParams ?? [],
    path_param_styles: endpoint.pathParamStyles ?? {},
    request_format: endpoint.requestFormat,
    response_format: endpoint.responseFormat,
    streaming: endpoint.streaming ?? null,
    ...(endpoint.responsesLifecycle ? { responsesLifecycle: endpoint.responsesLifecycle } : {}),
    ...(endpoint.lifecycle ? { lifecycle: structuredClone(endpoint.lifecycle) } : {}),
    ...(endpoint.outputTokenLimit ? { outputTokenLimit: endpoint.outputTokenLimit } : {}),
    ...(endpoint.requestPricing ? { requestPricing: structuredClone(endpoint.requestPricing) } : {}),
    ...(endpoint.toolPricing ? { toolPricing: structuredClone(endpoint.toolPricing) } : {}),
    ...(endpoint.modelPassthrough ? { modelPassthrough: {
      pricing_ref: endpoint.modelPassthrough.pricingRef ?? null,
      pricing: endpoint.modelPassthrough.pricingRef ? normalizePricing(manifest.models.entries.find((model) => model.pricingRef === endpoint.modelPassthrough.pricingRef).pricing) : null,
    } } : {}),
    ...(endpoint.websocket ? { websocket: endpoint.websocket } : {}),
    timeout_ms: endpoint.timeoutMs ?? null,
  }));
  const auth = {
    schemes: (manifest.auth.schemes ?? []).map(normalizeAuthScheme),
    authorization: normalizeAuthorization(manifest.auth.authorization),
    refresh: normalizeRefresh(manifest.auth.refresh),
    grantTransports: Object.fromEntries(Object.entries(manifest.auth.grantTransports ?? {}).map(([kind, transport]) => [kind, normalizeGrantTransport(transport)])),
  };
  const routing = {
    nativePrefixes: manifest.routing?.nativePrefixes ?? [],
    modelPrefixes: manifest.routing?.modelPrefixes ?? [],
    baseUrlParam: manifest.routing?.baseUrlParam ?? null,
    serviceParam: manifest.routing?.serviceParam ?? null,
  };
  const adapter = {
    request: manifest.adapter?.request ?? null,
    response: manifest.adapter?.response ?? null,
    stream: manifest.adapter?.stream ?? null,
    error: manifest.adapter?.error ?? null,
    passthroughHeaders: manifest.adapter?.passthroughHeaders ?? [],
    injectHeaders: manifest.adapter?.injectHeaders ?? {},
    injectQuery: manifest.adapter?.injectQuery ?? {},
    requestTransforms: {
      renameFields: (manifest.adapter?.requestTransforms?.renameFields ?? []).map((rename) => ({
        from: rename.from,
        to: rename.to,
        paths: rename.paths ?? [],
        upstreams: rename.upstreams ?? [],
        upstreamConfig: rename.upstreamConfig ?? null,
      })),
    },
  };
  const models = (manifest.models?.entries ?? []).map((model) => ({
    id: model.id,
    upstream: model.upstream,
    capabilities: model.capabilities ?? [],
    ...(model.availability ? { availability: structuredClone(model.availability) } : {}),
    ...(model.codexModel ? { codexModel: model.codexModel } : {}),
    ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
    ...(model.requestParameters ? { requestParameters: model.requestParameters } : {}),
    ...(model.nativeCapabilities ? { nativeCapabilities: model.nativeCapabilities } : {}),
    ...(model.endpointPricing ? { endpointPricing: Object.fromEntries(Object.entries(model.endpointPricing).map(([id, card]) => [id, { pricing_ref: card.pricingRef, pricing: card.pricing === null ? null : normalizePricing(card.pricing) }])) } : {}),
    pricing_ref: model.pricingRef ?? null,
    pricing: model.pricing ? normalizePricing(model.pricing) : null,
  }));
  const billing = {
    meter: manifest.billing?.meter ?? null,
    dimensions: manifest.billing?.dimensions ?? [],
    counters: manifest.billing?.counters ?? [],
  };
  const quota = normalizeQuota(manifest.quota);
  return {
    id: manifest.id,
    display_name: manifest.displayName,
    status: manifest.status ?? "stable",
    class: manifest.class ?? "openai_compatible",
    service_platform: manifest.service?.platform ?? manifest.id,
    service_kind: manifest.service?.kind ?? "api_provider",
    config_keys: manifest.service?.configKeys ?? [],
    optional_config_keys: manifest.service?.optionalConfigKeys ?? [],
    auth,
    auth_schemes: auth.schemes.map(authSchemeId),
    base_urls: manifest.baseUrls,
    routing,
    native_prefixes: routing.nativePrefixes,
    adapter,
    capabilities,
    endpoints,
    models,
    billing,
    meter: billing.meter,
    quota,
  };
}

function normalizeQuota(value) {
  const fallback = [
    { id: "requests", kind: "requests", limitHeaders: ["ratelimit-limit-requests", "x-ratelimit-limit-requests"], remainingHeaders: ["ratelimit-remaining-requests", "x-ratelimit-remaining-requests"], resetHeaders: ["ratelimit-reset-requests", "x-ratelimit-reset-requests"] },
    { id: "tokens", kind: "tokens", limitHeaders: ["ratelimit-limit-tokens", "x-ratelimit-limit-tokens"], remainingHeaders: ["ratelimit-remaining-tokens", "x-ratelimit-remaining-tokens"], resetHeaders: ["ratelimit-reset-tokens", "x-ratelimit-reset-tokens"] },
    { id: "generic", kind: "generic", limitHeaders: ["ratelimit-limit", "x-ratelimit-limit"], remainingHeaders: ["ratelimit-remaining", "x-ratelimit-remaining"], resetHeaders: ["ratelimit-reset", "x-ratelimit-reset"] },
  ];
  return {
    responseHeaders: (value?.responseHeaders ?? fallback).map((window) => normalizeQuotaWindow(window, false)),
    probes: (value?.probes ?? []).map((probe) => ({
      grantKinds: probe.grantKinds ?? [],
      requiresRefreshToken: probe.requiresRefreshToken === true,
      url: probe.url,
      method: probe.method ?? "GET",
      headers: probe.headers ?? {},
      ...(probe.facts ? { facts: probe.facts } : {}),
      windows: (probe.windows ?? []).map((window) => normalizeQuotaWindow(window, true)),
    })),
  };
}

function normalizeQuotaWindow(window, probe) {
  const shared = { id: window.id, kind: window.kind, unit: window.unit ?? null, window: window.window ?? null, fixedLimit: window.fixedLimit ?? null, metricScale: window.metricScale ?? 1 };
  return probe ? {
    ...shared,
    ...(window.models ? { models: window.models } : {}),
    ...(window.collection ? { collection: window.collection } : {}),
    limitPointer: window.limitPointer ?? null,
    remainingPointer: window.remainingPointer ?? null,
    usedPointer: window.usedPointer ?? null,
    resetPointer: window.resetPointer ?? null,
  } : {
    ...shared,
    limitHeaders: window.limitHeaders ?? [],
    remainingHeaders: window.remainingHeaders ?? [],
    usedHeaders: window.usedHeaders ?? [],
    resetHeaders: window.resetHeaders ?? [],
  };
}

function normalizePricing(pricing) {
  if (pricing.unit === "image_token") return structuredClone(pricing);
  if (pricing.unit === "character") return { unit: pricing.unit, effectiveAt: pricing.effectiveAt, source: pricing.source, inputMicrosPerMillionCharacters: pricing.inputMicrosPerMillionCharacters, maxInputCharacters: pricing.maxInputCharacters };
  return {
    effectiveAt: pricing.effectiveAt,
    ...(pricing.checkedAt ? { checkedAt: pricing.checkedAt } : {}),
    source: pricing.source,
    ...normalizeRates(pricing),
    maxInputTokens: pricing.maxInputTokens,
    maxRequestInputTokens: pricing.maxRequestInputTokens ?? null,
    defaultMaxOutputTokens: pricing.defaultMaxOutputTokens,
    inputTokenOverhead: pricing.inputTokenOverhead ?? 1024,
    ...(pricing.unpricedCosts ? { unpricedCosts: pricing.unpricedCosts } : {}),
    ...(pricing.settlementBasis ? { settlementBasis: pricing.settlementBasis } : {}),
    ...(pricing.autoServiceTier ? { autoServiceTier: pricing.autoServiceTier } : {}),
    ...(pricing.anthropicModifiers ? { anthropicModifiers: structuredClone(pricing.anthropicModifiers) } : {}),
    longContext: normalizeLongContext(pricing.longContext),
    ...(pricing.serviceTiers ? { serviceTiers: pricing.serviceTiers.map((tier) => ({ id: tier.id, aliases: tier.aliases ?? [], ...normalizeRates(tier), maxInputTokens: tier.maxInputTokens ?? null, longContext: normalizeLongContext(tier.longContext) })) } : {}),
  };
}

function normalizeRates(value) {
  return { inputMicrosPerMillion: value.inputMicrosPerMillion, outputMicrosPerMillion: value.outputMicrosPerMillion, ...Object.fromEntries(optionalRateFields.map((field) => [field, value[field] ?? null])) };
}

function normalizeLongContext(value) {
  return value ? { thresholdInputTokens: value.thresholdInputTokens, ...normalizeRates(value) } : null;
}

function validatePricing(pricing, modelId) {
  if (!pricing) return;
  if (pricing.unit === "image_token") {
    const g = pricing.generation, b = g.outputTokenBound;
    const maxFactor = Math.max(...Object.values(b.qualityFactors));
    const output = Math.ceil(maxFactor * maxFactor * (b.basePixels + g.maxPixels) / b.divisor) * g.maxImages;
    const input = (g.maxPromptCharacters * 4 + 1024) * g.maxImages;
    if (g.minPixels > g.maxPixels || g.maxEdge % g.dimensionMultiple || !Number.isSafeInteger(output * pricing.imageOutputMicrosPerMillion + input * pricing.textInputMicrosPerMillion)) throw new Error("image pricing has an invalid reservation envelope");
    return;
  }
  if (pricing.longContext && pricing.longContext.thresholdInputTokens >= pricing.maxInputTokens) throw new Error(`model ${modelId} has an invalid long-context threshold`);
  if (pricing.autoServiceTier && !pricing.serviceTiers?.length) throw new Error(`model ${modelId} autoServiceTier requires explicit service-tier cards`);
  if (pricing.serviceTiers === undefined) return;
  const tiers = pricing.serviceTiers;
  const fail = (message) => { throw new Error(`model ${modelId} serviceTiers ${message}`); };
  const ids = new Set();
  for (const tier of tiers) {
    for (const id of [tier.id, ...(tier.aliases ?? [])]) {
      if (id === "auto" || ids.has(id)) fail("ids and aliases must be unique bounded wire values other than auto");
      ids.add(id);
    }
    if (tier.maxInputTokens != null && tier.maxInputTokens > pricing.maxInputTokens) fail("has an invalid input limit");
    if (tier.longContext && tier.longContext.thresholdInputTokens >= (tier.maxInputTokens ?? pricing.maxInputTokens)) fail("has an invalid long-context threshold");
  }
  const standard = tiers.find((tier) => tier.id === "default");
  if (!standard || standard.maxInputTokens != null || JSON.stringify(normalizeRates(standard)) !== JSON.stringify(normalizeRates(pricing)) || JSON.stringify(normalizeLongContext(standard.longContext)) !== JSON.stringify(normalizeLongContext(pricing.longContext))) fail("default card must match the canonical model rates and context");
}

function validateManifest(manifest) {
  // Validate before normalization so defaults cannot hide a malformed manifest.
  // Cross-field references below remain semantic checks on this canonical shape.
  const validation = manifestValidator.validate(manifest);
  if (!validation.valid) throw new Error(`provider ${manifest?.id ?? "?"} invalid manifest: ${validation.errors.map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`).join("; ")}`);
  if (!manifest.baseUrls?.default) throw new Error(`provider ${manifest.id} is missing baseUrls.default`);
  validateBasetenSystemOne(manifest);
  validateGradiumSpeech(manifest);
  validateDeepSeekSearch(manifest);
  validateDeepgramPrerecorded(manifest);
  validateOpenRouterTranscription(manifest);
  validateGroqMistralTranscription(manifest);
  validateGoogleEmbeddings(manifest);
  validateBedrockEmbeddings(manifest);
  validateGoogleUnaryMedia(manifest, "image", "image.generate", ["gemini-3.1-flash-image", "gemini-3-pro-image"]);
  validateGoogleUnaryMedia(manifest, "music", "audio.generate", ["lyria-3-clip-preview", "lyria-3-pro-preview"]);
  validateGoogleSpeech(manifest);
  validateGoogleGroundedSearch(manifest);
  validateGoogleUnderstanding(manifest);
  validateXaiImages(manifest);
  validateNativeModels(manifest, "baseten", "https://inference.baseten.co/v1");
  validateNativeModels(manifest, "arcee", "https://api.arcee.ai/api/v1");
  validateNativeModels(manifest, "chutes", "https://llm.chutes.ai/v1");
  validateNativeModels(manifest, "featherless", "https://api.featherless.ai/v1");
  validateNativeModels(manifest, "venice", "https://api.venice.ai/api/v1");
  validateNativeModels(manifest, "novita", "https://api.novita.ai/openai/v1");
  validateSyntheticModels(manifest);
  const configKeys = new Set(manifest.service?.configKeys ?? []);
  for (const key of manifest.service?.optionalConfigKeys ?? []) if (!configKeys.has(key)) throw new Error(`provider ${manifest.id} optional config key ${key} is not declared in configKeys`);
  for (const capability of manifest.capabilities) {
    if (!Object.hasOwn(manifest.endpoints, capability.endpoint)) throw new Error(`provider ${manifest.id} capability ${capability.id} references missing endpoint ${capability.endpoint}`);
  }
  validateModels(manifest);
  validateManagedLifecycles(manifest);
  validateEndpoints(manifest);
  validateGrantTransports(manifest);
  validateQuota(manifest.id, manifest.quota);
}

function validateModels(manifest) {
  const stopped = new Set((manifest.models?.entries ?? []).filter(model => model.availability?.status === "stopped").map(model => model.upstream));
  for (const model of manifest.models?.entries ?? []) {
    validateModelAvailability(model);
    if (model.capabilities?.length && stopped.has(model.upstream)) throw new Error(`model ${model.id} availability stopped upstream cannot be exposed through another model identity`);
    for (const capability of model.capabilities ?? []) if (!manifest.capabilities.some((item) => item.id === capability)) throw new Error(`provider ${manifest.id} model ${model.id} references missing capability ${capability}`);
    if (model.codexModel !== undefined && (typeof model.codexModel !== "string" || !model.codexModel.trim())) throw new Error(`model ${model.id} codexModel must be a nonempty exact native slug`);
    for (const [id, parameters] of Object.entries(model.requestParameters ?? {})) {
      const endpoint = Object.hasOwn(manifest.endpoints, id) ? manifest.endpoints[id] : null;
      if (!endpoint || !manifest.capabilities.some((capability) => capability.endpoint === id && model.capabilities?.includes(capability.id))) throw new Error(`model ${model.id} requestParameters must reference a supported endpoint`);
      if (!["openai.chat_completions", "openai.responses"].includes(endpoint.requestFormat)) throw new Error(`model ${model.id} requestParameters requires an OpenAI Chat or Responses wire format`);
      if (parameters.defaultReasoningEffort !== undefined && !model.supportedReasoningEfforts?.includes(parameters.defaultReasoningEffort)) throw new Error(`model ${model.id} requestParameters default effort must belong to supportedReasoningEfforts`);
    }
    if ([model.pricing, ...Object.values(model.endpointPricing ?? {}).map(card => card.pricing)].some(pricing => pricing?.anthropicModifiers)) {
      if (manifest.id !== "anthropic" || !manifest.capabilities.some(capability => model.capabilities?.includes(capability.id) && manifest.endpoints[capability.endpoint]?.requestFormat === "anthropic.messages" && manifest.endpoints[capability.endpoint]?.responseFormat === "anthropic.messages")) throw new Error(`model ${model.id} anthropicModifiers requires first-party Anthropic Messages`);
    }
    validatePricing(model.pricing, model.id);
    if (model.capabilities?.includes("image.generation") && model.pricing?.unit !== "image_token") throw new Error("image generation requires a qualified image pricing contract");
    if (model.pricing?.unit === "image_token" && (!model.capabilities?.length || model.capabilities.some((id) => {
      const endpoint = manifest.endpoints[manifest.capabilities.find((capability) => capability.id === id)?.endpoint];
      return id !== "image.generation" || endpoint?.requestFormat !== "openai.images_generations" || endpoint.responseFormat !== "openai.images_generations" || endpoint.streaming;
    }))) throw new Error("image pricing requires the JSON image generation contract");
    for (const [id, card] of Object.entries(model.endpointPricing ?? {})) {
      if (!Object.hasOwn(manifest.endpoints, id) || !manifest.capabilities.some(capability => capability.endpoint === id && model.capabilities?.includes(capability.id))) throw new Error(`model ${model.id} endpointPricing must reference a supported endpoint`);
      validatePricing(card.pricing, `${model.id}/${id}`);
    }
    if (model.pricing?.unit === "character" && (!model.capabilities?.length || model.capabilities.some((id) => {
      const endpoint = manifest.endpoints[manifest.capabilities.find((capability) => capability.id === id)?.endpoint];
      return id !== "audio.speech" || endpoint?.requestFormat !== "openai.audio_speech" || endpoint.responseFormat !== "audio.binary";
    }))) throw new Error(`model ${model.id} character pricing requires the binary speech contract`);
    for (const [id, facts] of Object.entries(model.nativeCapabilities?.endpoints ?? {})) {
      const endpoint = Object.hasOwn(manifest.endpoints, id) ? manifest.endpoints[id] : null;
      const supported = manifest.capabilities.filter(capability => capability.endpoint === id && model.capabilities?.includes(capability.id));
      const fail = message => { throw new Error("model " + model.id + " nativeCapabilities " + message); };
      if (!endpoint || !supported.length) fail("must reference a supported endpoint");
      if (facts.contextTokens !== undefined && (facts.contextWindow === undefined || facts.contextTokens > facts.contextWindow)) fail("contextTokens requires and cannot exceed contextWindow");
      if (facts.maxOutputTokens !== undefined && facts.contextWindow !== undefined && facts.maxOutputTokens > facts.contextWindow) fail("maxOutputTokens cannot exceed contextWindow");
      if (facts.inference?.chat === true && !supported.some(capability => ["llm.chat", "llm.responses", "llm.messages", "llm.generate"].includes(capability.id))) fail("chat requires a conversational capability");
      if (facts.inference?.chat && facts.maxOutputTokens === 0) fail("chat cannot declare zero output tokens");
      const decision = facts.inference?.decision;
      if (decision) {
        const contract = decisionContracts.get(decision.protocol);
        if (!contract || manifest.id !== contract.provider || endpoint.requestFormat !== contract.format || endpoint.responseFormat !== contract.format
          || (endpoint.method ?? "POST") !== "POST" || endpoint.streaming || endpoint.websocket || endpoint.nativeProxy === false
          || endpoint.modelPassthrough || endpoint.responsesLifecycle || endpoint.lifecycle
          || !supported.some(capability => capability.id === "llm.decisions")
          || manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== "POST"))) fail("decision requires the declared Decisions endpoint and qualified protocol/provider pair");
        for (const [kind, question] of Object.entries(decision.questions)) {
          if (question.minOptions > question.maxOptions) fail(`${kind} minOptions exceeds maxOptions`);
          if (question.maxImageOptions > question.maxOptions) fail(`${kind} maxImageOptions exceeds maxOptions`);
        }
        if (decision.reasoning?.default && !decision.reasoning.modes.includes(decision.reasoning.default)) fail("decision default reasoning must belong to declared modes");
        if (decision.limits?.maxStateAndQuestionTokens > decision.limits?.maxRequestTokens) fail("decision state/question limit exceeds request limit");
        if (decision.limits?.image && !facts.input?.includes("image")) fail("decision image limits require image input");
      }
      if (facts.hostedTools && (manifest.id !== "openai" || id !== "responses" || endpoint.path !== "/v1/responses" || (endpoint.method ?? "POST") !== "POST" || endpoint.requestFormat !== "openai.responses" || endpoint.responseFormat !== "openai.responses" || !supported.some(capability => capability.id === "llm.responses"))) fail("hosted tools require the OpenAI Responses endpoint");
      if (facts.supportedServiceTiers) {
        if (!["openai.responses", "openai.chat_completions"].includes(endpoint.requestFormat)) fail("service tiers require a supported tier wire format");
        if (facts.supportedServiceTiers.some(tier => ["auto", "fast"].includes(tier) || !model.pricing?.serviceTiers?.some(card => card.id === tier))) fail("service tiers require canonical priced tier ids");
      }
    }
  }
}

function validateModelAvailability(model) {
  const availability = model.availability;
  if (!availability) return;
  const fail = message => { throw new Error(`model ${model.id} availability ${message}`); };
  for (const date of [availability.effectiveAt, availability.checkedAt]) {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) fail("requires calendar dates");
  }
  if (availability.effectiveAt > availability.checkedAt) fail("must be effective by its verification date");
  for (const source of availability.sources) {
    const url = new URL(source);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) fail("requires public HTTPS evidence without credentials");
  }
  if (availability.status === "upstream_alias" && [model.id, model.upstream].includes(availability.servingModel)) fail("must name a distinct serving model");
  // Keep the stopped identity in inventory: removing it could let an opaque
  // model-passthrough endpoint accept the same name as an unknown live model.
  if (availability.status === "stopped" && ((model.capabilities ?? []).length || ["pricing", "pricingRef", "endpointPricing", "nativeCapabilities", "requestParameters", "supportedReasoningEfforts", "codexModel"].some(key => Object.hasOwn(model, key))))
    fail("stopped identities cannot declare executable capabilities, prices or request facts");
}

function validateEndpoints(manifest) {
  const responseControls = new Set();
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    validateUpstreamPath(manifest, id, endpoint);
    if (endpoint.requestPricing?.unit === "image") {
      if (manifest.id !== "xai" || !["xai.images_generations", "xai.images_edits"].includes(endpoint.requestFormat) || endpoint.responseFormat !== "xai.images")
        throw new Error(`endpoint ${id} requestPricing requires the qualified native xAI image contract`);
    } else if (endpoint.requestPricing?.outcome) {
      // A possible charged rejection is additive to the inference reservation.
      // This contract never attests a free error or a fee from HTTP status alone.
      if (manifest.id !== "xai" || Object.values(manifest.baseUrls).some(url => url !== "https://api.x.ai")
        || manifest.auth.schemes.length !== 1 || manifest.auth.schemes[0].type !== "bearer"
        || manifest.auth.schemes[0].header !== "Authorization" || manifest.auth.schemes[0].format !== "Bearer ${secret}"
        || manifest.auth.schemes[0].secretKind !== "api_key" || manifest.auth.grantTransports
        || Object.keys(manifest.adapter.injectHeaders ?? {}).length || Object.keys(manifest.adapter.injectQuery ?? {}).length || manifest.adapter.passthroughHeaders?.length
        || endpoint.path !== "/v1/responses" || (endpoint.method ?? "POST") !== "POST"
        || endpoint.requestFormat !== "openai.responses" || endpoint.responseFormat !== "openai.responses"
        || endpoint.auth || Object.keys(endpoint.headers ?? {}).length || endpoint.requestHeaders?.length
        || endpoint.websocket || endpoint.modelPassthrough || endpoint.responsesLifecycle || endpoint.lifecycle
        || Object.keys(endpoint.query ?? {}).length || endpoint.pathParams?.length
        || endpoint.streaming && endpoint.streaming !== "sse"
        || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "llm.responses")
        || manifest.capabilities.some(capability => capability.endpoint === id && (capability.id !== "llm.responses" || capability.methods?.some(method => method !== "POST"))))
        throw new Error(`endpoint ${id} requestPricing requires the qualified xAI Responses outcome contract`);
    } else if (endpoint.requestPricing) {
      // The runtime can select a flat request tariff without provider branches.
      // Qualification remains explicit until another protocol has sourced billing semantics.
      const pricing = endpoint.requestPricing, variants = pricing.parameterRates;
      if (manifest.id !== "perplexity" || endpoint.path !== "/search" || (endpoint.method ?? "POST") !== "POST"
        || endpoint.requestFormat !== "perplexity.search" || endpoint.responseFormat !== "perplexity.search"
        || endpoint.streaming || endpoint.websocket || endpoint.modelPassthrough || endpoint.responsesLifecycle || endpoint.lifecycle
        || Object.keys(endpoint.query ?? {}).length || endpoint.pathParams?.length
        || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "web.search")
        || manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== "POST")))
        throw new Error(`endpoint ${id} requestPricing requires a qualified successful-request contract`);
      if (!variants || variants.parameter !== "search_type" || Object.keys(variants.rates).length !== 2 || !["web", "fast"].every(value => Object.hasOwn(variants.rates, value)))
        throw new Error(`endpoint ${id} requestPricing has unqualified parameter rates`);
      if (variants && Object.hasOwn(variants.rates, "web") && variants.rates.web !== pricing.successfulResponseMicros)
        throw new Error(`endpoint ${id} requestPricing default must match the web tariff`);
    }
    // This request format owns OpenAI's free tariff and API-key-only transport.
    // Wire compatibility alone cannot qualify another provider's billing.
    if (endpoint.requestFormat === "openai.moderations" && manifest.id !== "openai") throw new Error(`provider ${manifest.id} endpoint ${id} openai.moderations requires provider openai`);
    if (endpoint.responsesLifecycle) {
      const fail = () => { throw new Error(`provider ${manifest.id} endpoint ${id} responsesLifecycle requires distinct bodyless Responses retrieve/cancel endpoints`); };
      if ((endpoint.method ?? "POST") !== "POST" || endpoint.requestFormat !== "openai.responses" || endpoint.responseFormat !== "openai.responses") fail();
      for (const [action, controlId] of Object.entries(endpoint.responsesLifecycle)) {
        const control = Object.hasOwn(manifest.endpoints, controlId) ? manifest.endpoints[controlId] : null;
        if (!control || controlId === id || responseControls.has(controlId) || control.responsesLifecycle || control.modelPassthrough || control.websocket
          || (control.method ?? "POST") !== (action === "retrieve" ? "GET" : "POST")
          || control.requestFormat !== "openai.responses" || control.responseFormat !== "openai.responses"
          || JSON.stringify(control.pathParams) !== '["response_id"]' || !control.path.includes("${response_id}")
          || manifest.capabilities.some((capability) => capability.endpoint === controlId)) fail();
        responseControls.add(controlId);
      }
    }
    if (endpoint.requestFormat === "openai.standalone_search" && (manifest.id !== "openai" || endpoint.path !== "/v1/alpha/search" || (endpoint.method ?? "POST") !== "POST" || endpoint.responseFormat !== "openai.standalone_search" || endpoint.streaming || endpoint.websocket || endpoint.modelPassthrough || endpoint.nativeProxy === false || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "search.web") || manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== "POST")))) throw new Error("standalone search requires the native unary OpenAI search endpoint");
    if (endpoint.requestFormat === "openai.responses_compact") {
      if (manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== "POST"))) throw new Error(`provider ${manifest.id} endpoint ${id} compact is POST-only`);
      const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id).map(capability => capability.id);
      const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.some(capability => capabilities.includes(capability)));
      if (!models.length || models.some(model => !model.pricing || model.pricing.unit != null || !Number.isSafeInteger(model.pricing.defaultMaxOutputTokens) || model.pricing.defaultMaxOutputTokens <= 0)) throw new Error(`provider ${manifest.id} endpoint ${id} compact requires registered token-priced models with authoritative output bounds`);
    }
    if (endpoint.toolPricing) {
      const responses = endpoint.requestFormat === "openai.responses" && endpoint.responseFormat === "openai.responses";
      const messages = endpoint.requestFormat === "anthropic.messages" && endpoint.responseFormat === "anthropic.messages";
      if ((endpoint.method ?? "POST") !== "POST" || (!responses && !messages)
        || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id !== "llm.count_tokens")) throw new Error(`provider ${manifest.id} endpoint ${id} toolPricing requires a Responses or Messages generation endpoint`);
      if (messages && Object.keys(endpoint.toolPricing.previewMicrosPerCallByModel).length) throw new Error(`provider ${manifest.id} endpoint ${id} Messages toolPricing cannot declare preview models`);
      for (const model of Object.keys(endpoint.toolPricing.previewMicrosPerCallByModel)) {
        if (!manifest.models?.entries?.some(entry => entry.upstream === model && entry.capabilities?.some(capability => manifest.capabilities.some(item => item.id === capability && item.endpoint === id)))) throw new Error(`provider ${manifest.id} endpoint ${id} toolPricing references an unsupported preview model`);
      }
    }
    if (endpoint.outputTokenLimit && endpoint.outputTokenLimit.minimum > endpoint.outputTokenLimit.maximum) throw new Error(`provider ${manifest.id} endpoint ${id} outputTokenLimit minimum exceeds maximum`);
    if (endpoint.modelPassthrough) {
      const capabilities = manifest.capabilities.filter((capability) => capability.endpoint === id).map((capability) => capability.id);
      if (!capabilities.length) throw new Error(`provider ${manifest.id} endpoint ${id} modelPassthrough requires a declared capability`);
      const ref = endpoint.modelPassthrough.pricingRef;
      if (ref !== undefined) {
        const models = (manifest.models?.entries ?? []).filter((model) => model.pricingRef === ref);
        if (models.length !== 1 || !models[0].pricing || !models[0].capabilities?.some((capability) => capabilities.includes(capability))) throw new Error(`provider ${manifest.id} endpoint ${id} modelPassthrough pricingRef must resolve to one priced endpoint-compatible model`);
      }
    }
    if (endpoint.websocket === "openai.realtime") {
      if ((endpoint.method ?? "POST") !== "GET" || endpoint.requestFormat !== "openai.realtime" || endpoint.responseFormat !== "openai.realtime" || endpoint.streaming || endpoint.nativeProxy === false || endpoint.modelPassthrough) throw new Error("Realtime requires a native GA GET endpoint");
    } else if (endpoint.websocket !== undefined && (endpoint.websocket !== "openai.responses" || endpoint.requestFormat !== "openai.responses" || endpoint.responseFormat !== "openai.responses" || endpoint.streaming !== "sse" || (endpoint.method ?? "POST") !== "POST" || endpoint.nativeProxy === false)) throw new Error(`provider ${manifest.id} endpoint ${id} websocket requires a native POST Responses SSE endpoint`);
    for (const placeholder of endpoint.path.matchAll(/\$\{([^}]+)\}/g)) {
      if (!(endpoint.pathParams ?? []).includes(placeholder[1])) throw new Error(`provider ${manifest.id} endpoint ${id} path parameter ${placeholder[1]} is not declared`);
    }
  }
}

function validateUpstreamPath(manifest, id, endpoint) {
  if (endpoint.upstreamPath === undefined) return;
  const fail = () => { throw new Error(`endpoint ${id} upstreamPath requires a literal same-format Chat, Messages, Responses create or model-list path without conflicting transport overrides`); };
  const methods = { "openai.chat_completions": "POST", "anthropic.messages": "POST", "openai.responses": "POST", "openai.models": "GET", "anthropic.models": "GET", "synthetic.models": "GET" };
  const canonical = new RegExp(manifestSchema.$defs.literalUpstreamPath.pattern);
  if (!canonical.test(endpoint.path) || endpoint.path.length > 2048 || !canonical.test(endpoint.upstreamPath)
    || [endpoint.path, endpoint.upstreamPath].some(path => path.split("/").some(segment => segment === "." || segment === ".."))
    || endpoint.pathParams?.length || Object.keys(endpoint.pathParamStyles ?? {}).length
    || !Object.hasOwn(methods, endpoint.requestFormat) || endpoint.responseFormat !== endpoint.requestFormat
    || (endpoint.method ?? "POST") !== methods[endpoint.requestFormat]
    || manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== methods[endpoint.requestFormat]))
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.requestPricing || endpoint.toolPricing
    || endpoint.requestFormat === "openai.responses" && (endpoint.path !== "/v1/responses" || Object.keys(endpoint.query ?? {}).length)
    || endpoint.requestFormat.endsWith(".models") && (endpoint.streaming || endpoint.modelPassthrough)) fail();
  for (const transport of Object.values(manifest.auth.grantTransports ?? {})) {
    const path = transport.endpointPaths?.[id];
    if (path !== undefined && path !== endpoint.upstreamPath) fail();
  }
}

function validateNativeModels(manifest, providerId, baseUrl) {
  const format = `${providerId}.models`;
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === providerId && (endpoint.path === "/models" || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "models.list")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error(`${format} requires its native GET /models route, canonical inference origin and original Bearer API-key binding`); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== providerId || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== baseUrl)
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || endpoint.method !== "GET" || endpoint.path !== "/models" || endpoint.upstreamPath !== undefined
    || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "accept" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "models.list"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "GET") fail();
}

function validateSyntheticModels(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("synthetic.")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("synthetic.models upstreamPath requires the qualified Synthetic GET metadata route and original Bearer API-key binding"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "synthetic" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.synthetic.new")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "synthetic.models" || endpoint.responseFormat !== "synthetic.models"
    || endpoint.method !== "GET" || endpoint.path !== "/models" || endpoint.upstreamPath !== "/openai/v1/models"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "models.list"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "GET") fail();
}

function validateGrantTransports(manifest) {
  const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  for (const [kind, transport] of Object.entries(manifest.auth.grantTransports ?? {})) {
    if (!new Set(["api_key", "oauth", "subscription"]).has(kind)) throw new Error(`provider ${manifest.id} grant transport ${kind} has an invalid grant kind`);
    for (const name of [...Object.keys(transport.headers ?? {}), ...Object.keys(transport.appendHeaders ?? {})]) if (!headerName.test(name)) throw new Error(`provider ${manifest.id} grant transport ${kind} has an invalid header`);
    if (transport.allowedEndpoints?.some((id) => !Object.hasOwn(manifest.endpoints, id))) throw new Error(`provider ${manifest.id} grant transport ${kind} allowedEndpoints must reference unique existing endpoints`);
    const warm = transport.maintenance?.keepWarm;
    if (warm) {
      if (!Object.hasOwn(manifest.endpoints, warm.endpoint)) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm references missing endpoint ${warm.endpoint}`);
      const endpoint = manifest.endpoints[warm.endpoint];
      if ((endpoint.method ?? "POST").toUpperCase() !== "POST" || (endpoint.pathParams ?? []).length) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm requires a POST endpoint without path parameters`);
      if (JSON.stringify(warm.body).length > 16 * 1024) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm body is too large`);
    }
    if (transport.maintenance?.quotaPoll && !(manifest.quota?.probes ?? []).some((probe) => probe.grantKinds?.includes(kind))) throw new Error(`provider ${manifest.id} grant transport ${kind} quota polling requires a matching quota probe`);
  }
}

const managedLifecycleContracts = {
  "openrouter.video": {
    provider: "openrouter", create: ["/v1/videos"], request: "openrouter.video_create", response: "openrouter.video",
    controls: { retrieve: ["GET", "/v1/videos/${video_id}", "openrouter.video_get", "openrouter.video"] },
    files: { download: ["GET", "/v1/videos/${video_id}/content", "openrouter.video_content", "openrouter.video_content", { index: "0" }] },
  },
  "xai.video": {
    provider: "xai", create: ["/v1/videos/generations", "/v1/videos/edits", "/v1/videos/extensions"], response: "xai.video",
    requestByPath: { "/v1/videos/generations": "xai.video_generate", "/v1/videos/edits": "xai.video_edit", "/v1/videos/extensions": "xai.video_extend" },
    controls: { retrieve: ["GET", "/v1/videos/${request_id}", "xai.video_get", "xai.video"] },
  },
  "together.video": {
    provider: "together", create: ["/v2/videos"], request: "together.video_create", response: "together.video",
    controls: { retrieve: ["GET", "/v2/videos/${video_id}", "together.video_get", "together.video"] },
  },
  "runway.tasks": {
    provider: "runway", create: ["/v1/text_to_video", "/v1/image_to_video", "/v1/video_to_video"], response: "runway.task",
    requestByPath: { "/v1/text_to_video": "runway.text_video", "/v1/image_to_video": "runway.image_video", "/v1/video_to_video": "runway.video_video" },
    controls: {
      retrieve: ["GET", "/v1/tasks/${id}", "runway.task_get", "runway.task"],
      cancel: ["DELETE", "/v1/tasks/${id}", "runway.task_cancel", "runway.task_cancel"],
    },
  },
  "pixverse.video": {
    provider: "pixverse", create: ["/openapi/v2/video/text/generate"], request: "pixverse.text_video", response: "pixverse.video",
    controls: { retrieve: ["GET", "/openapi/v2/video/result/${video_id}", "pixverse.video_get", "pixverse.video"] },
  },
  "google.omni_video": {
    provider: "google-gemini", create: ["/v1beta/interactions"], request: "google.omni_video_create", response: "google.omni_video",
    controls: {
      retrieve: ["GET", "/v1beta/interactions/${interaction_id}", "google.omni_video_get", "google.omni_video"],
      cancel: ["POST", "/v1beta/interactions/${interaction_id}/cancel", "google.omni_video_cancel", "google.omni_video"],
    },
    files: {
      metadata: ["GET", "/v1beta/files/${file_id}", "google.omni_video_file_metadata", "google.omni_video_file"],
      download: ["GET", "/v1beta/files/${file_id}:download", "google.omni_video_file_download", "google.omni_video_bytes", { alt: "media" }],
    },
  },
  "dashscope.video": {
    provider: "alibaba", create: ["/api/v1/services/aigc/video-generation/video-synthesis"], request: "dashscope.video_create", response: "dashscope.video",
    controls: { retrieve: ["GET", "/api/v1/tasks/${task_id}", "dashscope.video_get", "dashscope.video"] },
  },
  "replicate.predictions": {
    provider: "replicate", create: ["/v1/predictions"], request: "replicate.prediction_create", response: "replicate.prediction",
    controls: {
      retrieve: ["GET", "/v1/predictions/${prediction_id}", "replicate.prediction_get", "replicate.prediction"],
      cancel: ["POST", "/v1/predictions/${prediction_id}/cancel", "replicate.prediction_cancel", "replicate.prediction"],
    },
  },
  "fal.queue": {
    provider: "fal", create: ["/${owner}/${app}", "/${owner}/${app}/${variant}", "/${owner}/${app}/${variant}/${subvariant}"], request: "fal.queue_submit", response: "fal.queue_submission",
    controls: {
      retrieve: ["GET", "/${owner}/${app}/requests/${request_id}/status", "fal.queue_status", "fal.queue_status"],
      result: ["GET", "/${owner}/${app}/requests/${request_id}", "fal.queue_result", "fal.queue_result"],
      cancel: ["PUT", "/${owner}/${app}/requests/${request_id}/cancel", "fal.queue_cancel", "fal.queue_cancel"],
    },
  },
  "kie.jobs": {
    provider: "kie", create: ["/api/v1/jobs/createTask"], request: "kie.job_create", response: "kie.job",
    controls: { retrieve: ["GET", "/api/v1/jobs/recordInfo", "kie.job_get", "kie.job"] },
  },
  "vydra.jobs": {
    provider: "vydra", create: ["/api/v1/jobs"], request: "vydra.job_create", response: "vydra.job",
    controls: {
      retrieve: ["GET", "/api/v1/jobs/${job_id}", "vydra.job_get", "vydra.job"],
      cancel: ["DELETE", "/api/v1/jobs/${job_id}", "vydra.job_cancel", "vydra.job_cancel"],
    },
  },
};

function validateManagedLifecycles(manifest) {
  const controls = new Set(), creates = new Set(), controlBindings = new Map();
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    if (!endpoint.lifecycle) continue;
    const fail = () => { throw new Error(`provider ${manifest.id} endpoint ${id} lifecycle requires distinct qualified native create/control endpoints`); };
    const protocol = endpoint.lifecycle.protocol;
    const fourSegmentFal = protocol === "fal.queue" && endpoint.path === "/${owner}/${app}/${variant}/${subvariant}";
    const contract = Object.hasOwn(managedLifecycleContracts, protocol) ? managedLifecycleContracts[protocol] : null;
    const incompatible = value => value.responsesLifecycle || value.modelPassthrough || value.streaming || value.websocket || value.nativeProxy === false;
    const methodsMatch = (endpointId, method) => !manifest.capabilities.some(capability => capability.endpoint === endpointId && capability.methods?.some(value => value !== method));
    const parametersMatch = value => {
      const names = [...value.path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]).sort();
      return JSON.stringify([...(value.pathParams ?? [])].sort()) === JSON.stringify(names)
        && !Object.entries(value.pathParamStyles ?? {}).some(([name, style]) => !names.includes(name) || style !== "segment");
    };
    if (!contract || manifest.id !== contract.provider || incompatible(endpoint) || Object.keys(endpoint.query ?? {}).length || !parametersMatch(endpoint)
      || (endpoint.method ?? "POST") !== "POST" || !methodsMatch(id, "POST") || !contract.create.includes(endpoint.path)
      || endpoint.requestFormat !== (contract.requestByPath?.[endpoint.path] ?? contract.request) || endpoint.responseFormat !== contract.response
      || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "media.predict")) fail();
    if (fourSegmentFal) {
      // Concrete product/segment values are checked by the registered fal codec.
      // The new shape cannot change origin, credentials or control ownership.
      const scheme = manifest.auth.schemes[0];
      if (Object.values(manifest.baseUrls).some(base => base !== "https://queue.fal.run")
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Key ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
    }
    if (protocol === "openrouter.video") {
      // This product has authenticated content, not a file metadata endpoint.
      // Only the original succeeded job and descriptor can authorize download.
      const scheme = manifest.auth.schemes[0];
      const attribution = { "HTTP-Referer": "${site_url}", "X-Title": "ClawRouter" };
      if (Object.values(manifest.baseUrls).some(base => base !== "https://openrouter.ai/api")
        || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length
        || Object.entries(manifest.adapter?.injectHeaders ?? {}).some(([name, value]) => !Object.hasOwn(attribution, name) || attribution[name] !== value)
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || endpoint.requestPricing || endpoint.toolPricing || endpoint.outputTokenLimit
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
      if ((manifest.models?.entries ?? []).some(model => model.capabilities?.includes("media.predict")
        && (model.upstream !== "google/veo-3.1-fast" || model.capabilities.length !== 1
          || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length))) fail();
    }
    if (protocol === "xai.video") {
      const scheme = manifest.auth.schemes[0];
      if (Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || endpoint.requestPricing || endpoint.toolPricing || endpoint.outputTokenLimit
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
      // Native duration and advisory idempotency are not a qualified tariff or
      // retry guarantee. These cards cannot borrow the provider's Chat prices.
      if ((manifest.models?.entries ?? []).some(model => model.capabilities?.includes("media.predict")
        && (!["grok-imagine-video", "grok-imagine-video-1.5"].includes(model.upstream) || model.capabilities.length !== 1
          || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length))) fail();
    }
    if (protocol === "dashscope.video") {
      // The bound credential comes from the shared owner, never endpoint overrides.
      if (endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) =>
        !(["x-dashscope-async", "content-type"].includes(name.toLowerCase()) && value === (name.toLowerCase() === "x-dashscope-async" ? "enable" : "application/json")))) fail();
    }
    if (protocol === "together.video") {
      // Pin the selected Together origin and credential; no alias fallback or
      // cross-product Wan/MiniMax authorization on the native video route.
      if (Object.values(manifest.baseUrls).some(base => !["https://api.together.xyz", "https://api.together.ai"].includes(base))
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "bearer" || schemes[0].header?.toLowerCase() !== "authorization"
        || schemes[0].format !== "Bearer ${secret}" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "runway.tasks") {
      if (Object.values(manifest.baseUrls).some(base => base !== "https://api.dev.runwayml.com")
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) =>
          !(["content-type", "x-runway-version"].includes(name.toLowerCase()) && value === (name.toLowerCase() === "content-type" ? "application/json" : "2024-11-06")))) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "bearer" || schemes[0].header?.toLowerCase() !== "authorization"
        || schemes[0].format !== "Bearer ${secret}" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "pixverse.video") {
      // Image routes remain closed until uploads have durable original-job scope.
      if (Object.values(manifest.baseUrls).some(base => !["https://app-api.pixverse.ai", "https://app-api.pixverseai.cn"].includes(base))
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "api_key" || schemes[0].header?.toLowerCase() !== "api-key" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "google.omni_video") {
      // Keep Google's existing origin-only base; the registered wrapper must
      // translate the codec's /v1beta-relative paths without changing that base.
      for (const base of Object.values(manifest.baseUrls)) {
        let url; try { url = new URL(base); } catch { fail(); }
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") fail();
      }
      if (endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
    }
    creates.add(id);
    for (const [action, [method, path, request, response, query = {}]] of Object.entries({ ...contract.controls, ...contract.files })) {
      const controlId = Object.hasOwn(contract.controls, action) ? endpoint.lifecycle[action] : endpoint.lifecycle.files[action];
      const control = Object.hasOwn(manifest.endpoints, controlId) ? manifest.endpoints[controlId] : null;
      const sharedControl = ["fal.queue", "xai.video"].includes(protocol) && controlBindings.get(controlId) === `${protocol}:${action}`;
      if (!control || controlId === id || controls.has(controlId) && !sharedControl || control.lifecycle || incompatible(control) || !parametersMatch(control)
        || Object.keys(control.query ?? {}).length !== Object.keys(query).length || Object.entries(query).some(([name, value]) => control.query?.[name] !== value)
        || (control.method ?? "POST") !== method || !methodsMatch(controlId, method) || control.path !== path
        || control.requestFormat !== request || control.responseFormat !== response
        || manifest.capabilities.some(capability => capability.endpoint === controlId && (protocol !== "replicate.predictions" || action !== "retrieve" || capability.id !== "media.prediction.read"))) fail();
      if ((fourSegmentFal || ["openrouter.video", "xai.video", "dashscope.video", "google.omni_video", "pixverse.video", "runway.tasks", "together.video"].includes(protocol)) && (control.auth || control.requestHeaders?.length || Object.keys(control.headers ?? {}).length)) fail();
      if (["openrouter.video", "xai.video"].includes(protocol) && (control.requestPricing || control.toolPricing || control.outputTokenLimit)) fail();
      controls.add(controlId);
      controlBindings.set(controlId, `${protocol}:${action}`);
    }
  }
  // New managed wire formats cannot accidentally expose an unbound raw control.
  // Legacy Replicate manifests retain their existing runtime ownership guard.
  const formats = new Set(Object.entries(managedLifecycleContracts).filter(([protocol]) => protocol !== "replicate.predictions")
    .flatMap(([, contract]) => [contract.request, ...Object.values(contract.requestByPath ?? {}), ...Object.values({ ...contract.controls, ...contract.files }).map(control => control[2])].filter(Boolean)));
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    const reservedFormat = ["openrouter.video", "xai.video", "dashscope.video", "google.omni_video", "pixverse.", "runway.", "together.video"].some(prefix => endpoint.requestFormat.startsWith(prefix) || endpoint.responseFormat.startsWith(prefix))
      || ["openrouter", "xai"].includes(manifest.id) && /^\/v1\/videos(?:\/|$)/.test(endpoint.path);
    if ((formats.has(endpoint.requestFormat) || reservedFormat) && !creates.has(id) && !controls.has(id))
      throw new Error(`provider ${manifest.id} endpoint ${id} lifecycle binding is required for a managed wire format`);
  }
}

function validateXaiImages(manifest) {
  const formats = new Map([["xai.images_generations", "/v1/images/generations"], ["xai.images_edits", "/v1/images/edits"]]);
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("xai.images"))
    || manifest.id === "xai" && [...formats.values()].includes(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("xAI images require qualified native formats, original global Bearer auth, finite models and separate per-image accounting"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "xai" || endpoints.length > 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== "xai.images" || endpoint.path !== formats.get(endpoint.requestFormat)
      || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || endpoint.requestPricing && endpoint.requestPricing.unit !== "image") fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "image.generate" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("image.generate"));
  // These units belong to the endpoint tariff, never a fabricated token card.
  if (!models.length || models.some(model => !["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"].includes(model.upstream)
    || model.capabilities.length !== 1 || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length)) fail();
}

function validateGoogleUnaryMedia(manifest, kind, capabilityId, upstreams) {
  const format = `google.${kind}`;
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === capabilityId));
  if (!endpoints.length) return;
  const fail = () => { throw new Error(`Google ${kind === "image" ? "images" : "music"} require the finite native unary format, canonical API-key origin and unpriced single-capability models`); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== `${format}_generate` || endpoint.responseFormat !== format
    || endpoint.path !== "/v1beta/models/${model}:generateContent" || endpoint.method !== "POST"
    || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== capabilityId
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capabilityId));
  // Media counters and bounded bytes cannot qualify a text-token price card.
  if (!models.length || models.some(model => !upstreams.includes(model.upstream)
    || model.id !== `google/${model.upstream}` || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

function validateGoogleSpeech(manifest) {
  const formats = ["google.speech_generate_content", "google.speech_interactions"];
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith("google.speech"))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.speech"));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google speech requires its paired unary transports, canonical API-key origin and unpriced frozen models"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== 2
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    const interactions = endpoint.requestFormat === "google.speech_interactions";
    if (!formats.includes(endpoint.requestFormat) || endpoint.responseFormat !== endpoint.requestFormat || endpoint.method !== "POST"
      || endpoint.path !== (interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent")
      || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => interactions || name !== "model" || style !== "segment")) fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech"
      || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  }
  const upstreams = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.speech"));
  // The shared nativeModelEligible contract owns transport eligibility and expiry;
  // declaration compilation preserves identities without freezing a clock verdict.
  if (!models.length || models.some(model => !upstreams.includes(model.upstream)
    || model.id !== `google/${model.upstream}` || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

function validateGoogleGroundedSearch(manifest) {
  const format = "google.grounded_search";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "search.web"));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google grounded search requires its frozen model, explicit manifest route, canonical API-key origin and unpriced endpoint"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "search.web"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("search.web"));
  // A shared Chat identity may retain its token card; grounding has an explicit
  // unknown endpoint price until the whole inference + tool bound is qualified.
  if (models.length !== 1 || models.some(model => model.upstream !== "gemini-3.6-flash" || model.id !== `google/${model.upstream}`
    || model.availability?.status === "upstream_alias" || model.endpointPricing?.[id]?.pricing !== null
    || model.requestParameters?.[id] !== undefined)) fail();
}

function validateGoogleUnderstanding(manifest) {
  const formats = new Map([["google.audio_understanding", "audio.transcription"], ["google.video_understanding", "video.understanding"]]);
  const reserved = value => [...formats.keys()].some(format => value.startsWith(format));
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(reserved)
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && [...formats.values()].includes(capability.id)));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google inline understanding requires finite manifest-only formats, the frozen model, canonical API-key origin and unknown endpoint prices"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length > 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== "google.generate_content"
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
    const capabilityId = formats.get(endpoint.requestFormat), capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== capabilityId
      || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
    const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capabilityId));
    // Input-media limits and native usage are not a whole-request price bound.
    // Keep the shared model's ordinary text card separate from each native route.
    if (models.length !== 1 || models.some(model => model.upstream !== "gemini-3-flash-preview" || model.id !== `google/${model.upstream}`
      || model.availability?.status === "upstream_alias" || model.endpointPricing?.[id]?.pricing !== null
      || model.requestParameters?.[id] !== undefined)) fail();
  }
}

function validateGoogleEmbeddings(manifest) {
  const formats = new Map([
    ["google.embed_content", "/v1beta/models/${model}:embedContent"],
    ["google.batch_embed_contents", "/v1beta/models/${model}:batchEmbedContents"],
  ]);
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("google.embed") || format.startsWith("google.batch_embed"))
    || /:(?:embedContent|batchEmbedContents)$/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google embeddings require paired native formats, original API-key auth, finite qualified models and unpriced accounting"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== 2
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== endpoint.requestFormat || endpoint.path !== formats.get(endpoint.requestFormat)
      || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "llm.embeddings" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.embeddings"));
  // The preview remains codec compatibility only; current live availability is
  // not established by that fixture. No native tariff/bound is qualified yet.
  if (!models.length || models.some(model => !["gemini-embedding-001", "gemini-embedding-2"].includes(model.upstream)
    || model.capabilities.length !== 1 || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length)) fail();
}

function validateBedrockEmbeddings(manifest) {
  const capabilities = manifest.capabilities.filter(capability => capability.id === "llm.embeddings");
  if (!capabilities.length || manifest.id !== "aws-bedrock" && !capabilities.some(capability =>
    manifest.endpoints[capability.endpoint]?.requestFormat === "aws_bedrock.invoke")) return;
  const fail = () => { throw new Error("Bedrock embeddings require the finite registered native models, original regional SigV4 route and unpriced embedding-only cards"); };
  const models = [
    "amazon.titan-embed-text-v2:0", "amazon.titan-embed-text-v1", "amazon.titan-embed-g1-text-02", "amazon.titan-embed-image-v1",
    "cohere.embed-english-v3", "cohere.embed-multilingual-v3", "cohere.embed-v4:0", "amazon.nova-2-multimodal-embeddings-v1:0",
    "us.twelvelabs.marengo-embed-2-7-v1:0", "twelvelabs.marengo-embed-3-0-v1:0",
  ];
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "aws-bedrock" || capabilities.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://bedrock-runtime.${region}.amazonaws.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "sig_v4" || scheme.service !== "bedrock" || scheme.regionParam !== "region"
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || adapter?.request !== "aws_bedrock" || adapter?.response !== "aws_bedrock"
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const capability = capabilities[0], endpoint = manifest.endpoints[capability.endpoint];
  if (!endpoint || capability.methods?.length !== 1 || capability.methods[0] !== "POST"
    || manifest.capabilities.filter(value => value.endpoint === capability.endpoint).length !== 1
    || endpoint.method !== "POST" || endpoint.path !== "/model/${model}/invoke" || endpoint.nativeProxy === false
    || endpoint.requestFormat !== "aws_bedrock.invoke" || endpoint.responseFormat !== "aws_bedrock.invoke"
    || endpoint.pathParams?.length !== 1 || endpoint.pathParams[0] !== "model"
    || Object.keys(endpoint.pathParamStyles ?? {}).length !== 1 || endpoint.pathParamStyles.model !== "opaque_segment"
    || Object.keys(endpoint.query ?? {}).length || endpoint.requestHeaders?.length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || ["auth", "upstreamPath", "streaming", "websocket", "lifecycle", "responsesLifecycle", "modelPassthrough", "outputTokenLimit", "requestPricing", "toolPricing"].some(key => endpoint[key] !== undefined)) fail();
  const entries = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.embeddings"));
  if (!entries.length || entries.some(model => !models.includes(model.upstream) || model.id !== `bedrock/${model.upstream}`
    || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
  for (const model of entries) {
    const facts = model.nativeCapabilities?.endpoints?.[capability.endpoint];
    // This frozen slice qualifies text input, not media delivery, token bounds or dimensions as tokens.
    if (facts && (facts.input?.some(input => input !== "text") || facts.contextWindow !== undefined || facts.contextTokens !== undefined
      || facts.maxOutputTokens !== undefined || facts.inference || facts.hostedTools || facts.supportedServiceTiers)) fail();
  }
}

function validateBasetenSystemOne(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("baseten.systemone"))
    || manifest.id === "baseten" && /^\/(?:v1\/)?systemone(?:\/|$)/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("baseten.systemone requires its finite decision-only models, native metadata, original Bearer origin and unpriced request contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "baseten" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://inference.baseten.co/v1")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "baseten.systemone" || endpoint.responseFormat !== "baseten.systemone"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "llm.decisions" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const nativeIds = ["decision-models/baseten-elephant-9b-latest", "decision-models/baseten-mammoth-27b-latest", "decision-models/baseten-joey-2b-latest"];
  const models = (manifest.models?.entries ?? []).filter(model => nativeIds.includes(model.upstream) || model.capabilities?.includes("llm.decisions"));
  if (!models.length || models.some(model => {
    const facts = model.nativeCapabilities?.endpoints?.[id];
    return !nativeIds.includes(model.upstream) || model.capabilities?.length !== 1 || model.capabilities[0] !== "llm.decisions"
      || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length
      || model.codexModel || model.supportedReasoningEfforts?.length
      || !facts || facts.inference?.decision?.protocol !== "baseten-systemone" || facts.inference.chat === true
      || facts.input?.some(input => !["text", "json"].includes(input)) || facts.maxOutputTokens !== undefined
      || facts.contextTokens !== undefined || facts.contextWindow !== undefined;
  })) fail();
}

function validateDeepSeekSearch(manifest) {
  const format = "deepseek.search";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "deepseek" && (endpoint.path === "/v1/tools/search"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "search.web")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("deepseek.search requires model-less native search, canonical origin, original Bearer auth and an unpriced request contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "deepseek" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.deepseek.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "search.web"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
    || manifest.models?.entries?.some(model => model.capabilities?.includes("search.web"))) fail();
}

function validateGradiumSpeech(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("gradium."))
    || manifest.id === "gradium" && endpoint.path === "/api/post/speech/tts");
  if (!endpoints.length) return;
  const fail = () => { throw new Error("gradium.speech requires model-less native unary speech, canonical origin and original x-api-key auth without inferred tariffs"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "gradium" || manifest.class !== "rest_json" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.gradium.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-api-key" || scheme.secretKind !== "api_key"
    || Object.keys(manifest.auth.grantTransports ?? {}).length || (manifest.models?.entries ?? []).length
    || manifest.routing?.modelPrefixes?.length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || (adapter?.request ?? "rest_json") !== "rest_json" || (adapter?.response ?? "rest_json") !== "rest_json" || adapter?.stream
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "gradium.speech" || endpoint.responseFormat !== "audio.binary"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech" || capabilities[0].methods?.some(method => method !== "POST")) fail();
}

function validateGroqMistralTranscription(manifest) {
  const contracts = {
    groq: { base: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", format: "groq.transcription" },
    mistral: { base: "https://api.mistral.ai", model: "voxtral-mini-latest", format: "mistral.transcription" },
  };
  const formats = Object.values(contracts).map(contract => contract.format);
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => formats.some(format => value.startsWith(format)))
    || Object.hasOwn(contracts, manifest.id) && (endpoint.path === "/v1/audio/transcriptions"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.transcription")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Groq/Mistral transcription requires its finite multipart format, original Bearer origin and unpriced audio-only model"); };
  const contract = Object.hasOwn(contracts, manifest.id) ? contracts[manifest.id] : null;
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (!contract || endpoints.length !== 1 || Object.values(manifest.baseUrls).some(base => base !== contract.base)
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== contract.format || endpoint.responseFormat !== contract.format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "accept" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (models.length !== 1 || models.some(model => model.upstream !== contract.model || model.id !== `${manifest.id}/${contract.model}`
    || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
  const facts = models[0].nativeCapabilities?.endpoints?.[id];
  // Upload bytes and observed audio seconds do not establish token limits.
  if (facts && (facts.input?.some(input => input !== "audio") || facts.contextWindow !== undefined
    || facts.contextTokens !== undefined || facts.maxOutputTokens !== undefined || facts.inference
    || facts.hostedTools || facts.supportedServiceTiers)) fail();
}

function validateOpenRouterTranscription(manifest) {
  const format = "openrouter.audio_transcription";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "openrouter" && (["/v1/audio/transcriptions", "/api/v1/audio/transcriptions"].includes(endpoint.path)
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.transcription")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("OpenRouter transcription requires the finite native JSON format, canonical API base, original Bearer auth and unpriced transcription-only model"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "openrouter" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://openrouter.ai/api")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.entries(adapter?.injectHeaders ?? {}).some(([name, value]) =>
      !((name.toLowerCase() === "http-referer" && value === "${site_url}") || (name.toLowerCase() === "x-title" && value === "ClawRouter")))
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || endpoint.path !== "/v1/audio/transcriptions"
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (models.length !== 1 || models[0].upstream !== "openai/whisper-large-v3-turbo" || models[0].capabilities.length !== 1
    || models[0].availability?.status === "upstream_alias" || models[0].pricing || models[0].pricingRef
    || Object.keys(models[0].endpointPricing ?? {}).length || Object.keys(models[0].requestParameters ?? {}).length) fail();
  const facts = models[0].nativeCapabilities?.endpoints?.[id];
  // Byte limits and native seconds/cost observations are not token envelopes.
  if (facts && (facts.input?.some(input => input !== "audio") || facts.contextWindow !== undefined
    || facts.contextTokens !== undefined || facts.maxOutputTokens !== undefined || facts.inference
    || facts.hostedTools || facts.supportedServiceTiers)) fail();
}

function validateDeepgramPrerecorded(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) => endpoint.requestFormat.startsWith("deepgram.") || endpoint.responseFormat.startsWith("deepgram."));
  if (manifest.id !== "deepgram" && !endpoints.length) return;
  const fail = () => { throw new Error("deepgram.prerecorded requires the qualified raw-audio provider, Token auth, nova-3 model and unpriced transcription contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "deepgram" || manifest.baseUrls.default !== "https://api.deepgram.com" || endpoints.length !== 1
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header.toLowerCase() !== "authorization"
    || scheme.format !== "Token ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "deepgram.prerecorded" || endpoint.responseFormat !== "deepgram.prerecorded") fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (models.length !== 1 || models[0].upstream !== "nova-3" || models[0].capabilities.length !== 1
    || models[0].pricing || models[0].pricingRef || Object.keys(models[0].endpointPricing ?? {}).length) fail();
}

function validateQuota(providerId, quota) {
  const validateBase = (window) => {
    if (window.fixedLimit != null && (!Number.isFinite(window.fixedLimit) || window.fixedLimit < 0)) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid fixed limit`);
    if (window.metricScale != null && (!Number.isFinite(window.metricScale) || window.metricScale <= 0 || window.metricScale > 1_000_000)) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid metric scale`);
  };
  const responseHeaders = quota?.responseHeaders ?? [];
  for (const window of responseHeaders) {
    validateBase(window);
    const fields = ["limitHeaders", "remainingHeaders", "usedHeaders", "resetHeaders"];
    const headers = fields.flatMap((field) => window[field] ?? []);
    if (!headers.length && window.fixedLimit == null) throw new Error(`provider ${providerId} quota window ${window.id} has no response source`);
    if (headers.some((header) => typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))) throw new Error(`provider ${providerId} quota window ${window.id} has an invalid header`);
  }
  const probes = quota?.probes ?? [];
  for (const probe of probes) {
    for (const [name, value] of Object.entries(probe.headers ?? {})) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string") throw new Error(`provider ${providerId} quota probe has an invalid header`);
    for (const window of probe.windows) {
      validateBase(window);
      const pointers = ["limitPointer", "remainingPointer", "usedPointer", "resetPointer"].flatMap((field) => window[field] == null ? [] : [window[field]]);
      if (!pointers.length && window.fixedLimit == null) throw new Error(`provider ${providerId} quota probe window ${window.id} has no data source`);
    }
  }
}

function authSchemeId(scheme) {
  if (scheme.type === "bearer") return `bearer:${scheme.secretKind}${scheme.required ? "" : ":optional"}`;
  if (scheme.type === "api_key" || scheme.type === "query_api_key") return `${scheme.type}:${scheme.secretKind}`;
  if (scheme.type === "oauth") return scheme.provider ? `oauth:${scheme.provider}` : "oauth";
  if (scheme.type === "sig_v4") return `sigv4:${scheme.service}`;
  return scheme.type;
}

function normalizeAuthScheme(scheme) {
  if (scheme.type === "bearer") return { ...scheme, required: scheme.required ?? true };
  if (scheme.type === "oauth") return {
    ...scheme,
    provider: scheme.provider ?? null,
    tokenRef: scheme.tokenRef ?? null,
  };
  if (scheme.type === "sig_v4") return { ...scheme, regionParam: scheme.regionParam ?? null };
  return scheme;
}

function normalizeAuthorization(value) {
  if (!value) return null;
  return {
    ...value,
    clientId: value.clientId ?? null,
    clientIdConfig: value.clientIdConfig ?? null,
    clientSecretConfig: value.clientSecretConfig ?? null,
    grantKind: value.grantKind ?? "oauth",
    extraAuthorizeParams: value.extraAuthorizeParams ?? {},
    extraTokenParams: value.extraTokenParams ?? {},
    accountIdJsonPointer: value.accountIdJsonPointer ?? null,
    subscriptionPlanJsonPointer: value.subscriptionPlanJsonPointer ?? null,
  };
}

function normalizeRefresh(value) {
  if (!value) return null;
  return {
    ...value,
    clientId: value.clientId ?? null,
    clientIdConfig: value.clientIdConfig ?? null,
    clientSecretConfig: value.clientSecretConfig ?? null,
    requestFormat: value.requestFormat ?? "form",
    extraParams: value.extraParams ?? {},
  };
}

function normalizeGrantTransport(value) {
  return {
    baseUrl: value.baseUrl ?? null,
    auth: value.auth ?? null,
    endpointPaths: value.endpointPaths ?? {},
    ...(value.allowedEndpoints ? { allowedEndpoints: value.allowedEndpoints } : {}),
    headers: value.headers ?? {},
    appendHeaders: value.appendHeaders ?? {},
    requestTransforms: { prependSystem: value.requestTransforms?.prependSystem ?? [] },
    maintenance: {
      quotaPoll: value.maintenance?.quotaPoll ?? null,
      keepWarm: value.maintenance?.keepWarm ? { ...value.maintenance.keepWarm, defaultEnabled: value.maintenance.keepWarm.defaultEnabled === true } : null,
    },
  };
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).toUpperCase()))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  const outputIndex = rawArgs.indexOf("--output");
  const output = outputIndex >= 0 ? rawArgs[outputIndex + 1] : null;
  const paths = rawArgs.filter((_, index) => outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1));
  if (!paths.length) throw new Error("usage: compile-providers <manifest...> [--output path]");

  const manifests = paths.sort().map((path) => parse(readFileSync(path, "utf8")));
  const snapshot = compileProviderSnapshot(manifests);
  const encoded = output ? `${JSON.stringify(snapshot)}\n` : `${JSON.stringify(snapshot, null, 2)}\n`;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, encoded);
  } else {
    process.stdout.write(encoded);
  }
}
