import {
  buildProviderSmokePlan,
  inspectSmokeKeyProviderAccess,
  liveProviderList,
  runLiveProviderSmokes,
  selectLiveProviderPlans,
  summarizePlan,
} from "./provider-smoke-plan.mjs";
import { assertAccessGateResponse } from "./smoke-access-gate.mjs";

const baseUrl = required(process.env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL").replace(/\/$/, "");
const smokeKey = process.env.CLAWROUTER_SMOKE_KEY;

await expectOk(`${baseUrl}/v1/health`, "health");
await expectRedirect(`${baseUrl}/`, "root redirect", "/dashboard");
await expectRedirectOrAccessGate(`${baseUrl}/dashboard`, "dashboard redirect", "/dashboard/catalog");
await expectAccessGate(`${baseUrl}/dashboard/catalog`, "catalog access gate");
await expectRedirect(`${baseUrl}/catalog`, "legacy catalog redirect", "/dashboard/catalog");
const providers = await expectOk(`${baseUrl}/v1/providers`, "providers");
if (!Array.isArray(providers.providers) || providers.providers.length < 19) {
  throw new Error("provider snapshot is unexpectedly small");
}
const routes = await expectOk(`${baseUrl}/v1/routes`, "route catalog");
expectRouteCatalog(routes, "route catalog");
const aliasedRoutes = await expectOk(`${baseUrl}/api/route`, "route catalog alias");
expectRouteCatalog(aliasedRoutes, "route catalog alias");
await expectAccessGate(`${baseUrl}/v1/session`, "session access gate");
await expectClientAuthGate(`${baseUrl}/v1/entitlements`, "entitlements Worker auth gate");
await expectAccessGate(`${baseUrl}/v1/playground/v1/chat/completions`, "playground access gate");
await expectAccessGate(`${baseUrl}/v1/oauth/callback`, "OAuth callback access gate");
await expectAccessGate(
  `${baseUrl}/v1/admin/upstream-grants/policies/smoke/openai/authorize`,
  "OAuth authorization access gate",
  { method: "POST" },
);
await expectClientAuthGate(`${baseUrl}/v1/models`, "models client auth gate");
await expectClientAuthGate(`${baseUrl}/v1/catalog`, "catalog client auth gate");
await expectClientAuthGate(
  `${baseUrl}/v1/native/openai/v1/responses`,
  "native proxy client auth gate",
  { method: "POST" },
);
const plan = buildProviderSmokePlan(providers);
if (plan.targetCount !== plan.providerCount) {
  throw new Error(`provider smoke plan is incomplete: ${plan.targetCount}/${plan.providerCount}`);
}
console.log(summarizePlan(plan));

const liveProviders = liveProviderList();
if (liveProviders.length === 0) {
  throw new Error("CLAWROUTER_SMOKE_LIVE_PROVIDERS must name at least one golden provider");
}
if (!smokeKey) {
  throw new Error("CLAWROUTER_SMOKE_KEY is required for live provider smoke");
}
const clientCatalog = await expectAuthenticatedOk(
  `${baseUrl}/v1/catalog`,
  "credential-scoped client catalog",
  smokeKey,
);
expectClientCatalog(clientCatalog);
const selectedLiveProviders = selectLiveProviderPlans(plan, liveProviders).map(
  (provider) => provider.id,
);
await inspectSmokeKeyProviderAccess({
  baseUrl,
  smokeKey,
  liveProviders: selectedLiveProviders,
});
const results = await runLiveProviderSmokes({
  baseUrl,
  smokeKey,
  plan,
  liveProviders,
  onResult: recordProviderHealth,
});
console.log(`live provider smoke passed: ${results.map((result) => result.provider).join(",")}`);

console.log("deployed smoke passed");

async function expectOk(url, name) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}`);
  }
  return response.json();
}

async function expectAuthenticatedOk(url, name, token) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}`);
  }
  return response.json();
}

async function expectRedirect(url, name, location) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`${name} returned ${response.status}, expected redirect`);
  }
  const actual = response.headers.get("location") ?? "";
  if (actual !== location) {
    throw new Error(`${name} redirected to ${actual || "<missing>"}, expected ${location}`);
  }
}

async function expectRedirectOrAccessGate(url, name, location) {
  const response = await fetch(url, {
    headers: { accept: "text/html,application/json" },
    redirect: "manual",
  });
  const actual = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && actual === location) {
    return;
  }
  if (response.status >= 300 && response.status < 400 && looksLikeAccessRedirect(actual, url)) {
    return;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${name} redirected to ${actual || "<missing>"}, expected ${location} or Cloudflare Access`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  assertAccessGateResponse(response, contentType, body, name);
}

async function expectAccessGate(url, name, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "text/html,application/json" },
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  assertAccessGateResponse(response, contentType, body, name);
}

async function expectClientAuthGate(url, name, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "text/html,application/json" },
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && looksLikeAccessRedirect(location, url)) {
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if ((response.status === 401 || response.status === 403) && contentType.includes("application/json")) {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    if (["client_auth_required", "invalid_proxy_key", "access_session_required"].includes(json?.error?.code)) {
      return;
    }
  }
  throw new Error(`${name} returned ${response.status}, expected a ClawRouter or Cloudflare Access auth challenge`);
}

function looksLikeAccessRedirect(location, requestUrl) {
  if (location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/")) {
    return true;
  }
  try {
    return new URL(location, requestUrl).origin !== new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

function expectRouteCatalog(catalog, name) {
  if (!Array.isArray(catalog.openaiCompatible) || catalog.openaiCompatible.length === 0) {
    throw new Error(`${name} is missing OpenAI-compatible routes`);
  }
  if (!Array.isArray(catalog.manifestProxy) || catalog.manifestProxy.length === 0) {
    throw new Error(`${name} is missing manifest proxy routes`);
  }
  if (!catalog.manifestProxy.some((route) => route.route === "/v1/proxy/tavily/search")) {
    throw new Error(`${name} is missing the Tavily manifest route`);
  }
}

function expectClientCatalog(catalog) {
  if (!Array.isArray(catalog.providers) || catalog.providers.length === 0) {
    throw new Error("credential-scoped client catalog is empty");
  }
  for (const provider of catalog.providers) {
    if (typeof provider.openAiCompatible !== "boolean") {
      throw new Error(`client catalog provider ${provider.id} is missing openAiCompatible`);
    }
    if (!Array.isArray(provider.routes)) {
      throw new Error(`client catalog provider ${provider.id} is missing routes`);
    }
    for (const route of provider.routes) {
      if (typeof route.requestFormat !== "string" || typeof route.responseFormat !== "string") {
        throw new Error(`client catalog provider ${provider.id} has an incomplete route contract`);
      }
    }
  }
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function recordProviderHealth(result) {
  const token = required(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  const accountId = required(process.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  const namespaceId = required(process.env.CLAWROUTER_POLICY_KV_ID, "CLAWROUTER_POLICY_KV_ID");
  const key = encodeURIComponent(`health/providers/${result.provider}`);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerId: result.provider,
        status: result.status,
        checkedAt: result.checkedAt,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error: result.error,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to record ${result.provider} health with ${response.status}`);
  }
}
