import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const providerSecretNames = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS",
  "AZURE_OPENAI_ENDPOINT",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_GATEWAY_ID",
  "CLOUDFLARE_API_TOKEN",
  "COHERE_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIREWORKS_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "HUGGINGFACE_API_TOKEN",
  "MINIMAX_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_SITE_URL",
  "PERPLEXITY_API_KEY",
  "REPLICATE_API_TOKEN",
  "TAVILY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
];

const providerSecretSources = {
  CLOUDFLARE_ACCOUNT_ID: "CLAWROUTER_PROVIDER_CLOUDFLARE_ACCOUNT_ID",
  CLOUDFLARE_AI_GATEWAY_ID: "CLAWROUTER_PROVIDER_CLOUDFLARE_AI_GATEWAY_ID",
  CLOUDFLARE_API_TOKEN: "CLAWROUTER_PROVIDER_CLOUDFLARE_API_TOKEN",
};

export function configuredProviderSecrets(env = process.env) {
  const secrets = Object.fromEntries(
    providerSecretNames
      .map((name) => [name, env[providerSecretSources[name] ?? name]])
      .filter(([, value]) => typeof value === "string" && value.length > 0),
  );
  if (!secrets.OPENROUTER_API_KEY) {
    delete secrets.OPENROUTER_SITE_URL;
  }
  return secrets;
}

export function putProviderSecrets({ env = process.env, dryRun = false } = {}) {
  const secrets = configuredProviderSecrets(env);
  const names = Object.keys(secrets);
  if (names.length === 0) {
    throw new Error("no provider secrets are configured");
  }
  if (dryRun) {
    console.log(`provider secrets ready: count=${names.length} names=${names.join(",")}`);
    return;
  }

  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "secret", "bulk", "--config", ".wrangler.generated.toml"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      input: JSON.stringify(secrets),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`wrangler secret bulk failed with status ${result.status}`);
  }
  console.log(`provider secrets uploaded: count=${names.length} names=${names.join(",")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  putProviderSecrets({ dryRun: process.argv.includes("--dry-run") });
}
