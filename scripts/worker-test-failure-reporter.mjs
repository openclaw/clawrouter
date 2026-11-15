import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const failureTypes = new Set(["testCodeFailure", "subtestsFailed", "testTimeoutFailure", "cancelledByParent", "parentAlreadyFinished", "hookFailed", "testAborted"]);
const codes = new Set(["ERR_TEST_FAILURE", "ERR_ASSERTION", "ERR_ASSERTION_ERROR", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE"]);
const filePattern = /^(?:worker\/)?test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;
const limit = 1_000_000;

// Do not inspect names, messages, causes, aggregate members or accessors.
function own(value, key) {
  if (value === null || !["object", "function"].includes(typeof value) || types.isProxy(value)) return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? { present: true, value: descriptor.value } : { present: false };
}

// Node-side fixture evidence only. Neither this payload nor its arrival order
// identifies a native test or proves cancellation/retirement.
export const workerAbortPrefix = "LITELLM_WORKER_ABORT_V1 ";
export const workerAbortStages = Object.freeze([
  "directory", "runtime", "direct_url", "upstream_handle", "upstream_setup",
  "router_setup_fetch", "router_setup_status", "router_setup_body", "caller",
  "started", "authored_abort", "caller_outcome", "caller_signal", "retire",
  "observation", "fallback_state", "retired", "final_state", "calls", "canceled",
  "active", "expired", "dispose", "remove",
]);

export function workerAbortEvidence() {
  let current = [1, 0], first = null, failures = 0, undefinedFailures = 0;
  let step = 0, failedStep = -1, worker = null, upstream = null;
  const reporting = [];
  const attempt = fn => { try { return fn(); } catch (error) { reporting.push(error); } };
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : null;
  const capture = (stage, part, error) => {
    failures = Math.min(limit, failures + 1);
    if (error === undefined) undefinedFailures = Math.min(limit, undefinedFailures + 1);
    first ??= [stage, part, error !== undefined];
  };
  return {
    stage(stage, part = 0) { attempt(() => { current = [stage, part]; step++; }); },
    failed(error) { attempt(() => { if (failedStep !== step) { failedStep = step; capture(...current, error); } }); },
    observation(stage, outcome) {
      attempt(() => {
        if (stage !== 15 && stage !== 16) throw new Error("invalid diagnostic stage");
        if (own(outcome, "status").value === "rejected") {
          const reason = own(outcome, "reason");
          if (!reason.present) throw new Error("missing diagnostic reason");
          capture(stage, 0, reason.value); return;
        }
        if (own(outcome, "status").value !== "fulfilled") throw new Error("invalid diagnostic outcome");
        const value = own(outcome, "value").value;
        if (stage === 15) {
          const checks = own(value, "checks").value;
          worker = [count(own(value, "operations").value), count(own(value, "syncFailures").value),
            closedDiagnosticTuple(checks, 5, x => x === null || typeof x === "boolean" || count(x) !== null)];
        } else if (stage === 16) {
          const calls = own(value, "calls").value;
          upstream = [Array.isArray(calls) && !types.isProxy(calls) ? count(calls.length) : null,
            ...["active", "canceled", "aborted", "expired", "finished"].map(key => count(own(value, key).value))];
        } else throw new Error("invalid diagnostic stage");
      });
    },
    report(context) {
      attempt(() => {
        const record = { v: 1, kind: "worker_abort_stage", first, failures, undefinedFailures,
          worker, upstream, reportingFailures: reporting.length };
        if (!validateWorkerAbortDiagnostic(record)) throw new Error("invalid diagnostic projection");
        context.diagnostic(workerAbortPrefix + JSON.stringify(record));
      });
      return reporting.slice();
    },
  };
}

function closedDiagnosticTuple(value, length, check) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length !== length) return null;
  const fields = Array.from({ length }, (_, i) => own(value, String(i)));
  return fields.every((field, i) => field.present && check(field.value, i)) ? fields.map(field => field.value) : null;
}

