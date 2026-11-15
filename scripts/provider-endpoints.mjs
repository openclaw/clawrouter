import { normalizePricing } from "./provider-pricing.mjs";
import { validateCatalogEndpoint } from "./provider-catalogs.mjs";

// Endpoint compilation consumes schema-validated provider declarations.
export function compileProviderEndpoints(manifest, capabilities) {
  return Object.entries(manifest.endpoints).sort(([a], [b]) => a.localeCompare(b)).map(([id, endpoint]) => ({
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
    ...(endpoint.inputProfile !== undefined ? { inputProfile: endpoint.inputProfile } : {}),
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
}

export function validateEndpoints(manifest, literalUpstreamPathPattern) {
  const responseControls = new Set();
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    validateUpstreamPath(manifest, id, endpoint, literalUpstreamPathPattern);
    validateCatalogEndpoint(manifest, id, endpoint);
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
    } else if (endpoint.requestPricing?.protocol) {
      if (endpoint.requestPricing.protocol !== "deepseek.search" || manifest.id !== "deepseek"
        || endpoint.path !== "/v1/tools/search" || (endpoint.method ?? "POST") !== "POST"
        || endpoint.requestFormat !== "deepseek.search" || endpoint.responseFormat !== "deepseek.search")
        throw new Error(`endpoint ${id} requestPricing requires the qualified deepseek.search native-result contract`);
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

function validateUpstreamPath(manifest, id, endpoint, literalUpstreamPathPattern) {
  if (endpoint.upstreamPath === undefined) return;
  const fail = () => { throw new Error(`endpoint ${id} upstreamPath requires a literal same-format Chat, Messages, Responses create or model-list path without conflicting transport overrides`); };
  const methods = { "openai.chat_completions": "POST", "anthropic.messages": "POST", "openai.responses": "POST", "openai.models": "GET", "anthropic.models": "GET", "synthetic.models": "GET" };
  const canonical = new RegExp(literalUpstreamPathPattern);
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

function unique(values) {
  return [...new Set(values.map((value) => String(value).toUpperCase()))];
}
