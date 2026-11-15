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

// Accept only the exact closed producer serialization. Parsing alone would
// erase duplicate keys and alternate spellings before schema validation.
function parseCanonicalWorkerRecord(payload, decode) {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 512 || /[^\x20-\x7e]/.test(payload)) return null;
  try {
    const record = decode(JSON.parse(payload));
    return record && JSON.stringify(record) === payload ? record : null;
  } catch { return null; }
}
export function parseWorkerAbortDiagnostic(payload) { return parseCanonicalWorkerRecord(payload, decodeWorkerAbortDiagnostic); }
export function parseWorkerReporterRecord(payload) { return parseCanonicalWorkerRecord(payload, decodeWorkerReporterRecord); }

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

// The frozen Worker CI command expands multiple files, once each. Qualification
// is deliberately narrower than Node's CLI: unknown modes/options stay unbound.
export function workerAbortInvocation(runtime, cwd) {
  const values = own(runtime, "versions").value, env = own(runtime, "env").value;
  const exec = own(runtime, "execArgv").value, argv = own(runtime, "argv").value, options = own(env, "NODE_OPTIONS");
  if (own(values, "node").value !== "24.22.1" || !env || types.isProxy(env)
    || own(env, "NODE_TEST_CONTEXT").present || options.present && options.value !== "") return null;
  const list = value => Array.isArray(value) && !types.isProxy(value) && value.length <= 4097
    ? closedDiagnosticTuple(value, value.length, x => typeof x === "string") : null;
  const flags = list(exec), args = list(argv);
  if (!flags || !args || !sameStrings(flags, ["--test", "--test-reporter=./scripts/worker-test-failure-reporter.mjs", "--test-reporter-destination=stdout"])
    || args.length < 2 || args[0] !== own(runtime, "execPath").value) return null;
  const file = value => typeof value === "string" ? relative(cwd, resolve(cwd, value)).split(sep).join("/") : null;
  const files = args.slice(1).map(file);
  if (files.some(value => !/^worker\/test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/.test(value))
    || new Set(files).size !== files.length || !files.includes("worker/test/litellm-model-discovery.test.mjs")) return null;
  return { files, file };
}
function sameStrings(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }

