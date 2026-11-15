import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { parseObservationDiagnostic, searchObservationContract } from "./search-semantics-fixture.mjs";

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

export function annotation(record, level) {
  const json = JSON.stringify(record);
  const escaped = json.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  const line = `::${level} title=Worker test identity::${escaped}\n`;
  if (Buffer.byteLength(line) > 768) throw new Error("worker identity record exceeds limit");
  return line;
}

// BEGIN observation native event binding (pure; final stream ownership only).
export function createObservationRelay(tracked) {
  const registrations = [], terminals = [], diagnostics = [];
  let active = false, overflow = false, diagnosticEvents = 0, reservedTargetFailure = null;
  const coordinate = data => {
    const fields = ["entryFile", "file", "line", "column", "nesting"].map(key => own(data, key).value);
    const [entryFile, file, line, column, nesting] = fields;
    if (typeof entryFile !== "string" || typeof file !== "string" || tracked(entryFile) !== searchObservationContract.file || tracked(file) !== searchObservationContract.file
      || ![line, column].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000) || !Number.isSafeInteger(nesting) || nesting < 0 || nesting > 100) return null;
    return JSON.stringify(fields);
  };
  const append = (list, row) => { if (list.length < 256) list.push(row); else overflow = true; };
  return {
    observe(type, data, failure) {
      if (!["test:enqueue", "test:diagnostic", "test:pass", "test:fail"].includes(type)) return;
      const file = own(data, "file").value;
      const child = own(data, "entryFile").value;
      if (tracked(file) !== searchObservationContract.file && tracked(child) !== searchObservationContract.file) return;
      const key = coordinate(data), name = own(data, "name").value, id = own(data, "testId");
      if (type === "test:enqueue") {
        const target = name === searchObservationContract.name;
        if (target) active = true;
        append(registrations, { key, child, target, id: id.present && Number.isSafeInteger(id.value) && id.value > 0 ? id.value : null });
      } else if (type === "test:diagnostic") {
        const text = own(data, "message").value;
        if (typeof text !== "string" || !text.startsWith(searchObservationContract.prefix)) return;
        diagnosticEvents = Math.min(1000000, diagnosticEvents + 1);
        let record; try { record = parseObservationDiagnostic(text); } catch { /* closed incomplete, never raw text */ }
        append(diagnostics, { key, record });
      } else {
        const target = name === searchObservationContract.name;
        // Reserve the original sanitized identity before either bounded buffer can drop it.
        // This retention is not evidence that diagnostic ownership is complete.
        if (target && type === "test:fail" && reservedTargetFailure === null) reservedTargetFailure = failure ?? null;
        append(terminals, { key, child, target, id, type, failure });
      }
    },
    finish() {
      if (!active) return { active: false, records: [], targetFailure: null, omitted: 0 };
      const candidates = registrations.filter(r => r.target), target = candidates[0];
      let reason = "complete", terminal, targetFailure = reservedTargetFailure;
      if (overflow) reason = "bounded_overflow";
      else if (candidates.length !== 1 || !target.key || target.id === null) reason = "registration_incomplete";
      else if (registrations.filter(r => r.key === target.key).length !== 1) reason = "ambiguous_coordinates";
      else if (registrations.filter(r => r.child === target.child && r.id === target.id).length !== 1) reason = "ambiguous_identity";
      else {
        const matching = terminals.filter(r => r.key === target.key);
        const sameIdentity = terminals.filter(r => r.child === target.child && r.id.present && r.id.value === target.id);
        if (matching.length !== 1 || !matching[0].target || !matching[0].id.present
          || !Number.isSafeInteger(matching[0].id.value) || matching[0].id.value <= 0 || matching[0].id.value !== target.id
          || sameIdentity.length !== 1 || sameIdentity[0] !== matching[0]) reason = "terminal_incomplete";
        else { terminal = matching[0]; targetFailure = terminal.failure ?? reservedTargetFailure; }
      }
      const owned = target?.key ? diagnostics.filter(r => r.key === target.key) : [];
      if (reason === "complete" && (owned.length !== 2 || owned.some(r => !r.record) || diagnostics.length !== owned.length)) reason = "diagnostics_incomplete";
      const boundary = owned.find(r => r.record?.kind === "boundary")?.record, cleanup = owned.find(r => r.record?.kind === "cleanup")?.record;
      if (reason === "complete" && (!boundary || !cleanup || (terminal.type === "test:pass" && (boundary.failurePresent || !cleanup.registered || cleanup.dispose === "rejected" || cleanup.remove === "rejected" || cleanup.recorderFailures)))) reason = "diagnostics_conflict";
      if (reason === "complete" && (cleanup.dispose === "pending" || cleanup.remove === "pending")) reason = "cleanup_incomplete";
      const records = reason === "complete" ? [boundary, cleanup] : [{ v: 1, kind: "observation_delivery", state: "incomplete", reason }];
      return { active: true, records, targetFailure, omitted: reason === "complete" ? 0 : diagnosticEvents };
    },
  };
}
export function selectFailureRecords(leaves, parents, relay) {
  const selected = [...leaves, ...parents];
  if (!relay.active) return selected.slice(0, 9);
  const target = relay.targetFailure, key = target && JSON.stringify(target);
  const unique = target ? [target, ...selected.filter(row => JSON.stringify(row) !== key)] : selected;
  return unique.slice(0, 9 - relay.records.length);
}
// END observation native event binding.

// Buffer only nine leaf and nine parent identities. Parent summaries cannot
// crowd out later leaf failures, and presentation never changes runner verdicts.
export async function* workerFailureReport(source, { cwd = process.cwd() } = {}) {
  const tracked = trackedTestFiles(cwd), leaves = new Map(), parents = new Map();
  const observation = createObservationRelay(tracked);
  let failures = 0, unknownFiles = 0;
  for await (const event of source) {
    const type = own(event, "type").value, data = own(event, "data").value;
    if (type !== "test:fail") { observation.observe(type, data); continue; }
    failures = Math.min(limit, failures + 1);
    const record = failureRecord(data, tracked);
    observation.observe(type, data, record);
    if (record.file === null) unknownFiles = Math.min(limit, unknownFiles + 1);
    const bucket = record.failureType === "subtestsFailed" ? parents : leaves;
    const key = JSON.stringify(record);
    if (bucket.has(key) || bucket.size < 9) bucket.set(key, record);
  }
  const relay = observation.finish();
  const selected = selectFailureRecords([...leaves.values()], [...parents.values()], relay);
  for (const record of selected) yield annotation(record, "error");
  for (const record of relay.records) yield annotation(record, "notice");
  // Zero observed failures is not a success verdict; Node owns the exit code.
  yield annotation({ v: 1, kind: "summary", failureEvents: failures, reported: selected.length,
    omittedEvents: Math.max(0, failures - selected.length), unknownFiles, countsSaturated: failures === limit,
    ...(relay.active ? { diagnosticsReported: relay.records.length, diagnosticsOmitted: relay.omitted } : {}) }, failures ? "error" : "notice");
}

export default workerFailureReport;
