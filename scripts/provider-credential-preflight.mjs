import {
  liveProviderList,
  selectLiveProviderPlans,
} from "./provider-smoke-plan.mjs";
import {
  configuredProviderSecrets,
  providerSecretNames,
} from "./put-provider-secrets.mjs";

const providerSecretNameSet = new Set(providerSecretNames);

export function fakecoProviderCredentialPlan(target, plan, env = process.env) {
  if (target.environment !== "fakeco") return null;
  const mode = env.CLAWROUTER_PROVIDER_CREDENTIAL_MODE?.trim();
  if (!new Set(["upload", "existing"]).has(mode)) {
    throw new Error(
      "CLAWROUTER_PROVIDER_CREDENTIAL_MODE must be upload or existing before any Access mutation",
    );
  }
  const selectedProviders = selectLiveProviderPlans(plan, liveProviderList(env));
  const configuredSecrets = configuredProviderSecrets(env);
  const requirements = selectedProviders.map((provider) => {
    const secretNames = provider.requiredConfig.filter((name) =>
      providerSecretNameSet.has(name),
    );
    const configNames = provider.requiredConfig.filter(
      (name) => !providerSecretNameSet.has(name),
    );
    return { provider: provider.id, secretNames, configNames };
  });
  const missingConfig = requirements.flatMap(({ provider, configNames }) =>
    configNames
      .filter((name) => !providerConfigValue(name, env))
      .map((name) => `${provider}(${name})`),
  );
  if (missingConfig.length > 0) {
    throw new Error(
      `selected live providers are missing required non-secret config: ${missingConfig.join(",")}`,
    );
  }
  if (mode === "upload") {
    const missingSecrets = requirements.flatMap(({ provider, secretNames }) =>
      secretNames
        .filter((name) => !hasValue(configuredSecrets[name]))
        .map((name) => `${provider}(${name})`),
    );
    if (missingSecrets.length > 0) {
      throw new Error(
        `FakeCo provider credential upload requires runner values for selected live providers: ${missingSecrets.join(",")}`,
      );
    }
  }
  return {
    mode,
    providerIds: requirements.map(({ provider }) => provider),
    secretNames: [...new Set(requirements.flatMap(({ secretNames }) => secretNames))].sort(),
  };
}

export async function verifyExistingFakecoProviderCredentials(
  target,
  credentialPlan,
  env = process.env,
  fetchImpl = fetch,
) {
  if (target.environment !== "fakeco" || credentialPlan?.mode !== "existing") {
    return null;
  }
  if (credentialPlan.secretNames.length === 0) {
    return { names: [] };
  }
  const accountId = requiredValue(env, "CLOUDFLARE_ACCOUNT_ID");
  const token = requiredValue(env, "CLOUDFLARE_API_TOKEN");
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(target.workerName)}/secrets`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status === 404) {
    throw new Error(
      "FakeCo provider credential mode existing requires a deployed locked Worker; choose upload for the first deployment",
    );
  }
  if (!response.ok || body.success === false || !Array.isArray(body.result)) {
    throw new Error(
      `could not read existing FakeCo Worker secret bindings: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    );
  }
  const names = new Set(
    body.result
      .map((binding) => binding?.name)
      .filter((name) => typeof name === "string"),
  );
  const missing = credentialPlan.secretNames.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `existing FakeCo Worker is missing selected live provider secret bindings: ${missing.join(",")}; choose upload`,
    );
  }
  return { names: credentialPlan.secretNames };
}

function providerConfigValue(name, env) {
  if (name === "AZURE_OPENAI_DEPLOYMENT") {
    const model = env.CLAWROUTER_SMOKE_MODEL_AZURE_OPENAI?.trim();
    return env[name]?.trim() || model?.replace(/^azure-openai\//, "") || "";
  }
  return env[name]?.trim() || "";
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for provider credential preflight`);
  return value;
}