export function decodeWorkerAbortDiagnostic(record) {
  if (!record || typeof record !== "object" || types.isProxy(record)) return null;
  const keys = ["v", "kind", "first", "failures", "undefinedFailures", "worker", "upstream", "reportingFailures"];
  if (Reflect.ownKeys(record).length !== keys.length || keys.some(key => !own(record, key).present)) return null;
  const get = key => own(record, key).value, count = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
  if (get("v") !== 1 || get("kind") !== "worker_abort_stage"
    || !["failures", "undefinedFailures", "reportingFailures"].every(key => count(get(key)))
    || get("undefinedFailures") > get("failures")) return null;
  const first = get("first") === null ? null : closedDiagnosticTuple(get("first"), 3, (x, i) =>
    i === 0 ? Number.isInteger(x) && x >= 1 && x <= 24 : i === 1 ? x === 0 || x === 1 : typeof x === "boolean");
  if (get("first") !== null && (!first || first[1] === 1 && ![5, 9].includes(first[0]))
    || (first === null) !== (get("failures") === 0)) return null;
  let worker = null, upstream = null;
  if (get("worker") !== null) {
    const fields = closedDiagnosticTuple(get("worker"), 3, (x, i) => i === 2 || x === null || count(x));
    if (!fields) return null;
    const checks = fields[2] === null ? null : closedDiagnosticTuple(fields[2], 5, x => x === null || typeof x === "boolean" || count(x));
    if (fields[2] !== null && !checks) return null;
    worker = [fields[0], fields[1], checks];
  }
  if (get("upstream") !== null) {
    upstream = closedDiagnosticTuple(get("upstream"), 6, x => x === null || count(x));
    if (!upstream) return null;
  }
  const result = { v: 1, kind: "worker_abort_stage", first, failures: get("failures"), undefinedFailures: get("undefinedFailures"),
    worker, upstream, reportingFailures: get("reportingFailures") };
  return Buffer.byteLength(JSON.stringify(result)) <= 512 ? result : null;
}
export function validateWorkerAbortDiagnostic(record) { return decodeWorkerAbortDiagnostic(record) !== null; }

