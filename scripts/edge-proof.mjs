import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, realpath, readlink, readdir, lstat } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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

const script = fileURLToPath(import.meta.url);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const refuse = code => { throw new Error(`edge-proof: ${code}`); };
const namespaceNames = ["net", "pid", "mnt", "user"];

// Construct, never merge, the child environment. This is credential/environment
// isolation, not filesystem confinement from other files readable by this UID.
export function packagingEnvironment(root, node = process.execPath) {
  return {
    PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp"),
    WRANGLER_LOG_PATH: join(root, "logs"), WRANGLER_SEND_METRICS: "false",
    DO_NOT_TRACK: "1", NO_COLOR: "1", LANG: "C.UTF-8",
  };
}
async function prepareEnvironment(root) {
  const env = packagingEnvironment(root);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "WRANGLER_LOG_PATH"]) await mkdir(env[key], { recursive: true, mode: 0o700 });
  return env;
}
export function validateNamespace(evidence, parent, builder = false) {
  if (evidence.platform !== "linux" || evidence.uid !== 0 || (builder ? !(evidence.pid > 1 && evidence.ppid === 1) : evidence.pid !== 1)) refuse("private-init-required");
  for (const name of namespaceNames) {
    const pattern = new RegExp(`^${name}:\\[\\d+\\]$`);
    if (!pattern.test(evidence.namespaces?.[name]) || !pattern.test(parent[name]) || evidence.namespaces[name] === parent[name]) refuse("namespace-mismatch");
  }
  if (JSON.stringify(evidence.interfaces) !== '["lo"]') refuse("external-interface");
  if (evidence.routes4.length || evidence.routes6.some(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 10 || fields[9] !== "lo" || ![0, 2, 4].every(index => /^[a-f0-9]{32}$/i.test(fields[index])) || ![1, 3].every(index => /^[a-f0-9]{2}$/i.test(fields[index])) || ![5, 6, 7, 8].every(index => /^[a-f0-9]{8}$/i.test(fields[index])) || fields[2] !== "0".repeat(32) || fields[3] !== "00" || fields[4] !== "0".repeat(32)) return true;
    // Linux may expose its unreachable ::/0 sentinel on lo. It is not an
    // external route: RTF_REJECT is required. A real loopback /128 is allowed.
    const reject = (Number.parseInt(fields[8], 16) & 0x200) !== 0;
    return !(reject && fields[0] === "0".repeat(32) && fields[1] === "00") &&
      !(fields[0] === "0".repeat(31) + "1" && fields[1] === "80");
  })) refuse("external-route");
  if (evidence.sharedMount !== false || evidence.procMounted !== true) refuse("private-proc-required");
  return true;
}
async function namespaceIdentity() {
  return Object.fromEntries(await Promise.all(namespaceNames.map(async name => [name, await readlink(`/proc/self/ns/${name}`)])));
}
async function namespaceEvidence() {
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n");
  const devices = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").slice(2);
  return {
    namespaces: await namespaceIdentity(), platform: process.platform, pid: process.pid, ppid: process.ppid, uid: process.getuid(),
    interfaces: devices.map(line => line.split(":")[0].trim()).sort(),
    routes4: (await readFile("/proc/net/route", "utf8")).trim().split("\n").slice(1).filter(Boolean),
    routes6: (await readFile("/proc/net/ipv6_route", "utf8")).trim().split("\n").filter(Boolean),
    sharedMount: mounts.some(line => /\b(?:shared|master|propagate_from):\d+/.test(line)),
    procMounted: mounts.some(line => line.split(" ")[4] === "/proc" && line.includes(" - proc ")),
  };
}
export function namespaceArguments(node, args) {
  // A private PID namespace makes PID 1's death a kernel-enforced descendant
  // boundary, including grandchildren that create their own process groups.
  // --mount-proc mounts only inside the explicitly private mount namespace.
  return ["--user", "--map-root-user", "--net", "--mount", "--propagation", "private", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "--", node, ...args];
}
export async function privateProcesses() {
  if (process.platform !== "linux" || process.pid !== 1) refuse("process-census-outside-private-init");
  const rows = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || name === "1") continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (!/^[RSDZTWXIKt]$/.test(fields[0]) || !/^\d+$/.test(fields[19]) || ![fields[1], fields[2]].every(value => /^\d+$/.test(value))) refuse("private-process-state-unknown");
      rows.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19], state: fields[0] });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return rows;
}

