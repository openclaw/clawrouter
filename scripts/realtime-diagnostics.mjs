import { types } from "node:util";

// BEGIN realtime diagnostics (pure; no fixture or native runner execution).
export const realtimeObservationContract = Object.freeze({ file: "test/realtime-cadence-workerd.test.mjs", prefix: "REALTIME_AUTHORITY_V1 ",
  names: Object.freeze(["bounded media authority revocation, ASR=false","bounded media authority principal, ASR=false","bounded media authority tenant, ASR=false","bounded media authority generation, ASR=false","bounded media authority route, ASR=false","bounded media authority revocation, ASR=true","bounded media authority principal, ASR=true","bounded media authority tenant, ASR=true","bounded media authority generation, ASR=true","bounded media authority route, ASR=true","bounded media authority asr-model, ASR=true","bounded media authority budget, ASR=true"]) });
const realtimeOperations = new Set(["temporary", "cleanup_registration", "server", "listen", "bundle", "bundle_anchor", "ready", "observer", "namespace", "authority", "policy", "policy_status", "credential", "credential_status", "connection", "control", "upgrade", "observer_acquired", "upgrade101", "session", "session_ack", "response", "response_ack", "first_send", "first_ack", "mutation", "send_loop", "stats", "calls", "close_snapshot", "diagnostic", "assert_snapshot", "assert_closed", "assert_elapsed", "assert_error_count", "assert_error_code", "assert_egress", "wait120", "assert_retired", "complete"]);
const realtimeCleanupKeys = ["release", "sockets", "drain", "clients", "dispose", "observer", "server", "remove", "server_errors"];
export function realtimeDiagnosticText(value) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw Error("invalid realtime diagnostic");
  const row = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = typeof key === "string" && Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, "value")) throw Error("invalid realtime diagnostic");
    Object.defineProperty(row, key, { value: d.value, enumerable: true });
  }
  const keys = Object.keys(row).sort().join(",");
  if (row.v !== 1 || typeof row.case !== "string" || !/^r(?:0[1-9]|1[0-2])$/.test(row.case) || !Number.isSafeInteger(row.unreportedCases) || row.unreportedCases < 0 || row.unreportedCases > 1000000) throw Error("invalid realtime diagnostic");
  if (row.kind === "realtime_boundary") {
    if (keys !== "case,failurePresent,kind,operation,reasonDefined,unreportedCases,v" || !realtimeOperations.has(row.operation) || typeof row.failurePresent !== "boolean" || (row.failurePresent ? typeof row.reasonDefined !== "boolean" : row.reasonDefined !== null)) throw Error("invalid realtime diagnostic");
  } else if (row.kind === "realtime_cleanup") {
    if (keys !== "case,kind,outcomes,recorderFailures,recorderFirstDefined,registered,unreportedCases,v" || typeof row.registered !== "boolean" || typeof row.outcomes !== "string" || !/^[upfdr]{9}$/.test(row.outcomes)
      || !Number.isSafeInteger(row.recorderFailures) || row.recorderFailures < 0 || row.recorderFailures > 1000000 || (row.recorderFailures ? typeof row.recorderFirstDefined !== "boolean" : row.recorderFirstDefined !== null)
      || (!row.registered && row.outcomes !== "uuuuuuuuu")) throw Error("invalid realtime diagnostic");
  } else throw Error("invalid realtime diagnostic");
  const text = realtimeObservationContract.prefix + JSON.stringify(row);
  if (Buffer.byteLength(text) > 640 || /[^\x20-\x7e]/.test(text)) throw Error("invalid realtime diagnostic");
  return text;
}
export function parseRealtimeDiagnostic(text) {
  if (typeof text !== "string" || text.length > 640 || /[^\x20-\x7e]/.test(text) || !text.startsWith(realtimeObservationContract.prefix)) throw Error("invalid realtime diagnostic");
  const row = JSON.parse(text.slice(realtimeObservationContract.prefix.length));
  if (realtimeDiagnosticText(row) !== text) throw Error("invalid realtime diagnostic");
  return row;
}
export function createRealtimeLedger(caseId, deliver) {
  let operation = "temporary", boundary, registered = false, flushed = false;
  const outcomes = Array(9).fill("u"), reporting = [];
  const ledger = {
    mark(value) { if (realtimeOperations.has(value)) operation = value; else reporting.push(undefined); },
    registered() { registered = true; },
    start(key) { outcomes[realtimeCleanupKeys.indexOf(key)] = "p"; },
    end(key, failed = false, reason) { outcomes[realtimeCleanupKeys.indexOf(key)] = failed ? reason === undefined ? "r" : "d" : "f"; },
    body(failed, reason) { boundary = { v: 1, kind: "realtime_boundary", case: caseId, operation, failurePresent: failed, reasonDefined: failed ? reason !== undefined : null, unreportedCases: 0 }; },
    flush() {
      if (flushed) return []; flushed = true;
      if (boundary) try { deliver(realtimeDiagnosticText(boundary)); } catch (error) { reporting.push(error); }
      try { deliver(realtimeDiagnosticText({ v: 1, kind: "realtime_cleanup", case: caseId, registered, outcomes: outcomes.join(""), recorderFailures: Math.min(1000000, reporting.length), recorderFirstDefined: reporting.length ? reporting[0] !== undefined : null, unreportedCases: 0 })); } catch (error) { reporting.push(error); }
      return [...reporting];
    },
    isRegistered: () => registered,
    failures: () => [...reporting],
    finishUnregistered(primaryPresent, primary) {
      if (registered) return;
      const errors = ledger.flush();
      if (!errors.length) return;
      if (primaryPresent) throw new AggregateError([primary, ...errors], "realtime body and reporting failed");
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "realtime reporting failed");
    },
  };
  return ledger;
}
// END realtime diagnostics.
