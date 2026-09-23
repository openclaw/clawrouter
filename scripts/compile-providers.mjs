import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Validator } from "@cfworker/json-schema";
import { parse } from "yaml";

const optionalRateFields = ["cachedInputMicrosPerMillion", "cacheWriteInputMicrosPerMillion", "cacheWrite5mInputMicrosPerMillion", "cacheWrite1hInputMicrosPerMillion"];
const manifestSchema = JSON.parse(readFileSync(new URL("../providers/_schema/service-provider.schema.json", import.meta.url), "utf8"));
const manifestValidator = new Validator(manifestSchema, "2020-12");

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
        ...(model.codexModel ? { codexModel: model.codexModel } : {}),
        ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
        ...(model.requestParameters ? { requestParameters: model.requestParameters } : {}),
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
    ...(model.codexModel ? { codexModel: model.codexModel } : {}),
    ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
    ...(model.requestParameters ? { requestParameters: model.requestParameters } : {}),
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
      windows: (probe.windows ?? []).map((window) => normalizeQuotaWindow(window, true)),
    })),
  };
}

function normalizeQuotaWindow(window, probe) {
  const shared = { id: window.id, kind: window.kind, unit: window.unit ?? null, window: window.window ?? null, fixedLimit: window.fixedLimit ?? null, metricScale: window.metricScale ?? 1 };
  return probe ? {
    ...shared,
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
  return {
    effectiveAt: pricing.effectiveAt,
    source: pricing.source,
    ...normalizeRates(pricing),
    maxInputTokens: pricing.maxInputTokens,
    maxRequestInputTokens: pricing.maxRequestInputTokens ?? null,
    defaultMaxOutputTokens: pricing.defaultMaxOutputTokens,
    inputTokenOverhead: pricing.inputTokenOverhead ?? 1024,
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
  if (pricing.longContext && pricing.longContext.thresholdInputTokens >= pricing.maxInputTokens) throw new Error(`model ${modelId} has an invalid long-context threshold`);
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
  const configKeys = new Set(manifest.service?.configKeys ?? []);
  for (const key of manifest.service?.optionalConfigKeys ?? []) if (!configKeys.has(key)) throw new Error(`provider ${manifest.id} optional config key ${key} is not declared in configKeys`);
  for (const capability of manifest.capabilities) {
    if (!Object.hasOwn(manifest.endpoints, capability.endpoint)) throw new Error(`provider ${manifest.id} capability ${capability.id} references missing endpoint ${capability.endpoint}`);
  }
  for (const model of manifest.models?.entries ?? []) {
    for (const capability of model.capabilities ?? []) if (!manifest.capabilities.some((item) => item.id === capability)) throw new Error(`provider ${manifest.id} model ${model.id} references missing capability ${capability}`);
    if (model.codexModel !== undefined && (typeof model.codexModel !== "string" || !model.codexModel.trim())) throw new Error(`model ${model.id} codexModel must be a nonempty exact native slug`);
    for (const [id, parameters] of Object.entries(model.requestParameters ?? {})) {
      const endpoint = Object.hasOwn(manifest.endpoints, id) ? manifest.endpoints[id] : null;
      if (!endpoint || !manifest.capabilities.some((capability) => capability.endpoint === id && model.capabilities?.includes(capability.id))) throw new Error(`model ${model.id} requestParameters must reference a supported endpoint`);
      if (!["openai.chat_completions", "openai.responses"].includes(endpoint.requestFormat)) throw new Error(`model ${model.id} requestParameters requires an OpenAI Chat or Responses wire format`);
      if (parameters.defaultReasoningEffort !== undefined && !model.supportedReasoningEfforts?.includes(parameters.defaultReasoningEffort)) throw new Error(`model ${model.id} requestParameters default effort must belong to supportedReasoningEfforts`);
    }
    validatePricing(model.pricing, model.id);
  }
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    if (endpoint.modelPassthrough) {
      const capabilities = manifest.capabilities.filter((capability) => capability.endpoint === id).map((capability) => capability.id);
      if (!capabilities.length) throw new Error(`provider ${manifest.id} endpoint ${id} modelPassthrough requires a declared capability`);
      const ref = endpoint.modelPassthrough.pricingRef;
      if (ref !== undefined) {
        const models = (manifest.models?.entries ?? []).filter((model) => model.pricingRef === ref);
        if (models.length !== 1 || !models[0].pricing || !models[0].capabilities?.some((capability) => capabilities.includes(capability))) throw new Error(`provider ${manifest.id} endpoint ${id} modelPassthrough pricingRef must resolve to one priced endpoint-compatible model`);
      }
    }
    if (endpoint.websocket !== undefined && (endpoint.websocket !== "openai.responses" || endpoint.requestFormat !== "openai.responses" || endpoint.responseFormat !== "openai.responses" || endpoint.streaming !== "sse" || (endpoint.method ?? "POST") !== "POST" || endpoint.nativeProxy === false)) throw new Error(`provider ${manifest.id} endpoint ${id} websocket requires a native POST Responses SSE endpoint`);
    for (const placeholder of endpoint.path.matchAll(/\$\{([^}]+)\}/g)) {
      if (!(endpoint.pathParams ?? []).includes(placeholder[1])) throw new Error(`provider ${manifest.id} endpoint ${id} path parameter ${placeholder[1]} is not declared`);
    }
  }
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
  validateQuota(manifest.id, manifest.quota);
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
