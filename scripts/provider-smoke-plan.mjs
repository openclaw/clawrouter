import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_OPTIONAL_CONFIG_KEYS = new Set([
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS",
]);

export class SmokeKeyInspectionUnavailableError extends Error {}

export function buildProviderSmokePlan(snapshot, env = process.env) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const optionalConfigKeys = new Set([
    ...DEFAULT_OPTIONAL_CONFIG_KEYS,
    ...splitCsv(env.CLAWROUTER_OPTIONAL_CONFIG_KEYS),
  ]);
  const providerPlans = providers.map((provider) => {
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
    "cargo",
    ["run", "-p", "clawrouter", "--", "provider", "compile", ...providerFiles],
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
    lines.push(`${provider.id}\t${provider.class}\t${config}${grant}\t${target}`);
  }
  return lines.join("\n");
}

function smokeTarget(provider, env) {
  if (supportsOpenAiCompatibleProxy(provider)) {
    const model = smokeModel(provider, env);
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
  const pathParams = Object.fromEntries(
    endpoint.path_params.map((param) => [param, samplePathParam(provider, endpoint, param, env)]),
  );
  const upstreamMethod = smokeMethod(endpoint);
  return {
    kind: "manifest_proxy",
    route: `/v1/proxy/${provider.id}/${endpoint.id}`,
    method: "POST",
    upstreamMethod,
    endpoint: endpoint.id,
    envelope: {
      method: upstreamMethod,
      pathParams,
      query: {},
      body: sampleBody(provider, endpoint, upstreamMethod, env),
    },
  };
}

function smokeModel(provider, env) {
  const override = providerSmokeModelOverride(provider, env);
  if (override) {
    return override;
  }
  const direct = provider.models.find((model) => {
    return model.capabilities.includes("llm.chat") && !model.upstream.includes("${");
  });
  if (direct) {
    return direct.id;
  }
  const prefix = provider.routing.modelPrefixes?.[0];
  if (prefix) {
    return `${prefix}smoke-model`;
  }
  return provider.models.find((model) => !model.upstream.includes("${"))?.id ?? null;
}

function providerSmokeModelOverride(provider, env) {
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
    if (!catalogModel.capabilities.includes("llm.chat")) {
      throw new Error(`smoke model override for ${provider.id} must support llm.chat`);
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
  const preferredId = preferredEndpointId(provider.id);
  if (preferredId) {
    const preferred = provider.endpoints.find((endpoint) => endpoint.id === preferredId);
    if (preferred) {
      return preferred;
    }
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

function preferredEndpointId(providerId) {
  return {
    cohere: "chat",
    tavily: "search",
  }[providerId];
}

function supportsOpenAiCompatibleProxy(provider) {
  return (
    provider.class === "openai_compatible" &&
    provider.adapter.request === "openai" &&
    provider.adapter.response === "openai" &&
    templatesSupportedByConfig(provider, provider.base_urls.default ?? "") &&
    provider.endpoints.every(openAiEndpointPathSupported) &&
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

function samplePathParam(provider, endpoint, param, env) {
  if (param === "path") {
    return "status";
  }
  if (param === "method") {
    return "status";
  }
  if (param === "model") {
    return (
      provider.models.find((model) => !model.upstream.includes("${"))?.upstream ?? "smoke-model"
    );
  }
  if (param === "account") {
    return env.CLOUDFLARE_ACCOUNT_ID ?? "account";
  }
  if (param === "gateway") {
    return env.CLOUDFLARE_AI_GATEWAY_ID ?? "gateway";
  }
  if (param.endsWith("_id")) {
    return "smoke";
  }
  return "smoke";
}

function sampleBody(provider, endpoint, method, env) {
  if (!methodAllowsBody(method)) {
    return {};
  }
  if (
    endpoint.request_format.includes("graphql") ||
    provider.adapter.request.includes("graphql")
  ) {
    return { query: "{ viewer { id } }" };
  }
  if (provider.id === "tavily" && endpoint.id === "search") {
    return { query: "OpenClaw", max_results: 1 };
  }
  if (provider.id === "firecrawl" && endpoint.id === "scrape") {
    return { url: "https://example.com", formats: ["markdown"] };
  }
  if (provider.id === "google-gemini") {
    return { contents: [{ parts: [{ text: "reply with ok" }] }] };
  }
  if (provider.id === "anthropic") {
    return {
      model: provider.models.find((model) => !model.upstream.includes("${"))?.upstream,
      max_tokens: 16,
      messages: [{ role: "user", content: "reply with ok" }],
    };
  }
  if (provider.id === "cohere") {
    return { model: "command", messages: [{ role: "user", content: "reply with ok" }] };
  }
  if (provider.id === "cloudflare-ai-gateway") {
    const step = {
      provider: "openai",
      endpoint: "chat/completions",
      query: {
        model: env.CLOUDFLARE_AI_GATEWAY_SMOKE_MODEL ?? "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: "reply with ok" }],
        max_tokens: 8,
      },
    };
    if (env.CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY) {
      step.headers = {
        Authorization: `Bearer ${env.CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      };
    }
    return [step];
  }
  return {};
}

function methodAllowsBody(method) {
  return !["GET", "HEAD"].includes((method ?? "POST").toUpperCase());
}

export async function runProviderTarget(baseUrl, smokeKey, provider) {
  const target = provider.target;
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
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