// Keep the original ChildProcess close outcome. No launcher signal-to-zero
// mapping; output remains private and bounded. Timers supervise, never make a
// failed command pass. The outer PID namespace also contains escaped groups.
export async function runOwnedProcess(command, args, { cwd, env, timeoutMs = 60000, graceMs = 1000, sample = async () => [], spawnProcess = spawn, signalSource = process } = {}) {
  const result = { code: null, signal: null, timedOut: false, interrupted: false, closed: false, errors: [], observed: new Map(), stdout: "", stderr: "" };
  let child, escalation, bytes = 0, sampling = false, stopped = false, finished = false;
  const stop = signal => {
    if (!child?.pid || finished) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") result.errors.push(error); }
    if (!escalation) escalation = setTimeout(() => stop("SIGKILL"), graceMs);
  };
  const interrupted = signal => { result.interrupted = true; stop(signal); };
  const onInt = () => interrupted("SIGINT"), onTerm = () => interrupted("SIGTERM");
  const observe = async () => {
    if (sampling) return;
    sampling = true;
    try {
      for (const row of await sample()) result.observed.set(`${row.pid}:${row.start}`, row);
      if (result.observed.size > 512) refuse("process-monitor-capacity");
    }
    catch (error) { result.errors.push(error); stop("SIGTERM"); }
    finally { sampling = false; }
  };
  const append = key => data => {
    bytes += data.length;
    if (bytes > 1024 * 1024) { if (!stopped) result.errors.push(new Error("edge-proof: output-capacity")); stopped = true; stop("SIGTERM"); }
    else result[key] += data.toString("utf8");
  };
  let deadline, monitor;
  try {
    child = spawnProcess(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", append("stdout")); child.stderr.on("data", append("stderr"));
    signalSource.on("SIGINT", onInt); signalSource.on("SIGTERM", onTerm);
    deadline = setTimeout(() => { result.timedOut = true; stop("SIGTERM"); }, timeoutMs);
    monitor = setInterval(() => { void observe(); }, 20);
    await new Promise(resolveClose => {
      child.on("error", error => { result.errors.push(error); });
      child.once("close", (code, signal) => { result.code = code; result.signal = signal; result.closed = true; resolveClose(); });
    });
  } catch (error) { result.errors.push(error); }
  finally {
    finished = true;
    clearTimeout(deadline); clearInterval(monitor); clearTimeout(escalation);
    signalSource.removeListener("SIGINT", onInt); signalSource.removeListener("SIGTERM", onTerm);
  }
  // Join any already-started observation before reading the final process set.
  while (sampling) await new Promise(resolveTick => setTimeout(resolveTick, 1));
  try { result.remaining = await sample(); } catch (error) { result.errors.push(error); result.remaining = null; }
  return result;
}
export function requireProcessSuccess(result) {
  if (!result.closed || result.code !== 0 || result.signal !== null || result.timedOut || result.interrupted || result.errors.length || !Array.isArray(result.remaining) || result.remaining.length) {
    throw new AggregateError([new Error("edge-proof: child-not-qualified"), ...result.errors], "edge-proof: child-not-qualified");
  }
}
export function verifyDryRun(result, bytes, expectedHash) {
  requireProcessSuccess(result);
  if (!result.stdout.split(/\r?\n/).some(line => line.trim() === "--dry-run: exiting now.") || !Buffer.isBuffer(bytes) || !bytes.length || digest(bytes) !== expectedHash) refuse("dry-run-marker-or-bundle-mismatch");
  return { code: result.code, signal: result.signal, closed: true, sha256: digest(bytes), observedProcesses: result.observed.size };
}
export function compareCapsules(first, second) {
  for (const value of [first, second]) {
    if (value.sourceSha !== edgeProof.sourceSha || value.sourceTree !== edgeProof.sourceTree || value.sourceFiles.length !== 600 || value.dependencyInputs.length !== 268 || value.instrumentation.length !== 4 || value.instrumentation.some(row => row.erasureExact !== true)) refuse("capsule-inventory-mismatch");
  }
  for (const key of ["sourceFiles", "dependencyInputs", "instrumentation", "observerSha256", "harnessInputs", "bundles", "runtime"]) if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) refuse("two-root-mismatch");
}
function offlineProjection() {
  // Offline placeholders ONLY. Never serialize this as a resource/custody
  // receipt and never pass it to activation (which this script cannot perform).
  const now = Date.now();
  return {
    environment: "edge-proof", sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree,
    accountId: "a".repeat(32), runId: "b".repeat(32), createdAt: now, expiresAt: now + 600000,
    edgeOrigin: "https://clawrouter-edge-proof.offline-only.workers.dev", upstreamOrigin: "https://clawrouter-upstream-proof.offline-only.workers.dev",
    resources: { workerName: edgeProof.workerName, upstreamWorkerName: edgeProof.upstreamWorkerName, policyKvNamespace: edgeProof.policyKvNamespace, policyKvId: "1".repeat(32), queueName: edgeProof.queueName, queueId: "2".repeat(32), queueDlqName: edgeProof.queueDlqName, queueDlqId: "3".repeat(32) },
    custody: { owner: "offline-placeholder-not-custody", accountId: "a".repeat(32), resourceNames: [edgeProof.workerName, edgeProof.upstreamWorkerName, edgeProof.policyKvNamespace, edgeProof.queueName, edgeProof.queueDlqName], exclusive: true, nonproduction: true, observedAt: now },
  };
}
export function admitSource(cwd, git = execFileSync) {
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  if (git("git", ["rev-parse", `${edgeProof.sourceSha}^{commit}`], options).trim() !== edgeProof.sourceSha || git("git", ["rev-parse", `${edgeProof.sourceSha}^{tree}`], options).trim() !== edgeProof.sourceTree) refuse("source-unavailable-or-mismatched");
}
export async function qualifyInstalledInputs(cwd) {
  const root = await realpath(cwd);
  let links = 0;
  for (const path of ["node_modules", "admin/node_modules"]) {
    const directory = join(root, path);
    if (!(await lstat(directory)).isDirectory()) refuse("owned-installation-required");
    async function walk(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          const target = relative(root, await realpath(path));
          if (target === ".." || target.startsWith("../")) refuse("installation-link-escape");
          links++;
        } else if (entry.isDirectory()) await walk(path);
        else if (!entry.isFile()) refuse("installation-special-file");
      }
    }
    await walk(directory);
  }
  return { owned: true, containedLinks: links };
}
async function offlineChild(cwd, root, parent) {
  validateNamespace(await namespaceEvidence(), parent);
  if ((await privateProcesses()).length) refuse("unexpected-private-process");
  const env = await prepareEnvironment(join(root, "child"));
  const receipts = [];
  for (const label of ["a", "b"]) {
    const capsule = join(root, `capsule-${label}`);
    const built = await runOwnedProcess(process.execPath, [script, "offline-build", cwd, capsule, JSON.stringify(parent)], { cwd: root, env, timeoutMs: 120000, sample: privateProcesses });
    requireProcessSuccess(built);
    receipts.push(JSON.parse(await readFile(join(capsule, "source-receipt.json"), "utf8")));
  }
  compareCapsules(...receipts);
  const require = createRequire(import.meta.resolve("wrangler/package.json"));
  const packageRoot = dirname(await realpath(require.resolve("wrangler/package.json")));
  const cli = join(packageRoot, "wrangler-dist/cli.js");
  if (relative(await realpath(join(cwd, "node_modules")), packageRoot).startsWith("..") || !(await lstat(cli)).isFile() || JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version !== "4.156.0" || digest(await readFile(cli)) !== "934d8051582ed5d85336e9e6677126ec87324a47166974de22d49a5523ba4d11") refuse("wrangler-input-mismatch");
  const results = {};
  const capsule = join(root, "capsule-a");
  for (const kind of ["edge", "upstream"]) {
    const config = join(capsule, `${kind}.toml`), output = join(root, `dry-${kind}`);
    await writeFile(config, renderEdgeConfig(offlineProjection(), kind, `${kind}.mjs`), { flag: "wx", mode: 0o600 });
    const result = await runOwnedProcess(process.execPath, ["--no-warnings", cli, "deploy", "--dry-run", "--config", config, "--outdir", output], { cwd: capsule, env, sample: privateProcesses });
    requireProcessSuccess(result);
    results[kind] = verifyDryRun(result, await readFile(join(output, `${kind}.mjs`)), receipts[0].bundles[kind]);
  }
  validateNamespace(await namespaceEvidence(), parent);
  if ((await privateProcesses()).length) refuse("private-descendant-not-retired");
  return { version: 1, isolated: true, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: 600, dependencyFiles: 268, exactErasures: 4, twoRoots: true, cliSha256: digest(await readFile(cli)), results, cloud: "UNRUN", sdk: "UNRUN" };
}
async function offlineCi() {
  if (process.platform !== "linux" || process.version !== "v24.22.1" || process.versions.modules !== "137" || process.arch !== "x64") refuse("linux-runtime-unqualified");
  const cwd = await realpath(process.cwd());
  admitSource(cwd);
  await qualifyInstalledInputs(cwd);
  const root = await mkdtemp(join(tmpdir(), "edge-offline-"));
  const env = await prepareEnvironment(root), parent = await namespaceIdentity();
  const result = await runOwnedProcess("/usr/bin/unshare", namespaceArguments(process.execPath, [script, "offline-child", cwd, root, JSON.stringify(parent)]), { cwd: root, env, timeoutMs: 480000 });
  requireProcessSuccess(result);
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1) refuse("missing-isolated-receipt");
  const receipt = JSON.parse(lines[0]);
  if (receipt.version !== 1 || receipt.isolated !== true || receipt.sourceSha !== edgeProof.sourceSha || receipt.sourceTree !== edgeProof.sourceTree || receipt.cloud !== "UNRUN" || receipt.sdk !== "UNRUN") refuse("invalid-isolated-receipt");
  return receipt;
}
export async function main(argv) {
  const [action = "plan", ...args] = argv;
  if (action === "offline-ci" && args.length === 0) return offlineCi();
  if (action === "offline-child" && args.length === 3) return offlineChild(args[0], args[1], JSON.parse(args[2]));
  if (action === "offline-build" && args.length === 3) {
    validateNamespace(await namespaceEvidence(), JSON.parse(args[2]), true);
    const receipt = await buildCapsule(args[0], args[1]);
    await writeFile(join(args[1], "source-receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    createRequire(import.meta.resolve("wrangler/package.json"))("esbuild").stop();
    return { built: true };
  }
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
