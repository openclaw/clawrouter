import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "yaml";

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
    timeout_ms: endpoint.timeoutMs ?? null,
  }));
  const auth = {
    schemes: (manifest.auth.schemes ?? []).map(normalizeAuthScheme),
    authorization: normalizeAuthorization(manifest.auth.authorization),
    refresh: normalizeRefresh(manifest.auth.refresh),
    grantTransports: manifest.auth.grantTransports ?? {},
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
    pricing_ref: model.pricingRef ?? null,
    pricing: model.pricing ? normalizePricing(model.pricing) : null,
  }));
  const billing = {
    meter: manifest.billing?.meter ?? null,
    dimensions: manifest.billing?.dimensions ?? [],
    counters: manifest.billing?.counters ?? [],
  };
  return {
    id: manifest.id,
    display_name: manifest.displayName,
    status: manifest.status ?? "stable",
    class: manifest.class ?? "openai_compatible",
    service_platform: manifest.service?.platform ?? manifest.id,
    service_kind: manifest.service?.kind ?? "api_provider",
    config_keys: manifest.service?.configKeys ?? [],
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
  };
}

function normalizePricing(pricing) {
  return {
    effectiveAt: pricing.effectiveAt,
    source: pricing.source,
    inputMicrosPerMillion: pricing.inputMicrosPerMillion,
    outputMicrosPerMillion: pricing.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: pricing.cachedInputMicrosPerMillion ?? null,
    cacheWrite5mInputMicrosPerMillion: pricing.cacheWrite5mInputMicrosPerMillion ?? null,
    cacheWrite1hInputMicrosPerMillion: pricing.cacheWrite1hInputMicrosPerMillion ?? null,
    maxInputTokens: pricing.maxInputTokens,
    maxRequestInputTokens: pricing.maxRequestInputTokens ?? null,
    defaultMaxOutputTokens: pricing.defaultMaxOutputTokens,
    inputTokenOverhead: pricing.inputTokenOverhead ?? 1024,
    longContext: pricing.longContext ? {
      thresholdInputTokens: pricing.longContext.thresholdInputTokens,
      inputMicrosPerMillion: pricing.longContext.inputMicrosPerMillion,
      outputMicrosPerMillion: pricing.longContext.outputMicrosPerMillion,
      cachedInputMicrosPerMillion: pricing.longContext.cachedInputMicrosPerMillion ?? null,
      cacheWrite5mInputMicrosPerMillion: pricing.longContext.cacheWrite5mInputMicrosPerMillion ?? null,
      cacheWrite1hInputMicrosPerMillion: pricing.longContext.cacheWrite1hInputMicrosPerMillion ?? null,
    } : null,
  };
}

function validateManifest(manifest) {
  if (manifest.schema !== "clawrouter.service-provider.v1") throw new Error(`provider ${manifest.id ?? "?"} has unsupported schema ${manifest.schema}`);
  if (!manifest.id) throw new Error("provider id is empty");
  if (!manifest.auth?.schemes?.length) throw new Error(`provider ${manifest.id} has no auth schemes`);
  if (!manifest.baseUrls?.default) throw new Error(`provider ${manifest.id} is missing baseUrls.default`);
  if (!Object.keys(manifest.endpoints ?? {}).length) throw new Error(`provider ${manifest.id} has no endpoints`);
  if (!(manifest.capabilities ?? []).length) throw new Error(`provider ${manifest.id} has no capabilities`);
  for (const capability of manifest.capabilities) {
    if (!manifest.endpoints[capability.endpoint]) throw new Error(`provider ${manifest.id} capability ${capability.id} references missing endpoint ${capability.endpoint}`);
  }
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    if (!endpoint.path?.startsWith("/")) throw new Error(`provider ${manifest.id} endpoint ${id} path must start with /`);
    for (const placeholder of endpoint.path.matchAll(/\$\{([^}]+)\}/g)) {
      if (!(endpoint.pathParams ?? []).includes(placeholder[1])) throw new Error(`provider ${manifest.id} endpoint ${id} path parameter ${placeholder[1]} is not declared`);
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
    extraParams: value.extraParams ?? {},
  };
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).toUpperCase()))];
}
