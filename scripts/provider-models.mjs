import { normalizePricing, validatePricing } from "./provider-pricing.mjs";

// Model compilation and cross-field checks consume a schema-validated manifest.
const decisionContracts = new Map([
  ["baseten-systemone", { provider: "baseten", format: "baseten.systemone" }],
  ["openai-decisions", { provider: "openai", format: "openai.decisions" }],
  ["levanto-sage", { provider: "levanto", format: "levanto.sage" }],
  ["liquid-ai-systemone", { provider: "liquid-ai", format: "liquid.systemone" }],
  ["typesafe-systemone", { provider: "typesafe", format: "typesafe.systemone" }],
  ["subq-decisions", { provider: "subq", format: "subq.decisions" }],
]);

export function compileProviderModels(manifest) {
  return (manifest.models?.entries ?? []).map((model) => ({
    id: model.id,
    upstream: model.upstream,
    ...(model.displayName ? { displayName: model.displayName } : {}),
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
}

export function validateProviderModels(manifest) {
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
    if (model.capabilities?.some(id => id === "image.generation" || id === "image.edit") && model.pricing?.unit !== "image_token") throw new Error("image pricing requires a qualified modality tariff");
    if (model.pricing?.unit === "image_token" && (!model.capabilities?.length || model.capabilities.some((id) => {
      const endpoint = manifest.endpoints[manifest.capabilities.find((capability) => capability.id === id)?.endpoint];
      return !["image.generation", "image.edit"].includes(id) || endpoint?.requestFormat !== (id === "image.edit" ? "openai.images_edits" : "openai.images_generations") || endpoint.responseFormat !== "openai.images_generations" || endpoint.streaming;
    }))) throw new Error("image pricing requires the JSON image generation or edit contract");
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
      if (facts.referenceImage) validateMusicImageRoute(manifest, model, id, endpoint, facts, "referenceImage");
      if (facts.publishedInput) validateMusicImageRoute(manifest, model, id, endpoint, facts, "publishedInput");
      if (facts.speech && (endpoint.requestFormat !== "openai.audio_speech" || endpoint.responseFormat !== "audio.binary"
        || (endpoint.method ?? "POST") !== "POST" || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
        || !supported.some(capability => capability.id === "audio.speech")
        || manifest.capabilities.some(capability => capability.endpoint === id && capability.methods?.some(method => method !== "POST"))))
        fail("speech profile requires a unary POST audio.speech endpoint with openai.audio_speech input and audio.binary output");
      if (facts.contextTokens !== undefined && (facts.contextWindow === undefined || facts.contextTokens > facts.contextWindow)) fail("contextTokens requires and cannot exceed contextWindow");
      if (facts.maxOutputTokens !== undefined && facts.contextWindow !== undefined && facts.maxOutputTokens > facts.contextWindow) fail("maxOutputTokens cannot exceed contextWindow");
      if (facts.inference?.chat === true && !supported.some(capability => ["llm.chat", "llm.responses", "llm.messages", "llm.generate"].includes(capability.id))) fail("chat requires a conversational capability");
      if (facts.inference?.chat && facts.maxOutputTokens === 0) fail("chat cannot declare zero output tokens");
      const decision = facts.inference?.decision;
      if (decision) {
        const contract = decisionContracts.get(decision.protocol);
        const sageBatch = decision.protocol === "levanto-sage" && endpoint.requestFormat === "levanto.sage_batch";
        const format = sageBatch ? "levanto.sage_batch" : contract?.format;
        if (!contract || manifest.id !== contract.provider || endpoint.requestFormat !== format || endpoint.responseFormat !== format
          || (endpoint.method ?? "POST") !== "POST" || endpoint.streaming || endpoint.websocket || endpoint.nativeProxy === false
          || endpoint.modelPassthrough || endpoint.responsesLifecycle || endpoint.lifecycle
          || !supported.some(capability => capability.id === (sageBatch ? "llm.decisions.batch" : "llm.decisions"))
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

function validateMusicImageRoute(manifest, model, id, endpoint, facts, field) {
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  // Support facts describe the registered leaf's input, never asset authority
  // or a capability inherited by another model on the shared Chat wire path.
  if (manifest.id !== "openrouter" || id !== "music_generate"
    || Object.values(manifest.baseUrls).some(base => base !== "https://openrouter.ai/api")
    || !["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"].includes(model.upstream)
    || model.id !== `openrouter/${model.upstream}` || model.availability?.status === "upstream_alias"
    || model.capabilities.length !== 1 || model.capabilities[0] !== "music.generate"
    || capabilities.length !== 1 || capabilities[0].id !== "music.generate"
    || capabilities[0].methods?.some(method => method !== "POST")
    || (endpoint.method ?? "POST") !== "POST" || endpoint.path !== "/v1/chat/completions"
    || endpoint.requestFormat !== "openai.chat_completions" || endpoint.responseFormat !== "openai.chat_completions"
    || endpoint.streaming !== "sse" || endpoint.pathParams?.length || Object.keys(endpoint.query ?? {}).length
    || ["upstreamPath", "websocket", "lifecycle", "responsesLifecycle", "modelPassthrough", "requestPricing", "inputProfile"].some(key => endpoint[key] !== undefined)
    || facts.input?.length !== 2 || !facts.input.includes("text") || !facts.input.includes("image"))
    throw new Error(`model ${model.id} ${field} requires the registered OpenRouter Lyria music_generate route with optional inline image input`);
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
