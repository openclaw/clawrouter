import { randomBytes, createHash } from "node:crypto";
import { writeSync } from "node:fs";
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
const containerDiagnosticPhases = ["entry", "module_import", "dispatch", "serialization", "reporting", "pending", "host_runtime", "parent_namespaces", "cwd", "temp", "environment", "docker_executable", "daemon_socket", "identity", "context", "daemon", "base", "image_build", "image_build_process", "image_build_internal", "native_prepare_internal", "attach_process", "init_prerequisite", "image_id", "native_receipt", "image", "create", "attach", "ready", "admission", "permit", "wait", "receipt", "terminal", "cgroup", "retirement", "remove", "final", "overflow"];
export const imageBuildStages = ["node_version", "node_abi", "architecture", "git_executable", "pnpm_bootstrap", "pnpm_version", "input_directories", "input_ownership", "frozen_install", "native_prepare"];
export const nativePrepareStages = Object.freeze([
  "app_entry", "module_import", "dispatch", "prepare_arguments", "runtime", "context_read", "context_identity",
  "context_enumeration", "context_byte_closure", "input_hashes", "link_containment", "typescript_anchor", "wrangler_anchor",
  "esbuild_resolver", "native_node", "native_git", "native_typescript", "native_esbuild", "native_wrangler", "native_identity",
  "typescript_resolver", "esbuild_child", "esbuild_version_check", "pnpm_child", "pnpm_version_check", "receipt_write", "receipt_output", "cli_serialization",
]);
export const enumerationOperations = Object.freeze(["directory_read", "directory_sort", "entry_path", "exclusion", "path_check", "directory_type", "recursion", "file_type", "file_type_check", "file_read", "byte_count", "capacity", "hash", "file_record", "final_sort"]);
export function validateEnumerationDetail(value) {
  const fields = ["op", "type", "depth", "files", "bytes", "overflow", "failed", "defined"];
  if (value && Object.hasOwn(value, "m")) fields.push("m");
  if (!value || typeof value !== "object" || Object.getOwnPropertyNames(value).join() !== fields.join()) refuse("enumeration-detail-keys");
  const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
  if (!enumerationOperations.includes(row.op) || !["unknown", "directory", "not_directory", "file", "other"].includes(row.type) || row.failed !== true || typeof row.defined !== "boolean" || typeof row.overflow !== "boolean") refuse("enumeration-detail-enum");
  const types = row.op === "recursion" ? ["directory"] : row.op === "file_type" ? ["not_directory"] : row.op === "file_type_check" ? ["file", "other"] : ["file_read", "byte_count", "capacity", "hash", "file_record"].includes(row.op) ? ["file"] : ["unknown"];
  if (!types.includes(row.type)) refuse("enumeration-detail-type");
  for (const [key, limit] of [["depth", 65535], ["files", 50000], ["bytes", 268435456]]) if (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > limit) refuse("enumeration-detail-count");
  if (row.overflow && row.depth !== 65535 && row.files !== 50000 && row.bytes !== 268435456) refuse("enumeration-detail-overflow");
  // m = [class, member bytes, unlisted .git bytes, unlisted manifest-directory
  // bytes, other-root bytes, per-class overflow bitmask]. Class 0 is unknown;
  // 1..4 follow the byte-counter order. null means unavailable, never zero.
  if (Object.hasOwn(row, "m") && row.m !== null) {
    const m = row.m, limit = 268435456;
    if (!Array.isArray(m) || Object.getOwnPropertyNames(m).join() !== "0,1,2,3,4,5,length" || ownData(m, "length") !== 6) refuse("enumeration-membership-keys");
    row.m = Array.from({ length: 6 }, (_, i) => ownData(m, String(i)));
    const [kind, ...counts] = row.m, mask = counts.pop();
    if (!Number.isInteger(kind) || kind < 0 || kind > 4 || !Number.isInteger(mask) || mask < 0 || mask > 15 || counts.some(n => !Number.isInteger(n) || n < 0 || n > limit)) refuse("enumeration-membership-counts");
    const fileOperation = ["file_read", "byte_count", "capacity", "hash", "file_record"].includes(row.op);
    if (fileOperation ? kind === 0 : kind !== 0) refuse("enumeration-membership-type");
    for (let i = 0; i < 4; i++) if ((mask & (1 << i)) && counts[i] !== limit) refuse("enumeration-membership-overflow");
    const total = counts.reduce((sum, n) => sum + n, 0);
    if (row.bytes !== Math.min(total, limit) || ((mask || total > limit) && !row.overflow) || (row.bytes < limit && mask)) refuse("enumeration-membership-total");
    if (row.overflow && !mask && total <= limit && row.depth !== 65535 && row.files !== 50000) refuse("enumeration-membership-saturation");
  }
  return row;
}
// Private preparation frames never become GitHub commands. A synchronous writer
// must deliver the entire bounded frame or retain an independent failure.
export function createNativePrepareDiagnostics(identity, write = (bytes, offset, length) => writeSync(1, bytes, offset, length)) {
  const errors = []; let context, nonce, sequence = 0, index = -1, finished = false, admitted = false;
  let enumerationPoint = null, enumerationFailure = null;
  let membership = null;
  try {
    context = ownData(identity, "contextHash"); nonce = ownData(identity, "nonce");
    if (![context, nonce].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) refuse("prepare-diagnostic-identity");
    admitted = true;
  } catch (error) { errors.push(error); }
  const emit = (event, outcome = null, defined = null) => {
    if (!admitted) return;
    const row = { v: 1, context, nonce, seq: ++sequence, stage: nativePrepareStages[index], event, outcome, defined,
      reportFailures: event === "terminal" ? errors.length : null, undefinedReportFailures: event === "terminal" ? errors.filter(error => error === undefined).length : null };
    if (event === "terminal" && outcome === "original_failure" && row.stage === "context_enumeration" && enumerationFailure) {
      if (Object.hasOwn(enumerationFailure, "m")) {
        // These two values already belong to the original-failure envelope.
        const { failed: _failed, defined: _defined, ...detail } = enumerationFailure;
        row.enumeration = detail;
      } else row.enumeration = enumerationFailure;
    }
    const bytes = Buffer.from("\n" + "EDGE_NATIVE_" + "PREPARE_V1 " + JSON.stringify(row) + "\n");
    if (sequence > 32 || bytes.length > 512) refuse("prepare-diagnostic-capacity");
    for (let offset = 0; offset < bytes.length;) {
      const written = write(bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) refuse("prepare-diagnostic-write");
      offset += written;
    }
  };
  return { errors,
    enumerationManifest(manifest) {
      try {
        if (nativePrepareStages[index] !== "context_enumeration" || finished || membership !== null) refuse("enumeration-manifest-stage");
        const count = ownData(manifest, "length");
        if (!Array.isArray(manifest) || !Number.isInteger(count) || count < 0 || count > 50000) refuse("enumeration-manifest-count");
        const members = new Set(), directories = new Set();
        for (let i = 0; i < count; i++) {
          const path = ownData(ownData(manifest, String(i)), "path");
          if (typeof path !== "string" || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split("/").some(part => part === "." || part === "..") || members.has(path)) refuse("enumeration-manifest-path");
          members.add(path);
          const parts = path.split("/"); parts.pop();
          while (parts.length) { directories.add(parts.join("/")); parts.pop(); }
        }
        membership = { members, directories, counts: [0, 0, 0, 0], size: 0, kind: 0, depth: null };
      } catch (error) { membership = false; errors.push(error); }
    },
    enumerationPath(path) {
      if (!membership) return;
      try {
        if (typeof path !== "string" || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split("/").some(part => part === "." || part === "..")) refuse("enumeration-observed-path");
        const parts = path.split("/"), depth = parts.length - 1; parts.pop();
        let directory = false;
        while (parts.length) { if (membership.directories.has(parts.join("/"))) directory = true; parts.pop(); }
        membership.kind = membership.members.has(path) ? 1 : path.startsWith(".git/") ? 2 : directory ? 3 : 4;
        membership.depth = depth;
      } catch (error) { membership = false; errors.push(error); }
    },
    enumerationBytes(size) {
      if (!membership) return;
      try {
        if (!Number.isSafeInteger(size) || size < membership.size || membership.kind < 1) refuse("enumeration-observed-bytes");
        membership.counts[membership.kind - 1] += size - membership.size;
        membership.size = size;
      } catch (error) { membership = false; errors.push(error); }
    },
    enumerationPoint(op, type, depth, files, bytes) {
      try {
        if (nativePrepareStages[index] !== "context_enumeration" || finished) refuse("enumeration-observer-stage");
        const values = [depth, files, bytes], limits = [65535, 50000, 268435456];
        if (values.some(value => !Number.isSafeInteger(value) || value < 0)) refuse("enumeration-observer-count");
        const fileOperation = ["file_read", "byte_count", "capacity", "hash", "file_record"].includes(op);
        if (membership && !fileOperation) { membership.kind = 0; membership.depth = null; }
        if (membership && (membership.size !== bytes || (fileOperation && membership.depth !== depth))) refuse("enumeration-membership-observation");
        const m = membership ? [membership.kind, ...membership.counts.map(n => Math.min(n, limits[2])), membership.counts.reduce((mask, n, i) => mask | (n > limits[2] ? 1 << i : 0), 0)] : null;
        enumerationPoint = validateEnumerationDetail({ op, type, depth: Math.min(depth, limits[0]), files: Math.min(files, limits[1]), bytes: Math.min(bytes, limits[2]), overflow: values.some((value, i) => value > limits[i]), failed: true, defined: false, ...(membership !== null ? { m } : {}) });
      } catch (error) { enumerationPoint = null; errors.push(error); }
    },
    enumerationFailure(reason) {
      try {
        if (!enumerationPoint || nativePrepareStages[index] !== "context_enumeration" || finished) refuse("enumeration-observer-missing");
        enumerationFailure = validateEnumerationDetail({ ...enumerationPoint, defined: reason !== undefined });
      } catch (error) { enumerationFailure = null; errors.push(error); }
    },
    enter(stage) {
      try {
        if (finished || nativePrepareStages[index + 1] !== stage) refuse("prepare-diagnostic-order");
        index++; emit("entered");
      } catch (error) { errors.push(error); }
    },
    finish(originalFailed, reason) {
      try {
        if (finished || index < 0 || typeof originalFailed !== "boolean") refuse("prepare-diagnostic-terminal");
        finished = true;
        if (!originalFailed && index !== nativePrepareStages.length - 1) refuse("prepare-diagnostic-incomplete");
        emit("terminal", originalFailed ? "original_failure" : errors.length ? "reporter_failure" : "complete", originalFailed ? reason !== undefined : null);
      } catch (error) { errors.push(error); }
    },
  };
}
export const initPrerequisiteStages = Object.freeze(["arguments", "identity", "environment_reset", "environment_prepare", "runtime", "native_receipt", "ready_write", "permit_receive"]);
export const attachFailureBranches = Object.freeze(["spawn_throw", "setup_failure", "child_error", "stdin_error", "close_before_ready", "invalid_ready", "replayed_ready", "deadline", "ready_deadline", "interrupt", "output_capacity", "permit_write", "incomplete_ready"]);
export const initGuardTags = Object.freeze(["runtime", "ancestry", "uid_gid_groups", "capabilities", "nnp", "seccomp", "mounts", "interfaces", "routes4", "routes6", "effective_env", "native_receipt_equality"]);
export const initSourcePhases = Object.freeze(["runtime", "ancestry", "status_read", "status_validate", "mount_read", "mount_parse", "mount_validate", "namespace_read", "network_validate", "environment_construct", "environment_validate", "native_read", "native_parse", "native_validate", "native_qualify", "native_equality", "mask_namespace", "mask_snapshot", "mask_open", "mask_identity", "mask_opendir", "mask_read", "mask_dir_close", "mask_anchor_close"]);
// Wire IDs are fixed source-owned predicates, never parsed exception text.
export const mountPredicates = Object.freeze([
  ["path", 4], ["escape", 1], ["table_capacity", 3], ["row_identity", 5], ["filesystem_token", 2],
  ["vfs_options", 5], ["super_options", 5], ["optional_array", 1], ["unique_rows", 2],
  ["text_capacity", 3], ["sections", 1], ["fields", 5], ["propagation", 2], ["permitted_target", 2],
  ["required_target", 1], ["root", 3], ["nearest_parent", 2], ["automatic", 8], ["metadata", 2],
  ["readonly_proc", 7], ["null_mask", 5], ["directory_mask", 6], ["automatic_devices", 1],
  ["task_size", 1], ["dev_size_mode", 2], ["shm_size", 1],
  ["directory_mask_group", 6], ["mask_empty", 1], ["parent_cgroup_automatic", 8], ["parent_root_field", 4],
]);
export const mountTargets = Object.freeze(["/", "/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/asound", "/proc/acpi", "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"]);
export const mountFilesystems = Object.freeze(["tmpfs", "proc", "devpts", "mqueue", "sysfs", "cgroup2", "overlay", "ext4", "xfs"]);
export function validateMountDetail(value, source) {
  if (!Array.isArray(value) || Object.getOwnPropertyNames(value).join() !== [...Array(11).keys(), "length"].join()) refuse("mount-detail-shape");
  const row = Array.from({ length: 11 }, (_, i) => ownData(value, String(i)));
  const [version, predicate, leaf, role, fs, root, seen, passed, count, distinct, overflow] = row;
  if (version !== 1 || !Number.isInteger(predicate) || predicate < 1 || predicate > mountPredicates.length || !["mount_parse", "mount_validate", "mask_read"].includes(source)) refuse("mount-detail-predicate");
  if (predicate === 28 ? source !== "mask_read" : source === "mask_read" || (predicate >= 10 && predicate <= 13 ? source !== "mount_parse" : predicate >= 14 && source !== "mount_validate")) refuse("mount-detail-source");
  const width = mountPredicates[predicate - 1][1], limit = 2 ** width - 1;
  if (!Number.isInteger(leaf) || leaf < 1 || leaf > width || !Number.isInteger(seen) || seen < 1 || seen > limit || !Number.isInteger(passed) || passed < 0 || (passed & seen) !== passed || !(seen & 2 ** (leaf - 1)) || passed & 2 ** (leaf - 1)) refuse("mount-detail-leaf");
  let order = Array.from({ length: width }, (_, i) => i + 1);
  if (predicate === 14) { if (leaf !== 2 || seen !== 3 || passed !== 0) refuse("mount-detail-or"); }
  else {
    if ([18, 29].includes(predicate)) {
      const target = role === null ? null : mountTargets[role - 2];
      if (!["/task", "/proc", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue", "/sys", "/sys/fs/cgroup"].includes(target)) refuse("mount-detail-automatic-role");
      const flags = target === "/dev" ? [4, 6] : target === "/dev/pts" ? [4, 6, 8] : [target.startsWith("/sys") ? 5 : 4, 6, 7, 8];
      order = [1, 2, 3, ...flags];
    }
    const end = order.indexOf(leaf), expected = order.slice(0, end + 1).reduce((mask, id) => mask + 2 ** (id - 1), 0);
    if (end < 0 || seen !== expected || passed !== seen - 2 ** (leaf - 1)) refuse("mount-detail-short-circuit");
  }
  const optional = (n, max) => n === null || Number.isInteger(n) && n >= 1 && n <= max;
  if (!optional(role, mountTargets.length + 1) || !optional(fs, mountFilesystems.length + 1) || !optional(root, 3)) refuse("mount-detail-enum");
  const roles = { 15: Array.from({length:12},(_,i)=>i+2), 16:[2], 19:[11,12,13], 20:[14,15,16,17,18], 21:[19,20,21,22,23,24,25], 22:[1,26,27,28,29,30], 24:[3], 25:[5], 26:[7], 27:[1,26,27,28,29,30], 28:[1,26,27,28,29,30], 29:[10] };
  if (roles[predicate] && !roles[predicate].includes(role)) refuse("mount-detail-role");
  for (const n of [count, distinct]) if (!(n === null || Number.isInteger(n) && n >= 0 && n <= 4095)) refuse("mount-detail-count");
  if (!Number.isInteger(overflow) || overflow < 0 || overflow > 3 || overflow & 1 && count !== 4095 || overflow & 2 && distinct !== 4095) refuse("mount-detail-saturation");
  if (fs !== null && ![5, 16, 18, 19, 20, 21, 22, 27, 29].includes(predicate) || root !== null && ![1, 16, 18, 20, 21, 22, 27, 29, 30].includes(predicate)) refuse("mount-detail-unobserved-field");
  if (predicate === 16 && (leaf < 3 && fs !== null || leaf < 2 && root !== null) || [18,29].includes(predicate) && leaf < 2 && root !== null || [20, 21, 22, 27].includes(predicate) && leaf < 3 && root !== null || predicate === 1 && root !== null && role !== null) refuse("mount-detail-unreached-field");
  if (count !== null && ![3, 6, 7, 9, 10, 11, 23].includes(predicate) || distinct !== null && ![6, 7, 9, 23].includes(predicate) || [6, 7].includes(predicate) && leaf < 4 && distinct !== null) refuse("mount-detail-unobserved-count");
  if ([2, 3, 4, 9, 10, 11, 12, 13, 23].includes(predicate) && role !== null) refuse("mount-detail-unobserved-role");
  if (predicate === 30 && (role !== null || fs !== null || count !== null || distinct !== null || overflow !== 0 || (leaf === 1 ? root !== null : root !== 3))) refuse("parent-root-detail");
  const relation = (id, result) => { if (result !== null && seen & 2 ** (id - 1) && Boolean(passed & 2 ** (id - 1)) !== result) refuse("mount-detail-value-comparison"); };
  const fsIs = names => fs === null ? null : names.includes(mountFilesystems[fs - 2]);
  const rootIs = expected => root === null ? null : root === expected;
  if (predicate === 1) {
    if (role !== null || root !== null) relation(1, true);
    if (role >= 2 || root === 1 || root === 2) for (const id of [2, 3, 4]) relation(id, true);
  }
  if (predicate === 5) { if (fs !== null) relation(1, true); if (fs >= 2) relation(2, true); }
  if (predicate === 16) { relation(2, rootIs(1)); relation(3, fsIs(["overlay", "ext4", "xfs"])); }
  if ([18,29].includes(predicate)) {
    const expected = { "/task": "tmpfs", "/proc": "proc", "/dev": "tmpfs", "/dev/pts": "devpts", "/dev/shm": "tmpfs", "/dev/mqueue": "mqueue", "/sys": "sysfs", "/sys/fs/cgroup": "cgroup2" };
    relation(1, fsIs([expected[mountTargets[role - 2]]])); if (predicate === 18) relation(2, rootIs(1)); else if (root === 1 || root === 2) relation(2, false);
  }
  if (predicate === 19) relation(1, fsIs(["ext4", "xfs"]));
  if (predicate === 20) relation(1, fsIs(["proc"]));
  if (predicate === 21) relation(3, rootIs(2));
  if ([22, 27].includes(predicate)) { relation(1, fsIs(["tmpfs"])); relation(3, rootIs(1)); }
  // The proc root RHS and null-mask filesystem RHS are separate, uncaptured reads.
  const comparison = predicate === 9 ? leaf : predicate === 23 ? 1 : [6, 7].includes(predicate) && leaf >= 4 ? 4 : null;
  if (comparison !== null && count !== null && distinct !== null && overflow === 0 && (count === distinct) !== Boolean(passed & 2 ** (comparison - 1))) refuse("mount-detail-count-comparison");
  if (predicate === 23 && (count === null || distinct === null || role !== null)) refuse("mount-detail-aggregate");
  return row;
}
// Close states: 0 not called, 1 original Node promise fulfilled, 2 rejected/threw.
// The pinned libuv path does not expose native closedir errno.
export function validateMaskDetail(value) {
  if (!Array.isArray(value) || Object.getOwnPropertyNames(value).join() !== [...Array(8).keys(), "length"].join()) refuse("mask-detail-shape");
  const row = Array.from({ length: 8 }, (_, i) => ownData(value, String(i)));
  const [version, role, total, completed, read, directoryClose, anchorClose, nativeErrno] = row;
  if (version !== 1 || !(role === null || [1,26,27,28,29,30].includes(role)) || !Number.isInteger(total) || total < 0 || total >= 4096 || !Number.isInteger(completed) || completed < 0 || completed > total || ![read, directoryClose, anchorClose].every(n => [0,1,2].includes(n)) || nativeErrno !== "UNOBSERVABLE") refuse("mask-detail-value");
  if (read !== 0 && directoryClose === 0 || directoryClose !== 0 && anchorClose === 0 || role === null && [read,directoryClose,anchorClose].some(Boolean)) refuse("mask-detail-order");
  return row;
}
export function validateInitDetail(value) {
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== ["guard", "source", ...(Object.hasOwn(value, "m") ? ["m"] : []), ...(Object.hasOwn(value, "e") ? ["e"] : [])].sort().join()) refuse("init-detail-keys");
  const row = { guard: ownData(value, "guard"), source: ownData(value, "source") };
  if (!(row.guard === null || initGuardTags.includes(row.guard)) || !initSourcePhases.includes(row.source)) refuse("init-detail-enum");
  const sources = { runtime: ["runtime"], ancestry: ["ancestry"], uid_gid_groups: ["status_validate"], capabilities: ["status_validate"], nnp: ["status_validate"], seccomp: ["status_validate"], mounts: ["mount_parse", "mount_validate", ...initSourcePhases.filter(phase => phase.startsWith("mask_"))], interfaces: ["network_validate"], routes4: ["network_validate"], routes6: ["network_validate"], effective_env: ["environment_validate"], native_receipt_equality: ["native_equality"] };
  if (row.guard !== null && !sources[row.guard].includes(row.source)) refuse("init-detail-pair");
  if (Object.hasOwn(value, "m")) { if (row.guard !== "mounts") refuse("mount-detail-guard"); row.m = validateMountDetail(ownData(value, "m"), row.source); }
  if (Object.hasOwn(value, "e")) {
    if (!row.source.startsWith("mask_") || ![null, "mounts"].includes(row.guard)) refuse("mask-detail-source");
    row.e = validateMaskDetail(ownData(value, "e"));
    if (row.m && (row.m[1] !== 28 || row.m[3] !== row.e[1] || row.e[4] !== 1)) refuse("mask-detail-binding");
    const [, role, total, completed, read, directoryClose, anchorClose] = row.e;
    if (["mask_namespace", "mask_snapshot"].includes(row.source)) {
      if (role !== null || ![0, total].includes(completed) || read || directoryClose || anchorClose) refuse("mask-detail-snapshot");
    } else {
      if (role === null || completed >= total) refuse("mask-detail-target");
      if (row.source === "mask_open" && (read || directoryClose) || row.source === "mask_opendir" && (read || directoryClose || !anchorClose) || row.source === "mask_identity" && read === 2 || row.source === "mask_read" && !read || row.source === "mask_dir_close" && (read !== 1 || directoryClose !== 2) || row.source === "mask_anchor_close" && (read !== 1 || ![1, 2].includes(directoryClose) || anchorClose !== 2 || directoryClose === 2 && row.guard !== null)) refuse("mask-detail-phase");
    }
  }
  if (row.m?.[1] === 28 && !row.e) refuse("mask-detail-missing-close");
  if ([29,30].includes(row.m?.[1])) refuse("init-parent-only-mount");
  return row;
}
export function createInitDiagnostics(writer = text => {
  const bytes = Buffer.from(text); if (writeSync(1, bytes, 0, bytes.length) !== bytes.length) refuse("init-frame-short-write");
}) {
  const errors = []; let identity, index = -1, seq = 0, finished = false;
  const emit = (event, reason = null, defined = null, detail, extraErrors = []) => {
    if (!identity) return;
    const row = { v: 1, ...identity, seq: ++seq, stage: initPrerequisiteStages[index], event, reason, defined, reportFailures: errors.length + extraErrors.length, undefinedReportFailures: [...errors, ...extraErrors].filter(error => error === undefined).length };
    if (detail !== undefined) row.detail = validateInitDetail(detail);
    const text = "\nEDGE_INIT_" + "V1 " + JSON.stringify(row) + "\n";
    if (seq > 9 || row.reportFailures > 16 || Buffer.byteLength(text) > 512) refuse("init-frame-capacity");
    writer(text);
  };
  return { errors,
    bind(nonce, contextHash) { try {
      if (identity || index !== 0 || !/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(contextHash)) refuse("init-frame-binding");
      identity = { nonce, contextHash }; emit("entered");
    } catch (error) { errors.push(error); } },
    enter(stage) { try { if (finished || initPrerequisiteStages[index + 1] !== stage) refuse("init-frame-order"); index++; emit("entered"); } catch (error) { errors.push(error); } },
    finish(failed, reason, detail, extraErrors = []) { try {
      if (finished || index < 0 || typeof failed !== "boolean" || !failed && index !== 7 && errors.length + extraErrors.length === 0) refuse("init-frame-terminal");
      finished = true; emit("terminal", failed ? "original_failure" : errors.length + extraErrors.length ? "reporter_failure" : "complete", failed ? reason !== undefined : null, failed ? detail : undefined, extraErrors);
    } catch (error) { errors.push(error); } },
  };
}
const containerDiagnosticSignals = [null, "SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGBUS", "SIGSYS"];
const processDiagnosticFields = ["v", "phase", "state", "defined", "available", "exit", "signal", "closed", "timedOut", "interrupted", "errors", "undefinedErrors", "spawnErrors", "undefinedSpawnErrors", "stdoutComplete", "stderrComplete"];
export const parentAdmissionSources = Object.freeze(["parent_status_read", "parent_identity", "inspect_command", "inspect_success", "inspect_json", "inspect_count", "inspect_validate", "live_init", "target_stat", "target_start", "target_parent", "target_status", "target_uid_map", "target_gid_map", "target_namespace_group", "target_mount_read", "target_mount_parse", "target_cgroup_read", "target_validate", "cgroup_path", "cgroup_realpath", "cgroup_stat", "cgroup_parent_stat", "cgroup_limits_group", "cgroup_limits", "parent_namespace", "parent_mount_read", "parent_mount_parse", "metadata", "identity_freshness", "mount_freshness", "cgroup_freshness", "metadata_freshness", "cgroup_observer", "cgroup_relation", "cgroup_binding", "cgroup_closing", "cgroup_repeat"]);
export const parentAdmissionRoles = Object.freeze(["Groups", "Uid", "Gid", "uid", "gid", "pid", "net", "mnt", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "ResolvConfPath", "HostnamePath", "HostsPath", "identity", "Binds", "VolumesFrom", "Devices", "DeviceRequests", "GroupAdd", "PortBindings", "Sysctls", "CgroupMount", "ParentAuthority"]);
export const parentAdmissionPredicates = Object.freeze([["status-capacity", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["status-field", 1, [[1, 0]], [[0, 0]]], ["identity-tuple", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["identity-groups", 1, [[1, 0]], [[0, 0]]], ["identity-drift", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["groups-drift", 1, [[1, 0]], [[0, 0]]], ["host-id-mapping", 5, [[1, 0], [3, 1], [7, 3], [15, 7], [31, 15]], [[0, 0], [1, 1], [3, 3], [7, 7], [15, 15]]], ["container-custody", 5, [[1, 0], [3, 1], [7, 3], [15, 7], [31, 15]], [[0, 0], [1, 1], [3, 3], [7, 7], [15, 15]]], ["container-isolation", 6, [[1, 0], [3, 1], [7, 3], [15, 7], [31, 15], [63, 31]], [[0, 0], [1, 1], [3, 3], [7, 7], [15, 15], [31, 31]]], ["container-capabilities", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["container-limits", 4, [[1, 0], [3, 1], [7, 3], [15, 7]], [[0, 0], [1, 1], [3, 3], [7, 7]]], ["container-extra-input", 2, [[3, 0]], [[0, 0], [1, 0]]], ["container-extra-input", 2, [[3, 0]], [[0, 0], [1, 0]]], ["container-port", 2, [[3, 0]], [[0, 0], [1, 0]]], ["container-mounts", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["container-tmpfs", 1, [[1, 0]], [[0, 0]]], ["container-command", 4, [[1, 0], [3, 1], [7, 3], [15, 7]], [[0, 0], [1, 1], [3, 3], [7, 7]]], ["container-env", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["daemon-root-identity", 1, [[1, 0]], [[0, 0]]], ["daemon-metadata-custody", 1, [[1, 0]], [[0, 0]]], ["daemon-metadata-parent-ambiguous", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["daemon-metadata-target", 1, [[1, 0]], [[0, 0]]], ["daemon-metadata-filesystem-unqualified", 1, [[1, 0]], [[0, 0]]], ["daemon-metadata-mount-identity", 4, [[1, 0], [3, 1], [7, 3], [15, 7]], [[0, 0], [1, 1], [3, 3], [7, 7]]], ["mount-observation-drift", 1, [[1, 0]], [[0, 0]]], ["process-id", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["process-start", 1, [[1, 0]], [[0, 0]]], ["user-mapping-unqualified", 1, [[1, 0]], [[0, 0]]], ["private-namespace", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["cgroup-cid", 1, [[1, 0]], [[0, 0]]], ["cgroup-custody", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["effective-cgroup-limit", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["effective-cpu-limit", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["cgroup-realpath", 1, [[1, 0]], [[0, 0]]], ["child-capability", 1, [[1, 0]], [[0, 0]]], ["child-security", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["missing-live-init", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["parent-mount-namespace-drift", 1, [[1, 0]], [[0, 0]]], ["init-identity-drift", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["init-cgroup-drift", 1, [[1, 0]], [[0, 0]]], ["daemon-metadata-drift", 1, [[1, 0]], [[0, 0]]], ["parent-mount-namespace-drift", 1, [[1, 0]], [[0, 0]]], ["inspect-count", 2, [[1, 0], [3, 1]], [[0, 0], [1, 1]]], ["canonical-number", 3, [[1, 0], [3, 1], [7, 3]], [[0, 0], [1, 1], [3, 3]]], ["observer-namespace", 1, [[1, 0]], [[0, 0]]], ["private-cgroup-namespace", 1, [[1, 0]], [[0, 0]]], ["owned-unified-membership", 1, [[1, 0]], [[0, 0]]], ["parent-cgroup-mapping", 1, [[1, 0]], [[0, 0]]], ["parent-cgroup-overmount", 1, [[1, 0]], [[0, 0]]], ["cgroup-view-custody", 1, [[1, 0]], [[0, 0]]], ["cgroup-directory-identity", 1, [[1, 0]], [[0, 0]]], ["cgroup-closing-view", 1, [[1, 0]], [[0, 0]]], ["cgroup-repeat-view", 1, [[1, 0]], [[0, 0]]], ["parent-mount-device", 1, [[1, 0]], [[0, 0]]], ["parent-stack-ancestor", 1, [[1, 0]], [[0, 0]]], ["parent-stack-equal", 1, [[1, 0]], [[0, 0]]], ["parent-stack-descendant", 1, [[1, 0]], [[0, 0]]], ["parent-metadata-overmount", 1, [[1, 0]], [[0, 0]]], ["parent-authority-binding", 1, [[1, 0]], [[0, 0]]]]);
export function validateParentAdmission(value) {
  const fields = ["v", "phase", "state", "defined", "exit", "signal", "detail", ...(Object.hasOwn(value, "m") ? ["m"] : [])];
  if (Object.getOwnPropertyNames(value).sort().join() !== [...fields].sort().join()) refuse("parent-admission-keys");
  const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
  if (row.v !== 8 || row.phase !== "admission" || row.state !== "rejected" || typeof row.defined !== "boolean" || row.exit !== null || row.signal !== null) refuse("parent-admission-outcome");
  const tuple = row.detail;
  if (!Array.isArray(tuple) || Object.getOwnPropertyNames(tuple).join() !== [...Array(11).keys(), "length"].join()) refuse("parent-admission-tuple");
  row.detail = Array.from({length:11}, (_,i) => ownData(tuple,String(i)));
  const [version,source,visit,kind,predicate,leaf,role,seen,passed,count,saturation] = row.detail;
  if (version !== 1 || !Number.isInteger(source) || source < 1 || source > parentAdmissionSources.length || ![1,2].includes(visit) || ![0,1,2,3].includes(kind) || !Number.isInteger(predicate) || predicate < 0 || predicate > parentAdmissionPredicates.length || !Number.isInteger(role) || role < 0 || role > parentAdmissionRoles.length || !Number.isInteger(seen) || !Number.isInteger(passed) || seen < 0 || passed < 0 || (passed & seen) !== passed) refuse("parent-admission-value");
  const spec = predicate ? parentAdmissionPredicates[predicate - 1] : null;
  const sources = [[2, 19], [2, 19], [2, 19], [2, 19], [2, 19], [2, 19], [19], [7], [7], [7], [7], [7], [7], [7], [7], [7], [7], [7], [29], [29], [29], [29], [29], [29], [31], [9], [10], [19], [19], [20], [20], [25], [25], [21], [19], [19], [8], [26], [30], [32], [33], [26], [6], [2, 11, 19, 25], [34], [35], [35], [35], [35], [34,35,36,19], [36], [37], [38], [36], [29,35], [29,35], [29,35], [29,35], [29,35]];
  if (predicate && !sources[predicate - 1].includes(source)) refuse("parent-admission-source");
  if (predicate >= 55 && predicate <= 58 && (![14,15,16,25].includes(role) || predicate === 58 && role === 25)) refuse("parent-authority-role");
  if (predicate === 59 && ![14,15,16,26].includes(role)) refuse("parent-authority-binding-role");
  if (kind === 1 && predicate) {
    if (!Number.isInteger(leaf) || leaf < 1 || leaf > spec[1] || !(seen & 2 ** (leaf - 1)) || passed & 2 ** (leaf - 1) || !spec[2].some(([s,p]) => s === seen && p === passed)) refuse("parent-admission-mask");
  } else if (leaf !== 0 || (kind !== 2 && (predicate || seen || passed))) refuse("parent-admission-mask");
  if (kind === 2 && (!spec || !spec[3].some(([s,p]) => s === seen && p === passed))) refuse("parent-admission-evaluation");
  if (!(count === null || Number.isInteger(count) && count >= 0 && count <= 4095) || ![0,1].includes(saturation) || saturation && count !== 4095 || count !== null && ![1, 2, 3, 21, 22, 43].includes(predicate)) refuse("parent-admission-count");
  if (visit === 2 && [1,2,3,4,5,6,7,8].includes(source)) refuse("parent-admission-visit");
  if (count !== null && !saturation) {
    const relation = (bit, expected) => { if (seen & bit && Boolean(passed & bit) !== expected) refuse("parent-admission-count-relation"); };
    if (predicate === 1) relation(2, count <= 65536);
    if ([2,22].includes(predicate)) relation(1, count === 1);
    if (predicate === 3) relation(1, count === 4);
    if (predicate === 21) { relation(1, count > 0); if (count === 1) relation(2, true); }
    if (predicate === 43) relation(2, count === 1);
  }
  if (Object.hasOwn(row,"m")) { if (![17,19,28,29,31].includes(source) || kind !== 1 || predicate) refuse("parent-admission-mount"); const mountPredicate = ownData(row.m, "1"); if (mountPredicate === 29 && source !== 19) refuse("parent-cgroup-source"); if (mountPredicate === 30 && ![28,29].includes(source)) refuse("parent-root-source"); row.m = validateMountDetail(row.m, mountPredicate >= 10 && mountPredicate <= 13 ? "mount_parse" : "mount_validate"); }
  else if (kind === 1 && !predicate) refuse("parent-admission-missing-predicate");
  return row;
}

export const receiptOperations = Object.freeze([["scan",0],["filter",0],["count_size",2],["json",0],["keys",1],["identity",14],["masks",8],["results_keys",1],["values",0],["result_keys",1],["result",6]]);
export const receiptChildPhases = Object.freeze(["entry","namespace_read","process_inventory","environment","build_a_launch","build_a_close","build_a_report","build_b_launch","build_b_close","build_b_report","builder_import","build","receipt_write","build_service_stop","two_roots","wrangler_input","edge_config","edge_launch","edge_close","edge_output","edge_marker","edge_hash","edge_privacy","upstream_config","upstream_launch","upstream_close","upstream_output","upstream_marker","upstream_hash","upstream_privacy","final_namespace","final_descendants","final"]);
export function validateReceiptDiagnostic(value) {
  const keys=["v","phase","state","defined","exit","signal","parser","child","reports"];
  if (Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("receipt-diagnostic-keys");
  const row=Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));
  if (row.v!==9 || row.phase!=="receipt" || row.state!=="rejected" || typeof row.defined!=="boolean" || row.exit!==null || row.signal!==null) refuse("receipt-diagnostic-state");
  const tuple=(v,n)=>{if(!Array.isArray(v)||Object.getOwnPropertyNames(v).join()!==[...Array(n).keys(),"length"].join())refuse("receipt-diagnostic-tuple");return Array.from({length:n},(_,i)=>ownData(v,String(i)));};
  if(row.parser!==null){
    row.parser=tuple(row.parser,9);const [v,outcome,defined,op,kind,leaf,role,seen,passed]=row.parser;
    if(v!==1||![0,1,2].includes(outcome)||![0,1,2].includes(kind)||![0,1,2].includes(role)||![op,leaf,seen,passed].every(Number.isSafeInteger)||op<0||op>receiptOperations.length||seen<0||passed<0||(passed&seen)!==passed)refuse("receipt-parser-values");
    if(outcome!==2){if(defined!==null||op||kind||leaf||role||seen||passed)refuse("receipt-parser-nonfailure");}
    else {
      if(typeof defined!=="boolean"||row.defined!==defined||!op||([10,11].includes(op)?role===0:role!==0))refuse("receipt-parser-operation");
      const width=receiptOperations[op-1][1];if(seen>=2**width||passed>=2**width)refuse("receipt-parser-width");
      if(kind===1){if(leaf<1||leaf>width||seen!==2**leaf-1||passed!==2**(leaf-1)-1)refuse("receipt-parser-false");}
      else if(leaf||passed!==seen||(kind===0?seen!==0:seen===0)||!Array.from({length:width+1},(_,n)=>2**n-1).includes(seen))refuse("receipt-parser-throw");
    }
  }
  row.child=tuple(row.child,9);const [v,reason,records,mask,terminal,role,phase,defined,reporting]=row.child;
  const known=["reported_rejection","reported_complete"].includes(reason);
  if(v!==1||reporting!=="UNKNOWN"||!["binding_unavailable","capture_unavailable","capture_mismatch","init_unqualified","no_records","incomplete","invalid","reported_rejection","reported_complete"].includes(reason))refuse("receipt-child-reason");
  if(known){if(!Number.isInteger(records)||records<2||records>256||!Number.isInteger(mask)||mask<1||mask>7||!(mask&1)||![1,2].includes(terminal))refuse("receipt-child-lifecycle");
    if(reason==="reported_complete"?(mask!==7||terminal!==1||role!==0||phase!==0||defined!==null):(terminal!==2||![1,2,3].includes(role)||!(mask&2**(role-1))||!Number.isInteger(phase)||phase<1||phase>receiptChildPhases.length||typeof defined!=="boolean"))refuse("receipt-child-outcome");
    if(reason === "reported_rejection") { const builder = ["entry","namespace_read","builder_import","build","receipt_write","build_service_stop","final"]; const name = receiptChildPhases[phase-1]; if (role === 1 ? ["builder_import","build","receipt_write","build_service_stop"].includes(name) : !builder.includes(name)) refuse("receipt-child-role-phase"); }
  } else if(mask||terminal||role||phase||defined!==null||(reason==="no_records"?records!==0:reason==="incomplete"?!Number.isInteger(records)||records<1||records>256:records!==null))refuse("receipt-child-unknown");
  row.reports=tuple(row.reports,2);if(!row.reports.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535)||row.reports[1]>row.reports[0]||row.parser?.[1]!==2&&row.reports[0]===0)refuse("receipt-report-failure");
  return row;
}
export function validateContainerDiagnostic(value) {
  if (value && typeof value === "object" && ownData(value, "v") === 9) return validateReceiptDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 8) return validateParentAdmission(value);
  if (value && typeof value === "object" && ownData(value, "v") === 6) {
    const fields = ["v", "phase", "state", "exit", "signal", "closed", "timedOut", "interrupted", "errors", "undefinedErrors", "supervisor", "ready", "first", "branches", "capture"];
    if (Object.getOwnPropertyNames(value).sort().join() !== [...fields].sort().join()) refuse("attach-summary-keys");
    const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
    const tuple = (v, n) => Array.isArray(v) && Object.getOwnPropertyNames(v).join() === [...Array(n).keys(), "length"].join() && Array.from({ length: n }, (_, i) => ownData(v, String(i))).every(x => typeof x === "boolean");
    if (row.phase !== "attach_process" || row.state !== "observed" || !containerDiagnosticSignals.includes(row.signal) || !(row.exit === null || Number.isInteger(row.exit) && row.exit >= -2147483648 && row.exit <= 2147483647)) refuse("attach-summary-outcome");
    if (![row.closed, row.timedOut, row.interrupted, row.ready].every(v => typeof v === "boolean") || !tuple(row.supervisor, 6) || !tuple(row.capture, 2)) refuse("attach-summary-facts");
    const [attempted, returned, threw, setupFailed, closeEvent, settled] = row.supervisor;
    if (!attempted || !settled || !row.closed || returned === threw || setupFailed && !returned || closeEvent && !returned || row.ready && !returned || !closeEvent && row.capture.some(Boolean)) refuse("attach-summary-consistency");
    if (!Number.isSafeInteger(row.errors) || row.errors < 0 || !Number.isSafeInteger(row.undefinedErrors) || row.undefinedErrors < 0 || row.undefinedErrors > row.errors || !Number.isInteger(row.branches) || row.branches < 0 || row.branches >= 2 ** attachFailureBranches.length || !(row.first === null || attachFailureBranches.includes(row.first)) || (row.first === null ? row.branches !== 0 : !(row.branches & 2 ** attachFailureBranches.indexOf(row.first)))) refuse("attach-summary-counts");
    return row;
  }
  if (value && typeof value === "object" && ownData(value, "v") === 7) {
    const fields = ["v", "phase", "state", "stage", "defined", "records", "reason", "reportFailures", "undefinedReportFailures"];
    if (Object.hasOwn(value, "detail")) fields.push("detail");
    if (Object.getOwnPropertyNames(value).sort().join() !== [...fields].sort().join()) refuse("init-summary-keys");
    const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
    const terminal = ["original_failure", "reporter_failure", "complete"].includes(row.reason);
    if (Object.hasOwn(row, "detail")) { if (row.reason !== "original_failure" || !["runtime", "native_receipt"].includes(row.stage)) refuse("init-detail-stage"); row.detail = validateInitDetail(row.detail); if (row.detail.source.startsWith("native_") !== (row.stage === "native_receipt")) refuse("init-detail-source-stage"); }
    // Two retained original close failures are thrown together as an AggregateError.
    if (row.detail?.source === "mask_anchor_close" && row.detail.e?.[5] === 2 && row.defined !== true) refuse("mask-detail-aggregate-defined");
    if (row.phase !== "init_prerequisite" || !["binding_unavailable", "capture_unavailable", "capture_mismatch", "no_records", "incomplete", "invalid", "original_failure", "reporter_failure", "complete"].includes(row.reason)) refuse("init-summary-enum");
    if (terminal) {
      if (!Number.isInteger(row.records) || row.records < 2 || row.records > 9 || !Number.isInteger(row.reportFailures) || row.reportFailures < 0 || row.reportFailures > 16 || !Number.isInteger(row.undefinedReportFailures) || row.undefinedReportFailures < 0 || row.undefinedReportFailures > row.reportFailures) refuse("init-summary-counts");
      if (row.reason === "original_failure" ? row.state !== "rejected" || row.stage !== initPrerequisiteStages[row.records - 2] || typeof row.defined !== "boolean" : row.stage !== null || row.defined !== null || (row.reason === "complete" ? row.records !== 9 || row.state !== "observed" || row.reportFailures !== 0 : row.state !== "rejected" || row.reportFailures < 1)) refuse("init-summary-terminal");
    } else if (row.state !== "observed" || row.stage !== null || row.defined !== null || row.reportFailures !== null || row.undefinedReportFailures !== null || (row.reason === "no_records" ? row.records !== 0 : row.reason === "incomplete" ? !Number.isInteger(row.records) || row.records < 1 || row.records > 8 : row.records !== null)) refuse("init-summary-unknown");
    return row;
  }
  if (value && typeof value === "object" && ownData(value, "v") === 5) {
    const fields = ["v", "phase", "state", "stage", "defined", "records", "reason", "reportFailures", "undefinedReportFailures"];
    if (Object.hasOwn(value, "enumeration")) fields.push("enumeration");
    if (Object.getOwnPropertyNames(value).sort().join() !== [...fields].sort().join()) refuse("prepare-summary-keys");
    const row = Object.fromEntries(fields.map(key => [key, ownData(value, key)]));
    if (row.phase !== "native_prepare_internal" || !["capture_unavailable", "capture_mismatch", "outer_inconsistent", "no_records", "incomplete", "invalid", "original_failure", "reporter_failure", "complete"].includes(row.reason)) refuse("prepare-summary-enum");
    const terminal = ["original_failure", "reporter_failure", "complete"].includes(row.reason);
    if (terminal) {
      if (!Number.isInteger(row.records) || row.records < 2 || row.records > 29 || !Number.isInteger(row.reportFailures) || row.reportFailures < 0 || row.reportFailures > 32 || !Number.isInteger(row.undefinedReportFailures) || row.undefinedReportFailures < 0 || row.undefinedReportFailures > row.reportFailures) refuse("prepare-summary-counts");
      if (row.reason === "original_failure") {
        if (row.state !== "rejected" || row.stage !== nativePrepareStages[row.records - 2] || typeof row.defined !== "boolean") refuse("prepare-summary-original");
      } else if (row.stage !== null || row.defined !== null || row.records !== 29 || (row.reason === "complete" ? row.state !== "observed" || row.reportFailures !== 0 : row.state !== "rejected" || row.reportFailures < 1)) refuse("prepare-summary-outcome");
    } else {
      if (row.state !== "observed" || row.stage !== null || row.defined !== null || row.reportFailures !== null || row.undefinedReportFailures !== null) refuse("prepare-summary-unknown");
      if (row.reason === "no_records" ? row.records !== 0 : row.reason === "incomplete" ? !Number.isInteger(row.records) || row.records < 1 || row.records > 28 : row.records !== null) refuse("prepare-summary-unknown-count");
    }
    if (Object.hasOwn(row, "enumeration")) {
      if (row.reason !== "original_failure" || row.stage !== "context_enumeration") refuse("enumeration-summary-stage");
      row.enumeration = validateEnumerationDetail(row.enumeration);
      if (row.enumeration.defined !== row.defined) refuse("enumeration-summary-outcome");
    }
    return row;
  }
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
  if (row.v !== 2 || !containerDiagnosticPhases.includes(row.phase) || ["image_build_process", "image_build_internal", "native_prepare_internal", "attach_process", "init_prerequisite"].includes(row.phase) || !["entered", "fulfilled", "rejected"].includes(row.state)) refuse("container-diagnostic-enum");
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
  const validated = records.map(validateContainerDiagnostic), detailed = validated.filter(row => row.v === 8);
  if (detailed.length > 1) refuse("parent-admission-duplicate");
  const receipt = validated.filter(row => row.v === 9); if (receipt.length > 1) refuse("receipt-diagnostic-duplicate");
  const rows = validated.filter(row => !(detailed.length && row.phase === "admission" && row.v === 2) && !(receipt.length && row.phase === "receipt" && row.v === 2)), unique = new Map();
  const rejected = rows.filter(row => row.state === "rejected");
  // Reserve the first actual failure and original build outcome before context.
  const reserved = ["admission", "ready", "attach_process", "init_prerequisite", "retirement"].map(phase =>
    rows.findLast(row => row.phase === phase && row.state === "rejected") ?? (["attach_process", "init_prerequisite"].includes(phase) ? rows.findLast(row => row.phase === phase) : undefined),
  ).filter(Boolean).concat(rows.filter(row => [3, 4, 5].includes(row.v)));
  for (const row of [...receipt, ...rejected.slice(0, 1), ...reserved, ...rejected.slice(1), ...rows.toReversed()]) if (!unique.has(row.phase)) unique.set(row.phase, row);
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
    async step(phase, operation, reporting) {
      if (reporting === undefined) { mark(phase, "entered"); try { const value = await operation(); mark(phase, "fulfilled"); return value; } catch (error) { mark(phase, "rejected", error); throw error; } }
      try { mark(phase, "entered"); } catch (error) { reporting.push(error); throw error; }
      let failed=false, reason, value; try { value=await operation(); } catch(error) { failed=true; reason=error; }
      try { mark(phase, failed ? "rejected" : "fulfilled", reason); } catch(error) { reporting.push(error); }
      if(failed) throw reason; if(reporting.length) throw reporting[0]; return value;
    },
  };
}
export function launchCli(argv, { run = main, writer = line => process.stdout.write(line), errorWriter = line => process.stderr.write(line), events = process, setExit = code => { process.exitCode = code; }, prepareWriter, prepareIdentity } = {}) {
  const report = createContainerDiagnostics(), errors = [];
  const prepare = argv[0] === "container-prepare" ? createNativePrepareDiagnostics(prepareIdentity ?? { contextHash: argv[1], nonce: process.env.TASK_NONCE }, prepareWriter) : null;
  if (prepare) report.prepare = prepare;
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
    let originalFailed = false, originalReason;
    try {
      prepare?.enter("app_entry");
      const value = await report.step("entry", () => run(argv, report));
      if (!errors.length) {
        prepare?.enter("cli_serialization");
        report.sync("serialization", () => writer(`${JSON.stringify(value)}\n`));
      }
    } catch (error) { originalFailed = true; originalReason = error; errors.push(error); }
    finally { pending = false; events.removeListener("beforeExit", beforeExit); }
    if (prepare) { prepare.finish(originalFailed, originalReason); errors.push(...prepare.errors); }
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
    report?.prepare?.enter("module_import");
    const { containerMain } = report ? await report.step("module_import", load) : await load();
    report?.prepare?.enter("dispatch");
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
