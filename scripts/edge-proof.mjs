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
  if (value && typeof value === "object" && ownData(value,"v") === 6) return validateObservedWranglerCloseDiagnostic(value);
  if (value && typeof value === "object" && ownData(value,"v") === 5) return validateWranglerCloseDiagnostic(value);
  if (value && typeof value === "object" && ownData(value,"v") === 4) return validateCensusCloseDiagnostic(value);
  if(value && typeof value==="object" && ownData(value,"v")===3) return validateOwnedCodeCloseDiagnostic(value);
  if(value && typeof value==="object" && ownData(value,"v")===2) return validateOwnedCloseDiagnostic(value);
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
  const mark = (phase, outcome, reason, result, qualification) => {
    try {
      const row = { v: 1, role, phase, outcome, defined: outcome === "rejected" ? reason !== undefined : null, exit: null, signal: null, closed: null, timedOut: null, interrupted: null, errors: null, remaining: null };
      if (result) {
        for (const [to, from] of [["exit", "code"], ["signal", "signal"], ["closed", "closed"], ["timedOut", "timedOut"], ["interrupted", "interrupted"]]) row[to] = ownData(result, from);
        row.errors = ownData(ownData(result, "errors"), "length");
        const remaining = ownData(result, "remaining"); row.remaining = remaining === null ? null : ownData(remaining, "length");
      }
      if (result && Object.hasOwn(result,"ownedTrace")) { row.v=2;row.trace=ownData(result,"ownedTrace"); }
      if (result && Object.hasOwn(result,"ownedCode")) { row.v=3;row.code=ownData(result,"ownedCode"); }
      accept(qualification === undefined ? (result && Object.hasOwn(result,"ownedCensus") ? packCensusCloseDiagnostic(row,ownData(result,"ownedCensus")) : row) : (Object.hasOwn(result,"ownedCensus") ? packObservedWranglerCloseDiagnostic(row, ownData(result,"outputSummary"), qualification, ownData(result,"ownedCensus")) : packWranglerCloseDiagnostic(row, ownData(result,"outputSummary"), qualification)));
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
  try { if(Object.hasOwn(result,"observerErrors")) errors.push(...ownData(result,"observerErrors")); } catch(error) { errors.push(error); }
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
// Optional, invocation-local observations. No error properties or native calls.
export const ownedCodeClasses = Object.freeze(["ENOENT","ESRCH","EACCES","EPERM","EIO","ENOTDIR","EBADF","EINTR","EMFILE","ENFILE","ENOMEM","EAGAIN","OTHER_STRING","UNDEFINED","NULL","OTHER_NONSTRING"]);
export function classifyOwnedCode(value) {
  if(typeof value==="string"){const index=ownedCodeClasses.slice(0,12).indexOf(value);return index<0?13:index+1;}
  return value===undefined?14:value===null?15:16;
}
export const ownedErrorSites = Object.freeze(["stop_throw","monitor_sample","monitor_rows","monitor_capacity","capture_capacity","spawn","setup","child_error","final_sample"]);
export const ownedSampleStages = Object.freeze(["admission","directory","entry_filter","stat_read","stat_parse","stat_shape","row","stat_error_filter","returned"]);
// Census observations are private copied primitives, never process identities
// in the wire format. Two detailed rows; all states retain bounded counts.
export const censusStates = "RSDZTWXIKt";
export function createFinalCensusLedger(errors) {
  const samples = new WeakMap(), history = new Map(); let close = false, order = 0, outcome = 0, final = null, broken = false, historyUnknown = false;
  const note = fn => { try { return fn(); } catch (error) { broken = true; errors.push(error); } };
  const bounded = n => Math.min(65535,n);
  return {
    censusBegin() { return note(() => ({ count: 0, counts: Array(10).fill(0), rows: [], invalid: false })); },
    censusRow(token,pid,parent,group,start,state) { note(() => {
      if (!token) throw new Error("edge-proof: census-token");
      const index = censusStates.indexOf(state);
      if (![pid,parent].every(n=>Number.isSafeInteger(n)&&n>=0) || !(Number.isSafeInteger(group) && (group>=0 || parent===0 && group===-1)) || pid<2 || typeof start!=="string" || !/^\d+$/.test(start) || typeof state!=="string" || state.length!==1 || index<0) token.invalid = true;
      token.count++; if(index>=0)token.counts[index]++;
      if(token.rows.length<512)token.rows.push({pid,parent,group,start,state:index+1});
    }); },
    censusSample(token,rows) { note(() => { if (!token || !Array.isArray(rows)) throw new Error("edge-proof: census-sample"); samples.set(rows,token); }); },
    censusObserved(rows) { note(() => {
      const token=samples.get(rows); samples.delete(rows);
      if(!token || token.invalid || token.count>512) { historyUnknown=true; return; }
      for(const row of token.rows){ const key=row.pid+":"+row.start; if(!history.has(key)&&history.size>=512){historyUnknown=true;return;} history.set(key,row); }
    }); },
    censusMonitorFailed() { note(() => { historyUnknown=true; }); },
    censusClose() { note(() => { close=true; }); },
    censusFinal() { note(() => { if(outcome||order)throw new Error("edge-proof: census-final-repeat");order=(close?1:0)|6; }); },
    censusResult(rows) { note(() => { outcome=1;final=samples.get(rows)??null;samples.delete(rows); }); },
    censusFailed(reason) { note(() => { outcome=reason===undefined?2:3; }); },
    censusFinish() { return note(() => {
      if (!outcome) return [1,0,order,null,0,null,0,null,[],0];
      if (outcome!==1) return [1,outcome,order,null,0,null,0,null,[],broken?3:0];
      if (!final || final.invalid || broken || errors.length) return [1,1,order,null,0,null,0,null,[],broken||errors.length?3:0];
      const complete=final.count<=512, ids=new Set(final.rows.map(row=>row.pid)), priorPids=new Set([...history.values()].map(row=>row.pid));
      const ambiguous=ids.size!==final.rows.length;
      const rows=final.rows.slice(0,2).map(row=>{
        const matched=ambiguous||historyUnknown?null:history.get(row.pid+":"+row.start);
        // Historical wire versions couple a matched identity to three known
        // comparisons. Keep the private identity, but report UNKNOWN if either
        // sample lacks relationships; equal sentinels are not an unchanged group.
        const prior=matched&&matched.group!==-1&&row.group!==-1?matched:null;
        const observed=ambiguous||historyUnknown||matched&&!prior?0:prior?1:priorPids.has(row.pid)?2:3;
        const parent=row.group===-1?0:row.parent===1?1:ambiguous||!complete?0:ids.has(row.parent)?2:3;
        const group=row.group===-1?0:row.group===row.pid?1:row.group===1?2:ambiguous||!complete?0:ids.has(row.group)?3:4;
        const compare=key=>prior?(row[key]===prior[key]?1:2):0;
        return row.state+observed*16+parent*64+group*256+compare("state")*2048+compare("parent")*8192+compare("group")*32768;
      });
      let saturation=final.count>65535?1:0;final.counts.forEach((n,i)=>{if(n>65535)saturation|=2**(i+1);});
      return [1,1,order,bounded(final.count),rows.length,bounded(final.count-rows.length),saturation,final.counts.map(bounded),rows,ambiguous?0:complete?1:2];
    }); },
  };
}
export function createOwnedProcessLedger() {
  const errors=[], counts=Array(5).fill(0); let activeSamples=0, pendingCode=null, firstCode=[1,0,0]; let saturation=0, first=null, sample=[0,0,0,0,0], condition=[0,0,0,0], operation=0, reasons=0, signals=0, firstReason=0, firstSignal=0, firstOutcome=0, firstThrow=0, active=false, sealed=false, ignored=0;
  const note=fn=>{try{return fn();}catch(error){errors.push(error);}};
  const bump=i=>{if(counts[i]===255)saturation|=2**i;else counts[i]++;};
  return {errors,...createFinalCensusLedger(errors),
    sampleBegin(){note(()=>{if(sealed)return;if(++activeSamples!==1)throw new Error("edge-proof: overlapping-sampler-observation");if(!first)pendingCode=null;});},
    sampleEnd(){note(()=>{if(!sealed)activeSamples--;});},
    sampleCode(reason,access,value){note(()=>{if(!sealed&&!first)pendingCode={reason,tuple:[1,access,access===1?classifyOwnedCode(value):0]};});},
    code(){return note(()=>errors.length?null:firstCode.slice());},
    sampleStage(stage){note(()=>{if(!sealed)sample=[stage,0,0,0,0];});},
    sampleLeaf(id,value,negative){note(()=>{if(sealed)return;sample[3]|=2**(id-1);if(negative?!value:!!value)sample[4]|=2**(id-1);});},
    sampleFalse(){note(()=>{if(sealed)return;sample[1]=1;sample[2]=[1,2,3].find(id=>(sample[3]&~sample[4])&2**(id-1))??0;});},
    sampleState(){return note(()=>sample.slice());},
    sampleRestore(value){note(()=>{if(!sealed)sample=value;});},
    operation(stage){note(()=>{if(!sealed)operation=stage;});},
    condition(value){note(()=>{if(!sealed)condition=value===undefined?[0,0,0,0]:[value?1:0,value?1:0,1,value?0:1];});},
    error(site,reason,stage=0){note(()=>{
      if(sealed||first)return;
      const fact=[2,9].includes(site)?sample:[4,5].includes(site)?[1,...condition]:[site===3?operation:stage,0,0,0,0];
      if(fact[1]===0&&fact[3])fact[1]=2;
      first=[site,...fact,reason!==undefined];
      if([2,9].includes(site)&&pendingCode&&Object.is(pendingCode.reason,reason))firstCode=pendingCode.tuple;
      pendingCode=null;
    });},
    request(reason,signal){note(()=>{if(sealed)return;bump(0);reasons|=2**(reason-1);signals|=signal==="SIGINT"?1:signal==="SIGTERM"?2:4;active=false;});},
    skipped(){note(()=>{if(!sealed)bump(4);});},
    attempt(reason,signal){note(()=>{if(sealed)return;bump(1);active=true;if(!firstReason){firstReason=reason;firstSignal=receiptBuilderSignals.indexOf(signal);}});},
    returned(){note(()=>{if(sealed||!active)return;bump(2);if(!firstOutcome)firstOutcome=1;active=false;});},
    thrown(reason){note(()=>{if(sealed||!active)return;bump(3);if(!firstOutcome)firstOutcome=reason===undefined?2:3;if(!firstThrow)firstThrow=reason===undefined?1:2;active=false;});},
    ignored(){note(()=>{if(sealed)return;if(ignored===255)saturation|=32;else ignored++;});},
    finish(){return note(()=>{sealed=true;return [1,errors.length?null:first,errors.length?null:[...counts,reasons,signals,firstReason,firstSignal,firstOutcome,firstThrow,saturation,ignored],[Math.min(65535,errors.length),Math.min(65535,errors.filter(e=>e===undefined).length),(errors.length>65535?1:0)|(errors.filter(e=>e===undefined).length>65535?2:0)]];});},
  };
}
const ownedNote=(recorder,method,...args)=>{if(recorder)try{return recorder[method](...args);}catch(error){recorder.errors.push(error);}};
const ownedLeaf=(recorder,id,value,negative=false)=>{ownedNote(recorder,"sampleLeaf",id,value,negative);return value;};
const ownedValue=(recorder,method,observed,value)=>{ownedNote(recorder,method,observed);return value;};
const ownedCondition=(recorder,value)=>{ownedNote(recorder,"condition",value);return value;};
const ownedArgument=(recorder,reason,signal,value)=>{ownedNote(recorder,"attempt",reason,signal);return value;};
// Only the container admission path mints this invocation-local capability.
// Each census must observe both exact PID:start controls; a missing/reused PID
// cannot be omitted. The old private-init caller remains PID1-only.
const censusControls = new WeakSet();
const censusComparisons = new WeakMap();
// Private fixture witness: only the original start comparison can mint evidence.
// Neither a caller-supplied row/mask nor an equal undefined value is authority.
export function createCensusComparisonWitness(controls, role, observe = () => {}) {
  if (!censusControls.has(controls) || !["reaper","coordinator"].includes(role)) refuse("census-witness-identity");
  const recorder = Object.freeze({}), state = {controls,role,expected:controls[role],observe,errors:[],started:false,completed:false,consumed:false,present:false};
  censusComparisons.set(recorder,state);
  return {recorder,requireRejected(failed,reason) {
    const accepted = !state.consumed && failed === true && state.started && state.completed && state.present &&
      state.record.invocation === state.invocation && state.record.controls === controls && state.record.expected === state.expected &&
      state.record.role === role && state.record.failed === true && Object.is(state.record.reason,reason);
    state.consumed = true;
    if (state.errors.length) throw new AggregateError(failed ? [reason,...state.errors] : state.errors.slice(),"edge-proof: census witness failure");
    if (!accepted) { if (failed) throw reason; refuse("census-witness-rejection-missing"); }
  }};
}
function beginCensusComparison(recorder, controls) {
  if (recorder === undefined) return undefined;
  const state = censusComparisons.get(recorder);
  if (!state || state.controls !== controls || state.started || state.consumed) {
    const error = new Error("edge-proof: census witness invocation"); if (state) state.errors.push(error); throw error;
  }
  const invocation = Object.freeze({}); state.started = true; state.invocation = invocation;
  censusComparisons.set(invocation,state); return invocation;
}
function recordCensusComparison(invocation, controls, role, expected, row, reason) {
  if (invocation === undefined) return;
  const state = censusComparisons.get(invocation);
  if (!state || state.invocation !== invocation) return;
  if (state.controls !== controls || state.role !== role || state.expected !== expected) return;
  try {
    if (state.completed || state.present) refuse("census-witness-comparison");
    state.record = {invocation,controls,role,expected,row,failed:true,reason}; state.present = true;
    state.observe();
  } catch (error) { state.errors.push(error); }
}
export function bindCensusControls(reaper, coordinator) {
  if (reaper.pid !== 1 || coordinator.pid <= 1 || coordinator.parent !== 1 || !/^\d+$/.test(reaper.start) || !/^\d+$/.test(coordinator.start)) refuse("census-control-identity");
  const controls = Object.freeze({ reaper: Object.freeze({...reaper}), coordinator: Object.freeze({...coordinator}) });
  censusControls.add(controls); return controls;
}
export function classifyCensusControl(row, controls, comparison) {
  if (!censusControls.has(controls)) refuse("census-control-authority");
  for (const [key, expected] of Object.entries(controls)) if (row.pid === expected.pid) {
    const startMismatch = row.start !== expected.start;
    if (startMismatch || row.parent !== expected.parent || row.group === -1 || !["R", "S", "D", "I"].includes(row.state)) {
      try { refuse("census-control-drift"); }
      catch (error) { if (startMismatch) recordCensusComparison(comparison,controls,key,expected,row,error); throw error; }
    }
    return key;
  }
  return null;
}
function validStatRelationships(name, parent, group) {
  // Linux do_task_stat initializes PPID=0/PGRP=-1 and emits that pair when
  // lock_task_sighand fails. It is an unavailable relationship, not no process.
  return Number.isSafeInteger(Number(name)) && Number(name)>0 &&
    ([parent,group].every(value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))) || parent==="0"&&group==="-1");
}
export async function privateProcesses(recorder, controls, comparisonRecorder) {
  const comparison = beginCensusComparison(comparisonRecorder,controls);
  const census=ownedNote(recorder,"censusBegin");
  ownedNote(recorder,"sampleBegin");
  try {
  ownedNote(recorder,"sampleStage",1);
  if (ownedLeaf(recorder,1,process.platform !== "linux",true) || ownedLeaf(recorder,2,controls ? !censusControls.has(controls) || process.pid !== controls.coordinator.pid || process.ppid !== 1 : process.pid !== 1,true)) { ownedNote(recorder,"sampleFalse"); refuse("process-census-outside-private-init"); }
  const rows = [], seenControls = new Set();
  ownedNote(recorder,"sampleStage",2);
  for (const name of await readdir("/proc")) {
    ownedNote(recorder,"sampleStage",3);
    if (!/^\d+$/.test(name) || !controls && name === "1") continue;
    let readingStat = false;
    try {
      ownedNote(recorder,"sampleStage",4);
      const statPath = `/proc/${name}/stat`;
      readingStat = true;
      const text = await readFile(statPath, "utf8");
      readingStat = false;
      ownedNote(recorder,"sampleStage",5);
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      ownedNote(recorder,"sampleStage",6);
      if (ownedLeaf(recorder,1,!/^[RSDZTWXIKt]$/.test(fields[0]),true) || ownedLeaf(recorder,2,!/^\d+$/.test(fields[19]),true) || ownedLeaf(recorder,3,!validStatRelationships(name,fields[1],fields[2]),true)) { ownedNote(recorder,"sampleFalse"); refuse("private-process-state-unknown"); }
      ownedNote(recorder,"sampleStage",7);
      const row={ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19], state: fields[0] };
      const control = controls ? classifyCensusControl(row, controls, comparison) : null;
      if (control) { if (seenControls.has(control)) refuse("duplicate-census-control"); seenControls.add(control); continue; }
      rows.push(row);
      ownedNote(recorder,"censusRow",census,row.pid,row.parent,row.group,row.start,row.state);
    } catch (error) {
      const failure=ownedNote(recorder,"sampleState");ownedNote(recorder,"sampleStage",8);
      let code;
      try { code=error?.code; }
      catch (accessError) { ownedNote(recorder,"sampleCode",accessError,2);throw accessError; }
      // proc_single_show can report a vanished task after enumeration. Only
      // the original stat read may tolerate ESRCH; later phases remain fatal.
      if (code !== "ENOENT" && !(readingStat && code === "ESRCH")) { ownedNote(recorder,"sampleCode",error,1,code);ownedNote(recorder,"sampleRestore",failure);throw error; }
    }
  }
  ownedNote(recorder,"sampleStage",9);
  if (controls && seenControls.size !== 2) refuse("missing-census-control");
  ownedNote(recorder,"censusSample",census,rows);
  return rows;
  } finally { ownedNote(recorder,"sampleEnd"); if (comparison !== undefined) censusComparisons.get(comparison).completed = true; }
}

