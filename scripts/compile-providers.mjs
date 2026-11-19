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

import { validateBedrockConverse, validateBedrockEmbeddings } from "./provider-validation/aws-bedrock.mjs";
import { validateBasetenSystemOne } from "./provider-validation/baseten.mjs";
import { validateSageBatch } from "./provider-validation/levanto.mjs";
import { validateDeepSeekSearch } from "./provider-validation/deepseek.mjs";
import { validateXaiImages, validateXaiSpeech } from "./provider-validation/xai.mjs";
import { validateGradiumSpeech } from "./provider-validation/gradium.mjs";
import { validateNativeTranscription, validateOpenRouterTranscription, validateDeepgramPrerecorded } from "./provider-validation/transcription.mjs";
import { validateInputProfiles } from "./provider-validation/pixverse.mjs";

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
