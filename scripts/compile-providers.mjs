import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Validator } from "@cfworker/json-schema";
import { loadProviderManifestInputs, parseProviderCompilerArgs } from "./provider-manifest-inputs.mjs";
import { compileProviderProducts } from "./provider-products.mjs";
import { compileProviderOffers } from "./provider-offers.mjs";
import { compileProviderModels, validateProviderModels } from "./provider-models.mjs";
import { authSchemeId, compileProviderAuth, validateGrantTransports } from "./provider-auth.mjs";
import { normalizeQuota, validateQuota } from "./provider-quota.mjs";
import { validatePublicCatalog, validateNativeModels, validateSyntheticModels } from "./provider-catalogs.mjs";
import { validateManagedLifecycles } from "./provider-lifecycles.mjs";
import { compileProviderEndpoints, validateEndpoints } from "./provider-endpoints.mjs";
import { validateGoogleUnaryMedia, validateGoogleSpeech, validateGoogleGroundedSearch, validateGoogleUnderstanding, validateGoogleEmbeddings } from "./provider-validation/google.mjs";

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
        ...(model.displayName ? { displayName: model.displayName } : {}),
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
  const endpoints = compileProviderEndpoints(manifest, capabilities);
  const auth = compileProviderAuth(manifest);
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
  const models = compileProviderModels(manifest);
  const billing = {
    meter: manifest.billing?.meter ?? null,
    dimensions: manifest.billing?.dimensions ?? [],
    counters: manifest.billing?.counters ?? [],
  };
  const quota = normalizeQuota(manifest.quota);
  const products = compileProviderProducts(manifest);
  const offerDefinitions = compileProviderOffers(manifest, products);
  return {
    id: manifest.id,
    ...(products ? { products } : {}),
    ...(offerDefinitions ? { offer_definitions: offerDefinitions } : {}),
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

function validateManifest(manifest) {
  // Validate before normalization so defaults cannot hide a malformed manifest.
  // Cross-field references below remain semantic checks on this canonical shape.
  const validation = manifestValidator.validate(manifest);
  if (!validation.valid) throw new Error(`provider ${manifest?.id ?? "?"} invalid manifest: ${validation.errors.map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`).join("; ")}`);
  if (!manifest.baseUrls?.default) throw new Error(`provider ${manifest.id} is missing baseUrls.default`);
  validateInputProfiles(manifest);
  validateSageBatch(manifest);
  validateBasetenSystemOne(manifest);
  validateGradiumSpeech(manifest);
  validateXaiSpeech(manifest);
  validateDeepSeekSearch(manifest);
  validateDeepgramPrerecorded(manifest);
  validateOpenRouterTranscription(manifest);
  validateNativeTranscription(manifest);
  validateGoogleEmbeddings(manifest);
  validateBedrockEmbeddings(manifest);
  validateBedrockConverse(manifest);
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
  validateNativeModels(manifest, "requesty", "https://router.requesty.ai/v1", { format: "requesty.models_managed", path: "/models/managed", id: "models_managed" });
  validatePublicCatalog(manifest);
  validateSyntheticModels(manifest);
  const configKeys = new Set(manifest.service?.configKeys ?? []);
  for (const key of manifest.service?.optionalConfigKeys ?? []) if (!configKeys.has(key)) throw new Error(`provider ${manifest.id} optional config key ${key} is not declared in configKeys`);
  for (const capability of manifest.capabilities) {
    if (!Object.hasOwn(manifest.endpoints, capability.endpoint)) throw new Error(`provider ${manifest.id} capability ${capability.id} references missing endpoint ${capability.endpoint}`);
  }
  validateProviderModels(manifest);
  validateManagedLifecycles(manifest);
  validateEndpoints(manifest, manifestSchema.$defs.literalUpstreamPath.pattern);
  validateGrantTransports(manifest);
  validateQuota(manifest.id, manifest.quota);
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

function validateInputProfiles(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) => endpoint.inputProfile !== undefined);
  if (!endpoints.length) return;
  const fail = () => { throw new Error("inputProfile requires the exact PixVerse image-create contract and explicit registered video.generate models"); };
  if (manifest.id !== "pixverse" || endpoints.length !== 1) fail();
  const [id, endpoint] = endpoints[0], capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1" || capabilities.length !== 1
    || capabilities[0].id !== "video.generate" || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("video.generate"));
  if (!models.length || models.some(model => !["v6", "c1"].includes(model.upstream) || model.id !== `pixverse/${model.upstream}`
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

function validateBedrockConverse(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("aws_bedrock.converse"))
    || manifest.id === "aws-bedrock" && /\/converse(?:[-/]|$)/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("aws_bedrock.converse requires an explicitly selected Chat model, original regional SigV4 route and qualified unary or buffered EventStream contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "aws-bedrock" || manifest.class !== "custom_adapter" || endpoints.length > 2
    || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://bedrock-runtime.${region}.amazonaws.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "sig_v4" || scheme.service !== "bedrock" || scheme.regionParam !== "region" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || adapter?.request !== "aws_bedrock" || adapter?.response !== "aws_bedrock"
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    const stream = endpoint.requestFormat === "aws_bedrock.converse_stream";
    if (capabilities.length !== 1 || capabilities[0].id !== "llm.chat" || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
      || !["aws_bedrock.converse", "aws_bedrock.converse_stream"].includes(endpoint.requestFormat)
      || endpoint.responseFormat !== (stream ? "aws_bedrock.converse_eventstream" : "aws_bedrock.converse")
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase())
        || value !== (stream && name.toLowerCase() === "accept" ? "application/vnd.amazon.eventstream" : "application/json"))) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.chat"));
  if (!models.length || models.some(model => !model.upstream || model.upstream.length > 2048 || /[\x00-\x1f\x7f]/.test(model.upstream)
    || model.upstream.includes("${") || model.availability?.status === "upstream_alias" || model.pricing
    || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
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

function validateSageBatch(manifest) {
  const format = "levanto.sage_batch", capability = "llm.decisions.batch";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "levanto" && manifest.capabilities.some(item => item.endpoint === id && item.id === capability));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("levanto.sage_batch requires the finite Sage model, text/list decision metadata and exact batch endpoint"); };
  if (manifest.id !== "levanto" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://sage.levanto.ai")
    || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  const capabilities = manifest.capabilities.filter(item => item.endpoint === id);
  if (id !== "decisions_batch" || endpoint.path !== "/decide/batch"
    || endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || capabilities.length !== 1 || capabilities[0].id !== capability
    || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capability));
  if (models.length !== 1) fail();
  const model = models[0], facts = model.nativeCapabilities?.endpoints?.[id];
  if (model.id !== "levanto/levanto-sage-2" || model.upstream !== "levanto-sage-2" || model.availability?.status === "upstream_alias"
    || model.capabilities.some(value => !["llm.decisions", capability].includes(value))) fail();
  // Existing singular-runtime fixtures carry the closed batch endpoint without
  // support facts. Preserve omission; it must not manufacture batch support.
  if (facts && (facts.inference?.decision?.protocol !== "levanto-sage" || facts.inference.chat === true
    || facts.input?.length !== 2 || !facts.input.includes("text") || !facts.input.includes("json")
    || facts.inference.decision.limits?.image || facts.inference.decision.questions.choice?.maxImageOptions !== undefined)) fail();
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

function validateXaiSpeech(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("xai.tts"))
    || manifest.id === "xai" && (endpoint.path === "/v1/tts"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.speech")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("xai.tts requires model-less native unary speech, audio.binary output, canonical origin and original Bearer API-key auth without inferred tariffs"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "xai" || manifest.class !== "openai_compatible" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "xai.tts" || endpoint.responseFormat !== "audio.binary"
    || endpoint.auth || endpoint.requestHeaders?.length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
    || manifest.models?.entries?.some(model => model.capabilities?.includes("audio.speech"))) fail();
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

function validateNativeTranscription(manifest) {
  const contracts = {
    groq: { base: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", format: "groq.transcription" },
    mistral: { base: "https://api.mistral.ai", model: "voxtral-mini-latest", format: "mistral.transcription" },
    xai: { base: "https://api.x.ai", model: null, format: "xai.stt" },
  };
  const formats = Object.values(contracts).map(contract => contract.format);
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => formats.some(format => value.startsWith(format)))
    || Object.hasOwn(contracts, manifest.id) && (["/v1/audio/transcriptions", "/v1/stt"].includes(endpoint.path)
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.transcription")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Groq/Mistral transcription or xAI STT requires its finite multipart format, original Bearer origin and unpriced model contract"); };
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
  if (contract.model === null) { if (models.length) fail(); return; }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifestPaths, pluginPaths, output } = parseProviderCompilerArgs(process.argv.slice(2));
  const manifests = loadProviderManifestInputs(manifestPaths, pluginPaths);
  const snapshot = compileProviderSnapshot(manifests);
  const encoded = output ? `${JSON.stringify(snapshot)}\n` : `${JSON.stringify(snapshot, null, 2)}\n`;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, encoded);
  } else {
    process.stdout.write(encoded);
  }
}
