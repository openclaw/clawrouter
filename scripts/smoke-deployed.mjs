import {
  buildProviderSmokePlan,
  liveProviderList,
  runLiveProviderSmokes,
  summarizePlan,
} from "./provider-smoke-plan.mjs";

const baseUrl = required(process.env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL").replace(/\/$/, "");
const smokeKey = process.env.CLAWROUTER_SMOKE_KEY;

await expectOk(`${baseUrl}/v1/health`, "health");
await expectHtml(`${baseUrl}/`, "root console");
await expectHtml(`${baseUrl}/dashboard`, "dashboard console");
const providers = await expectOk(`${baseUrl}/v1/providers`, "providers");
if (!Array.isArray(providers.providers) || providers.providers.length < 20) {
  throw new Error("provider snapshot is unexpectedly small");
}
const routes = await expectOk(`${baseUrl}/v1/routes`, "route catalog");
expectRouteCatalog(routes, "route catalog");
const aliasedRoutes = await expectOk(`${baseUrl}/api/route`, "route catalog alias");
expectRouteCatalog(aliasedRoutes, "route catalog alias");
const session = await expectOk(`${baseUrl}/v1/session`, "session");
if (typeof session.authenticated !== "boolean" || typeof session.role !== "string") {
  throw new Error("session response is missing authenticated/role fields");
}
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

async function expectHtml(url, name) {
  const response = await fetch(url, { headers: { accept: "text/html" } });
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${name} returned ${contentType || "no content-type"}, expected text/html`);
  }
  const body = await response.text();
  if (!body.includes("ClawRouter")) {
    throw new Error(`${name} did not return the ClawRouter console`);
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

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
