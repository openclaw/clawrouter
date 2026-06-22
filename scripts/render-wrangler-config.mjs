import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const source = process.argv[2] ?? "wrangler.toml";
const target = process.argv[3] ?? ".wrangler.generated.toml";

const workerName = process.env.CLAWROUTER_WORKER_NAME ?? "clawrouter-edge";
const queueName = process.env.CLAWROUTER_USAGE_QUEUE ?? "clawrouter-usage";
const queueDlqName =
  process.env.CLAWROUTER_USAGE_DLQ ?? "clawrouter-usage-dead-letter";
const contentBucketName =
  process.env.CLAWROUTER_CONTENT_BUCKET ?? "clawrouter-content";
const kvId = process.env.CLAWROUTER_POLICY_KV_ID;
const kvPreviewId = process.env.CLAWROUTER_POLICY_KV_PREVIEW_ID ?? kvId;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const strict = process.env.CLAWROUTER_STRICT_CONFIG !== "0";
const omitRoutes = process.env.CLAWROUTER_OMIT_ROUTES === "1";
const workerVars = {
  CLAWROUTER_ACCESS_TEAM_DOMAIN: process.env.CLAWROUTER_ACCESS_TEAM_DOMAIN,
  CLAWROUTER_ACCESS_AUD: process.env.CLAWROUTER_ACCESS_AUD,
  CLAWROUTER_ACCESS_ADMIN_EMAILS: process.env.CLAWROUTER_ACCESS_ADMIN_EMAILS,
  CLAWROUTER_ACCESS_ADMIN_DOMAINS: process.env.CLAWROUTER_ACCESS_ADMIN_DOMAINS,
  CLAWROUTER_ACCESS_DEFAULT_TENANT: process.env.CLAWROUTER_ACCESS_DEFAULT_TENANT,
  AZURE_OPENAI_DEPLOYMENT: providerModelSuffix(
    process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.CLAWROUTER_SMOKE_MODEL_AZURE_OPENAI,
    "azure-openai/",
  ),
};

if (strict && !kvId) {
  throw new Error("CLAWROUTER_POLICY_KV_ID is required to render deploy config");
}

let config = readFileSync(source, "utf8");
config = config.replace(/^name = .+$/m, `name = "${workerName}"`);
config = config.replace(/^queue = ".+"$/gm, `queue = "${queueName}"`);
config = config.replace(
  /^dead_letter_queue = ".+"$/gm,
  `dead_letter_queue = "${queueDlqName}"`,
);
config = config.replace(
  /^bucket_name = ".+"$/gm,
  `bucket_name = "${contentBucketName}"`,
);
if (omitRoutes) {
  config = removeTomlArrayBlocks(config, "routes");
  config = ensureTopLevelSetting(config, "workers_dev", "false");
  config = ensureTopLevelSetting(config, "preview_urls", "false");
}

if (kvId) {
  config = `${config.trimEnd()}

[[kv_namespaces]]
binding = "POLICY_KV"
id = "${kvId}"
preview_id = "${kvPreviewId}"
`;
}
if (accountId && !/^account_id = /m.test(config)) {
  config = config.replace(/^name = .+$/m, (line) => `${line}\naccount_id = "${accountId}"`);
}

const renderedVars = Object.entries(workerVars)
  .filter(([, value]) => value)
  .map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
if (renderedVars.length > 0) {
  config = `${config.trimEnd()}

[vars]
${renderedVars.join("\n")}
`;
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, config);
console.log(`rendered ${target}`);

function providerModelSuffix(value, prefix) {
  const normalized = value?.trim();
  return normalized?.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function removeTomlArrayBlocks(input, name) {
  const header = `[[${name}]]`;
  const lines = input.split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== header) {
      output.push(lines[index]);
      continue;
    }
    index += 1;
    while (index < lines.length && !lines[index].trimStart().startsWith("[")) {
      index += 1;
    }
    index -= 1;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function ensureTopLevelSetting(input, key, value) {
  const pattern = new RegExp(`^${key}\\s*=`, "m");
  if (pattern.test(input)) {
    return input;
  }
  return input.replace(/^name = .+$/m, (line) => `${line}\n${key} = ${value}`);
}
