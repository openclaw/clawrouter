import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const source = process.argv[2] ?? "wrangler.toml";
const target = process.argv[3] ?? ".wrangler.generated.toml";

const workerName = process.env.CLAWROUTER_WORKER_NAME ?? "clawrouter-edge";
const queueName = process.env.CLAWROUTER_USAGE_QUEUE ?? "clawrouter-usage";
const kvId = process.env.CLAWROUTER_POLICY_KV_ID;
const kvPreviewId = process.env.CLAWROUTER_POLICY_KV_PREVIEW_ID ?? kvId;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const strict = process.env.CLAWROUTER_STRICT_CONFIG !== "0";

if (strict && !kvId) {
  throw new Error("CLAWROUTER_POLICY_KV_ID is required to render deploy config");
}

let config = readFileSync(source, "utf8");
config = config.replace(/^name = .+$/m, `name = "${workerName}"`);
config = config.replace(/queue = ".+"/, `queue = "${queueName}"`);

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

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, config);
console.log(`rendered ${target}`);
