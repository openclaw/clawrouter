import { buildProviderSmokePlan, runLiveProviderSmokes, summarizePlan } from "./provider-smoke-plan.mjs";

const baseUrl = required(process.env.CLAWROUTER_BASE_URL, "CLAWROUTER_BASE_URL").replace(/\/$/, "");
const smokeKey = process.env.CLAWROUTER_SMOKE_KEY;

await expectOk(`${baseUrl}/v1/health`, "health");
const providers = await expectOk(`${baseUrl}/v1/providers`, "providers");
if (!Array.isArray(providers.providers) || providers.providers.length < 20) {
  throw new Error("provider snapshot is unexpectedly small");
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

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function liveProviderList() {
  const providers = (process.env.CLAWROUTER_SMOKE_LIVE_PROVIDERS ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  if (process.env.CLAWROUTER_SMOKE_OPENAI === "1" && !providers.includes("openai")) {
    providers.push("openai");
  }
  return providers;
}
