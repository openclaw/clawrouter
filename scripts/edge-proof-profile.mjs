import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const edgeProof = Object.freeze(JSON.parse(readFileSync(new URL("../config/deployments/edge-proof.json", import.meta.url), "utf8")));
const fields = ["environment", "sourceSha", "sourceTree", "accountId", "runId", "createdAt", "expiresAt", "edgeOrigin", "upstreamOrigin", "resources", "custody"];
const resourceFields = ["workerName", "upstreamWorkerName", "policyKvNamespace", "policyKvId", "queueName", "queueId", "queueDlqName", "queueDlqId"];
function keys(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) throw new Error("edge-proof: incomplete or unknown plan fields");
}
function id(value, pattern) { if (typeof value !== "string" || !pattern.test(value)) throw new Error("edge-proof: invalid identity"); }
function origin(value) {
  if (typeof value !== "string") throw new Error("edge-proof: missing origin");
  const parsed = new URL(value);
  if (parsed.origin !== value || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(parsed.hostname) || /(?:^|\.)(?:localhost|example|invalid|test)$/.test(parsed.hostname) || /\.(?:example|invalid|test)\./.test(parsed.hostname) || /^\d+(?:\.\d+){3}$/.test(parsed.hostname)) throw new Error("edge-proof: public HTTPS origin required");
  if (parsed.hostname === "clawrouter.openclaw.ai" || /fakeco/i.test(parsed.hostname)) throw new Error("edge-proof: protected origin");
}
export function validatePlan(plan, now = Date.now()) {
  keys(plan, fields); keys(plan.resources, resourceFields);
  keys(plan.custody, ["owner", "accountId", "resourceNames", "exclusive", "nonproduction", "observedAt"]);
  if (plan.environment !== "edge-proof" || plan.sourceSha !== edgeProof.sourceSha || plan.sourceTree !== edgeProof.sourceTree) throw new Error("edge-proof: frozen source mismatch");
  id(plan.accountId, /^[a-f0-9]{32}$/); id(plan.runId, /^[a-f0-9]{32}$/);
  id(plan.custody.owner, /^[a-z][a-z0-9-]{2,63}$/);
  origin(plan.edgeOrigin); origin(plan.upstreamOrigin);
  if (plan.edgeOrigin === plan.upstreamOrigin) throw new Error("edge-proof: origins must be distinct");
  const edgeHost = new URL(plan.edgeOrigin).hostname, upstreamHost = new URL(plan.upstreamOrigin).hostname;
  const accountSubdomain = edgeHost.slice((edgeProof.workerName + ".").length);
  if (!edgeHost.startsWith(edgeProof.workerName + ".") || !/^[a-z0-9-]+\.workers\.dev$/.test(accountSubdomain) || upstreamHost !== `${edgeProof.upstreamWorkerName}.${accountSubdomain}`) throw new Error("edge-proof: dedicated same-account workers.dev origins required");
  for (const name of ["workerName", "upstreamWorkerName", "policyKvNamespace", "queueName", "queueDlqName"]) if (plan.resources[name] !== edgeProof[name]) throw new Error("edge-proof: resource name mismatch");
  for (const name of ["policyKvId", "queueId", "queueDlqId"]) id(plan.resources[name], /^[a-f0-9]{32}$/);
  if (new Set([plan.resources.policyKvId, plan.resources.queueId, plan.resources.queueDlqId]).size !== 3) throw new Error("edge-proof: resource identity collision");
  if (![plan.createdAt, plan.expiresAt, plan.custody.observedAt].every(Number.isSafeInteger) || plan.createdAt > now || plan.createdAt < now - edgeProof.limits.runMs || plan.expiresAt <= now || plan.expiresAt - plan.createdAt > edgeProof.limits.runMs || plan.custody.observedAt > now || plan.custody.observedAt < plan.createdAt) throw new Error("edge-proof: stale plan or custody");
  const names = [edgeProof.workerName, edgeProof.upstreamWorkerName, edgeProof.policyKvNamespace, edgeProof.queueName, edgeProof.queueDlqName].sort();
  if (plan.custody.accountId !== plan.accountId || plan.custody.exclusive !== true || plan.custody.nonproduction !== true || !Array.isArray(plan.custody.resourceNames) || JSON.stringify([...plan.custody.resourceNames].sort()) !== JSON.stringify(names)) throw new Error("edge-proof: incomplete resource custody");
  return structuredClone(plan);
}
export function planDigest(plan) { return createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }
export function edgeTarget(env) {
  if (!env.CLAWROUTER_EDGE_PROOF_PLAN) throw new Error("edge-proof: explicit plan file required");
  const plan = validatePlan(JSON.parse(readFileSync(env.CLAWROUTER_EDGE_PROOF_PLAN, "utf8")));
  if (env.CLOUDFLARE_ACCOUNT_ID !== undefined && env.CLOUDFLARE_ACCOUNT_ID !== plan.accountId) throw new Error("edge-proof: ambient account conflict");
  for (const name of ["CLAWROUTER_WORKER_NAME", "CLAWROUTER_BASE_URL", "CLAWROUTER_POLICY_KV_ID", "CLAWROUTER_USAGE_QUEUE", "CLAWROUTER_USAGE_DLQ", "CLAWROUTER_CONTENT_BUCKET"]) if (env[name] !== undefined) throw new Error("edge-proof: ambient deployment override refused");
  return { ...edgeProof, baseUrl: plan.edgeOrigin, contentBucketName: null, contentRetentionDefault: false, plan };
}
export function renderEdgeConfig(plan, kind, main) {
  validatePlan(plan);
  if (!["edge", "upstream"].includes(kind) || main !== `${kind}.mjs`) throw new Error("edge-proof: invalid projection");
  const template = readFileSync(new URL(`../wrangler.edge-proof${kind === "upstream" ? "-upstream" : ""}.toml`, import.meta.url), "utf8");
  const values = { MAIN: main, ACCOUNT: plan.accountId, KV: plan.resources.policyKvId, RUN: plan.runId, EXPIRES: plan.expiresAt, SOURCE: plan.sourceSha, TREE: plan.sourceTree, UPSTREAM: plan.upstreamOrigin, EDGE: plan.edgeOrigin };
  const output = template.replace(/@@([A-Z]+)@@/g, (_, name) => { if (!(name in values)) throw new Error("edge-proof: unknown template token"); return String(values[name]); });
  if (/@@|\[assets\]|\[triggers\]|\[\[r2_buckets\]\]|\[\[containers\]\]|\[build\]/.test(output)) throw new Error("edge-proof: forbidden deployment surface");
  return output;
}