export const workerAbortAdmissionSites = Object.freeze([
  "invocation", "watch", "census", "scope_field", "scope_entry", "location", "name", "parent", "id",
  "wrapper_shape", "wrapper_generation", "wrapper_id", "wrapper_match", "wrapper_terminal",
  "child_id", "child_match", "child_terminal", "contradictory_terminal", "frame", "diagnostic_scope",
  "wrapper_completion", "target_unique", "target_valid", "target_coordinates", "target_failure", "diagnostic_match", "wire_size",
]);
// Node's FileTest forwards own entryFile on child events, but not on its parent
// wrapper. Child IDs are root-local. A file name alone never establishes a root:
// admission also requires the qualified invocation and one completed wrapper.
export function workerAbortAdmission(tracked, invocation) {
  const targetFile = "worker/test/litellm-model-discovery.test.mjs";
  const targetName = "original metadata caller abort retains strict acquisition and retirement outcomes";
  const wrappers = new Map(), parentIds = new Map(), ids = new Map(), coordinates = new Map(), diagnostics = [];
  const expected = new Set(invocation?.files ?? []);
  let census = 0, childEvents = 0, overflow = false, recognized = 0, rejected = 0, targetFailure = null;
  let parentInvalid = false, childInvalid = false, diagnosticInvalid = false, first = null, evaluated = 0, failed = 0, phase = 0;
  let fields = [0, 0, 0];
  const gate = (site, ok) => {
    const bit = 2 ** site; evaluated |= bit; if (!ok) failed |= bit;
    if (!ok && first === null) first = { reason: [site + 1, phase], gates: [evaluated, evaluated & ~failed], fields: [...fields] };
    return ok;
  };
  gate(0, invocation !== null && invocation !== undefined);
  const keys = ["entryFile", "file", "line", "column", "nesting", "testId", "parentId", "name"];
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const mismatch = (a, b) => a.reduce((mask, value, i) => mask | (Object.is(value, b[i]) ? 0 : 2 ** i), 0);
  return {
    observe(event) {
      const type = own(event, "type").value, data = own(event, "data").value;
      if (typeof type === "string" && type.startsWith("test:watch:")) { phase = 6; fields = [0, 0, 0]; gate(1, false); parentInvalid = true; return; }
      const eventIndex = ["test:enqueue", "test:fail", "test:pass", "test:complete", "test:diagnostic"].indexOf(type);
      if (eventIndex < 0) return;
      const message = type === "test:diagnostic" ? own(data, "message").value : null;
      if (type === "test:diagnostic" && (typeof message !== "string" || !message.startsWith(workerAbortPrefix))) return;
      phase = eventIndex + 1;
      const f = keys.map(key => own(data, key));
      const [entry, sourceFile, line, column, nesting, id, parent, name] = f;
      fields = [f.reduce((mask, value, i) => mask | (value.present ? 2 ** i : 0), 0), 0, 0];
      const validity = [typeof entry.value === "string", typeof sourceFile.value === "string", count(line.value) && line.value > 0,
        count(column.value) && column.value > 0, count(nesting.value), Number.isSafeInteger(id.value) && id.value > 0,
        parent.present && (parent.value === undefined || parent.value === null || Number.isSafeInteger(parent.value) && parent.value >= 0),
        typeof name.value === "string" && Buffer.byteLength(name.value) <= 512];
      fields[1] = validity.reduce((mask, value, i) => mask | (value ? 2 ** i : 0), 0);
      const file = tracked(sourceFile.value), entryFile = entry.present ? tracked(entry.value) : null;
      const at = file && validity[2] && validity[3] && validity[4] ? [file, line.value, column.value, nesting.value] : null;
      if (type === "test:diagnostic") {
        recognized = Math.min(limit, recognized + 1);
        const record = parseWorkerAbortDiagnostic(message.slice(workerAbortPrefix.length));
        if (!gate(18, record !== null)) { rejected = Math.min(limit, rejected + 1); return; }
        if (diagnostics.length >= 32) { overflow = true; gate(2, false); return; }
        if (!gate(19, entry.present && entryFile === targetFile && at !== null && file === targetFile)) {
          diagnosticInvalid = true; diagnostics.push({ at: null, record }); return;
        }
        diagnostics.push({ at, record }); return;
      }
      if (type === "test:fail" && file === targetFile && name.value === targetName) targetFailure ??= failureRecord(data, tracked);
      if (++census > limit) { overflow = true; gate(2, false); return; }
      // Missing entryFile is a parent event, never a forwarded child event.
      // An accessor is neither an absent field nor a valid parent/child marker.
      if (!gate(3, entry.present || data !== null && typeof data === "object" && !types.isProxy(data) && !Object.hasOwn(data, "entryFile"))) { parentInvalid = true; return; }
      if (entry.present) {
        if (!gate(4, validity[0] && entryFile !== null && expected.has(entryFile))) { parentInvalid = true; return; }
        if (entryFile !== targetFile) return;
        if (++childEvents > 4096) { overflow = true; gate(2, false); return; }
      } else if (!gate(4, file !== null && expected.has(file))) { parentInvalid = true; return; }
      let valid = true;
      valid = gate(5, at !== null) && valid; valid = gate(6, validity[7]) && valid;
      valid = gate(7, validity[6]) && valid; valid = gate(8, id.present && validity[5]) && valid;
      if (!valid) { if (entry.present) childInvalid = true; else parentInvalid = true; return; }
      const identity = [id.value, parent.value, name.value, ...at], key = JSON.stringify(at);
      if (!entry.present) {
        if (!gate(9, invocation?.file(name.value) === file && line.value === 1 && column.value === 1 && nesting.value === 0 && parent.value === 0)) { parentInvalid = true; return; }
        if (type === "test:enqueue") {
          const uniqueFile = gate(10, !wrappers.has(file)), uniqueId = gate(11, !parentIds.has(id.value));
          if (!uniqueFile || !uniqueId) { parentInvalid = true; return; }
          const row = { identity, events: new Set() }; wrappers.set(file, row); parentIds.set(id.value, row);
        } else {
          const row = parentIds.get(id.value); fields[2] = row ? mismatch(row.identity, identity) : 0;
          if (!gate(12, row !== undefined && same(row.identity, identity))) { parentInvalid = true; return; }
          if (!gate(13, !row.events.has(type))) parentInvalid = true;
          row.events.add(type);
          if (!gate(17, !(row.events.has("test:fail") && row.events.has("test:pass")))) parentInvalid = true;
        }
        return;
      }
      if (type === "test:enqueue") {
        const row = { at, id: id.value, identity, name: name.value, events: new Set(), failure: null };
        const siblings = coordinates.get(key) ?? []; siblings.push(row); coordinates.set(key, siblings);
        // Shared unrelated call sites are legitimate; ID reuse within this
        // child execution is not. Target-coordinate uniqueness is checked last.
        if (!gate(14, !ids.has(id.value))) childInvalid = true;
        else ids.set(id.value, row);
      } else {
        const row = ids.get(id.value); fields[2] = row ? mismatch(row.identity, identity) : 0;
        if (!gate(15, row !== undefined && same(row.identity, identity))) { childInvalid = true; return; }
        if (!gate(16, !row.events.has(type))) childInvalid = true;
        row.events.add(type);
        if (!gate(17, !(row.events.has("test:fail") && row.events.has("test:pass")))) childInvalid = true;
        if (type === "test:fail" && file === targetFile && name.value === targetName) {
          row.failure = failureRecord(data, tracked); targetFailure ??= row.failure;
        }
      }
    },
    finish() {
      phase = 7; fields = [0, 0, 0];
      const rows = [...coordinates.values()].flat().filter(row => row.name === targetName && row.at[0] === targetFile);
      const row = rows.length === 1 ? rows[0] : null;
      const matches = row ? diagnostics.filter(value => same(value.at, row.at)) : [];
      const complete = invocation && wrappers.size === expected.size && [...expected].every(file => wrappers.get(file)?.events.has("test:complete"));
      let bound = gate(20, Boolean(complete) && !parentInvalid && !overflow);
      bound = gate(21, rows.length === 1) && bound;
      bound = gate(22, row !== null && !childInvalid) && bound;
      bound = gate(23, row !== null && coordinates.get(JSON.stringify(row.at)).length === 1) && bound;
      bound = gate(24, row !== null && row.failure !== null) && bound;
      bound = gate(25, matches.length === 1 && diagnostics.length === 1 && rejected === 0 && !diagnosticInvalid) && bound;
      let record = null;
      if (bound) {
        const data = matches[0].record;
        record = { v: 1, kind: "worker_abort", at: row.at, stage: data.first,
          counts: [data.failures, data.undefinedFailures, data.reportingFailures], worker: data.worker, upstream: data.upstream };
        if (!gate(26, Buffer.byteLength(JSON.stringify(record)) <= 512)) record = null;
      }
      const admitted = record !== null;
      if (!admitted && recognized) {
        record = { v: 1, kind: "worker_abort_unbound", reason: first?.reason ?? null, gates: first?.gates ?? [0, 0], fields: first?.fields ?? [0, 0, 0],
          census: [expected.size, wrappers.size, childEvents, ids.size, rows.length, matches.length],
          scope: [Boolean(invocation), !parentInvalid, Boolean(complete), !childInvalid, true] };
      }
      return { failure: recognized ? row?.failure ?? targetFailure : null, record,
        diagnostics: recognized ? [recognized, admitted ? 1 : 0, rejected, recognized - rejected - (admitted ? 1 : 0), overflow] : null };
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
  } else if (get("kind") === "worker_abort_unbound") {
    if (!exact(["v", "kind", "reason", "gates", "fields", "census", "scope"])) return null;
    const reason = closedDiagnosticTuple(get("reason"), 2, (x, i) => Number.isInteger(x) && (i === 0 ? x >= 1 && x <= workerAbortAdmissionSites.length : x >= 0 && x <= 7));
    const gates = closedDiagnosticTuple(get("gates"), 2, x => Number.isInteger(x) && x >= 0 && x < 2 ** workerAbortAdmissionSites.length);
    const fields = closedDiagnosticTuple(get("fields"), 3, x => Number.isInteger(x) && x >= 0 && x <= 255);
    const census = closedDiagnosticTuple(get("census"), 6, count);
    const scope = closedDiagnosticTuple(get("scope"), 5, x => typeof x === "boolean");
    if (!reason || !gates || (gates[1] & ~gates[0]) !== 0 || !fields || !census || !scope
      || (gates[0] & 2 ** (reason[0] - 1)) === 0 || (gates[1] & 2 ** (reason[0] - 1)) !== 0) return null;
    result = { v: 1, kind: "worker_abort_unbound", reason, gates, fields, census, scope };
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
  const admission = workerAbortAdmission(tracked, workerAbortInvocation(process, cwd));
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
  const prioritized = [...(evidence.failure ? [evidence.failure] : []), ...(evidence.record ? [evidence.record] : [])];
  const selected = [...prioritized, ...[...leaves.values(), ...parents.values()].filter(record => !evidence.failure || JSON.stringify(record) !== JSON.stringify(evidence.failure))].slice(0, 9);
  for (const record of selected) yield annotation(record, "error");
  const identities = selected.filter(record => record.kind === "failure").length;
  // Zero observed failures is not a success verdict; Node owns the exit code.
  yield annotation({ v: 1, kind: "summary", failureEvents: failures, reported: identities,
    omittedEvents: Math.max(0, failures - identities), unknownFiles, countsSaturated: failures === limit,
    ...(evidence.diagnostics ? { diagnostics: evidence.diagnostics } : {}) }, failures ? "error" : "notice");
}

export default workerFailureReport;
