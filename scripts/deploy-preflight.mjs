import {
  buildProviderSmokePlan,
  compileProviderSnapshot,
  liveProviderList,
  selectLiveProviderPlans,
} from "./provider-smoke-plan.mjs";

const requiredDeployEnv = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLAWROUTER_POLICY_KV_ID",
];

const errors = [];
for (const name of requiredDeployEnv) {
  if (!process.env[name]) {
    errors.push(`missing required deploy env: ${name}`);
  }
}

const plan = buildProviderSmokePlan(compileProviderSnapshot());
if (plan.targetCount !== plan.providerCount) {
  errors.push(`provider smoke plan is incomplete: ${plan.targetCount}/${plan.providerCount}`);
}

const baseUrl = process.env.CLAWROUTER_BASE_URL;
if (baseUrl) {
  try {
    new URL(baseUrl);
  } catch {
    errors.push("CLAWROUTER_BASE_URL must be a valid absolute URL");
  }
}

const liveProviders = liveProviderList();
let selectedProviders = [];
if (liveProviders.length > 0) {
  if (!baseUrl) {
    errors.push("CLAWROUTER_BASE_URL is required when live provider smoke is enabled");
  }
  if (!process.env.CLAWROUTER_SMOKE_KEY) {
    errors.push("CLAWROUTER_SMOKE_KEY is required when live provider smoke is enabled");
  }
  try {
    selectedProviders = selectLiveProviderPlans(plan, liveProviders);
  } catch (error) {
    errors.push(error.message);
  }
}

if (errors.length > 0) {
  console.error("clawrouter deploy preflight failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `clawrouter deploy preflight passed: providers=${plan.providerCount} smokeTargets=${plan.targetCount}`,
);
if (selectedProviders.length > 0) {
  console.log(`live provider smoke enabled: ${selectedProviders.map((p) => p.id).join(",")}`);
}
