import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, realpath, readlink, readdir, lstat, open } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { edgeProof, validatePlan, renderEdgeConfig, planDigest } from "./edge-proof-profile.mjs";

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
const diagnosticPrefix = "EDGE_PACKAGING_V1 ";
const diagnosticRoles = ["parent", "child", "build_a", "build_b"];
const diagnosticPhases = ["entry", "runtime", "cwd", "source", "dependencies", "temp", "environment", "parent_namespaces", "parent_launch", "supervisor_close", "child_report", "namespace_read", "private_init", "user_namespace", "net_namespace", "pid_namespace", "mount_namespace", "interfaces", "routes", "private_mount", "process_inventory", "build_a_launch", "build_a_close", "build_a_report", "build_b_launch", "build_b_close", "build_b_report", "builder_import", "build", "receipt_write", "build_service_stop", "two_roots", "wrangler_input", "edge_config", "edge_launch", "edge_close", "edge_output", "edge_marker", "edge_hash", "edge_privacy", "upstream_config", "upstream_launch", "upstream_close", "upstream_output", "upstream_marker", "upstream_hash", "upstream_privacy", "final_namespace", "final_descendants", "final", "overflow"];
const diagnosticSignals = [null, "SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGPIPE", "SIGHUP", "SIGQUIT", "SIGTRAP", "SIGXCPU", "SIGXFSZ", "SIGSYS"];
function ownData(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor)) refuse("diagnostic-data-required");
  return descriptor.value;
}
export function validatePackagingDiagnostic(value) {
  const phase = value && typeof value === "object" ? ownData(value, "phase") : null;
  const summaries = {
    stdout_summary: ["bytes", "sha256", "esc", "complete"], stderr_summary: ["bytes", "sha256", "esc", "complete"],
    protocol_summary: ["valid", "entry", "final", "rejected", "foreign", "malformed", "receipts", "unclassified", "complete"],
    linux_policy: ["seccomp", "apparmor", "usernsClone", "maxUserNamespaces"],
  };
  if (typeof phase === "string" && Object.hasOwn(summaries, phase)) {
    const keys = ["v", "role", "phase", "outcome", ...summaries[phase]];
    if (Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("diagnostic-schema");
    const row = Object.fromEntries(keys.map(key => [key, ownData(value, key)]));
    if (row.v !== 1 || !diagnosticRoles.includes(row.role) || row.outcome !== "observed") refuse("diagnostic-enum");
    if (phase === "linux_policy") {
      if (![null, 0, 1, 2].includes(row.seccomp) || ![null, 0, 1].includes(row.apparmor) || ![null, 0, 1].includes(row.usernsClone) || !["zero", "positive", "unknown"].includes(row.maxUserNamespaces)) refuse("diagnostic-policy");
    } else {
      if (typeof row.complete !== "boolean") refuse("diagnostic-boolean");
      if (phase === "protocol_summary") {
        for (const key of summaries[phase].filter(key => key !== "complete")) if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 65535) refuse("diagnostic-count");
      } else if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.esc !== "boolean") refuse("diagnostic-stream");
    }
    if (Buffer.byteLength(JSON.stringify(row)) > 640) refuse("diagnostic-capacity");
    return row;
  }
  const keys = ["v", "role", "phase", "outcome", "defined", "exit", "signal", "closed", "timedOut", "interrupted", "errors", "remaining"];
  if (!value || typeof value !== "object" || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("diagnostic-schema");
  const row = Object.fromEntries(keys.map(key => [key, ownData(value, key)]));
  if (row.v !== 1 || !diagnosticRoles.includes(row.role) || !diagnosticPhases.includes(row.phase) || !["enter", "fulfilled", "rejected"].includes(row.outcome) || !diagnosticSignals.includes(row.signal)) refuse("diagnostic-enum");
  for (const key of ["defined", "closed", "timedOut", "interrupted"]) if (row[key] !== null && typeof row[key] !== "boolean") refuse("diagnostic-boolean");
  for (const key of ["exit", "errors", "remaining"]) if (row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < (key === "exit" ? -65535 : 0) || row[key] > 65535)) refuse("diagnostic-count");
  if (Buffer.byteLength(JSON.stringify(row)) > 640) refuse("diagnostic-capacity");
  return row;
}
export function createPackagingDiagnostics(role, writer) {
  if (!diagnosticRoles.includes(role)) refuse("diagnostic-role");
  const records = [], errors = [];
  const accept = value => {
    try {
      const row = validatePackagingDiagnostic(value);
      if (records.length >= 256) refuse("diagnostic-capacity");
      records.push(row);
      if (writer) writer(diagnosticPrefix + JSON.stringify(row) + "\n");
    } catch (error) { errors.push(error); }
  };
  const mark = (phase, outcome, reason, result) => {
    try {
      const row = { v: 1, role, phase, outcome, defined: outcome === "rejected" ? reason !== undefined : null, exit: null, signal: null, closed: null, timedOut: null, interrupted: null, errors: null, remaining: null };
      if (result) {
        for (const [to, from] of [["exit", "code"], ["signal", "signal"], ["closed", "closed"], ["timedOut", "timedOut"], ["interrupted", "interrupted"]]) row[to] = ownData(result, from);
        row.errors = ownData(ownData(result, "errors"), "length");
        const remaining = ownData(result, "remaining"); row.remaining = remaining === null ? null : ownData(remaining, "length");
      }
      accept(row);
    } catch (error) { errors.push(error); }
  };
  return {
    role, records, errors, accept, mark,
    sync(phase, operation) { mark(phase, "enter"); try { const value = operation(); mark(phase, "fulfilled"); return value; } catch (error) { mark(phase, "rejected", error); throw error; } },
    async step(phase, operation) { mark(phase, "enter"); try { const value = await operation(); mark(phase, "fulfilled"); return value; } catch (error) { mark(phase, "rejected", error); throw error; } },
  };
}
export function parsePackagingOutput(text, roles) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) refuse("diagnostic-output-capacity");
  const records = [], output = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(diagnosticPrefix)) {
      if (Buffer.byteLength(line) > 768 || records.length >= 256) refuse("diagnostic-capacity");
      const record = validatePackagingDiagnostic(JSON.parse(line.slice(diagnosticPrefix.length)));
      if (!roles.includes(record.role)) refuse("diagnostic-foreign-role");
      records.push(record);
    } else if (line.trim()) output.push(line);
  }
  return { records, output };
}
// Independent observation only: malformed/foreign records remain fatal in the
// original parser below. Never emit non-protocol lines or infer an OS cause.
export function summarizePackagingOutput(text, role) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024 || !diagnosticRoles.includes(role)) refuse("diagnostic-output-capacity");
  const summary = { valid: 0, entry: 0, final: 0, rejected: 0, foreign: 0, malformed: 0, receipts: 0, unclassified: 0, complete: true };
  const roles = role === "child" ? ["child", "build_a", "build_b"] : [role];
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (++count > 256) { summary.complete = false; break; }
    if (line.startsWith(diagnosticPrefix)) {
      try {
        if (Buffer.byteLength(line) > 768) refuse("diagnostic-capacity");
        const row = validatePackagingDiagnostic(JSON.parse(line.slice(diagnosticPrefix.length)));
        if (!roles.includes(row.role)) { summary.foreign++; continue; }
        summary.valid++;
        if (row.outcome === "rejected") summary.rejected++;
        if (row.role === role) {
          if (row.phase === "entry") summary.entry++;
          if (row.phase === "final") summary.final++;
        }
      } catch { summary.malformed++; }
    } else {
      try {
        const value = JSON.parse(line);
        if (role === "child") validatePackagingReceipt(value);
        else if (!value || Object.keys(value).join() !== "built" || value.built !== true) refuse("invalid-builder-receipt");
        summary.receipts++;
      } catch { summary.unclassified++; }
    }
  }
  return summary;
}
export function decodeLinuxPolicy(inputs) {
  const get = key => { try { const value = ownData(inputs, key); return typeof value === "string" ? value : null; } catch { return null; } };
  const bit = value => value === "0\n" || value === "0" ? 0 : value === "1\n" || value === "1" ? 1 : null;
  const status = get("status"), matches = status?.split("\n").filter(line => line.startsWith("Seccomp:"));
  const seccomp = matches?.length === 1 && /^Seccomp:\t[012]$/.test(matches[0]) ? Number(matches[0].at(-1)) : null;
  const max = get("maxUserNamespaces");
  return { seccomp, apparmor: bit(get("apparmor")), usernsClone: bit(get("usernsClone")), maxUserNamespaces: typeof max === "string" && /^(?:0|[1-9][0-9]{0,19})\n?$/.test(max) ? (BigInt(max.trim()) === 0n ? "zero" : "positive") : "unknown" };
}
async function readLinuxPolicy() {
  const inputs = {};
  for (const [key, path, limit] of [["status", "/proc/self/status", 65536], ["apparmor", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", 64], ["usernsClone", "/proc/sys/kernel/unprivileged_userns_clone", 64], ["maxUserNamespaces", "/proc/sys/user/max_user_namespaces", 64]]) {
    let handle;
    try {
      handle = await open(path, "r");
      const bytes = Buffer.alloc(limit + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      inputs[key] = result.bytesRead <= limit ? bytes.subarray(0, result.bytesRead).toString("utf8") : null;
    } catch { inputs[key] = null; }
    finally { if (handle) await handle.close(); }
  }
  return decodeLinuxPolicy(inputs);
}
export function validatePackagingReceipt(value) {
  const exact = (object, keys) => {
    if (!object || typeof object !== "object" || Object.getOwnPropertyNames(object).sort().join() !== [...keys].sort().join()) refuse("receipt-schema");
    return Object.fromEntries(keys.map(key => [key, ownData(object, key)]));
  };
  const row = exact(value, ["version", "isolated", "sourceSha", "sourceTree", "sourceFiles", "dependencyFiles", "exactErasures", "twoRoots", "cliSha256", "results", "cloud", "sdk"]);
  if (row.version !== 1 || row.isolated !== true || row.sourceSha !== edgeProof.sourceSha || row.sourceTree !== edgeProof.sourceTree || row.sourceFiles !== 600 || row.dependencyFiles !== 268 || row.exactErasures !== 4 || row.twoRoots !== true || !/^[a-f0-9]{64}$/.test(row.cliSha256) || row.cloud !== "UNRUN" || row.sdk !== "UNRUN") refuse("receipt-identity");
  row.results = exact(row.results, ["edge", "upstream"]);
  for (const kind of ["edge", "upstream"]) {
    const result = exact(row.results[kind], ["code", "signal", "closed", "sha256", "observedProcesses"]);
    if (result.code !== 0 || result.signal !== null || result.closed !== true || !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.observedProcesses) || result.observedProcesses < 0 || result.observedProcesses > 512) refuse("receipt-result");
    row.results[kind] = result;
  }
  return row;
}
function raisePackagingFailures(errors) { if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, "edge-proof: original and diagnostic failures"); }
export function acceptPackagingProcess(result, report, role, closePhase, reportPhase) {
  const errors = []; let parsed;
  try { requireProcessSuccess(result); report.mark(closePhase, "fulfilled", undefined, result); }
  catch (error) { errors.push(error); report.mark(closePhase, "rejected", error, result); }
  // Observe the original capture independently of strict parsing, so no-entry
  // failures still carry bounded evidence. Observation failures cannot mask exit.
  try {
    const output = ownData(result, "outputSummary");
    for (const stream of ["stdout", "stderr"]) {
      const capture = ownData(output, stream);
      report.accept({ v: 1, role: report.role, phase: `${stream}_summary`, outcome: "observed", ...Object.fromEntries(["bytes", "sha256", "esc", "complete"].map(key => [key, ownData(capture, key)])) });
    }
    const summary = summarizePackagingOutput(ownData(result, "stdout"), role);
    // The strict parser remains authoritative. A truncated/undecodable capture
    // cannot claim a complete census of the original byte stream.
    summary.complete &&= ownData(ownData(output, "stdout"), "complete") === true && ownData(ownData(output, "stdout"), "sha256") === digest(ownData(result, "stdout"));
    report.accept({ v: 1, role: report.role, phase: "protocol_summary", outcome: "observed", ...summary });
  } catch (error) { errors.push(error); report.mark(reportPhase, "rejected", error); }
  // Parse only newly generated, strictly validated records. Never echo child
  // stdout/stderr or classify their arbitrary text as an operating-system cause.
  try {
    parsed = parsePackagingOutput(ownData(result, "stdout"), role === "child" ? ["child", "build_a", "build_b"] : [role]);
    for (const row of parsed.records) report.accept(row);
    const entry = parsed.records.filter(row => row.role === role && row.phase === "entry" && row.outcome === "fulfilled");
    const final = parsed.records.filter(row => row.role === role && row.phase === "final" && row.outcome === "fulfilled");
    if (entry.length !== 1 || final.length !== 1 || parsed.records.some(row => row.outcome === "rejected") || parsed.output.length !== 1) refuse("missing-or-failed-child-milestone");
    report.mark(reportPhase, "fulfilled");
  } catch (error) { errors.push(error); report.mark(reportPhase, "rejected", error); }
  raisePackagingFailures(errors);
  return parsed.output[0];
}
export function emitPackagingFailure(records, writer) {
  const valid = records.map(validatePackagingDiagnostic), unique = new Map();
  // Keep failure boundaries first, then the most recent phase per role. All
  // omitted failures still fail the operation; this is only a bounded report.
  const priority = ["supervisor_close", "protocol_summary", "stdout_summary", "stderr_summary", "child_report", "linux_policy"];
  const first = priority.flatMap(phase => valid.filter(row => row.role === "parent" && row.phase === phase).toReversed());
  for (const row of [...first, ...valid.filter(row => row.outcome === "rejected"), ...valid.toReversed()]) {
    const key = `${row.role}:${row.phase}`; if (!unique.has(key)) unique.set(key, row);
  }
  let bytes = 0;
  const selected = [...unique.values()].slice(0, 9);
  if (unique.size > 9) selected.push({ v: 1, role: "parent", phase: "overflow", outcome: "rejected", defined: null, exit: null, signal: null, closed: null, timedOut: null, interrupted: null, errors: Math.min(65535, unique.size - 9), remaining: null });
  for (const row of selected) {
    const encoded = JSON.stringify(validatePackagingDiagnostic(row)).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    const command = `::error title=Edge packaging boundary::${encoded}\n`;
    bytes += Buffer.byteLength(command);
    if (Buffer.byteLength(command) > 768 || bytes > 8192) refuse("annotation-capacity");
    writer(command);
  }
}
export async function runPackagingBoundary(role, operation, { writer, emit = line => process.stdout.write(line) } = {}) {
  const report = createPackagingDiagnostics(role, writer), failures = [];
  report.mark("entry", "fulfilled"); let value;
  try { value = await operation(report); } catch (error) { failures.push(error); }
  failures.push(...report.errors);
  const reportedErrors = report.errors.length;
  report.mark("final", failures.length ? "rejected" : "fulfilled", failures[0]);
  // A final-record writer failure must never allow a success receipt.
  failures.push(...report.errors.slice(reportedErrors));
  if (failures.length && role === "parent") {
    try { emitPackagingFailure(report.records, emit); } catch (error) { failures.push(error); }
  }
  raisePackagingFailures(failures);
  return value;
}

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
export async function prepareEnvironment(root) {
  const env = packagingEnvironment(root);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "WRANGLER_LOG_PATH"]) await mkdir(env[key], { recursive: true, mode: 0o700 });
  return env;
}
export function validateNamespace(evidence, parent, builder = false, report) {
  const check = (phase, fn) => report ? report.sync(phase, fn) : fn();
  check("private_init", () => { if (evidence.platform !== "linux" || evidence.uid !== 0 || (builder ? !(evidence.pid > 1 && evidence.ppid === 1) : evidence.pid !== 1)) refuse("private-init-required"); });
  const phases = { net: "net_namespace", pid: "pid_namespace", mnt: "mount_namespace", user: "user_namespace" };
  for (const name of namespaceNames) {
    check(phases[name], () => {
      const pattern = new RegExp(`^${name}:\\[\\d+\\]$`);
      if (!pattern.test(evidence.namespaces?.[name]) || !pattern.test(parent[name]) || evidence.namespaces[name] === parent[name]) refuse("namespace-mismatch");
    });
  }
  check("interfaces", () => { if (JSON.stringify(evidence.interfaces) !== '["lo"]') refuse("external-interface"); });
  check("routes", () => {
  if (evidence.routes4.length || evidence.routes6.some(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 10 || fields[9] !== "lo" || ![0, 2, 4].every(index => /^[a-f0-9]{32}$/i.test(fields[index])) || ![1, 3].every(index => /^[a-f0-9]{2}$/i.test(fields[index])) || ![5, 6, 7, 8].every(index => /^[a-f0-9]{8}$/i.test(fields[index])) || fields[2] !== "0".repeat(32) || fields[3] !== "00" || fields[4] !== "0".repeat(32)) return true;
    // Linux may expose its unreachable ::/0 sentinel on lo. It is not an
    // external route: RTF_REJECT is required. A real loopback /128 is allowed.
    const reject = (Number.parseInt(fields[8], 16) & 0x200) !== 0;
    return !(reject && fields[0] === "0".repeat(32) && fields[1] === "00") &&
      !(fields[0] === "0".repeat(31) + "1" && fields[1] === "80");
  })) refuse("external-route");
  });
  check("private_mount", () => { if (evidence.sharedMount !== false || evidence.procMounted !== true) refuse("private-proc-required"); });
  return true;
}
export async function namespaceIdentity() {
  return Object.fromEntries(await Promise.all(namespaceNames.map(async name => [name, await readlink(`/proc/self/ns/${name}`)])));
}
export async function namespaceEvidence() {
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
  const result = { code: null, signal: null, timedOut: false, interrupted: false, closed: false, errors: [], spawnErrors: [], observed: new Map(), stdout: "", stderr: "" };
  const captures = Object.fromEntries(["stdout", "stderr"].map(key => [key, { bytes: 0, hash: createHash("sha256"), esc: false }]));
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
    // Hash original bytes before the existing bounded UTF-8 capture. Chunk
    // boundaries and malformed UTF-8 must not change these fingerprints.
    const capture = captures[key]; capture.bytes += data.length; capture.hash.update(data); capture.esc ||= data.includes(0x1b);
    bytes += data.length;
    if (bytes > 1024 * 1024) { if (!stopped) result.errors.push(new Error("edge-proof: output-capacity")); stopped = true; stop("SIGTERM"); }
    else result[key] += data.toString("utf8");
  };
  let deadline, monitor;
  try {
    try { child = spawnProcess(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { result.spawnErrors.push(error); throw error; }
    child.stdout.on("data", append("stdout")); child.stderr.on("data", append("stderr"));
    signalSource.on("SIGINT", onInt); signalSource.on("SIGTERM", onTerm);
    deadline = setTimeout(() => { result.timedOut = true; stop("SIGTERM"); }, timeoutMs);
    monitor = setInterval(() => { void observe(); }, 20);
    await new Promise(resolveClose => {
      child.on("error", error => { result.spawnErrors.push(error); result.errors.push(error); });
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
  result.outputSummary = Object.fromEntries(Object.entries(captures).map(([key, value]) => [key, { bytes: value.bytes, sha256: value.hash.digest("hex"), esc: value.esc, complete: result.closed }]));
  return result;
}
export function requireProcessSuccess(result) {
  if (!result.closed || result.code !== 0 || result.signal !== null || result.timedOut || result.interrupted || result.errors.length || !Array.isArray(result.remaining) || result.remaining.length) {
    throw new AggregateError([new Error("edge-proof: child-not-qualified"), ...result.errors], "edge-proof: child-not-qualified");
  }
}
export function verifyDryRun(result, bytes, expectedHash, report, phases, privateRoots = []) {
  requireProcessSuccess(result);
  const check = (phase, fn) => report ? report.sync(phase, fn) : fn();
  check(phases?.marker, () => { if (!result.stdout.split(/\r?\n/).some(line => line.trim() === "--dry-run: exiting now.")) refuse("dry-run-marker-or-bundle-mismatch"); });
  check(phases?.hash, () => { if (!Buffer.isBuffer(bytes) || !bytes.length || digest(bytes) !== expectedHash) refuse("dry-run-marker-or-bundle-mismatch"); });
  check(phases?.privacy, () => { if ([...privateRoots, "/Users/", "/home/"].some(path => bytes.includes(path))) refuse("dry-run-private-path"); });
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
async function offlineChild(cwd, root, parent, report) {
  return runPackagingPipeline(cwd, root, report, {
    checkBoundary: async () => validateNamespace(await namespaceEvidence(), parent, false, report),
    buildArguments: (capsule, role) => [script, "offline-build", cwd, capsule, JSON.stringify(parent), role],
  });
}
// Both admitted isolation routes use the same original builder, two-root
// comparison, direct CLI, output checks and private-process retirement.
export async function runPackagingPipeline(cwd, root, report, boundary) {
  await report.step("namespace_read", boundary.checkBoundary);
  await report.step("process_inventory", async () => { if ((await privateProcesses()).length) refuse("unexpected-private-process"); });
  const env = await report.step("environment", () => prepareEnvironment(join(root, "child")));
  const receipts = [];
  for (const [label, role, launch, close, check] of [["a", "build_a", "build_a_launch", "build_a_close", "build_a_report"], ["b", "build_b", "build_b_launch", "build_b_close", "build_b_report"]]) {
    const capsule = join(root, `capsule-${label}`);
    report.mark(launch, "enter");
    const built = await runOwnedProcess(process.execPath, boundary.buildArguments(capsule, role), { cwd: root, env, timeoutMs: 120000, sample: privateProcesses });
    const value = JSON.parse(acceptPackagingProcess(built, report, role, close, check));
    if (value.built !== true || Object.keys(value).join() !== "built") refuse("invalid-builder-receipt");
    receipts.push(await report.step(check, async () => JSON.parse(await readFile(join(capsule, "source-receipt.json"), "utf8"))));
  }
  report.sync("two_roots", () => compareCapsules(...receipts));
  const cli = await report.step("wrangler_input", async () => {
    const require = createRequire(import.meta.resolve("wrangler/package.json"));
    const packageRoot = dirname(await realpath(require.resolve("wrangler/package.json")));
    const cli = join(packageRoot, "wrangler-dist/cli.js");
    if (relative(await realpath(join(cwd, "node_modules")), packageRoot).startsWith("..") || !(await lstat(cli)).isFile() || JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version !== "4.156.0" || digest(await readFile(cli)) !== "934d8051582ed5d85336e9e6677126ec87324a47166974de22d49a5523ba4d11") refuse("wrangler-input-mismatch");
    return cli;
  });
  const results = {};
  const capsule = join(root, "capsule-a");
  for (const [kind, configPhase, launch, close, outputPhase, marker, hash, privacy] of [["edge", "edge_config", "edge_launch", "edge_close", "edge_output", "edge_marker", "edge_hash", "edge_privacy"], ["upstream", "upstream_config", "upstream_launch", "upstream_close", "upstream_output", "upstream_marker", "upstream_hash", "upstream_privacy"]]) {
    const config = join(capsule, `${kind}.toml`), output = join(root, `dry-${kind}`);
    await report.step(configPhase, () => writeFile(config, renderEdgeConfig(offlineProjection(), kind, `${kind}.mjs`), { flag: "wx", mode: 0o600 }));
    report.mark(launch, "enter");
    const result = await runOwnedProcess(process.execPath, ["--no-warnings", cli, "deploy", "--dry-run", "--config", config, "--outdir", output], { cwd: capsule, env, sample: privateProcesses });
    try { requireProcessSuccess(result); report.mark(close, "fulfilled", undefined, result); } catch (error) { report.mark(close, "rejected", error, result); throw error; }
    const bytes = await report.step(outputPhase, () => readFile(join(output, `${kind}.mjs`)));
    results[kind] = verifyDryRun(result, bytes, receipts[0].bundles[kind], report, { marker, hash, privacy }, [root, cwd]);
  }
  await report.step("final_namespace", boundary.checkBoundary);
  await report.step("final_descendants", async () => { if ((await privateProcesses()).length) refuse("private-descendant-not-retired"); });
  return { version: 1, isolated: true, sourceSha: edgeProof.sourceSha, sourceTree: edgeProof.sourceTree, sourceFiles: 600, dependencyFiles: 268, exactErasures: 4, twoRoots: true, cliSha256: digest(await readFile(cli)), results, cloud: "UNRUN", sdk: "UNRUN" };
}
async function offlineCi(report) {
  report.sync("runtime", () => { if (process.platform !== "linux" || process.version !== "v24.22.1" || process.versions.modules !== "137" || process.arch !== "x64") refuse("linux-runtime-unqualified"); });
  const cwd = await report.step("cwd", () => realpath(process.cwd()));
  report.sync("source", () => admitSource(cwd));
  await report.step("dependencies", () => qualifyInstalledInputs(cwd));
  const root = await report.step("temp", () => mkdtemp(join(tmpdir(), "edge-offline-")));
  const env = await report.step("environment", () => prepareEnvironment(root)), parent = await report.step("parent_namespaces", namespaceIdentity);
  report.accept({ v: 1, role: "parent", phase: "linux_policy", outcome: "observed", ...await readLinuxPolicy() });
  report.mark("parent_launch", "enter");
  const result = await runOwnedProcess("/usr/bin/unshare", namespaceArguments(process.execPath, [script, "offline-child", cwd, root, JSON.stringify(parent)]), { cwd: root, env, timeoutMs: 480000 });
  const output = acceptPackagingProcess(result, report, "child", "supervisor_close", "child_report");
  const receipt = report.sync("child_report", () => validatePackagingReceipt(JSON.parse(output)));
  return receipt;
}
const containerDiagnosticPhases = ["entry", "module_import", "dispatch", "serialization", "reporting", "pending", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base", "image_build", "image_build_process", "image_build_internal", "image_id", "native_receipt", "image", "create", "attach", "ready", "admission", "permit", "wait", "receipt", "terminal", "cgroup", "retirement", "remove", "final", "overflow"];
export const imageBuildStages = ["node_version", "node_abi", "architecture", "git_executable", "pnpm_bootstrap", "pnpm_version", "input_directories", "input_ownership", "frozen_install", "native_prepare"];
const containerDiagnosticSignals = [null, "SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGBUS", "SIGSYS"];
const processDiagnosticFields = ["v", "phase", "state", "defined", "available", "exit", "signal", "closed", "timedOut", "interrupted", "errors", "undefinedErrors", "spawnErrors", "undefinedSpawnErrors", "stdoutComplete", "stderrComplete"];
export function validateContainerDiagnostic(value) {
  if (value && typeof value === "object" && ownData(value, "v") === 4) {
    const fields = ["v", "phase", "state", "stage", "status", "records", "reason"];
    if (Object.getOwnPropertyNames(value).sort().join() !== [...fields].sort().join()) refuse("container-internal-keys");
    const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
    if (row.phase !== "image_build_internal" || !["capture_unavailable", "capture_mismatch", "no_records", "incomplete", "invalid", "validated_failure", "complete"].includes(row.reason) || !(row.records === null || Number.isInteger(row.records) && row.records >= 0 && row.records <= 20)) refuse("container-internal-enum");
    if (row.reason === "validated_failure") {
      if (row.state !== "rejected" || !Number.isInteger(row.status) || row.status < 1 || row.status > 255 || row.records < 2 || row.records % 2 || row.stage !== imageBuildStages[row.records / 2 - 1]) refuse("container-internal-failure");
    } else if (row.reason === "complete") {
      if (row.state !== "observed" || row.stage !== "native_prepare" || row.status !== 0 || row.records !== 20) refuse("container-internal-complete");
    } else {
      if (row.state !== "observed" || row.stage !== null || row.status !== null) refuse("container-internal-unknown");
      if (row.reason === "no_records" ? row.records !== 0 : row.reason === "incomplete" ? !(row.records >= 1 && row.records < 20) : row.records !== null) refuse("container-internal-count");
    }
    return row;
  }
  if (value && typeof value === "object" && ownData(value, "v") === 3) {
    if (Object.getOwnPropertyNames(value).sort().join() !== [...processDiagnosticFields].sort().join()) refuse("container-process-keys");
    const row = Object.fromEntries(processDiagnosticFields.map(key => [key, ownData(value, key)]));
    if (row.phase !== "image_build_process" || typeof row.available !== "boolean" || row.state !== (row.available ? "observed" : "rejected") || !(row.available ? row.defined === null : typeof row.defined === "boolean")) refuse("container-process-identity");
    // Node may report a negative OS error code when spawning fails.
    if (!containerDiagnosticSignals.includes(row.signal) || !(row.exit === null || Number.isInteger(row.exit) && row.exit >= -2147483648 && row.exit <= 2147483647)) refuse("container-process-exit");
    for (const key of ["closed", "timedOut", "interrupted", "stdoutComplete", "stderrComplete"]) if (row[key] !== null && typeof row[key] !== "boolean") refuse("container-process-boolean");
    for (const key of ["errors", "undefinedErrors", "spawnErrors", "undefinedSpawnErrors"]) if (!(row[key] === null || Number.isSafeInteger(row[key]) && row[key] >= 0)) refuse("container-process-count");
    for (const [part, total] of [["undefinedErrors", "errors"], ["spawnErrors", "errors"], ["undefinedSpawnErrors", "spawnErrors"], ["undefinedSpawnErrors", "undefinedErrors"]]) if (row[part] !== null && row[total] !== null && row[part] > row[total]) refuse("container-process-count-order");
    if (!row.available && processDiagnosticFields.slice(5).some(key => row[key] !== null)) refuse("container-process-unavailable");
    return row;
  }
  if (!value || typeof value !== "object" || Object.getOwnPropertyNames(value).sort().join() !== ["v", "phase", "state", "defined", "exit", "signal"].sort().join()) refuse("container-diagnostic-keys");
  const row = Object.fromEntries(["v", "phase", "state", "defined", "exit", "signal"].map(key => [key, ownData(value, key)]));
  if (row.v !== 2 || !containerDiagnosticPhases.includes(row.phase) || ["image_build_process", "image_build_internal"].includes(row.phase) || !["entered", "fulfilled", "rejected"].includes(row.state)) refuse("container-diagnostic-enum");
  if (![null, true, false].includes(row.defined) || !containerDiagnosticSignals.includes(row.signal) || !(row.exit === null || Number.isInteger(row.exit) && row.exit >= 0 && row.exit <= 255)) refuse("container-diagnostic-outcome");
  return row;
}
export function containerProcessDiagnostic(result, available = true, reason) {
  const field = (object, key) => object && Object.hasOwn(object, key) ? ownData(object, key) : null;
  const count = values => {
    if (values === null) return [null, null];
    if (!Array.isArray(values)) refuse("container-process-errors");
    let undefinedCount = 0;
    for (let i = 0; i < values.length; i++) if (ownData(values, String(i)) === undefined) undefinedCount++;
    return [values.length, undefinedCount];
  };
  const [errors, undefinedErrors] = available ? count(field(result, "errors")) : [null, null];
  const [spawnErrors, undefinedSpawnErrors] = available ? count(field(result, "spawnErrors")) : [null, null];
  const summary = available ? field(result, "outputSummary") : null;
  return validateContainerDiagnostic({ v: 3, phase: "image_build_process", state: available ? "observed" : "rejected", defined: available ? null : reason !== undefined, available,
    exit: available ? field(result, "code") : null, signal: available ? field(result, "signal") : null,
    closed: available ? field(result, "closed") : null, timedOut: available ? field(result, "timedOut") : null, interrupted: available ? field(result, "interrupted") : null,
    errors, undefinedErrors, spawnErrors, undefinedSpawnErrors,
    stdoutComplete: field(field(summary, "stdout"), "complete"), stderrComplete: field(field(summary, "stderr"), "complete") });
}
export function emitContainerFailure(records, writer = line => process.stdout.write(line)) {
  const rows = records.map(validateContainerDiagnostic), unique = new Map();
  const rejected = rows.filter(row => row.state === "rejected");
  // Reserve the first actual failure and original build outcome before context.
  for (const row of [...rejected.slice(0, 1), ...rows.filter(row => row.v === 3), ...rejected.slice(1), ...rows.toReversed()]) if (!unique.has(row.phase)) unique.set(row.phase, row);
  const selected = [...unique.values()].slice(0, 9);
  if (unique.size > 9) selected.push({ v: 2, phase: "overflow", state: "rejected", defined: null, exit: Math.min(255, unique.size - 9), signal: null });
  let bytes = 0;
  for (const row of selected) {
    const command = `::error title=Edge container boundary::${JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`;
    bytes += Buffer.byteLength(command); if (Buffer.byteLength(command) > 768 || bytes > 8192) refuse("container-diagnostic-capacity"); writer(command);
  }
}
export function createContainerDiagnostics() {
  const records = [];
  const mark = (phase, state, reason) => records.push(validateContainerDiagnostic({ v: 2, phase, state, defined: state === "rejected" ? reason !== undefined : null, exit: null, signal: null }));
  return { records, mark, process(result, available, reason) { records.push(containerProcessDiagnostic(result, available, reason)); }, internal(row) { records.push(validateContainerDiagnostic(row)); },
    sync(phase, operation) { mark(phase, "entered"); try { const value = operation(); mark(phase, "fulfilled"); return value; } catch (error) { mark(phase, "rejected", error); throw error; } },
    async step(phase, operation) { mark(phase, "entered"); try { const value = await operation(); mark(phase, "fulfilled"); return value; } catch (error) { mark(phase, "rejected", error); throw error; } },
  };
}
export function launchCli(argv, { run = main, writer = line => process.stdout.write(line), errorWriter = line => process.stderr.write(line), events = process, setExit = code => { process.exitCode = code; } } = {}) {
  const report = createContainerDiagnostics(), errors = [];
  const containerAction = ["container-ci", "container-init", "container-build", "container-prepare"].includes(argv[0]);
  let pending = true, emitted = false;
  const failure = code => {
    setExit(code);
    if (emitted) return;
    emitted = true;
    // Existing non-container commands retain their own diagnostic protocol.
    if (containerAction) try { emitContainerFailure(report.records, writer); } catch (error) { errors.push(error); report.mark("reporting", "rejected", error); }
    try { errorWriter("edge-proof: offline preparation refused; no cloud action attempted\n"); } catch (error) { errors.push(error); report.mark("reporting", "rejected", error); }
  };
  const beforeExit = () => {
    if (!pending) return;
    const error = new Error("edge-proof: original CLI work unresolved");
    errors.push(error); report.mark("pending", "rejected", error);
    events.removeListener("beforeExit", beforeExit);
    failure(13);
  };
  events.on("beforeExit", beforeExit);
  // Do not top-level-await this promise: container dispatch dynamically imports
  // a module that statically imports these exports. Keep rejection ownership,
  // and fail closed if Node would exit with original work still unresolved.
  const completion = (async () => {
    try {
      const value = await report.step("entry", () => run(argv, report));
      if (!errors.length) report.sync("serialization", () => writer(`${JSON.stringify(value)}\n`));
    } catch (error) { errors.push(error); }
    finally { pending = false; events.removeListener("beforeExit", beforeExit); }
    if (errors.length) {
      failure(1);
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "edge-proof: CLI and reporting failures");
    }
  })();
  // The CLI owns exit status; callers/tests may still inspect the exact failures.
  void completion.catch(() => {});
  return { completion, errors, records: report.records };
}
export async function main(argv, report) {
  const [action = "plan", ...args] = argv;
  if (["container-ci", "container-init", "container-build", "container-prepare"].includes(action)) {
    const load = () => import("./edge-proof-container.mjs");
    const { containerMain } = report ? await report.step("module_import", load) : await load();
    return report ? report.step("dispatch", () => containerMain(action, args, report)) : containerMain(action, args);
  }
  if (action === "offline-ci" && args.length === 0) return runPackagingBoundary("parent", offlineCi);
  if (action === "offline-child" && args.length === 3) return runPackagingBoundary("child", report => offlineChild(args[0], args[1], JSON.parse(args[2]), report), { writer: line => process.stdout.write(line) });
  if (action === "offline-build" && args.length === 4 && ["build_a", "build_b"].includes(args[3])) return runPackagingBoundary(args[3], async report => {
    validateNamespace(await report.step("namespace_read", namespaceEvidence), JSON.parse(args[2]), true, report);
    const { buildCapsule } = await report.step("builder_import", () => import("./edge-proof-build.mjs"));
    const receipt = await report.step("build", () => buildCapsule(args[0], args[1]));
    await report.step("receipt_write", () => writeFile(join(args[1], "source-receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 }));
    report.sync("build_service_stop", () => createRequire(import.meta.resolve("wrangler/package.json"))("esbuild").stop());
    return { built: true };
  }, { writer: line => process.stdout.write(line) });
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
  const { buildCapsule } = await import("./edge-proof-build.mjs");
  const receipt = await buildCapsule(process.cwd(), output);
  await writeFile(join(output, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { built: true, sourceSha: receipt.sourceSha, sourceTree: receipt.sourceTree, sourceFiles: receipt.sourceFiles.length, cloud: "UNRUN", sdk: "UNRUN" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launchCli(process.argv.slice(2));
}
