import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export class SmokeKeyInspectionUnavailableError extends Error {}

export function buildProviderSmokePlan(snapshot, env = process.env) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const providerPlans = providers.map((provider) => {
    const optionalConfigKeys = new Set([
      ...(provider.optional_config_keys ?? []),
      ...splitCsv(env.CLAWROUTER_OPTIONAL_CONFIG_KEYS),
    ]);
    const optionalConfig = provider.config_keys.filter(
      (key) => optionalConfigKeys.has(key) || optionalAuthConfig(provider, key),
    );
    const requiredConfig = provider.config_keys.filter((key) => !optionalConfig.includes(key));
    const missingConfig = requiredConfig.filter((key) => !env[key]);
    const target = smokeTarget(provider, env);
    const oauth = provider.auth_schemes.some((scheme) => scheme.startsWith("oauth:"));
    const oauthGrantReady =
      !oauth || env[`CLAWROUTER_OAUTH_READY_${envName(provider.id)}`] === "1";
    const configPresent = missingConfig.length === 0;
    return {
      id: provider.id,
      class: provider.class,
      servicePlatform: provider.service_platform,
      serviceKind: provider.service_kind,
      meter: provider.meter ?? null,
      authSchemes: provider.auth_schemes,
      requiredConfig,
      optionalConfig,
      missingConfig,
      configPresent,
      configured: configPresent && oauthGrantReady,
      oauthGrantRequired: oauth,
      oauthGrantReady,
      target,
    };
  });
  return {
    version: "clawrouter.provider-smoke-plan.v1",
    providerCount: providerPlans.length,
    targetCount: providerPlans.filter((plan) => plan.target).length,
    configuredCount: providerPlans.filter((plan) => plan.configured).length,
    providers: providerPlans,
  };
}

