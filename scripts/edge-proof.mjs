import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { edgeProof, validatePlan, renderEdgeConfig, planDigest } from "./edge-proof-profile.mjs";
import { buildCapsule } from "./edge-proof-build.mjs";

export const cases = ["stream", "streamSimple"].flatMap(api => ["eof", "preabort", "partial_abort", "provider_error"].map(role => ({ id: `${api === "stream" ? "stream" : "simple"}_${role}`, api, role })));
export function newRuntimeAuthority() {
  const token = () => randomBytes(32).toString("hex");
  const credentials = { admin: token(), cases: cases.map(row => ({ ...row, proxy: token(), upstream: token(), control: token() })) };
  if (new Set([credentials.admin, ...credentials.cases.flatMap(row => [row.proxy, row.upstream, row.control])]).size !== 25) throw new Error("edge-proof: credential collision");
  return credentials;
}
export function secretProjections(authority) {
  if (!authority || !Array.isArray(authority.cases) || JSON.stringify(authority.cases.map(({ id, api, role }) => ({ id, api, role }))) !== JSON.stringify(cases)) throw new Error("edge-proof: authority case mismatch");
  const tokens = [authority.admin, ...authority.cases.flatMap(row => [row.proxy, row.upstream, row.control])];
  if (tokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) || new Set(tokens).size !== 25) throw new Error("edge-proof: authority token mismatch");
  return {
    edge: JSON.stringify(authority),
    upstream: JSON.stringify(authority.cases.map(({ id, role, upstream, control }) => ({ id, role, upstream, control }))),
    sdk: JSON.stringify(authority.cases.map(({ id, api, role, proxy, control }) => ({ id, api, role, proxy, control }))),
  };
}
export function deploymentInventory(plan) {
  validatePlan(plan);
  return {
    classification: "instrumented-frozen-candidate-edge-composition",
    planDigest: planDigest(plan), sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sdkSha: edgeProof.sdkSha,
    workers: [edgeProof.workerName, edgeProof.upstreamWorkerName],
    kv: edgeProof.policyKvNamespace, queues: [edgeProof.queueName, edgeProof.queueDlqName],
    edgeSqliteClasses: ["BudgetLedgerObject", "UsageLedgerObject", "PolicyBindingIndexObject", "GrantCredentialObject", "ProofRecords"],
    upstreamSqliteClasses: ["UpstreamRecords"], excluded: edgeProof.excluded,
    credentialConsumers: { wrangler: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], edge: ["EDGE_PROOF_SECRET"], upstream: ["EDGE_PROOF_SECRET"], ephemeralSdk: ["CLAWROUTER_EDGE_PROOF_CASES"] },
    protocol: "record-actual-negotiated-protocol; H1 is eligible",
    cloud: "UNRUN", sdk: "UNRUN", production: "not deployed",
  };
}
export function teardownGuard(plan, proof) {
  // Validation only; resource deletion needs a separate destructive lease and
  // fresh remote reference checks by its executor. A local plan is not custody.
  validatePlan(plan, plan.custody.observedAt);
  if (!proof || proof.runId !== plan.runId || proof.sourceSha !== edgeProof.sourceSha || proof.accountId !== plan.accountId || JSON.stringify(proof.resources) !== JSON.stringify(plan.resources)) throw new Error("edge-proof: teardown identity mismatch");
  if (!Number.isSafeInteger(proof.observedAt) || proof.observedAt > Date.now() || Date.now() - proof.observedAt > 60000) throw new Error("edge-proof: fresh teardown evidence required");
  for (const name of ["allOriginalsJoined", "syntheticCredentialsRevoked", "usageQueueDrained", "deadLetterQueueDrained", "noForeignReferences", "separateDestructiveLease"]) if (proof[name] !== true) throw new Error("edge-proof: teardown prerequisite missing");
  if (proof.pending !== 0 || proof.failedCleanup !== 0) throw new Error("edge-proof: live or failed original cleanup");
  return { eligibleForIndependentReview: true, deletionExecuted: false };
}
export async function main(argv) {
  const [action = "plan", ...args] = argv;
  if (!["plan", "render", "build"].includes(action) || args.includes("--execute")) throw new Error("edge-proof: this code-only route does not activate, provision or delete cloud resources");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--profile", "--source-sha", "--plan-file", "--output"].includes(key) || !value || value.startsWith("--") || key in options) throw new Error("edge-proof: unknown or duplicate option");
    options[key] = value;
  }
  if (options["--profile"] !== "edge-proof" || options["--source-sha"] !== edgeProof.sourceSha || !options["--plan-file"]) throw new Error("edge-proof: explicit profile, frozen source and resource plan required");
  const plan = validatePlan(JSON.parse(await readFile(options["--plan-file"], "utf8")));
  if (action === "plan") return deploymentInventory(plan);
  if (!options["--output"]) throw new Error("edge-proof: explicit owned output required");
  const output = resolve(options["--output"]);
  if (action === "render") {
    for (const kind of ["edge", "upstream"]) await writeFile(join(output, `${kind}.toml`), renderEdgeConfig(plan, kind, `${kind}.mjs`), { flag: "wx", mode: 0o600 });
    return { rendered: true, cloud: "UNRUN", planDigest: planDigest(plan) };
  }
  const receipt = await buildCapsule(process.cwd(), output);
  await writeFile(join(output, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { built: true, sourceSha: receipt.sourceSha, sourceTree: receipt.sourceTree, sourceFiles: receipt.sourceFiles.length, cloud: "UNRUN", sdk: "UNRUN" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch { console.error("edge-proof: offline preparation refused; no cloud action attempted"); process.exitCode = 1; }
}