// Original operations remain authoritative; observations never stop cleanup.
export async function runOwnedProcess(command, args, { cwd, env, timeoutMs = 60000, graceMs = 1000, sample = async () => [], spawnProcess = spawn, signalSource = process, recorder, beforeFinal } = {}) {
  const result = { code: null, signal: null, timedOut: false, interrupted: false, closed: false, errors: [], spawnErrors: [], observed: new Map(), stdout: "", stderr: "" };
  const captures = Object.fromEntries(["stdout", "stderr"].map(key => [key, { bytes: 0, hash: createHash("sha256"), esc: false }]));
  let child, escalation, bytes = 0, sampling = false, stopped = false, finished = false;
  const stop = (signal,reason) => {
    ownedNote(recorder,"request",reason,signal);
    if (!child?.pid || finished) { ownedNote(recorder,"skipped");return; }
    try { process.kill(ownedArgument(recorder,reason,signal,-child.pid), signal); ownedNote(recorder,"returned"); }
    catch (error) { ownedNote(recorder,"thrown",error);if (error?.code !== "ESRCH") { result.errors.push(error);ownedNote(recorder,"error",1,error); } else ownedNote(recorder,"ignored"); }
    if (!escalation) escalation = setTimeout(() => stop("SIGKILL",6), graceMs);
  };
  const interrupted = signal => { result.interrupted = true; stop(signal,signal==="SIGINT"?4:5); };
  const onInt = () => interrupted("SIGINT"), onTerm = () => interrupted("SIGTERM");
  const observe = async () => {
    if (sampling) return;
    sampling = true;let stage=2;
    try {
      ownedNote(recorder,"sampleStage",0);const sampled=await sample();stage=3;ownedNote(recorder,"operation",1);
      for (const row of sampled) { ownedNote(recorder,"operation",2);result.observed.set(ownedValue(recorder,"operation",3,`${row.pid}:${row.start}`), row); }
      stage=4;ownedNote(recorder,"condition",undefined);
      if (ownedCondition(recorder,result.observed.size > 512)) refuse("process-monitor-capacity");
      ownedNote(recorder,"censusObserved",sampled);
    }
    catch (error) { result.errors.push(error);ownedNote(recorder,"error",stage,error);ownedNote(recorder,"censusMonitorFailed");stop("SIGTERM",1); }
    finally { sampling = false; }
  };
  const append = key => data => {
    const capture = captures[key]; capture.bytes += data.length; capture.hash.update(data); capture.esc ||= data.includes(0x1b);
    bytes += data.length;
    if (bytes > 1024 * 1024) { if (!stopped) { const error=new Error("edge-proof: output-capacity");result.errors.push(error);ownedNote(recorder,"condition",true);ownedNote(recorder,"error",5,error); } stopped = true; stop("SIGTERM",2); }
    else result[key] += data.toString("utf8");
  };
  let deadline, monitor, setup=1;
  try {
    try { child = spawnProcess(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { result.spawnErrors.push(error); throw error; }
    setup=2;child.stdout.on("data", append("stdout")); child.stderr.on("data", append("stderr"));
    setup=3;signalSource.on("SIGINT", onInt); signalSource.on("SIGTERM", onTerm);
    setup=4;deadline = setTimeout(() => { result.timedOut = true; stop("SIGTERM",3); }, timeoutMs);
    setup=5;monitor = setInterval(() => { void observe(); }, 20);
    setup=6;await new Promise(resolveClose => {
      child.on("error", error => { result.spawnErrors.push(error); result.errors.push(error);ownedNote(recorder,"error",8,error); });
      child.once("close", (code, signal) => { result.code = code; result.signal = signal; result.closed = true; ownedNote(recorder,"censusClose"); resolveClose(); });
    });
  } catch (error) { result.errors.push(error);ownedNote(recorder,"error",setup===1?6:7,error,setup); }
  finally {
    finished = true;
    clearTimeout(deadline); clearInterval(monitor); clearTimeout(escalation);
    signalSource.removeListener("SIGINT", onInt); signalSource.removeListener("SIGTERM", onTerm);
  }
  while (sampling) await new Promise(resolveTick => setTimeout(resolveTick, 1));
  // A failed control barrier never replaces the original process errors and
  // never skips the original final sample. A pending ACK uses the outer lease.
  if (beforeFinal) try {
    if (!result.closed) refuse("control-barrier-without-close");
    await beforeFinal();
  } catch (error) { result.errors.push(error); }
  ownedNote(recorder,"censusFinal");
  try { ownedNote(recorder,"sampleStage",0);const remaining = await sample();result.remaining = remaining;ownedNote(recorder,"censusResult",remaining); } catch (error) { result.errors.push(error);ownedNote(recorder,"error",9,error);result.remaining = null;ownedNote(recorder,"censusFailed",error); }
  result.outputSummary = Object.fromEntries(Object.entries(captures).map(([key, value]) => [key, { bytes: value.bytes, sha256: value.hash.digest("hex"), esc: value.esc, complete: result.closed }]));
  if(recorder){result.ownedCensus=ownedNote(recorder,"censusFinish");result.ownedCode=ownedNote(recorder,"code");result.ownedTrace=ownedNote(recorder,"finish");result.observerErrors=recorder.errors;}
  return result;
}
export function requireProcessSuccess(result) {
  if (!result.closed || result.code !== 0 || result.signal !== null || result.timedOut || result.interrupted || result.errors.length || !Array.isArray(result.remaining) || result.remaining.length) {
    throw new AggregateError([new Error("edge-proof: child-not-qualified"), ...result.errors], "edge-proof: child-not-qualified");
  }
}
// Observation faults are independent of the original process verdict. Report
// the earliest original failure, then retain every secondary failure on throw.
export function reportObservedWranglerProcess(result, report, phase) {
  let qualification = 1, failed = false, reason;
  try { requireProcessSuccess(result); }
  catch (error) { qualification = error === undefined ? 2 : 3; failed = true; reason = error; }
  const failures = failed ? [reason] : [];
  failures.push(...result.observerErrors);
  if (failures.length) {
    try { report.mark(phase, "rejected", failures[0], result, qualification); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "edge-proof: process-observation-failures");
  }
  try { report.mark(phase, "fulfilled", undefined, result, qualification); }
  catch (error) {
    try { report.mark(phase, "rejected", error, result, qualification); }
    catch (reportError) { throw new AggregateError([error, reportError], "edge-proof: process-report-failures"); }
    throw error;
  }
}
// The qualification result is captured inside the original operation. A later
// reporting throw cannot relabel that operation or replace its original reason.
export function reportWranglerProcess(result, report, phase) {
  let qualification;
  try {
    try { requireProcessSuccess(result); qualification = 1; }
    catch (error) { qualification = error === undefined ? 2 : 3; throw error; }
    report.mark(phase, "fulfilled", undefined, result, qualification);
  } catch (error) {
    try { report.mark(phase, "rejected", error, result, qualification); }
    catch (reportError) { throw new AggregateError([error, reportError], "edge-proof: process-report-failures"); }
    throw error;
  }
}
export function verifyDryRun(result, bytes, expectedHash, report, phases, privateRoots = []) {
  requireProcessSuccess(result);
  const check = (phase, fn) => report ? report.sync(phase, fn) : fn();
  check(phases?.marker, () => { if (!result.stdout.split(/\r?\n/).some(line => line.trim() === "--dry-run: exiting now.")) refuse("dry-run-marker-or-bundle-mismatch"); });
  check(phases?.hash, () => { if (!Buffer.isBuffer(bytes) || !bytes.length || digest(bytes) !== expectedHash) refuse("dry-run-marker-or-bundle-mismatch"); });
  check(phases?.privacy, () => {
    const paths = [...privateRoots, "/Users/", "/home/"];
    if (paths.some((path, index) => bytes.includes(path) && (index >= paths.length - 2 || privateDirectoryMatch(bytes, path)))) refuse("dry-run-private-path");
  });
  return { code: result.code, signal: result.signal, closed: true, sha256: digest(bytes), observedProcesses: result.observed.size };
}
function privateDirectoryMatch(bytes, root) {
  // Only prove longer literal components safe. Do not normalize private roots
  // or interpret escapes, encodings, interpolation or ambiguous suffixes.
  if (typeof root !== "string" || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(root) || root.split("/").some(part => part === "." || part === "..")) return true;
  for (let at = bytes.indexOf(root); at !== -1; at = bytes.indexOf(root, at + 1)) {
    let end = at + root.length;
    const start = end;
    while (end < bytes.length && ((bytes[end] >= 65 && bytes[end] <= 90) || (bytes[end] >= 97 && bytes[end] <= 122) || (bytes[end] >= 48 && bytes[end] <= 57) || bytes[end] === 95 || bytes[end] === 45)) end++;
    if (end === start || (end < bytes.length && ![47, 34, 39, 96].includes(bytes[end]))) return true;
  }
  return false;
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
  const census = recorder => privateProcesses(recorder, boundary.controls);
  await report.step("namespace_read", boundary.checkBoundary);
  await report.step("process_inventory", async () => { if ((await census()).length) refuse("unexpected-private-process"); });
  const env = await report.step("environment", () => prepareEnvironment(join(root, "child")));
  const receipts = [];
  for (const [label, role, launch, close, check] of [["a", "build_a", "build_a_launch", "build_a_close", "build_a_report"], ["b", "build_b", "build_b_launch", "build_b_close", "build_b_report"]]) {
    const capsule = join(root, `capsule-${label}`);
    report.mark(launch, "enter");
    const recorder=boundary.builderDiagnostics?createOwnedProcessLedger():undefined;
    const built = await runOwnedProcess(process.execPath, boundary.buildArguments(capsule, role), { cwd: root, env, timeoutMs: 120000, sample: () => census(recorder), ...(recorder?{recorder}:{}), ...(boundary.drain ? {beforeFinal: boundary.drain} : {}) });
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
    const recorder = boundary.builderDiagnostics ? createOwnedProcessLedger() : undefined;
    const result = await runOwnedProcess(process.execPath, ["--no-warnings", cli, "deploy", "--dry-run", "--config", config, "--outdir", output], { cwd: capsule, env, sample: () => census(recorder), ...(recorder ? {recorder} : {}), ...(boundary.drain ? {beforeFinal: boundary.drain} : {}) });
    (recorder ? reportObservedWranglerProcess : reportWranglerProcess)(result, report, close);
    const bytes = await report.step(outputPhase, () => readFile(join(output, `${kind}.mjs`)));
    results[kind] = verifyDryRun(result, bytes, receipts[0].bundles[kind], report, { marker, hash, privacy }, [root, cwd]);
  }
  await report.step("final_namespace", boundary.checkBoundary);
  await report.step("final_descendants", async () => { if ((await census()).length) refuse("private-descendant-not-retired"); });
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
export const nativeCompileOperations = Object.freeze([
  "runtime", "context_read_parse", "context_validate", "source_identity", "source_inventory",
  "compiler_identity", "compiler_target", "tool_selection", "tool_identity", "tool_version", "tool_record",
  "compile", "link", "header_read", "header_format", "header_parse", "header_paths",
  "link_parse", "link_object", "link_filter", "link_paths", "elf_read_validate",
  "header_inventory", "link_inventory", "argument_copy", "object_identity", "binary_identity",
  "manifest_validate", "manifest_write_arguments", "exclusive_write",
]);
export const nativeCompileRoles = Object.freeze(["none", "gcc", "cc1", "as", "collect2", "ld"]);
export function validateCompileDetail(value) {
  if (!Array.isArray(value) || Object.getOwnPropertyNames(value).sort().join() !== "0,1,2,length" || ownData(value,"length") !== 3) refuse("compile-detail-shape");
  const [version, operation, role] = [0,1,2].map(index => ownData(value,String(index)));
  if (version !== 1 || !Number.isInteger(operation) || operation < 1 || operation > nativeCompileOperations.length || !Number.isInteger(role)) refuse("compile-detail-enum");
  const validRole = [6,7,12,13].includes(operation) ? role === 1 : operation >= 8 && operation <= 11 ? role >= (operation === 8 ? 2 : 1) && role <= 5 : role === 0;
  if (!validRole) refuse("compile-detail-role");
  return [version,operation,role];
}
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
  let compilation = null, compileDetail = null;
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
    if (event === "terminal" && compileDetail) row.compile = compileDetail;
    const bytes = Buffer.from("\n" + "EDGE_NATIVE_" + "PREPARE_V1 " + JSON.stringify(row) + "\n");
    if (sequence > 32 || bytes.length > 512) refuse("prepare-diagnostic-capacity");
    for (let offset = 0; offset < bytes.length;) {
      const written = write(bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) refuse("prepare-diagnostic-write");
      offset += written;
    }
  };
  return { errors,
    compileBegin() {
      const state = { active:true, invalid:false, point:null, failed:false, reason:undefined };
      const observe = operation => { try { operation(); } catch (error) { state.invalid = true; errors.push(error); } };
      observe(() => {
        if (finished || nativePrepareStages[index] !== "prepare_arguments" || compilation) refuse("compile-invocation");
        compilation = state;
      });
      return {
        point(operation, role = "none") { observe(() => {
          if (compilation !== state || !state.active || finished || nativePrepareStages[index] !== "prepare_arguments") refuse("compile-point-owner");
          state.point = validateCompileDetail([1,operation,nativeCompileRoles.indexOf(role)]);
        }); },
        finish(failed, reason) { observe(() => {
          if (compilation !== state || !state.active || finished || typeof failed !== "boolean") refuse("compile-finish-owner");
          state.active = false; state.failed = failed; state.reason = reason;
          if (!failed) state.point = null;
        }); },
      };
    },
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
        if (originalFailed && nativePrepareStages[index] === "prepare_arguments" && compilation?.failed && !compilation.active && !compilation.invalid && errors.length === 0 && Object.is(compilation.reason,reason)) compileDetail = compilation.point;
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
// Projector failures describe validation of evidence, never a child payload cause.
// Contexts: 0 global, 1 stdout, 2 stderr, 3 child, 4 build_a, 5 build_b.
export const projectionBoundaries = Object.freeze([
  ["binding",5,[0]], ["supervisor",3,[0]], ["capture_summary_read",0,[1,2]], ["capture_summary",3,[1,2]],
  ["capture_bytes",0,[1,2]], ["capture_integrity",4,[1,2]], ["init",2,[0]], ["scan",0,[0]], ["line_select",0,[0]],
  ["frame",5,[0]], ["json",0,[0]], ["schema",0,[0]], ["canonical",3,[0]], ["rejection_presence",1,[0]], ["nonfailure_presence",1,[0]],
  ["append",0,[0]], ["records_present",1,[0]], ["role_filter",0,[3,4,5]], ["lifecycle",0,[3,4,5]], ["terminal_present",1,[3,4,5]],
  ["lifecycle_store",0,[3,4,5]], ["child_present",1,[0]], ["role_members",0,[4,5]], ["forwarding",4,[4,5]], ["accepted_role",2,[4,5]],
  ["final_consistency",3,[0]], ["summary",0,[0]], ["lifecycle_take",3,[3,4,5]], ["lifecycle_final",5,[3,4,5]],
  ["lifecycle_step",2,[3,4,5]], ["lifecycle_close",2,[3]], ["lifecycle_report",2,[3]],
]);
export function validateReceiptBoundaryDiagnostic(value) {
  const keys = ["v","phase","state","defined","exit","signal","parser","child","reports","count","projection"];
  if (Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("receipt-boundary-keys");
  const row = Object.fromEntries(keys.map(key => [key, ownData(value,key)]));
  if (row.v !== 10 || !["ZERO","ONE","MULTIPLE","UNKNOWN"].includes(row.count)) refuse("receipt-boundary-version-count");
  const original = Object.fromEntries(keys.slice(0,9).map(key => [key,row[key]])); original.v = 9;
  const validated = validateReceiptDiagnostic(original), parser = validated.parser;
  if (row.count !== "UNKNOWN") {
    if (!parser || parser[1] === 0 || parser[1] === 2 && parser[3] < 3) refuse("receipt-count-unreached");
    const countFalse = parser[1] === 2 && parser[3] === 3 && parser[4] === 1 && parser[5] === 1;
    if (parser[1] === 2 && parser[3] === 3 && !(parser[7] & 1)) refuse("receipt-count-not-observed");
    if (row.count === "ONE" ? countFalse : !countFalse) refuse("receipt-count-comparison");
  }
  if (row.projection !== null) {
    const detail = row.projection;
    if (!Array.isArray(detail) || Object.getOwnPropertyNames(detail).join() !== "0,1,2,3,4,5,6,7,length") refuse("projection-tuple");
    row.projection = Array.from({length:8},(_,i)=>ownData(detail,String(i)));
    const [v,boundary,context,kind,leaf,seen,passed,defined] = row.projection;
    if (v !== 1 || ![boundary,context,kind,leaf,seen,passed].every(Number.isSafeInteger) || boundary < 1 || boundary > projectionBoundaries.length || ![1,2].includes(kind)) refuse("projection-values");
    const [,width,contexts] = projectionBoundaries[boundary-1];
    if (!contexts.includes(context) || leaf < 0 || seen < 0 || seen >= 2**width || passed < 0 || passed >= 2**width || (seen & passed) !== passed) refuse("projection-masks");
    const possible = boundary === 26 ? [0,1,3,7] : boundary === 28 ? [0,1,3,7] : Array.from({length:width+1},(_,i)=>2**i-1);
    if (!possible.includes(seen)) refuse("projection-evaluation-order");
    if (kind === 2) {
      const beforeThrow = boundary === 26 ? [[0,0],[1,0],[3,2]] : boundary === 28 ? [[0,0],[1,1],[3,1]] : boundary === 29 ? [[0,0],[1,1],[3,3],[7,3],[15,11]] : width ? Array.from({length:width},(_,i)=>[2**i-1,2**i-1]) : [[0,0]];
      if (leaf !== 0 || typeof defined !== "boolean" || validated.child[1] !== "invalid" || !beforeThrow.some(([a,b])=>a===seen&&b===passed)) refuse("projection-throw");
    }
    else {
      if (!width || defined !== null || leaf < 1 || leaf > width) refuse("projection-false");
      const failed = seen & ~passed, first = Array.from({length:width},(_,i)=>i+1).find(i=>failed & 2**(i-1));
      const falseMasks = boundary === 26 ? [[3,0],[7,2]] : boundary === 28 ? [[1,0],[7,1]] : boundary === 29 ? [[1,0],[3,1],[15,3],[31,11]] : Array.from({length:width},(_,i)=>[2**(i+1)-1,2**i-1]);
      if (leaf !== first || !falseMasks.some(([a,b])=>a===seen&&b===passed)) refuse("projection-false-mask");
      const reason = boundary === 1 ? "binding_unavailable" : [2,4].includes(boundary) ? "capture_unavailable" : boundary === 6 ? "capture_mismatch" : boundary === 7 ? "init_unqualified" : boundary === 17 ? "no_records" : [20,22].includes(boundary) ? "incomplete" : "invalid";
      if (validated.child[1] !== reason) refuse("projection-reason");
    }
    if (["reported_complete","reported_rejection"].includes(validated.child[1])) refuse("projection-lifecycle-credit");
  }
  return {...validated,v:10,count:row.count,projection:row.projection};
}
// V11 adds rejected-projector input context only. V9/V10 remain unchanged.
// lifecycle = [version, role-local index, count, expected phase, actual phase,
// presence (1 present, 2 absent), evaluated outcome]. Zero means UNKNOWN.
export function validateReceiptLifecycleDiagnostic(value) {
  const keys = ["v","phase","state","defined","exit","signal","parser","child","reports","count","projection","lifecycle"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("receipt-lifecycle-keys");
  const row = Object.fromEntries(keys.map(key => [key,ownData(value,key)]));
  if (row.v !== 11) refuse("receipt-lifecycle-version");
  const prior = Object.fromEntries(keys.slice(0,-1).map(key => [key,row[key]])); prior.v = 10;
  const validated = validateReceiptBoundaryDiagnostic(prior);
  if (row.lifecycle !== null) {
    if (!Array.isArray(row.lifecycle) || Object.getOwnPropertyNames(row.lifecycle).join() !== "0,1,2,3,4,5,6,length") refuse("receipt-lifecycle-tuple");
    row.lifecycle = Array.from({length:7},(_,i)=>ownData(row.lifecycle,String(i)));
    const [v,index,count,expected,actual,presence,outcome] = row.lifecycle, detail = validated.projection;
    if (!detail || detail[1] !== 30 || detail[3] !== 1 || validated.child[1] !== "invalid") refuse("receipt-lifecycle-boundary");
    if (v !== 1 || !row.lifecycle.every(Number.isSafeInteger) || index < 2 || count < 2 || count > 256 || index > count || expected < 1 || expected > receiptChildPhases.length || actual < 0 || actual > receiptChildPhases.length || ![1,2].includes(presence)) refuse("receipt-lifecycle-values");
    const builder = ["namespace_read","builder_import","build","receipt_write","build_service_stop"];
    const child = ["namespace_read","process_inventory","environment","build_a_report","build_b_report","two_roots","wrangler_input","edge_config","edge_output","edge_marker","edge_hash","edge_privacy","upstream_config","upstream_output","upstream_marker","upstream_hash","upstream_privacy","final_namespace","final_descendants"];
    if (!(detail[2] === 3 ? child : builder).includes(receiptChildPhases[expected-1])) refuse("receipt-lifecycle-role");
    if (presence === 2 ? index !== count || actual !== 0 || outcome !== 0 || detail[4] !== 1 : index >= count) refuse("receipt-lifecycle-presence");
    if (detail[4] === 1 ? actual === expected || outcome !== 0 : presence !== 1 || actual !== expected || ![1,4].includes(outcome)) refuse("receipt-lifecycle-comparison");
  }
  const result = {...validated,v:11,lifecycle:row.lifecycle};
  if (Buffer.byteLength(JSON.stringify(result)) > 512) refuse("receipt-lifecycle-capacity");
  return result;
}
// V12 adds CHILD-REPORTED original builder process facts, not lifecycle or
// physical-host custody. Flags: close, timeout, interrupt, stdout ESC/complete,
// stderr ESC/complete. Codec 1 requires a bound, complete outer capture and a
// canonical source-associated group. Inner retained-text integrity stays UNKNOWN;
// capture hashes describe received bytes only. Wrapper 1=fulfilled, 2=rejected
// undefined, 3=rejected defined. Signal 0=null; remaining null=UNKNOWN.
export const receiptBuilderSignals = Object.freeze([null,"SIGINT","SIGTERM","SIGKILL","SIGABRT","SIGSEGV","SIGBUS","SIGILL","SIGPIPE","SIGHUP","SIGQUIT","SIGTRAP","SIGXCPU","SIGXFSZ","SIGSYS"]);
export function validateReportedBuilderProcess(value) {
  if (!Array.isArray(value) || Object.getOwnPropertyNames(value).join() !== [...Array(12).keys(),"length"].join()) refuse("receipt-builder-tuple");
  value = Array.from({length:12},(_,i)=>ownData(value,String(i)));
  const [v,role,outcome,exit,signal,flags,errors,remaining,outBytes,outHash,errBytes,errHash] = value;
  if (v !== 1 || ![1,2].includes(role)) refuse("receipt-builder-role");
  if (![1,2,3].includes(outcome) || !Number.isSafeInteger(signal) || signal < 0 || signal >= receiptBuilderSignals.length || !Number.isSafeInteger(flags) || flags < 0 || flags > 127) refuse("receipt-builder-values");
  if (exit !== null && (!Number.isSafeInteger(exit) || exit < -65535 || exit > 65535)) refuse("receipt-builder-exit");
  if (!Number.isSafeInteger(errors) || errors < 0 || errors > 65535 || remaining !== null && (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 65535)) refuse("receipt-builder-counts");
  if (![outBytes,errBytes].every(n=>Number.isSafeInteger(n)&&n>=0) || ![outHash,errHash].every(s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s))) refuse("receipt-builder-captures");
  if (!(flags & 1) && (exit !== null || signal !== 0) || Boolean(flags & 16) !== Boolean(flags & 1) || Boolean(flags & 64) !== Boolean(flags & 1)) refuse("receipt-builder-close");
  if (outcome === 1 && (exit !== 0 || signal !== 0 || !(flags & 1) || (flags & 6) || errors !== 0 || remaining !== 0)) refuse("receipt-builder-success");
  return value;
}
export function validateReceiptBuilderDiagnostic(value) {
  const keys = ["v","phase","state","defined","exit","signal","parser","child","reports","count","projection","lifecycle","builder"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("receipt-builder-keys");
  const row = Object.fromEntries(keys.map(key => [key,ownData(value,key)]));
  if (row.v !== 12) refuse("receipt-builder-version");
  const prior = Object.fromEntries(keys.slice(0,-1).map(key => [key,row[key]])); prior.v = 11;
  const validated = validateReceiptLifecycleDiagnostic(prior);
  if (row.builder !== null) {
    row.builder = validateReportedBuilderProcess(row.builder);
    const detail = validated.projection;
    if (!detail || detail[2] !== row.builder[1]+3 || !["invalid","incomplete"].includes(validated.child[1]) || detail[1] < 18 || detail[1] > 30) refuse("receipt-builder-source-role");
  }
  const result = {...validated,v:12,builder:row.builder};
  if (Buffer.byteLength(JSON.stringify(result)) > 512) refuse("receipt-builder-capacity");
  return result;
}
const ownedTuple=(value,length)=>{
  if(!Array.isArray(value)||Object.getOwnPropertyNames(value).join()!==[...Array(length).keys(),"length"].join())refuse("owned-tuple");
  return Array.from({length},(_,i)=>ownData(value,String(i)));
};
export function validateOwnedTrace(value,errorCount,originalFlags) {
  const trace=ownedTuple(value,4);if(trace[0]!==1)refuse("owned-version");
  const flags=originalFlags===undefined?null:ownedTuple(originalFlags,2);
  if(flags&&!flags.every(v=>typeof v==="boolean"))refuse("owned-original-flags");
  if(!Number.isSafeInteger(errorCount)||errorCount<0||errorCount>65535)refuse("owned-error-count");
  trace[3]=ownedTuple(trace[3],3);const [faults,undefinedFaults,reportSaturation]=trace[3];
  if(![faults,undefinedFaults].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535)||undefinedFaults>faults)refuse("owned-reports");
  if(!Number.isInteger(reportSaturation)||reportSaturation<0||reportSaturation>3||(reportSaturation&1)&&faults!==65535||(reportSaturation&2)&&(undefinedFaults!==65535||!(reportSaturation&1)))refuse("owned-report-saturation");
  if(faults){if(trace[1]!==null||trace[2]!==null)refuse("owned-incomplete");return trace;}
  if(trace[1]!==null){
    trace[1]=ownedTuple(trace[1],7);const [site,stage,kind,leaf,seen,passed,defined]=trace[1];
    if(![site,stage,kind,leaf,seen,passed].every(Number.isSafeInteger)||site<1||site>9||typeof defined!=="boolean"||kind<0||kind>2)refuse("owned-error");
    const width=[2,9].includes(site)?stage===1?2:stage===6?3:0:[4,5].includes(site)?1:0;
    if(stage<0||stage>([2,9].includes(site)?9:site===3?3:site===7?6:[4,5,6].includes(site)?1:0)||site===6&&stage!==1||site===7&&stage<2||[4,5].includes(site)&&stage!==1)refuse("owned-stage");
    if(seen<0||seen>=2**width||passed<0||(passed&seen)!==passed||![0,1,3,7].includes(seen))refuse("owned-mask");
    if(kind===1){if(!defined||leaf<1||leaf>width||seen!==2**leaf-1||passed!==2**(leaf-1)-1)refuse("owned-false");}
    else if(leaf!==0||seen!==passed||(kind===0?seen!==0:seen===0||seen===2**width-1))refuse("owned-throw");
    if(errorCount===0)refuse("owned-error-count");
  } else if(errorCount!==0)refuse("owned-missing-error");
  trace[2]=ownedTuple(trace[2],13);const [requests,attempts,returned,thrown,skipped,reasons,signals,reason,signal,outcome,throwDefined,saturation,ignored]=trace[2];
  if(!trace[2].every(Number.isSafeInteger)||trace[2].slice(0,5).some(n=>n<0||n>255)||reasons<0||reasons>63||signals<0||signals>7||reason<0||reason>6||![0,1,2,3].includes(signal)||outcome<0||outcome>3||throwDefined<0||throwDefined>2||saturation<0||saturation>63||ignored<0||ignored>255)refuse("owned-stop");
  for(let i=0;i<5;i++)if(saturation&2**i&&trace[2][i]!==255)refuse("owned-saturation");
  if(saturation&32&&ignored!==255||!(saturation&8)&&(saturation&32?256:ignored)>thrown)refuse("owned-ignored-count");
  if(!requests?(reasons||signals||attempts||skipped):(reasons===0||signals===0))refuse("owned-request");
  let expectedSignals=0;for(let i=0;i<6;i++)if(reasons&2**i)expectedSignals|=i===3?1:i===5?4:2;
  if(signals!==expectedSignals||!(saturation&1)&&reasons.toString(2).replaceAll("0","").length>requests)refuse("owned-signals");
  if(!attempts?(reason||signal||outcome||returned||thrown):(reason===0||!(reasons&2**(reason-1))||signal!==(reason===4?1:reason===6?3:2)||outcome===0))refuse("owned-first-dispatch");
  if(!thrown?throwDefined!==0:throwDefined===0)refuse("owned-throw-presence");
  if(outcome===1&&!returned||outcome>=2&&(!thrown||throwDefined!==outcome-1))refuse("owned-first-outcome");
  const bounds=i=>saturation&2**i?[256,Infinity]:[trace[2][i],trace[2][i]];
  const sumMatches=(left,right,total)=>{const a=bounds(left),b=bounds(right),c=bounds(total);return a[0]+b[0]<=c[1]&&c[0]<=a[1]+b[1];};
  if(!sumMatches(1,4,0)||!sumMatches(2,3,1))refuse("owned-stop-counts");
  if((throwDefined===1||trace[1]?.[0]===1)&&!(saturation&8)&&(saturation&32?256:ignored)>=thrown)refuse("owned-ignored-undefined");
  const unignored=Math.max(0,(saturation&8?256:thrown)-(saturation&32?Infinity:ignored),throwDefined===1||trace[1]?.[0]===1?1:0);
  const site=trace[1]?.[0], monitorError=Boolean(reasons&1)||[2,3,4].includes(site), captureError=Boolean(reasons&2)||site===5;
  const otherError=[6,7,8,9].includes(site)?1:0;
  // Original catch/callback sites latch these facts before requesting a stop.
  // A skipped dispatch still records its request; observer faults return above.
  if([2,3,4].includes(site)&&!(reasons&1)||site===5&&!(reasons&2))refuse("owned-error-stop-reason");
  if(reasons&32&&(!(reasons&31)||!attempts||reason===6))refuse("owned-escalation-origin");
  if(flags&&(flags[0]!==Boolean(reasons&4)||flags[1]!==Boolean(reasons&24)))refuse("owned-stop-original-flags");
  if(site===1&&(ignored===0||throwDefined===1)&&trace[1][6]!==(throwDefined===2))refuse("owned-same-throw-definedness");
  if(errorCount<65535&&unignored+Number(monitorError)+Number(captureError)+otherError>errorCount)refuse("owned-stop-error-presence");
  return trace;
}
export function validateOwnedCloseDiagnostic(value) {
  const keys=["v","role","phase","outcome","defined","exit","signal","closed","timedOut","interrupted","errors","remaining","trace"];
  if(Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("owned-close-keys");
  const row=Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));
  if(row.v!==2||row.role!=="child"||!["build_a_close","build_b_close"].includes(row.phase))refuse("owned-close-role");
  const prior={...row,v:1};delete prior.trace;validatePackagingDiagnostic(prior);
  row.trace=validateOwnedTrace(row.trace,row.errors,[row.timedOut,row.interrupted]);
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("owned-close-capacity");
  return row;
}
// V13 positional fields: parser, child, reports, count, projector, lifecycle,
// builder, owned trace. Builder hashes alone use canonical base64url (32 bytes).
export function packReceiptOwnedDiagnostic(value,trace) {
  const prior=validateReceiptBuilderDiagnostic(value),builder=prior.builder?.slice()??null;
  if(builder)for(const i of [9,11])builder[i]=Buffer.from(builder[i],"hex").toString("base64url");
  return validateReceiptOwnedDiagnostic({v:13,phase:prior.phase,state:prior.state,defined:prior.defined,exit:prior.exit,signal:prior.signal,detail:[prior.parser,prior.child,prior.reports,prior.count,prior.projection,prior.lifecycle,builder,trace]});
}
export function unpackReceiptOwnedDiagnostic(value) {
  const detail=ownedTuple(ownData(value,"detail"),8),builder=detail[6]===null?null:ownedTuple(detail[6],12);
  if(builder)for(const i of [9,11]){
    if(typeof builder[i]!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(builder[i]))refuse("owned-hash");
    const bytes=Buffer.from(builder[i],"base64url");if(bytes.length!==32||bytes.toString("base64url")!==builder[i])refuse("owned-hash-canonical");builder[i]=bytes.toString("hex");
  }
  return {v:12,phase:ownData(value,"phase"),state:ownData(value,"state"),defined:ownData(value,"defined"),exit:ownData(value,"exit"),signal:ownData(value,"signal"),parser:detail[0],child:detail[1],reports:detail[2],count:detail[3],projection:detail[4],lifecycle:detail[5],builder};
}
export function validateReceiptOwnedDiagnostic(value) {
  const keys=["v","phase","state","defined","exit","signal","detail"];
  if(!value||Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("owned-receipt-keys");
  const row=Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));if(row.v!==13)refuse("owned-receipt-version");
  row.detail=ownedTuple(row.detail,8);const prior=validateReceiptBuilderDiagnostic(unpackReceiptOwnedDiagnostic(row));
  if(row.detail[7]!==null){if(!prior.builder)refuse("owned-unbound-trace");row.detail[7]=validateOwnedTrace(row.detail[7],prior.builder[6],[Boolean(prior.builder[5]&2),Boolean(prior.builder[5]&4)]);}
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("owned-receipt-capacity");return row;
}
// Display classes describe only the original primitive operand, never errno/cause.
// [version, access: 0 UNOBSERVED / 1 RETURNED / 2 THREW, display class].
export function validateOwnedCode(value,trace) {
  if(value===null)return null;
  const code=ownedTuple(value,3),[v,access,kind]=code;
  if(v!==1||![0,1,2].includes(access)||!Number.isInteger(kind)||kind<0||kind>16||(access===1?kind===0:kind!==0))refuse("owned-code-tuple");
  if(!trace||trace[3][0])refuse("owned-code-unbound");
  const first=trace[1];
  if(access!==0){
    if(!first||![2,9].includes(first[0]))refuse("owned-code-source");
    if(access===2?first[1]!==8:first[1]<4||first[1]>7||kind===1||(!first[6]&&kind!==14))refuse("owned-code-relation");
  }
  return code;
}
export function validateOwnedCodeCloseDiagnostic(value) {
  const keys=["v","role","phase","outcome","defined","exit","signal","closed","timedOut","interrupted","errors","remaining","trace","code"];
  if(Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("owned-code-close-keys");
  const row=Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));
  if(row.v!==3)refuse("owned-code-close-version");
  const prior={...row,v:2};delete prior.code;validateOwnedCloseDiagnostic(prior);
  row.code=validateOwnedCode(row.code,row.trace);
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("owned-code-close-capacity");return row;
}
export function packReceiptCodeDiagnostic(value,trace,code) {
  const prior=packReceiptOwnedDiagnostic(value,trace);
  return validateReceiptCodeDiagnostic({...prior,v:14,detail:[...prior.detail,code]});
}
export function validateReceiptCodeDiagnostic(value) {
  const keys=["v","phase","state","defined","exit","signal","detail"];
  if(!value||Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("code-receipt-keys");
  const row=Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));if(row.v!==14)refuse("code-receipt-version");
  row.detail=ownedTuple(row.detail,9);
  const prior=validateReceiptOwnedDiagnostic({...row,v:13,detail:row.detail.slice(0,8)});
  row.detail[8]=validateOwnedCode(row.detail[8],prior.detail[7]);
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("code-receipt-capacity");return row;
}
// V15 retains the V14 layout and adds exact admitted-rejection association.
// No new process facts or lifecycle credit are created by this envelope.
export function packReceiptAssociatedDiagnostic(value, trace, code) {
  if (value.child[1] !== "reported_rejection") return { ...packReceiptCodeDiagnostic(value, trace, code), v: 15 };
  const builder = value.builder === null ? null : validateReportedBuilderProcess(value.builder).slice();
  if (builder) for (const i of [9,11]) builder[i] = Buffer.from(builder[i], "hex").toString("base64url");
  return validateReceiptAssociatedDiagnostic({ v: 15, phase: value.phase, state: value.state, defined: value.defined, exit: value.exit, signal: value.signal,
    detail: [value.parser,value.child,value.reports,value.count,value.projection,value.lifecycle,builder,trace,code] });
}
export function validateReceiptAssociatedDiagnostic(value) {
  const keys = ["v","phase","state","defined","exit","signal","detail"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("associated-receipt-keys");
  const row = Object.fromEntries(keys.map(key => [key,ownData(value,key)]));
  if (row.v !== 15) refuse("associated-receipt-version");
  row.detail = ownedTuple(row.detail,9);
  const decoded = unpackReceiptOwnedDiagnostic({...row,v:13,detail:row.detail.slice(0,8)});
  const {builder,...base} = decoded;
  const prior = validateReceiptLifecycleDiagnostic({...base,v:11});
  if (prior.child[1] !== "reported_rejection") {
    validateReceiptCodeDiagnostic({...row,v:14});
  } else {
    if (builder !== null) {
      validateReportedBuilderProcess(builder);
      const role = builder[1], phase = receiptChildPhases[prior.child[6]-1];
      const childRole = prior.child[5], name = role === 1 ? "build_a" : "build_b";
      if (childRole === 1) {
        if (![name+"_close",name+"_report"].includes(phase)) refuse("associated-child-role");
        if (phase === name+"_close" ? builder[2] !== (prior.child[7] ? 3 : 2) : builder[2] !== 1) refuse("associated-close-outcome");
      } else if (childRole !== role+1 || builder[2] !== 1 || !["namespace_read","builder_import","build","receipt_write","build_service_stop","final"].includes(phase)) refuse("associated-builder-role");
      if (role === 2 && !(prior.child[3] & 2)) refuse("associated-prior-builder");
      if (row.detail[7] !== null) validateOwnedTrace(row.detail[7],builder[6],[Boolean(builder[5]&2),Boolean(builder[5]&4)]);
    } else if (row.detail[7] !== null || row.detail[8] !== null) refuse("associated-unbound-observation");
    validateOwnedCode(row.detail[8],row.detail[7]);
  }
  if (Buffer.byteLength(JSON.stringify(row)) > 512) refuse("associated-receipt-capacity");
  return row;
}
// V16 reconstructs V15 losslessly; fixed envelope fields and enum labels are
// implicit. Reporting counts are two unsigned 16-bit fields in one integer.
const censusReasons = ["binding_unavailable","capture_unavailable","capture_mismatch","init_unqualified","no_records","incomplete","invalid","reported_rejection","reported_complete"];
const censusCardinality = ["UNKNOWN","ZERO","ONE","MULTIPLE"];
export function validateFinalCensus(value,remaining,closed,errors,trace) {
  const t=ownedTuple(value,10),[v,outcome,order,total,projected,omitted,saturation,counts,rows,availability]=t;
  if(v!==1||![0,1,2,3].includes(outcome)||!Number.isInteger(order)||order<0||order>7||![0,1,2,3].includes(availability))refuse("census-header");
  if(outcome?(order!==6+Number(closed)):(order!==0&&order!==6+Number(closed)))refuse("census-order");
  if(!Number.isInteger(projected)||projected<0||projected>2||!Array.isArray(rows)||rows.length!==projected||!Number.isInteger(saturation)||saturation<0||saturation>=2048)refuse("census-counts");
  t[8]=ownedTuple(rows,projected);
  const first=trace?.[1], monitorFailed=[2,3,4].includes(first?.[0])||Boolean(trace?.[2]?.[5]&1);
  if(trace?.[3]?.[0]&&(total!==null||projected||omitted!==null||saturation||counts!==null))refuse("census-observer-fault");
  if(availability===3&&trace?.[3]?.[0]===0)refuse("census-missing-observer-fault");
  if(first?.[0]===9&&(remaining!==null||outcome!==0&&outcome!==2+Number(first[6])))refuse("census-final-failure");
  if(outcome>=2&&first&&first[0]!==9&&errors<2)refuse("census-later-final-failure");
  if(outcome!==1 || total===null){
    if(total!==null||projected||omitted!==null||saturation||counts!==null||availability===1||availability===2)refuse("census-unavailable");
    if(outcome>=2&&(remaining!==null||errors<1))refuse("census-original-failure");
    if(outcome===0&&availability!==0)refuse("census-unobserved");
    return t;
  }
  if(![total,omitted].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535)||remaining!==total||projected!==Math.min(2,total)||omitted!==total-projected||saturation!==0||availability===3)refuse("census-total");
  t[7]=ownedTuple(counts,10);
  if(!t[7].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535)||t[7].reduce((a,b)=>a+b,0)!==total||availability===1&&total>512||availability===2&&total<=512||availability===0&&total<2)refuse("census-states");
  const seen=Array(10).fill(0);
  for(const code of rows){
    if(!Number.isInteger(code)||code<0||code>=131072)refuse("census-row");
    const state=code%16,history=(code>>4)&3,parent=(code>>6)&3,group=(code>>8)&7,changes=[(code>>11)&3,(code>>13)&3,(code>>15)&3];
    if(state<1||state>10||group>4||changes.some(n=>n===3)||(history===1?changes.some(n=>n===0):changes.some(n=>n!==0)))refuse("census-row-relations");
    if(monitorFailed&&history!==0)refuse("census-failed-monitor-history");
    if(availability!==1&&(parent>1||group>2)||availability===0&&history!==0)refuse("census-ambiguous");
    seen[state-1]++;
  }
  if(seen.some((n,i)=>n>counts[i]))refuse("census-row-state-count");
  return t;
}
export function packCensusCloseDiagnostic(value,census) {
  const row=validateOwnedCodeCloseDiagnostic(value),flags=Number(row.closed)+2*Number(row.timedOut)+4*Number(row.interrupted);
  return validateCensusCloseDiagnostic({v:4,role:row.role,phase:row.phase,outcome:row.outcome,defined:row.defined,detail:[row.exit,receiptBuilderSignals.indexOf(row.signal),flags,row.errors,row.remaining,row.trace,row.code,census]});
}
export function unpackCensusCloseDiagnostic(row) {
  const d=ownedTuple(ownData(row,"detail"),8);
  if(!Number.isInteger(d[2])||d[2]<0||d[2]>7||!Number.isInteger(d[1])||d[1]<0||d[1]>=receiptBuilderSignals.length)refuse("census-close-flags");
  return {v:3,role:row.role,phase:row.phase,outcome:row.outcome,defined:row.defined,exit:d[0],signal:receiptBuilderSignals[d[1]],closed:Boolean(d[2]&1),timedOut:Boolean(d[2]&2),interrupted:Boolean(d[2]&4),errors:d[3],remaining:d[4],trace:d[5],code:d[6]};
}
export function validateCensusCloseDiagnostic(value) {
  const keys=["v","role","phase","outcome","defined","detail"];
  if(!value||Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("census-close-keys");
  const row=Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));if(row.v!==4)refuse("census-close-version");
  row.detail=ownedTuple(row.detail,8);const original=validateOwnedCodeCloseDiagnostic(unpackCensusCloseDiagnostic(row));
  validateFinalCensus(row.detail[7],original.remaining,original.closed,original.errors,original.trace);
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("census-close-capacity");return row;
}
export function packReceiptCensusDiagnostic(value,trace,code,census) {
  const prior=packReceiptAssociatedDiagnostic(value,trace,code),d=prior.detail.slice(),c=d[1];
  d[1]=[censusReasons.indexOf(c[1]),...c.slice(2,8)];d[2]=d[2][0]*65536+d[2][1];d[3]=censusCardinality.indexOf(d[3]);
  return validateReceiptCensusDiagnostic({v:16,phase:prior.phase,state:prior.state,detail:[prior.defined,...d,census]});
}
export function unpackReceiptCensusDiagnostic(value) {
  const d=ownedTuple(ownData(value,"detail"),11),c=ownedTuple(d[2],7);
  if(!Number.isInteger(c[0])||c[0]<0||c[0]>=censusReasons.length||!Number.isInteger(d[3])||d[3]<0||d[3]>4294967295||!Number.isInteger(d[4])||d[4]<0||d[4]>=censusCardinality.length)refuse("census-receipt-codec");
  return {v:15,phase:value.phase,state:value.state,defined:d[0],exit:null,signal:null,detail:[d[1],[1,censusReasons[c[0]],...c.slice(1),"UNKNOWN"],[Math.floor(d[3]/65536),d[3]%65536],censusCardinality[d[4]],...d.slice(5,10)]};
}
export function validateReceiptCensusDiagnostic(value) {
  const keys=["v","phase","state","detail"];
  if(!value||Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join())refuse("census-receipt-keys");
  const row=Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));if(row.v!==16)refuse("census-receipt-version");
  row.detail=ownedTuple(row.detail,11);const prior=validateReceiptAssociatedDiagnostic(unpackReceiptCensusDiagnostic(row)),builder=prior.detail[6];
  if(row.detail[10]!==null){if(!builder)refuse("census-unbound");validateFinalCensus(row.detail[10],builder[7],Boolean(builder[5]&1),builder[6],prior.detail[7]);}
  if(Buffer.byteLength(JSON.stringify(row))>512)refuse("census-receipt-capacity");return row;
}
// V17 adds a complete CHILD-REPORTED Wrangler result, never an owned trace.
// Group: V12 process fields (role 1=edge, 2=upstream), then the original
// requireProcessSuccess outcome: 1 fulfilled / 2 rejected undefined / 3 defined.
// Both SHA256 values use canonical lossless 32-byte base64url on the wire.
export function validateReportedWranglerProcess(value) {
  const group = ownedTuple(value,13), process = group.slice(0,12);
  for (const i of [9,11]) {
    if (typeof process[i] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(process[i])) refuse("wrangler-hash");
    const bytes = Buffer.from(process[i],"base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== process[i]) refuse("wrangler-hash-canonical");
    process[i] = bytes.toString("hex");
  }
  validateReportedBuilderProcess(process); // Identical primitive process schema only.
  const passed = process[3] === 0 && process[4] === 0 && Boolean(process[5]&1) && !(process[5]&6) && process[6] === 0 && process[7] === 0;
  if (![1,2,3].includes(group[12]) || (group[12] === 1) !== passed || group[2] === 1 && group[12] !== 1 || group[12] !== 1 && group[2] !== group[12]) refuse("wrangler-operation-outcome");
  return group;
}
export function packWranglerCloseDiagnostic(row, summaries, qualification) {
  const out = ownData(summaries,"stdout"), err = ownData(summaries,"stderr");
  const values = [row.closed,row.timedOut,row.interrupted,ownData(out,"esc"),ownData(out,"complete"),ownData(err,"esc"),ownData(err,"complete")];
  if (!values.every(v=>typeof v === "boolean")) refuse("wrangler-capture-flags");
  const hashes = [out,err].map(summary=>{
    const hash = ownData(summary,"sha256");
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) refuse("wrangler-capture-hash");
    return Buffer.from(hash,"hex").toString("base64url");
  });
  return validateWranglerCloseDiagnostic({v:5,role:row.role,phase:row.phase,outcome:row.outcome,defined:row.defined,detail:
    [1,row.phase === "edge_close" ? 1 : 2,row.outcome === "fulfilled" ? 1 : row.defined ? 3 : 2,row.exit,receiptBuilderSignals.indexOf(row.signal),values.reduce((n,v,i)=>n+Number(v)*2**i,0),row.errors,row.remaining,ownData(out,"bytes"),hashes[0],ownData(err,"bytes"),hashes[1],qualification]});
}
export function validateWranglerCloseDiagnostic(value) {
  const keys = ["v","role","phase","outcome","defined","detail"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("wrangler-close-keys");
  const row = Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));
  if (row.v !== 5 || row.role !== "child" || !["edge_close","upstream_close"].includes(row.phase)) refuse("wrangler-close-role");
  row.detail = validateReportedWranglerProcess(row.detail);
  if (row.detail[1] !== (row.phase === "edge_close" ? 1 : 2) || row.outcome !== (row.detail[2] === 1 ? "fulfilled" : "rejected") || row.defined !== (row.detail[2] === 1 ? null : row.detail[2] === 3)) refuse("wrangler-close-outcome");
  if (Buffer.byteLength(JSON.stringify(row)) > 512) refuse("wrangler-close-capacity");
  return row;
}
export function packReceiptWranglerDiagnostic(value, group) {
  const prior = validateReceiptCensusDiagnostic(value);
  if (group === null) return prior;
  return validateReceiptWranglerDiagnostic({...prior,v:17,detail:[...prior.detail,group]});
}
export function unpackReceiptWranglerDiagnostic(value) {
  const detail = ownedTuple(ownData(value,"detail"),12);
  return {v:16,phase:ownData(value,"phase"),state:ownData(value,"state"),detail:detail.slice(0,11)};
}
export function validateReceiptWranglerDiagnostic(value) {
  const keys = ["v","phase","state","detail"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("wrangler-receipt-keys");
  const row = Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));
  if (row.v !== 17) refuse("wrangler-receipt-version");
  row.detail = ownedTuple(row.detail,12);
  const prior = validateReceiptCensusDiagnostic(unpackReceiptWranglerDiagnostic(row));
  const child = unpackReceiptCensusDiagnostic(prior).detail[1];
  const group = row.detail[11] = validateReportedWranglerProcess(row.detail[11]);
  if (child[1] !== "reported_rejection" || child[3] !== 7 || child[5] !== 1 || receiptChildPhases[child[6]-1] !== (group[1] === 1 ? "edge_close" : "upstream_close") || group[2] !== (child[7] ? 3 : 2)) refuse("wrangler-receipt-association");
  // No Wrangler recorder exists. Builder/trace/code/census cannot be borrowed.
  if (row.detail.slice(7,11).some(v=>v!==null)) refuse("wrangler-unowned-observation");
  if (Buffer.byteLength(JSON.stringify(row)) > 512) refuse("wrangler-receipt-capacity");
  return row;
}
// V18 retains the whole V17 process group plus the existing invocation-owned
// trace, code operand and census. The four absent builder slots are implicit;
// unpacking restores V17 exactly. No sampled relation establishes ownership.
export function validateObservedWranglerGroup(value) {
  const group = ownedTuple(value,4), process = group[0] = validateReportedWranglerProcess(group[0]);
  const trace = group[1] = validateOwnedTrace(group[1],process[6],[Boolean(process[5]&2),Boolean(process[5]&4)]);
  group[2] = validateOwnedCode(group[2],trace);
  if (group[3] !== null) group[3] = validateFinalCensus(group[3],process[7],Boolean(process[5]&1),process[6],trace);
  const [faults,undefinedFaults] = trace[3];
  if (faults && (process[2] === 1 || process[12] === 1 && (undefinedFaults === faults ? process[2] !== 2 : undefinedFaults === 0 && process[2] !== 3))) refuse("wrangler-observer-outcome");
  return group;
}
export function packObservedWranglerCloseDiagnostic(row, summaries, qualification, census) {
  const prior = packWranglerCloseDiagnostic(row,summaries,qualification);
  return validateObservedWranglerCloseDiagnostic({...prior,v:6,detail:[prior.detail,row.trace,row.code,census]});
}
export function validateObservedWranglerCloseDiagnostic(value) {
  const keys = ["v","role","phase","outcome","defined","detail"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("wrangler-observed-close-keys");
  const row = Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));
  if (row.v !== 6) refuse("wrangler-observed-close-version");
  row.detail = validateObservedWranglerGroup(row.detail);
  validateWranglerCloseDiagnostic({...row,v:5,detail:row.detail[0]});
  if (Buffer.byteLength(JSON.stringify(row)) > 512) refuse("wrangler-observed-close-capacity");
  return row;
}
export function packReceiptObservedWranglerDiagnostic(value, group) {
  if (group === null || group.length === 13) return packReceiptWranglerDiagnostic(value,group);
  const observed = validateObservedWranglerGroup(group), prior = packReceiptWranglerDiagnostic(value,observed[0]);
  return validateReceiptObservedWranglerDiagnostic({...prior,v:18,detail:[...prior.detail.slice(0,7),...observed]});
}
export function unpackReceiptObservedWranglerDiagnostic(value) {
  const detail = ownedTuple(ownData(value,"detail"),11);
  return {v:17,phase:ownData(value,"phase"),state:ownData(value,"state"),detail:[...detail.slice(0,7),null,null,null,null,detail[7]]};
}
export function validateReceiptObservedWranglerDiagnostic(value) {
  const keys = ["v","phase","state","detail"];
  if (!value || Object.getOwnPropertyNames(value).sort().join() !== [...keys].sort().join()) refuse("wrangler-observed-receipt-keys");
  const row = Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));
  if (row.v !== 18) refuse("wrangler-observed-receipt-version");
  row.detail = ownedTuple(row.detail,11);
  validateReceiptWranglerDiagnostic(unpackReceiptObservedWranglerDiagnostic(row));
  row.detail.splice(7,4,...validateObservedWranglerGroup(row.detail.slice(7)));
  if (Buffer.byteLength(JSON.stringify(row)) > 512) refuse("wrangler-observed-receipt-capacity");
  return row;
}
// V19 enriches the existing attach row; historical V6 and receipt codecs stay strict.
export function validateCoordinatorRuntime(value) {
  if (value === null) return null;
  const row = ownedTuple(value,5), [first,failed,defined,finish,finishDefined] = row;
  if (!Number.isInteger(first) || first < 0 || first > 5 || typeof failed !== "boolean" ||
      (failed ? first === 0 || typeof defined !== "boolean" : first !== 0 || defined !== null) ||
      ![0,1,2].includes(finish) || (finish === 2 ? typeof finishDefined !== "boolean" : finishDefined !== null)) refuse("coordinator-runtime-fields");
  return row;
}
export function validateReaperTerminalDetail(value) {
  const row = ownedTuple(value,11), [decode,decodeDefined,sequence,kind,code,faults,finished,drained,retention,retentionDefined,receiptSha] = row;
  if (![0,1,2,3].includes(decode) || ([1,2].includes(decode) ? typeof decodeDefined !== "boolean" : decodeDefined !== null)) refuse("terminal-detail-decode");
  if (decode === 3) {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= 0xffffffff || ![0,1,2].includes(kind) ||
        (kind === 0 ? code !== null : !Number.isInteger(code) || (kind === 1 ? code < 0 || code > 255 : code < 1 || code > 64)) ||
        !Number.isInteger(faults) || faults < 0 || faults > 511 || typeof finished !== "boolean" || drained !== true ||
        (finished ? sequence < 2 : !(faults & 8))) refuse("terminal-detail-values");
  } else if (row.slice(2,8).some(x=>x!==null)) refuse("terminal-detail-unavailable");
  if (![0,1,2].includes(retention) || (retention === 2 ? typeof retentionDefined !== "boolean" : retentionDefined !== null) ||
      (retention === 1 ? typeof receiptSha !== "string" || !/^[a-f0-9]{64}$/.test(receiptSha) : receiptSha !== null) ||
      (decode === 0 ? retention !== 0 : retention === 0)) refuse("terminal-detail-retention");
  return row;
}
export function unpackAttachTerminalDiagnostic(value) {
  const a=ownedTuple(ownData(value,"attach"),9), [exit,signal,flags,errors,undefinedErrors,supervisor,first,branches,capture]=a;
  if (!Number.isInteger(signal) || signal < 0 || signal >= containerDiagnosticSignals.length || !Number.isInteger(flags) || flags < 0 || flags > 15 ||
      !Number.isInteger(supervisor) || supervisor < 0 || supervisor > 63 || !Number.isInteger(first) || first < 0 || first > attachFailureBranches.length ||
      !Number.isInteger(capture) || capture < 0 || capture > 3) refuse("attach-terminal-mask");
  return {v:6,phase:"attach_process",state:"observed",exit,signal:containerDiagnosticSignals[signal],closed:Boolean(flags&1),timedOut:Boolean(flags&2),interrupted:Boolean(flags&4),errors,undefinedErrors,
    supervisor:Array.from({length:6},(_,i)=>Boolean(supervisor&2**i)),ready:Boolean(flags&8),first:first?attachFailureBranches[first-1]:null,branches,capture:[Boolean(capture&1),Boolean(capture&2)]};
}
export function validateAttachTerminalDiagnostic(value) {
  const keys=["v","phase","state","attach","terminal","runtime"];
  if (!value || Object.getOwnPropertyNames(value).sort().join()!==[...keys].sort().join()) refuse("attach-terminal-keys");
  const row=Object.fromEntries(keys.map(k=>[k,ownData(value,k)]));
  if (row.v!==19 || row.phase!=="attach_process" || row.state!=="observed") refuse("attach-terminal-identity");
  row.attach=ownedTuple(row.attach,9);const prior=validateContainerDiagnostic(unpackAttachTerminalDiagnostic(row));
  row.terminal=validateReaperTerminalDetail(row.terminal);row.runtime=validateCoordinatorRuntime(row.runtime);
  if ((row.terminal[0]>=2 || row.runtime!==null) && (!prior.supervisor[4] || !prior.capture.every(Boolean))) refuse("attach-terminal-capture");
  if (row.runtime!==null && (row.terminal[0]<2 || !prior.ready)) refuse("attach-runtime-binding");
  if (row.runtime?.[3]===1 && row.terminal[0]===3 && !row.terminal[6]) refuse("attach-finish-contradiction");
  if (row.runtime!==null && row.terminal[0]===3 && row.terminal[3]===1 && row.terminal[4]===0 && (row.runtime[1] || row.runtime[3]===2)) refuse("attach-runtime-exit-contradiction");
  if (Buffer.byteLength(JSON.stringify(row))>512) refuse("attach-terminal-capacity");
  return row;
}
export function packAttachTerminalDiagnostic(prior,terminal,runtime) {
  const row=validateContainerDiagnostic(prior);if(row.v!==6)refuse("attach-terminal-original");
  const mask=values=>values.reduce((n,value,i)=>n+(value?2**i:0),0);
  return validateAttachTerminalDiagnostic({v:19,phase:"attach_process",state:"observed",
    attach:[row.exit,containerDiagnosticSignals.indexOf(row.signal),mask([row.closed,row.timedOut,row.interrupted,row.ready]),row.errors,row.undefinedErrors,mask(row.supervisor),row.first===null?0:attachFailureBranches.indexOf(row.first)+1,row.branches,mask(row.capture)],terminal,runtime});
}
export function validateContainerDiagnostic(value) {
  if (value && typeof value === "object" && ownData(value,"v") === 19) return validateAttachTerminalDiagnostic(value);
  if (value && typeof value === "object" && ownData(value,"v") === 18) return validateReceiptObservedWranglerDiagnostic(value);
  if (value && typeof value === "object" && ownData(value,"v") === 17) return validateReceiptWranglerDiagnostic(value);
  if (value && typeof value === "object" && ownData(value,"v") === 16) return validateReceiptCensusDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 15) return validateReceiptAssociatedDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 14) return validateReceiptCodeDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 13) return validateReceiptOwnedDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 12) return validateReceiptBuilderDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 11) return validateReceiptLifecycleDiagnostic(value);
  if (value && typeof value === "object" && ownData(value, "v") === 10) return validateReceiptBoundaryDiagnostic(value);
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
    if (Object.hasOwn(value, "compile")) fields.push("compile");
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
    if (Object.hasOwn(row,"compile")) {
      if (row.reason !== "original_failure" || row.stage !== "prepare_arguments" || row.records !== 5 || row.reportFailures !== 0 || row.undefinedReportFailures !== 0 || Object.hasOwn(row,"enumeration")) refuse("compile-summary-owner");
      row.compile = validateCompileDetail(row.compile);
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
  const receipt = validated.filter(row => row.v === 9 || row.v === 10 || row.v === 11 || row.v === 12 || row.v === 13 || row.v === 14 || row.v === 15 || row.v === 16 || row.v === 17 || row.v === 18); if (receipt.length > 1) refuse("receipt-diagnostic-duplicate");
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
  return { records, mark, replace(original,value) {
      const prior=validateContainerDiagnostic(original),next=validateContainerDiagnostic(value);
      const indexes=records.flatMap((row,index)=>row.phase===prior.phase?[index]:[]);
      if(prior.v!==6 || next.v!==19 || indexes.length!==1 || JSON.stringify(records[indexes[0]])!==JSON.stringify(prior))refuse("attach-replacement-conflict");
      records[indexes[0]]=next;
    }, process(result, available, reason) { records.push(containerProcessDiagnostic(result, available, reason)); }, internal(row) { records.push(validateContainerDiagnostic(row)); },
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
  const containerAction = ["container-ci", "container-init", "container-build", "container-prepare", "container-reaper-probe"].includes(argv[0]);
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
  if (["container-ci", "container-init", "container-build", "container-prepare", "container-reaper-probe"].includes(action)) {
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
