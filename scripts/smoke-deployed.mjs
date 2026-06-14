import {
  buildProviderSmokePlan,
  liveProviderList,
  runLiveProviderSmokes,
  summarizePlan,
} from "./provider-smoke-plan.mjs";

const baseUrl = required(process.env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL").replace(/\/$/, "");
const smokeKey = process.env.CLAWROUTER_SMOKE_KEY;

await expectOk(`${baseUrl}/v1/health`, "health");
await expectRedirect(`${baseUrl}/`, "root redirect", "/dashboard");
await expectRedirectOrAccessGate(`${baseUrl}/dashboard`, "dashboard redirect", "/dashboard/catalog");
await expectAccessGate(`${baseUrl}/dashboard/catalog`, "catalog access gate");
await expectRedirect(`${baseUrl}/catalog`, "legacy catalog redirect", "/dashboard/catalog");
const providers = await expectOk(`${baseUrl}/v1/providers`, "providers");
if (!Array.isArray(providers.providers) || providers.providers.length < 20) {
  throw new Error("provider snapshot is unexpectedly small");
}
const routes = await expectOk(`${baseUrl}/v1/routes`, "route catalog");
expectRouteCatalog(routes, "route catalog");
const aliasedRoutes = await expectOk(`${baseUrl}/api/route`, "route catalog alias");
expectRouteCatalog(aliasedRoutes, "route catalog alias");
await expectAccessGate(`${baseUrl}/v1/session`, "session access gate");
await expectAccessGate(`${baseUrl}/v1/playground/v1/chat/completions`, "playground access gate");
const plan = buildProviderSmokePlan(providers);
if (plan.targetCount !== plan.providerCount) {
  throw new Error(`provider smoke plan is incomplete: ${plan.targetCount}/${plan.providerCount}`);
}
console.log(summarizePlan(plan));

if (smokeKey) {
  const inspect = await fetch(`${baseUrl}/v1/key/inspect`, {
    headers: { authorization: `Bearer ${smokeKey}` },
  });
  if (!inspect.ok) {
    throw new Error(`/v1/key/inspect failed with ${inspect.status}`);
  }
}

const liveProviders = liveProviderList();
if (liveProviders.length > 0) {
  if (!smokeKey) {
    throw new Error("CLAWROUTER_SMOKE_KEY is required for live provider smoke");
  }
  const results = await runLiveProviderSmokes({ baseUrl, smokeKey, plan, liveProviders });
  console.log(`live provider smoke passed: ${results.map((result) => result.provider).join(",")}`);
}

console.log("deployed smoke passed");

async function expectOk(url, name) {
  const response = await fetch(url);
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
  if (response.status >= 300 && response.status < 400 && looksLikeAccessRedirect(actual)) {
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  assertAccessGateResponse(response, contentType, body, name);
}

async function expectAccessGate(url, name) {
  const response = await fetch(url, {
    headers: { accept: "text/html,application/json" },
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  assertAccessGateResponse(response, contentType, body, name);
}

function assertAccessGateResponse(response, contentType, body, name) {
  if (contentType.includes("application/json")) {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    if (json?.error?.code === "access_session_required") {
      throw new Error(
        `${name} reached ClawRouter's fallback 401; Cloudflare Access is not protecting the console path`,
      );
    }
  }
  if (response.ok && contentType.includes("text/html") && body.includes("ClawRouter")) {
    throw new Error(`${name} returned the ClawRouter console without Cloudflare Access`);
  }
  if (response.status >= 300 && response.status < 400) {
    return;
  }
  if ((response.status === 401 || response.status === 403) && !body.includes("ClawRouter")) {
    return;
  }
  throw new Error(`${name} returned ${response.status}, expected Cloudflare Access challenge`);
}

function looksLikeAccessRedirect(location) {
  return location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/");
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

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