export async function runLiveProviderSmokes({
  baseUrl,
  smokeKey,
  plan,
  liveProviders,
  onResult = async () => {},
}) {
  if (!baseUrl || !smokeKey || liveProviders.length === 0) {
    return [];
  }
  const selected = selectLiveProviderPlans(plan, liveProviders);
  const results = [];
  const failures = [];
  for (const provider of selected) {
    const result = await runProviderTarget(baseUrl, smokeKey, provider);
    results.push(result);
    if (result.providerAttempted) {
      try {
        await onResult(result);
      } catch (error) {
        failures.push(`${provider.id} health record failed: ${errorMessage(error)}`);
      }
    }
    if (result.status !== "verified") {
      failures.push(`${provider.id} smoke failed: ${result.error}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  return results;
}

export function selectLiveProviderPlans(plan, liveProviders) {
  const allowAll = liveProviders.includes("all");
  if (!allowAll) {
    const planById = new Map(plan.providers.map((provider) => [provider.id, provider]));
    const invalid = liveProviders.filter((id) => !planById.get(id)?.target);
    if (invalid.length > 0) {
      throw new Error(`unknown or unsmokable live providers: ${invalid.join(",")}`);
    }
  }
  return plan.providers.filter((provider) => {
    return provider.target && (allowAll || liveProviders.includes(provider.id));
  });
}

export function liveProviderList(env = process.env) {
  const providers = splitCsv(env.CLAWROUTER_SMOKE_LIVE_PROVIDERS);
  if (env.CLAWROUTER_SMOKE_OPENAI === "1" && !providers.includes("openai")) {
    providers.push("openai");
  }
  return providers;
}

export async function inspectSmokeKeyProviderAccess({
  baseUrl,
  smokeKey,
  liveProviders,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/key/inspect`, {
      headers: { authorization: `Bearer ${smokeKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SmokeKeyInspectionUnavailableError(
      `could not reach /v1/key/inspect: ${error.message}`,
    );
  }
  if (!response.ok) {
    let errorCode = "";
    try {
      const body = await response.json();
      errorCode = body?.error?.code ?? "";
    } catch {}
    if (response.status === 400 && errorCode === "invalid_key_syntax") {
      throw new Error(`/v1/key/inspect failed with 400: invalid_key_syntax`);
    }
    throw new SmokeKeyInspectionUnavailableError(
      `/v1/key/inspect failed with ${response.status}${errorCode ? `: ${errorCode}` : ""}`,
    );
  }
  let inspection;
  try {
    inspection = await response.json();
  } catch (error) {
    throw new SmokeKeyInspectionUnavailableError(
      `/v1/key/inspect returned invalid JSON: ${error.message}`,
    );
  }
  if (inspection?.verification === "policy_store_unavailable") {
    throw new SmokeKeyInspectionUnavailableError(
      "/v1/key/inspect reported policy_store_unavailable",
    );
  }
  if (inspection?.verified !== true) {
    throw new Error(
      `/v1/key/inspect rejected the smoke key: ${inspection?.verification ?? "unknown"}`,
    );
  }
  if (!Array.isArray(inspection.providers)) {
    throw new SmokeKeyInspectionUnavailableError(
      "/v1/key/inspect did not expose the smoke key provider scope",
    );
  }
  const denied = liveProviders.filter(
    (provider) => inspection.providers.length > 0 && !inspection.providers.includes(provider),
  );
  if (denied.length > 0) {
    throw new Error(`smoke key policy does not allow live providers: ${denied.join(",")}`);
  }
  return inspection;
}

export function compileProviderSnapshot() {
  const providerFiles = readdirSync("providers")
    .filter((file) => file.endsWith(".provider.yaml"))
    .sort()
    .map((file) => `providers/${file}`);
  const result = spawnSync(
    process.execPath,
    ["scripts/compile-providers.mjs", ...providerFiles],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.status !== 0) {
    throw new Error("provider snapshot compile failed");
  }
  return JSON.parse(result.stdout);
}

export function summarizePlan(plan) {
  const lines = [
    `providers=${plan.providerCount} smokeTargets=${plan.targetCount} configured=${plan.configuredCount}`,
  ];
  for (const provider of plan.providers) {
    const config = provider.configPresent
      ? "configured"
      : `missing=${provider.missingConfig.join(",")}`;
    const target = provider.target
      ? `${provider.target.kind}:${provider.target.route}`
      : "no-target";
    const grant = provider.oauthGrantRequired
      ? provider.oauthGrantReady
        ? " oauth=ready"
        : " oauth=grant-required"
      : "";
    lines.push(`${provider.id}\t${provider.class}\t${config}${grant}\t${target}${provider.target?.unresolved ? ` unresolved=${provider.target.unresolved}` : ""}`);
  }
  return lines.join("\n");
}

function smokeTarget(provider, env) {
  const chatEndpointId = provider.capabilities.find((capability) => capability.id === "llm.chat")?.endpoint;
  const chatEndpoint = provider.endpoints.find((endpoint) => endpoint.id === chatEndpointId);
  if (chatEndpoint && supportsOpenAiCompatibleProxy(provider, chatEndpoint)) {
    const model = smokeModel(provider, chatEndpoint, env);
    if (model) {
      return {
        kind: "openai_chat",
        route: "/v1/chat/completions",
        method: "POST",
        model,
        body: {
          model,
          messages: [{ role: "user", content: "reply with ok" }],
          max_tokens: 16,
        },
      };
    }
  }

  const endpoint = smokeEndpoint(provider);
  if (!endpoint || !supportsManifestProxy(provider, endpoint)) {
    return null;
  }
  const model = manifestSmokeModelOverride(provider, endpoint, env)
    ?? modelsForEndpoint(provider, endpoint).find((model) => !model.upstream.includes("${"))?.upstream;
  if (["openai.chat_completions", "openai.responses", "openai.embeddings", "anthropic.messages", "cohere.chat", "cohere.embed", "google.generate_content", "aws_bedrock.invoke"].includes(endpoint.request_format) && !model) return null;
  const pathParams = Object.fromEntries(
    endpoint.path_params.map((param) => [param, samplePathParam(provider, param, model, env)]),
  );
  const upstreamMethod = smokeMethod(endpoint);
  const body = sampleBody(provider, endpoint, upstreamMethod, model, env);
  const unresolvedParams = endpoint.path_params.filter(param => !["model", "deployment"].includes(param)
    && !(endpoint.request_format === "cloudflare_ai_gateway.universal" && ["account", "gateway"].includes(param)));
  return {
    kind: "manifest_proxy",
    route: `/v1/proxy/${provider.id}/${endpoint.id}`,
    method: "POST",
    upstreamMethod,
    endpoint: endpoint.id,
    ...(body === null || unresolvedParams.length ? { unresolved: endpoint.request_format === "replicate.prediction_get"
      ? "prediction lookup requires an existing prediction ID; no smoke fixture is declared"
      : unresolvedParams.length ? `path parameters require a smoke fixture: ${unresolvedParams.join(", ")}`
      : `no smoke request template for ${endpoint.request_format}` } : {}),
    envelope: {
      method: upstreamMethod,
      pathParams,
      query: {},
      body: body ?? {},
    },
  };
}

function modelsForEndpoint(provider, endpoint) {
  const capabilities = provider.capabilities.filter((capability) => capability.endpoint === endpoint.id);
  return provider.models.filter((model) => capabilities.some((capability) => model.capabilities.includes(capability.id)));
}

function smokeModel(provider, endpoint, env) {
  const override = providerSmokeModelOverride(provider, endpoint, env);
  if (override) {
    return override;
  }
  const models = modelsForEndpoint(provider, endpoint);
  return (models.find((model) => !model.upstream.includes("${")) ?? models[0])?.id ?? null;
}

function providerSmokeModelOverride(provider, endpoint, env) {
  const providerName = envName(provider.id);
  const override =
    env[`CLAWROUTER_SMOKE_MODEL_${providerName}`] ||
    env[`${providerName}_SMOKE_MODEL`] ||
    null;
  if (!override) {
    return null;
  }
  const catalogModel = provider.models.find((model) => model.id === override);
  if (catalogModel) {
    if (!modelsForEndpoint(provider, endpoint).includes(catalogModel)) {
      throw new Error(`smoke model override for ${provider.id} must support ${endpoint.id}`);
    }
    return override;
  }
  const matchesPrefix = (provider.routing.modelPrefixes ?? []).some((prefix) => {
    return override.startsWith(prefix) && override.length > prefix.length;
  });
  if (!matchesPrefix) {
    throw new Error(
      `smoke model override for ${provider.id} must match a catalog id or provider model prefix`,
    );
  }
  return override;
}

function smokeEndpoint(provider) {
  // Prefer the declared operation, not a provider or endpoint spelling. Counting
  // shares the Messages format but avoids generating output during a smoke.
  for (const [format, capability] of [
    ["anthropic.messages", "llm.count_tokens"],
    ["openai.chat_completions", "llm.chat"],
    ["anthropic.messages", "llm.messages"],
    ["cohere.chat", "llm.chat"],
    ["google.generate_content", "llm.generate"],
    ["aws_bedrock.invoke", "llm.invoke"],
    ["tavily.search", "web.search"],
    ["openai.responses", "llm.responses"],
    ["openai.embeddings", "llm.embeddings"],
    ["cohere.embed", "llm.embeddings"],
    ["tavily.extract", "web.extract"],
  ]) {
    const preferred = provider.endpoints.find(endpoint => endpoint.request_format === format
      && provider.capabilities.some(item => item.endpoint === endpoint.id && item.id === capability));
    if (preferred) return preferred;
  }
  const nonStreaming = provider.endpoints.filter((endpoint) => !endpoint.streaming);
  return (
    nonStreaming.find((endpoint) => endpoint.method === "GET") ??
    nonStreaming.find((endpoint) => endpoint.methods.includes("GET")) ??
    nonStreaming[0] ??
    provider.endpoints[0] ??
    null
  );
}

function smokeMethod(endpoint) {
  return endpoint.methods.includes("GET") ? "GET" : endpoint.method ?? "POST";
}

function supportsOpenAiCompatibleProxy(provider, endpoint) {
  return (
    endpoint.request_format === "openai.chat_completions" &&
    endpoint.response_format === "openai.chat_completions" &&
    provider.class === "openai_compatible" &&
    provider.adapter.request === "openai" &&
    provider.adapter.response === "openai" &&
    templatesSupportedByConfig(provider, provider.base_urls.default ?? "") &&
    openAiEndpointPathSupported(endpoint) &&
    Object.values(provider.adapter.injectQuery ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    Object.values(provider.adapter.injectHeaders ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    supportsEdgeAuth(provider)
  );
}

function supportsManifestProxy(provider, endpoint) {
  return (
    templatesSupportedByConfig(provider, provider.base_urls.default ?? "") &&
    Object.values(provider.adapter.injectHeaders ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    Object.values(provider.adapter.injectQuery ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    Object.values(endpoint.headers ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    Object.values(endpoint.query ?? {}).every((value) =>
      templatesSupportedByConfig(provider, value),
    ) &&
    supportsEdgeAuth(provider)
  );
}

function supportsEdgeAuth(provider) {
  return provider.auth.schemes.every((scheme) => {
    if (scheme.type === "bearer") {
      return scheme.required === false || providerHasSecretCandidate(provider, scheme.secretKind);
    }
    if (["api_key", "query_api_key"].includes(scheme.type)) {
      return providerHasSecretCandidate(provider, scheme.secretKind);
    }
    if (scheme.type === "cloudflare_binding") {
      return true;
    }
    if (scheme.type === "oauth") {
      return Boolean(scheme.provider || scheme.tokenRef);
    }
    if (scheme.type === "sig_v4") {
      const regionParam = scheme.regionParam ?? "region";
      return (
        Boolean(scheme.service) &&
        templateHasConfigKey(provider, "access_key_id") &&
        templateHasConfigKey(provider, "secret_access_key") &&
        templateHasConfigKey(provider, regionParam)
      );
    }
    return false;
  });
}

function optionalAuthConfig(provider, key) {
  return (provider.auth?.schemes ?? []).some((scheme) => {
    return (
      scheme.type === "bearer" &&
      scheme.required === false &&
      secretBindingCandidates(provider, scheme.secretKind).includes(key)
    );
  });
}

function templatesSupportedByConfig(provider, value) {
  return templatePlaceholders(value).every((name) => templateHasConfigKey(provider, name));
}

function templateHasConfigKey(provider, name) {
  return templateBindingCandidates(provider, name).some((candidate) => {
    return provider.config_keys.includes(candidate);
  });
}

function templateBindingCandidates(provider, name) {
  const normalizedName = normalizeBindingSegment(name);
  const candidates = [];
  pushDeclaredTemplateCandidate(provider, candidates, normalizedName);
  pushDeclaredTemplateCandidate(
    provider,
    candidates,
    `${normalizeBindingSegment(provider.id)}_${normalizedName}`,
  );
  pushDeclaredTemplateCandidate(
    provider,
    candidates,
    `${normalizeBindingSegment(provider.service_platform)}_${normalizedName}`,
  );
  for (const key of provider.config_keys) {
    if (key === normalizedName || key.endsWith(`_${normalizedName}`)) {
      pushUnique(candidates, key);
    }
  }
  return candidates;
}

function pushDeclaredTemplateCandidate(provider, candidates, candidate) {
  if (provider.config_keys.includes(candidate)) {
    pushUnique(candidates, candidate);
  }
}

function providerHasSecretCandidate(provider, secretKind) {
  return secretBindingCandidates(provider, secretKind).some((candidate) => {
    return provider.config_keys.includes(candidate);
  });
}

function secretBindingCandidates(provider, secretKind) {
  const candidates = [];
  for (const key of provider.config_keys) {
    if (configKeyMatchesSecretKind(key, secretKind)) {
      candidates.push(key);
    }
  }
  candidates.push(secretBindingName(provider.id, secretKind));
  return [...new Set(candidates)].sort();
}

function configKeyMatchesSecretKind(key, secretKind) {
  if (secretKind === "api_token") {
    return key.endsWith("_API_TOKEN") || key.endsWith("_TOKEN");
  }
  if (secretKind === "api_key") {
    return key.endsWith("_API_KEY") || key.endsWith("_API_TOKEN");
  }
  return key.toUpperCase().endsWith(secretKind.toUpperCase());
}

function secretBindingName(providerId, secretKind) {
  return `${normalizeBindingSegment(providerId)}_${normalizeBindingSegment(secretKind)}`;
}

function openAiEndpointPathSupported(endpoint) {
  const placeholders = templatePlaceholders(endpoint.path);
  return (
    placeholders.length === 0 ||
    (endpoint.path_params.length === 1 &&
      ["model", "deployment"].includes(endpoint.path_params[0]) &&
      placeholders.every((name) => endpoint.path_params.includes(name)))
  );
}

function templatePlaceholders(value) {
  return [...String(value ?? "").matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
}

function normalizeBindingSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toUpperCase();
}

function pushUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function samplePathParam(provider, param, model, env) {
  if (param === "model" || param === "deployment") {
    return model;
  }
  if (param === "account") {
    return provider.id === "cloudflare-ai-gateway" ? env.CLOUDFLARE_ACCOUNT_ID ?? "account" : "account";
  }
  if (param === "gateway") {
    return provider.id === "cloudflare-ai-gateway" ? env.CLOUDFLARE_AI_GATEWAY_ID ?? "gateway" : "gateway";
  }
  return "smoke";
}

function sampleBody(provider, endpoint, method, model, env) {
  const format = endpoint.request_format;
  const graphql = format.includes("graphql") || provider.adapter.request?.includes("graphql");
  // GET/HEAD have no body. GraphQL GET still needs a schema-specific query
  // fixture; the existing POST query below is retained without claiming that.
  if (!methodAllowsBody(method)) return graphql ? null : {};
  if (graphql) return { query: "{ viewer { id } }" };
  if (format === "tavily.search") {
    return { query: "OpenClaw", max_results: 1 };
  }
  if (format === "tavily.extract") {
    return { urls: ["https://example.com"] };
  }
  if (format === "firecrawl.scrape") {
    return { url: "https://example.com", formats: ["markdown"] };
  }
  if (format === "google.generate_content") {
    return { contents: [{ parts: [{ text: "reply with ok" }] }] };
  }
  if (format === "anthropic.messages" || format === "openai.chat_completions") {
    const body = {
      model,
      messages: [{ role: "user", content: "reply with ok" }],
    };
    if (format !== "anthropic.messages" || !provider.capabilities.some(item => item.endpoint === endpoint.id && item.id === "llm.count_tokens")) {
      body.max_tokens = 16;
    }
    return body;
  }
  if (format === "cohere.chat") {
    return { model, messages: [{ role: "user", content: "reply with ok" }] };
  }
  if (format === "openai.responses") {
    return { model, input: "reply with ok", max_output_tokens: 16 };
  }
  if (format === "openai.embeddings") {
    return { model, input: "OpenClaw" };
  }
  if (format === "cohere.embed") {
    return { model, texts: ["OpenClaw"], input_type: "search_query", embedding_types: ["float"] };
  }
  if (format === "aws_bedrock.invoke") {
    const override = provider.id === "aws-bedrock" ? env.CLAWROUTER_SMOKE_BODY_AWS_BEDROCK : null;
    if (override) {
      let parsed;
      try {
        parsed = JSON.parse(override);
      } catch {
        throw new Error("CLAWROUTER_SMOKE_BODY_AWS_BEDROCK must contain valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("CLAWROUTER_SMOKE_BODY_AWS_BEDROCK must contain a JSON object");
      }
      return parsed;
    }
    return {
      schemaVersion: "messages-v1",
      messages: [{ role: "user", content: [{ text: "reply with ok" }] }],
      inferenceConfig: { maxTokens: 16 },
    };
  }
  if (format === "cloudflare_ai_gateway.universal") {
    // These legacy operator overrides belong only to the bundled gateway;
    // a renamed manifest must never inherit another provider's inline key.
    const builtin = provider.id === "cloudflare-ai-gateway";
    const step = {
      provider: "openai",
      endpoint: "chat/completions",
      query: {
        model: builtin ? env.CLOUDFLARE_AI_GATEWAY_SMOKE_MODEL ?? "openai/gpt-4.1-mini" : "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: "reply with ok" }],
        max_tokens: 8,
      },
    };
    if (builtin && env.CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY) {
      step.headers = {
        Authorization: `Bearer ${env.CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      };
    }
    return [step];
  }
  return null;
}

function manifestSmokeModelOverride(provider, endpoint, env) {
  const raw = env[`CLAWROUTER_SMOKE_MODEL_${envName(provider.id)}`];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`smoke model override for ${provider.id} is invalid`);
  }
  const catalog = provider.models.find((model) => model.id === value || model.upstream === value);
  if (catalog) {
    if (!modelsForEndpoint(provider, endpoint).includes(catalog)) {
      throw new Error(`smoke model override for ${provider.id} must support ${endpoint.id}`);
    }
    if (!catalog.upstream.includes("${")) return catalog.upstream;
  }
  const prefix = (provider.routing.modelPrefixes ?? []).find((candidate) => value.startsWith(candidate));
  return prefix ? value.slice(prefix.length) : value;
}

function methodAllowsBody(method) {
  return !["GET", "HEAD"].includes((method ?? "POST").toUpperCase());
}

export async function runProviderTarget(baseUrl, smokeKey, provider) {
  const target = provider.target;
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  if (target.unresolved) return {
    provider: provider.id, status: "failed", checkedAt, latencyMs: 0,
    statusCode: null, error: target.unresolved, providerAttempted: false,
  };
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${target.route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${smokeKey}`,
        "content-type": "application/json",
        "x-request-id": `smoke_${provider.id}_${startedAt}`,
      },
      body: JSON.stringify(target.kind === "openai_chat" ? target.body : target.envelope),
    });
  } catch {
    return {
      provider: provider.id,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: null,
      error: "transport failure",
      providerAttempted: false,
    };
  }
  const providerAttempted =
    response.headers.get("x-clawrouter-upstream-provider") === provider.id;
  try {
    await response.arrayBuffer();
  } catch {
    return {
      provider: provider.id,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      error: "response body read failure",
      providerAttempted,
    };
  }
  return {
    provider: provider.id,
    status: response.ok && providerAttempted ? "verified" : "failed",
    checkedAt,
    latencyMs: Date.now() - startedAt,
    statusCode: response.status,
    error: response.ok && providerAttempted
      ? null
      : providerAttempted
        ? `HTTP ${response.status}`
        : `gateway HTTP ${response.status} before upstream response`,
    providerAttempted,
  };
}

function splitCsv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function envName(value) {
  return value.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(values) {
  const out = { json: false, strict: false };
  for (const value of values) {
    if (value === "--json") {
      out.json = true;
    } else if (value === "--strict") {
      out.strict = true;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildProviderSmokePlan(compileProviderSnapshot());
  if (args.strict && plan.targetCount !== plan.providerCount) {
    throw new Error(`missing provider smoke targets: ${plan.providerCount - plan.targetCount}`);
  }
  console.log(args.json ? JSON.stringify(plan, null, 2) : summarizePlan(plan));
}