// Node 24.22.1 forwards the owner's loc on diagnostics, but no testId/name.
// IDs are compared only inside a validated native file context. Payloads never
// supply identity. Full-stream collisions invalidate earlier candidate matches.
export function workerAbortAdmission(tracked) {
  const targetFile = "worker/test/litellm-model-discovery.test.mjs";
  const targetName = "original metadata caller abort retains strict acquisition and retirement outcomes";
  const contexts = new Map(), diagnostics = [];
  let census = 0, overflow = false, recognized = 0, rejected = 0, targetFailure = null;
  const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
  const location = data => {
    const file = tracked(own(data, "file").value), entry = own(data, "entryFile");
    const values = ["line", "column", "nesting"].map(key => own(data, key).value);
    if (!file || entry.present && tracked(entry.value) !== file || !values.every(integer) || values[0] === 0 || values[1] === 0) return null;
    return [file, ...values];
  };
  const context = file => {
    if (!contexts.has(file)) contexts.set(file, { ids: new Map(), coordinates: new Map(), unknown: false });
    return contexts.get(file);
  };
  const parent = data => {
    const field = own(data, "parentId");
    if (!field.present) return [false, undefined];
    return field.value === undefined || field.value === null || Number.isSafeInteger(field.value) && field.value >= 0 ? [true, field.value] : null;
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  return {
    observe(event) {
      const type = own(event, "type").value, data = own(event, "data").value;
      if (type === "test:diagnostic") {
        const message = own(data, "message").value;
        if (typeof message !== "string" || !message.startsWith(workerAbortPrefix)) return;
        recognized = Math.min(limit, recognized + 1);
        let record = null;
        if (Buffer.byteLength(message) <= 512 + workerAbortPrefix.length && !message.includes("\x1b")) {
          try { record = decodeWorkerAbortDiagnostic(JSON.parse(message.slice(workerAbortPrefix.length))); } catch { /* closed invalid frame */ }
        }
        if (!record) { rejected = Math.min(limit, rejected + 1); return; }
        if (diagnostics.length >= 32) { overflow = true; return; }
        diagnostics.push({ at: location(data), record }); return;
      }
      if (!["test:enqueue", "test:fail", "test:pass", "test:complete"].includes(type)) return;
      const file = tracked(own(data, "file").value);
      if (file !== targetFile) return;
      if (++census > 4096) { overflow = true; return; }
      const c = context(file), at = location(data), id = own(data, "testId"), p = parent(data), name = own(data, "name").value;
      if (!at || typeof name !== "string" || Buffer.byteLength(name) > 512) { c.unknown = true; return; }
      const key = JSON.stringify(at), identity = [id.value, p?.[0], p?.[1], name, ...at];
      if (type === "test:enqueue") {
        const row = { at, id: id.value, parent: p, identity, name, events: new Set(), invalid: false, failure: null };
        const siblings = c.coordinates.get(key) ?? [];
        if (siblings.length) c.unknown = true;
        siblings.push(row); c.coordinates.set(key, siblings);
        if (!id.present || !Number.isSafeInteger(id.value) || !p) { row.invalid = true; c.unknown = true; }
        if (c.ids.has(id.value)) { c.ids.get(id.value).invalid = true; row.invalid = true; c.unknown = true; }
        else c.ids.set(id.value, row);
      } else {
        const row = c.ids.get(id.value);
        if (!row || !id.present || !same(row.identity, identity) || !p) { c.unknown = true; return; }
        if (row.events.has(type)) { row.invalid = true; c.unknown = true; }
        row.events.add(type);
        if (row.events.has("test:fail") && row.events.has("test:pass")) { row.invalid = true; c.unknown = true; }
        if (type === "test:fail" && file === targetFile && name === targetName) {
          row.failure = failureRecord(data, tracked); targetFailure ??= row.failure;
        }
      }
    },
    finish() {
      const c = contexts.get(targetFile), rows = c ? [...c.coordinates.values()].flat().filter(row => row.name === targetName) : [];
      const row = rows.length === 1 ? rows[0] : null;
      const matches = row ? diagnostics.filter(value => same(value.at, row.at)) : [];
      const bound = !overflow && c && !c.unknown && row && !row.invalid && row.id > 0 && row.failure
        && c.coordinates.get(JSON.stringify(row.at)).length === 1 && matches.length === 1 && rejected === 0;
      let record = null;
      if (bound) {
        const data = matches[0].record;
        record = { v: 1, kind: "worker_abort", at: row.at, stage: data.first,
          counts: [data.failures, data.undefinedFailures, data.reportingFailures], worker: data.worker, upstream: data.upstream };
        if (Buffer.byteLength(JSON.stringify(record)) > 512) record = null;
      }
      return { failure: recognized ? record ? row.failure : targetFailure : null, record,
        diagnostics: recognized ? [recognized, record ? 1 : 0, rejected, recognized - rejected - (record ? 1 : 0), overflow] : null };
    },
  };
}

// The private Checks collector shares the signed closed wire schema. Decoding
// verifies shape, not native delivery, case success or cancellation ownership.
export function decodeWorkerReporterRecord(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  const get = key => own(value, key).value;
  const exact = keys => Reflect.ownKeys(value).length === keys.length && keys.every(key => own(value, key).present);
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
  if (get("v") !== 1) return null;
  let result;
  if (get("kind") === "failure") {
    const keys = ["v", "kind", "file", "line", "failureType", "errorClass", "code"], file = get("file"), line = get("line");
    if (!exact(keys) || !(file === null || typeof file === "string" && file.length <= 240 && filePattern.test(file))
      || !(line === null || file !== null && count(line) && line > 0)
      || ![...failureTypes, "unknown"].includes(get("failureType")) || ![...codes, "unknown"].includes(get("code"))
      || !["missing", "undefined", "null", "native_error", "unknown"].includes(get("errorClass"))) return null;
    result = Object.fromEntries(keys.map(key => [key, get(key)]));
  } else if (get("kind") === "worker_abort") {
    if (!exact(["v", "kind", "at", "stage", "counts", "worker", "upstream"])) return null;
    const at = closedDiagnosticTuple(get("at"), 4, (x, i) => i === 0 ? x === "worker/test/litellm-model-discovery.test.mjs" : count(x) && (i === 3 || x > 0));
    const counts = closedDiagnosticTuple(get("counts"), 3, count);
    if (!at || !counts) return null;
    const data = decodeWorkerAbortDiagnostic({ v: 1, kind: "worker_abort_stage", first: get("stage"), failures: counts[0], undefinedFailures: counts[1],
      reportingFailures: counts[2], worker: get("worker"), upstream: get("upstream") });
    if (!data) return null;
    result = { v: 1, kind: "worker_abort", at, stage: data.first, counts, worker: data.worker, upstream: data.upstream };
  } else if (get("kind") === "summary") {
    const keys = ["v", "kind", "failureEvents", "reported", "omittedEvents", "unknownFiles", "countsSaturated"];
    const extra = own(value, "diagnostics");
    if (!exact(extra.present ? [...keys, "diagnostics"] : keys) || !keys.slice(2, 6).every(key => count(get(key)))
      || get("reported") > 9 || get("reported") > get("failureEvents") || get("unknownFiles") > get("failureEvents")
      || get("omittedEvents") !== get("failureEvents") - get("reported") || typeof get("countsSaturated") !== "boolean") return null;
    result = Object.fromEntries(keys.map(key => [key, get(key)]));
    if (extra.present) {
      const diagnostic = closedDiagnosticTuple(extra.value, 5, (x, i) => i === 4 ? typeof x === "boolean" : count(x));
      if (!diagnostic || diagnostic[1] > 1 || diagnostic[0] !== diagnostic[1] + diagnostic[2] + diagnostic[3]) return null;
      result.diagnostics = diagnostic;
    }
  } else return null;
  return Buffer.byteLength(JSON.stringify(result)) <= 512 ? result : null;
}

function trackedTestFiles(cwd) {
  try {
    const git = args => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const root = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
    const lexicalRoot = resolve(cwd, relative(realpathSync(cwd), root));
    const files = new Set(git(["ls-files", "--stage", "-z", "--", ":(top)worker/test", ":(top)test"]).split("\0")
      .map(entry => /^(?:100644|100755) [0-9a-f]{40,64} 0\t(.+)$/.exec(entry)?.[1])
      .filter(file => file && file.length <= 240 && filePattern.test(file)));
    return value => {
      if (typeof value !== "string" || /[\\\x00-\x1f\x7f]/.test(value) || /^[A-Za-z]:/.test(value)
        || value.replace(/%2e/gi, ".").split("/").includes("..")) return null;
      try {
        let path;
        if (value.startsWith("file:")) {
          const url = new URL(value);
          if (url.hostname || url.search || url.hash || url.username || url.password) return null;
          path = fileURLToPath(url);
        } else path = isAbsolute(value) ? value : resolve(cwd, value);
        const file = [lexicalRoot, root].map(base => relative(base, path).split(sep).join("/")).find(file => files.has(file));
        if (!file) return null;
        if (!lstatSync(path).isFile()) return null;
        if (realpathSync(path) !== resolve(root, file)) return null;
        return file;
      } catch { return null; }
    };
  } catch { return () => null; }
}

function failureRecord(data, tracked) {
  const details = own(data, "details").value;
  const error = own(details, "error");
  const value = error.value;
  const failureType = own(value, "failureType").value;
  const code = own(value, "code").value;
  const file = tracked(own(data, "file").value), line = own(data, "line").value;
  return {
    v: 1, kind: "failure", file,
    line: file && Number.isSafeInteger(line) && line > 0 && line <= limit ? line : null,
    failureType: failureTypes.has(failureType) ? failureType : "unknown",
    errorClass: !error.present ? "missing" : value === undefined ? "undefined" : value === null ? "null"
      : !types.isProxy(value) && types.isNativeError(value) ? "native_error" : "unknown",
    code: codes.has(code) ? code : "unknown",
  };
}

function annotation(record, level) {
  const json = JSON.stringify(record);
  const escaped = json.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  const line = `::${level} title=Worker test identity::${escaped}\n`;
  if (Buffer.byteLength(line) > 768) throw new Error("worker identity record exceeds limit");
  return line;
}

// Buffer only nine leaf and nine parent identities. Parent summaries cannot
// crowd out later leaf failures, and presentation never changes runner verdicts.
export async function* workerFailureReport(source, { cwd = process.cwd() } = {}) {
  const tracked = trackedTestFiles(cwd), leaves = new Map(), parents = new Map();
  const admission = workerAbortAdmission(tracked);
  let failures = 0, unknownFiles = 0;
  for await (const event of source) {
    admission.observe(event);
    if (own(event, "type").value !== "test:fail") continue;
    failures = Math.min(limit, failures + 1);
    const record = failureRecord(own(event, "data").value, tracked);
    if (record.file === null) unknownFiles = Math.min(limit, unknownFiles + 1);
    const bucket = record.failureType === "subtestsFailed" ? parents : leaves;
    const key = JSON.stringify(record);
    if (bucket.has(key) || bucket.size < 9) bucket.set(key, record);
  }
  const evidence = admission.finish();
  const prioritized = evidence.failure ? [evidence.failure, ...(evidence.record ? [evidence.record] : [])] : [];
  const selected = [...prioritized, ...[...leaves.values(), ...parents.values()].filter(record => !evidence.failure || JSON.stringify(record) !== JSON.stringify(evidence.failure))].slice(0, 9);
  for (const record of selected) yield annotation(record, "error");
  const identities = selected.filter(record => record.kind === "failure").length;
  // Zero observed failures is not a success verdict; Node owns the exit code.
  yield annotation({ v: 1, kind: "summary", failureEvents: failures, reported: identities,
    omittedEvents: Math.max(0, failures - identities), unknownFiles, countsSaturated: failures === limit,
    ...(evidence.diagnostics ? { diagnostics: evidence.diagnostics } : {}) }, failures ? "error" : "notice");
}

export default workerFailureReport;
