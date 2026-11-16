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
  let step = 0, failedStep = -1, worker = null, upstream = null, relational = null, observation = null, producer = null, postlude = null;
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
          const ledger = own(value, "ledger").value, original = own(ledger, "10");
          const retained = own(ledger, "11"); if (retained.present) { relational = retained.value; observation = value; }
          if (original.present) { const decoded = decodeWorkerAbortOperation(original.value); if (!decoded) throw new Error("invalid original operation projection"); worker.push(decoded); }
        } else if (stage === 16) {
          const calls = own(value, "calls").value;
          producer = closedDiagnosticTuple(own(value, "producer").value, 5, x => x === null || count(x) !== null);
          upstream = [Array.isArray(calls) && !types.isProxy(calls) ? count(calls.length) : null,
            ...["active", "canceled", "aborted", "expired", "finished"].map(key => count(own(value, key).value))];
        } else throw new Error("invalid diagnostic stage");
      });
    },
    postlude(value) { attempt(() => { const closed=decodeWorkerPostludeNode(value); if(!closed)throw new Error("invalid postlude projection"); postlude=closed; }); },
    report(context) {
      attempt(() => {
        if (relational !== null) {
          const frames = attempt(() => {
            const parts = buildWorkerAbortParts(relational, observation, first, [failures, undefinedFailures, reporting.length], worker?.[2] ?? null, worker?.[0] ?? null, upstream, producer, postlude);
            if (!validateWorkerAbortGroup(parts)) return null;
            return parts.map(part => (part.v === 3 ? workerAbortRelationalPrefixV3 : workerAbortRelationalPrefix) + JSON.stringify(part));
          });
          if (frames) {
            for (const frame of frames) context.diagnostic(frame);
            return;
          }
        }
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

// v1: association is to the captured comparison and later ledger row only.
// Error presence and definedness are independent; null never means fulfillment.
export function decodeWorkerAbortOperation(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
  const fields = closedDiagnosticTuple(value, 7, () => true);
  if (!fields || fields[0] !== 1 || ![null, false, true].includes(fields[1])
    || !(fields[2] === null || [0, 2, 3].includes(fields[2])) || !count(fields[4]) || !count(fields[5])
    || !(fields[6] === null || count(fields[6]) && fields[6] > 0)) return null;
  let row = null;
  if (fields[3] !== null) {
    row = closedDiagnosticTuple(fields[3], 10, (x, i) => i === 6 ? typeof x === "boolean" : i === 7 ? x === null || typeof x === "boolean"
      : [3, 4, 5, 9].includes(i) ? x === null || count(x) : count(x));
    if (!row || row[1] > 10 || ![0, 2, 3].includes(row[2]) || row[2] !== fields[2]
      || (row[6] ? typeof row[7] !== "boolean" : row[7] !== null)
      || fields[1] !== true || fields[6] === null || row[3] === null || row[3] === 0) return null;
  }
  if (fields[1] === true && row === null || fields[1] !== true && (row !== null || fields[6] !== null)
    || fields[1] === null && fields[2] !== null || fields[1] !== null && fields[2] === null) return null;
  return [1, fields[1], fields[2], row, fields[4], fields[5], fields[6]];
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
    const value = get("worker"), width = own(value, "length").value;
    const fields = [3, 4].includes(width) ? closedDiagnosticTuple(value, width, (x, i) => i >= 2 || x === null || count(x)) : null;
    if (!fields) return null;
    const checks = fields[2] === null ? null : closedDiagnosticTuple(fields[2], 5, x => x === null || typeof x === "boolean" || count(x));
    if (fields[2] !== null && !checks) return null;
    worker = [fields[0], fields[1], checks];
    if (fields.length === 4) { const original = decodeWorkerAbortOperation(fields[3]); if (!original) return null; worker.push(original); }
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

// Bifrost Worker evidence is opt-in and reports only source-owned boundaries.
// A stage is not an error cause, native retirement proof or accounting success.
export const bifrostWorkerPrefix = "BIFROST_WORKER_STAGE_V1 ";
export const bifrostWorkerStages = Object.freeze([
  "fixture", "setup", "request", "response_body", "response_record", "response_status",
  "no_publication", "join", "retirement", "accounting", "producer_state", "request_ownership",
  "close", "calls", "canceled", "settled", "expired",
]);
export function bifrostWorkerEvidence() {
  let stage = 1, first = null, failures = 0, undefinedFailures = 0;
  const reporting = [];
  const attempt = fn => { try { return fn(); } catch (error) { reporting.push(error); } };
  const failed = error => attempt(() => {
    failures = Math.min(limit, failures + 1);
    if (error === undefined) undefinedFailures = Math.min(limit, undefinedFailures + 1);
    first ??= [stage, true, error !== undefined];
  });
  return {
    stage(value) { attempt(() => {
      if (!Number.isInteger(value) || value < 1 || value > bifrostWorkerStages.length) throw new Error("invalid Bifrost boundary");
      stage = value;
    }); },
    failed,
    escaping(error) { if (failures === 0) failed(error); },
    report(context) {
      if (failures || reporting.length) attempt(() => {
        const record = { v: 1, kind: "bifrost_worker_stage", first, counts: [failures, undefinedFailures, Math.min(limit, reporting.length)] };
        if (!decodeBifrostWorkerDiagnostic(record)) throw new Error("invalid Bifrost diagnostic");
        context.diagnostic(bifrostWorkerPrefix + JSON.stringify(record));
      });
      return reporting.slice();
    },
  };
}
export function decodeBifrostWorkerDiagnostic(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  const keys = ["v", "kind", "first", "counts"];
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => own(value, key).present)
    || own(value, "v").value !== 1 || own(value, "kind").value !== "bifrost_worker_stage") return null;
  const counts = closedDiagnosticTuple(own(value, "counts").value, 3, n => Number.isSafeInteger(n) && n >= 0 && n <= limit);
  const raw = own(value, "first").value;
  const first = raw === null ? null : closedDiagnosticTuple(raw, 3, (x, i) => i === 0
    ? Number.isInteger(x) && x >= 1 && x <= bifrostWorkerStages.length : i === 1 ? x === true : typeof x === "boolean");
  if (!counts || counts[1] > counts[0] || (raw !== null && !first) || (counts[0] === 0) !== (first === null)
    || first && (first[2] ? counts[0] !== limit && counts[1] === counts[0] : counts[1] === 0)) return null;
  return { v: 1, kind: "bifrost_worker_stage", first, counts };
}
export function parseBifrostWorkerDiagnostic(payload) { return parseCanonicalWorkerRecord(payload, decodeBifrostWorkerDiagnostic); }

// Fixed semantic components. Payload references are consistency checks, never
// authority for a native case. The reporter binds every part independently.
export const workerAbortParts = Object.freeze(["retire", "bad_a", "bad_b", "resource", "relations", "signals", "abort", "coverage"]);
export const workerAbortRelationalPrefix = "LITELLM_WORKER_ABORT_V2 ";
export const workerAbortRelationalPrefixV3 = "LITELLM_WORKER_ABORT_V3 ";
export function decodeWorkerPostludeRouter(value) {
  if(value===null)return null;
  const n=x=>Number.isSafeInteger(x)&&x>=0&&x<=limit,b=x=>typeof x==="boolean",optional=x=>x===null||b(x);
  const d=closedDiagnosticTuple(value,19,()=>true);
  if(!d||d[0]!==1||![1,2,3,4,9,11,17,18].every(i=>n(d[i]))||![5,6,7,8,13,15,16].every(i=>b(d[i]))
    ||![10,12].every(i=>optional(d[i]))||!(d[14]===null||n(d[14])&&d[14]<=15)||d[1]>63||d[2]>63||(d[2]&~d[1])||!d[5]
    ||d[9]>3||d[11]>4||(d[9]===3)!==(d[10]!==null)||(d[11]===3)!==(d[12]!==null)||d[18]>d[17]
    ||d[13]!== (d[11]===2)||d[13]!== (d[14]!==null)||d[15]!== (d[11]===3)||d[16]!==!!(d[1]&32)
    ||!d[8]&&(d[9]!==0||d[11]!==0)||d[7]&&(d[1]!==d[2]||d[3]!==d[4]||d[17]!==0))return null;
  return d;
}
export function decodeWorkerPostludeNode(value) {
  if(value===null)return null;
  const n=x=>Number.isSafeInteger(x)&&x>=0&&x<=limit,b=x=>typeof x==="boolean";
  const d=closedDiagnosticTuple(value,13,()=>true);
  if(!d||d[0]!==1||d[1]!==true||!b(d[2])||![3,5,11,12].every(i=>n(d[i]))||d[3]>3||d[5]>3
    ||![4,6,10].every(i=>d[i]===null||b(d[i]))||![7,8,9].every(i=>d[i]===null||n(d[i]))||d[12]>d[11]
    ||(d[3]===3)!==(d[4]!==null)||(d[5]===3)!==(d[6]!==null)
    ||d[3]!==2&&[7,8,9,10].some(i=>d[i]!==null)||d[10]===true&&(d[7]===null||d[7]<1||d[8]!==2*d[7]||d[9]!==0))return null;
  return d;
}
// Completeness of this diagnostic cohort is not retirement/accounting success.
export function workerAbortPostludeCoverage(parts) {
  const ordered=validateWorkerAbortGroup(parts);if(!ordered||ordered[0].v!==3)return false;
  const r=ordered[0].data[5],n=ordered[7].data[17];
  return !!r&&!!n&&r[7]&&r[1]===63&&r[2]===63&&r[8]&&r[9]===3&&[2,3].includes(r[11])&&r[16]
    &&[2,3].includes(n[3])&&n[5]===3&&n[11]===0;
}
function relationData(part, data, version = 2) {
  const n = x => Number.isSafeInteger(x) && x >= 0 && x <= limit;
  const optional = x => x === null || n(x), boolean = x => x === null || typeof x === "boolean";
  const tuple = (x, size, check = () => true) => closedDiagnosticTuple(x, size, check);
  const pair = x => { const p = tuple(x, 2, (v, i) => i ? boolean(v) : typeof v === "boolean"); return p && (p[0] || p[1] === null) ? p : null; };
  if (data === null && ["resource", "relations"].includes(part)) return null;
  let d;
  if (part === "retire") {
    d = tuple(data, version===3?6:5); if (!d) return undefined;
    const stage = d[0] === null ? null : tuple(d[0], 3, (v, i) => i === 0 ? n(v) && v >= 1 && v <= 24 : i === 1 ? v === 0 || v === 1 : typeof v === "boolean");
    const counts = tuple(d[1], 3, n), checks = d[2] === null ? null : tuple(d[2], 5, v => boolean(v) || n(v));
    if (d[0] !== null && !stage || !counts || counts[1] > counts[0] || d[2] !== null && !checks || !optional(d[3]) || ![null, 0, 2, 3].includes(d[4])) return undefined;
    if(version===3){const post=d[5]===null?null:decodeWorkerPostludeRouter(d[5]);if(d[5]!==null&&!post)return undefined;return [stage,counts,checks,d[3],d[4],post];}
    return [stage, counts, checks, d[3], d[4]];
  }
  if (part === "bad_a" || part === "bad_b") {
    d = tuple(data, 2); if (!d) return undefined;
    const rows = d.map(x => x === null ? null : tuple(x, 11, (v, i) => i === 7 ? typeof v === "boolean" : i === 8 ? boolean(v) : [3,4,5,6,10].includes(i) ? optional(v) : n(v)));
    if (rows.some((row, i) => d[i] !== null && (!row || row[1] > 10 || ![0,2,3].includes(row[2]) || (row[7] ? typeof row[8] !== "boolean" : row[8] !== null)))) return undefined;
    return rows;
  }
  if (part === "resource") {
    d = tuple(data, 7); if (!d || !n(d[0]) || d[0] > 63 || typeof d[5] !== "boolean" || typeof d[6] !== "boolean") return undefined;
    const rows = d.slice(1,5).map(x => x === null ? null : tuple(x, 5, optional));
    if (rows.some((row, i) => d[i+1] !== null && (!row || !n(row[0]) || ![0,1,2,3].includes(row[1]) || !n(row[2]) || row[2] > 7 || (row[2]&6) && !(row[2]&1) || row[2]&4 && !(row[2]&2)))) return undefined;
    return [d[0], ...rows, d[5], d[6]];
  }
  if (part === "relations") {
    d = tuple(data, 18, (v, i) => i < 2 ? n(v) && v <= 63 : i >= 13 && i <= 16 ? optional(v) : boolean(v));
    return d && (d[1] & ~d[0]) === 0 ? d : undefined;
  }
  if (part === "signals") {
    d = tuple(data, 4); if (!d) return undefined;
    const rows = d.map(x => { if (x === null) return null; const row = tuple(x,7); if (!row || !n(row[0])) return undefined;
      const pairs = [pair(row.slice(1,3)),pair(row.slice(3,5)),pair(row.slice(5,7))]; return pairs.every(Boolean) ? [row[0],...pairs.flat()] : undefined; });
    return rows.some(x => x === undefined) ? undefined : rows;
  }
  if (part === "abort") {
    d = tuple(data,11); if (!d || ![0,2,4,6].every(i => typeof d[i] === "boolean") || ![1,7,9].every(i => optional(d[i])) || ![3,5,10].every(i => boolean(d[i]))) return undefined;
    const size = own(d[8],"length").value, rows = Number.isInteger(size) && size >= 0 && size <= 4 ? tuple(d[8],size) : null;
    const refs = rows?.map(x => tuple(x,2,optional));
    if (!refs || refs.some(x => !x) || !d[0] && d[1] !== null || !d[2] && d[3] !== null || !d[4] && d[5] !== null
      || !d[6] && (d[7] !== null || refs.length || d[9] !== null || d[10] !== null)
      || d[7] !== null && (d[9] === null || d[7] !== refs.length+d[9])) return undefined;
    return [...d.slice(0,8),refs,...d.slice(9)];
  }
  if (part === "coverage") {
    d = tuple(data,19); if (!d || !d.slice(0,12).every((v,i) => i === 3 ? typeof v === "boolean" : optional(v)) || typeof d[12] !== "boolean") return undefined;
    const states = d.slice(13,16).map(pair), producer = d[16] === null ? null : tuple(d[16],5,optional), upstream = d[18] === null ? null : tuple(d[18],6,optional);
    const post=version===3&&d[17]!==null?decodeWorkerPostludeNode(d[17]):null;
    if (states.some(x => !x) || d[16] !== null && !producer || d[17] !== null && !post || d[18] !== null && !upstream) return undefined;
    return [...d.slice(0,13),...states,producer,post,upstream];
  }
  return undefined;
}
export function decodeWorkerAbortPart(record) {
  const keys=["v","kind","part","ref","data"];
  if (!record || typeof record !== "object" || types.isProxy(record) || Reflect.ownKeys(record).length !== keys.length || keys.some(k=>!own(record,k).present)
    || ![2,3].includes(own(record,"v").value) || own(record,"kind").value !== "worker_abort_part") return null;
  const part=own(record,"part").value, ref=closedDiagnosticTuple(own(record,"ref").value,5,v=>v===null||Number.isSafeInteger(v)&&v>=0&&v<=limit);
  if (!workerAbortParts.includes(part)||!ref) return null;
  const data=relationData(part,own(record,"data").value,own(record,"v").value); if(data===undefined)return null;
  const result={v:own(record,"v").value,kind:"worker_abort_part",part,ref,data};return Buffer.byteLength(JSON.stringify(result))<=512?result:null;
}
export function parseWorkerAbortPart(payload) { return parseCanonicalWorkerRecord(payload,decodeWorkerAbortPart); }
function validateWorkerAbortGroupV2(parts) {
  if (!Array.isArray(parts)||types.isProxy(parts)||parts.length!==8)return null;
  const decoded=closedDiagnosticTuple(parts,8,()=>true)?.map(decodeWorkerAbortPart);
  if(!decoded||decoded.some(x=>!x)||new Set(decoded.map(x=>x.part)).size!==8)return null;
  const ordered=workerAbortParts.map(name=>decoded.find(x=>x.part===name)),ref=ordered[0].ref;
  if(ref.some((v,i)=>!Number.isSafeInteger(v)||v<(i===4?0:1))||ordered.some(x=>!sameStrings(x.ref,ref)))return null;
  const [retire,a,b,resource,relations,signals,abort,coverage]=ordered.map(x=>x.data),rows=[...a,...b];
  if(rows.some(x=>!x)||new Set(rows.map(x=>x[0])).size!==4||coverage[0]!==4||coverage[1]!==4||coverage[2]!==0||coverage[3]||!coverage[12]
    ||rows.some(row=>row[3]!==ref[0]||row[4]!==ref[1]||row[5]!==null&&row[5]!==ref[2]||row[6]!==null&&row[6]!==ref[3])
    ||rows.some((row,i)=>i&&row[0]<=rows[i-1][0])||rows[0][0]!==ref[4]||![0,2,3].includes(retire[4])
    ||!resource||!relations||resource.slice(1,5).some(x=>!x)||!resource[5]||!resource[6]||resource[3][0]!==ref[4]
    ||signals.some((row,i)=>!row||row[0]!==rows[i][0])
    ||rows.some(row=>row[2]===0 ? row[7]||row[10]!==null : !row[7]||row[10]===null))return null;
  const total = retire[3], ordinal = id => Number.isSafeInteger(id) && id >= 0 && id < total;
  const sequence = (state, errorPresent, invoke, settle) => Number.isSafeInteger(invoke) && invoke > 0
    && (state === 0 ? !errorPresent && settle === null : Number.isSafeInteger(settle) && settle > invoke
      && (state === 1 ? !errorPresent : errorPresent));
  if(!Number.isSafeInteger(total)||total<4||!ordinal(ref[4])
    ||!(rows[0][2]===retire[4]||retire[4]===0&&rows[0][2]===2)
    ||coverage[4]!==rows.filter(row=>row[2]===0).length
    ||rows.some(row=>!ordinal(row[0])||row[1]<1||row[1]>10||!sequence(row[2],row[7],row[9],row[10])
      ||[2,3,4,5,6,7,8].includes(row[1])&&row[5]!==ref[2]
      ||[4,5,6,7].includes(row[1])&&row[6]!==ref[3]||row[6]!==null&&row[5]===null)
    ||resource.slice(1,5).some(row=>!ordinal(row[0])||!sequence(row[1],!!(row[2]&1),row[3],row[4]))
    ||abort[8].some(row=>!ordinal(row[0])))return null;
  // One ordinal names one original record. Cross-part aliases may repeat that
  // record's facts; distinct records cannot reuse its invocation/observer clock.
  const operations = new Map(rows.map(row=>[row[0],{kind:row[1],state:row[2],invoke:row[9],settle:row[10]}]));
  // Check every shared ordinal, not a guessed list of four failing kinds.
  for(let i=0;i<4;i++){
    const role=resource[i+1], bad=rows.find(row=>row[0]===role[0]);
    if(!bad){if(role[1]!==1)return null;operations.set(role[0],{kind:[4,5,6,7][i],state:role[1],invoke:role[3],settle:role[4]});continue;}
    const expectedKind=[4,5,6,7][i];
    if(bad[1]!==expectedKind||bad[2]!==role[1]||bad[5]!==ref[2]||bad[6]!==ref[3]||bad[9]!==role[3]||bad[10]!==role[4]
      ||bad[7]!==!!(role[2]&1)||bad[8]!==((role[2]&1)?!!(role[2]&2):null))return null;
  }
  const clocks = new Set();
  for(const op of operations.values())for(const clock of [op.invoke,op.settle]){
    if(clock===null)continue;if(clocks.has(clock))return null;clocks.add(clock);
  }
  if(abort[6]&&(abort[7]!==abort[8].length||abort[9]!==0)
    ||abort[8].some(row=>{const op=operations.get(row[0]);return op&&(op.kind!==4
      ||abort[0]&&abort[1]!==null&&(op.invoke>=abort[1]||op.settle!==null&&op.settle<=abort[1]));}))return null;
  if(new Set(resource.slice(1,5).map(x=>x[0])).size!==4||resource[0]!==63||rows[0][1]!==6
    ||relations[0]!==63||new Set(abort[8].map(row=>row[0])).size!==abort[8].length||abort[8].some(row=>row[0]===null||row[1]!==ref[3])||abort[9]>0||abort[6]&&abort[10]!==true)return null;
  return ordered;
}
// v2 remains the historical four-bad, closed-first contract. v3 is a complete
// one-to-four census, with a separately bound C0 and optional absent cancel.
export function validateWorkerAbortGroup(parts) {
  const decoded=closedDiagnosticTuple(parts,8,()=>true)?.map(decodeWorkerAbortPart);
  if(!decoded||decoded.some(x=>!x)||decoded.some(x=>x.v!==decoded[0].v))return null;
  return decoded[0].v===2?validateWorkerAbortGroupV2(decoded):validateWorkerAbortGroupV3(decoded);
}
function validateWorkerAbortGroupV3(parts) {
  if (!Array.isArray(parts)||types.isProxy(parts)||parts.length!==8)return null;
  const decoded=closedDiagnosticTuple(parts,8,()=>true)?.map(decodeWorkerAbortPart);
  if(!decoded||decoded.some(x=>!x)||new Set(decoded.map(x=>x.part)).size!==8)return null;
  const ordered=workerAbortParts.map(name=>decoded.find(x=>x.part===name)),ref=ordered[0].ref;
  if(ref.some((v,i)=>!Number.isSafeInteger(v)||v<(i===4?0:1))||ordered.some(x=>!sameStrings(x.ref,ref)))return null;
  const [retire,a,b,resource,relations,signals,abort,coverage]=ordered.map(x=>x.data),padded=[...a,...b],rows=padded.filter(x=>x!==null);
  if(rows.length<1||rows.length>4||padded.some((x,i)=>(i<rows.length)!==(x!==null))||new Set(rows.map(x=>x[0])).size!==rows.length||coverage[0]!==rows.length||coverage[1]!==rows.length||coverage[2]!==0||coverage[3]||!coverage[12]
    ||rows.some(row=>row[3]!==ref[0]||row[4]!==ref[1]||row[5]!==null&&row[5]!==ref[2]||row[6]!==null&&row[6]!==ref[3])
    ||rows.some((row,i)=>i&&row[0]<=rows[i-1][0])||rows[0][0]!==ref[4]||![0,2,3].includes(retire[4])
    ||!resource||!relations||resource.slice(1,4).some(x=>!x)||!resource[5]||!resource[6]||!resource.slice(1,5).some(x=>x?.[0]===ref[4])
    ||signals.some((row,i)=>i<rows.length ? !row||row[0]!==rows[i][0] : row!==null)
    ||rows.some(row=>row[2]===0 ? row[7]||row[10]!==null : !row[7]||row[10]===null))return null;
  const post=retire[5],node=coverage[17];
  if(post&&post[7]&&(post[3]<1||rows.some(row=>row[10]===null||row[10]>post[3])
      ||resource.slice(1,5).some(row=>row&&(row[1]===0||row[4]>post[3]))||coverage[4]!==0)
    ||node&&(!retire[0]||retire[0][0]!==14||retire[0][2]!==node[2]))return null;
  const total = retire[3], ordinal = id => Number.isSafeInteger(id) && id >= 0 && id < total;
  const sequence = (state, errorPresent, invoke, settle) => Number.isSafeInteger(invoke) && invoke > 0
    && (state === 0 ? !errorPresent && settle === null : Number.isSafeInteger(settle) && settle > invoke
      && (state === 1 ? !errorPresent : errorPresent));
  if(!Number.isSafeInteger(total)||total<rows.length||!ordinal(ref[4])
    ||!(rows[0][2]===retire[4]||retire[4]===0&&[2,3].includes(rows[0][2]))
    ||coverage[4]!==rows.filter(row=>row[2]===0).length
    ||rows.some(row=>!ordinal(row[0])||row[1]<1||row[1]>10||!sequence(row[2],row[7],row[9],row[10])
      ||[2,3,4,5,6,7,8].includes(row[1])&&row[5]!==ref[2]
      ||[4,5,6,7].includes(row[1])&&row[6]!==ref[3]||row[6]!==null&&row[5]===null)
    ||resource.slice(1,5).some(row=>row!==null&&(!ordinal(row[0])||!sequence(row[1],!!(row[2]&1),row[3],row[4])))
    ||abort[8].some(row=>!ordinal(row[0])))return null;
  // One ordinal names one original record. Cross-part aliases may repeat that
  // record's facts; distinct records cannot reuse its invocation/observer clock.
  const operations = new Map(rows.map(row=>[row[0],{kind:row[1],state:row[2],invoke:row[9],settle:row[10]}]));
  // Check every shared ordinal, not a guessed list of four failing kinds.
  for(let i=0;i<4;i++){
    const role=resource[i+1];if(role===null)continue;const bad=rows.find(row=>row[0]===role[0]);
    if(!bad){if(role[1]!==1)return null;operations.set(role[0],{kind:[4,5,6,7][i],state:role[1],invoke:role[3],settle:role[4]});continue;}
    const expectedKind=[4,5,6,7][i];
    if(bad[1]!==expectedKind||bad[2]!==role[1]||bad[5]!==ref[2]||bad[6]!==ref[3]||bad[9]!==role[3]||bad[10]!==role[4]
      ||bad[7]!==!!(role[2]&1)||bad[8]!==((role[2]&1)?!!(role[2]&2):null))return null;
  }
  const clocks = new Set();
  for(const op of operations.values())for(const clock of [op.invoke,op.settle]){
    if(clock===null)continue;if(clocks.has(clock))return null;clocks.add(clock);
  }
  if(abort[6]&&(abort[7]!==abort[8].length||abort[9]!==0)
    ||abort[8].some(row=>{const op=operations.get(row[0]);return op&&(op.kind!==4
      ||abort[0]&&abort[1]!==null&&(op.invoke>=abort[1]||op.settle!==null&&op.settle<=abort[1]));}))return null;
  const roles=resource.slice(1,5).filter(Boolean),known=resource[4]===null?11:63;
  if(rows.some(row=>row[1]===7&&(resource[4]===null||row[0]!==resource[4][0])))return null;
  if(new Set(roles.map(x=>x[0])).size!==roles.length||resource[0]!==63
    ||relations[0]!==known||relations[1]!==0
    ||resource[4]===null&&(relations[13]!==null||[4,5,6,7,8,12].some(i=>relations[i]!==null))||new Set(abort[8].map(row=>row[0])).size!==abort[8].length||abort[8].some(row=>row[0]===null||row[1]!==ref[3])||abort[9]>0||abort[6]&&abort[10]!==true)return null;
  return ordered;
}
function buildWorkerAbortParts(source, observation, first, counts, checks, operations, upstream, producer, postlude = null) {
  const get=k=>own(source,k).value, ref=get("ref"), tuple=(v,n)=>closedDiagnosticTuple(v,n,()=>true);
  const size=own(get("rows"),"length").value, rows=Number.isInteger(size)&&size<=4?tuple(get("rows"),size):null;
  const signalSize=own(get("signals"),"length").value, signals=signalSize===size?tuple(get("signals"),size):null;
  const coverage=tuple(get("coverage"),12),positions=tuple(get("positions"),3);
  if(own(source,"v").value!==2||!rows||!signals||!coverage||!positions)throw new Error("invalid retained relation source");
  const state=(key,index,field)=>{const list=own(observation,key).value,n=own(list,"length").value;
    if(!Array.isArray(list)||types.isProxy(list)||!Number.isInteger(index)||index<0||index>=n)return [false,null];
    const item=own(list,String(index)),stored=field?own(item.value,field):item;
    return [stored.present,typeof stored.value==="boolean"?stored.value:null];};
  const associated=get("associated")===true&&own(own(observation,"ingress").value,"length").value===coverage[9]
    &&own(own(observation,"inputs").value,"length").value===coverage[10]&&own(own(observation,"readers").value,"length").value===coverage[11];
  const parts=[ [first,counts,checks,operations,own(own(own(observation,"ledger").value,"10").value,"2").value??null],
    [rows[0]??null,rows[1]??null],[rows[2]??null,rows[3]??null],get("resource"),get("relations"),
    [signals[0]??null,signals[1]??null,signals[2]??null,signals[3]??null],get("abort"),
    [...coverage,associated,state("ingress",positions[0]),state("inputs",positions[1],"signalAborted"),state("readers",positions[2],"locked"),producer,null,upstream] ];
  const records=workerAbortParts.map((part,i)=>{const result=decodeWorkerAbortPart({v:2,kind:"worker_abort_part",part,ref,data:parts[i]});if(!result)throw new Error("invalid relational component");return result;});
  const router=own(observation,"postlude").value??null;
  if(router===null&&postlude===null&&validateWorkerAbortGroupV2(records))return records;
  return records.map(record=>({...record,v:3,data:record.part==="retire"?[...record.data,router]
    :record.part==="coverage"?record.data.map((v,i)=>i===17?postlude:v):record.data}));
}

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
export function workerAbortAdmission(tracked, invocation, bifrost = false) {
  // Two fixed source targets share the same full-stream ownership census.
  const targetFile = bifrost ? "worker/test/bifrost-model-discovery.test.mjs" : "worker/test/litellm-model-discovery.test.mjs";
  const targetName = bifrost ? "Bifrost shipping 30-second deadline cancels an incomplete original response without publication"
    : "owned HTTP/1 reset propagates real metadata ingress cancellation and strict retirement";
  if (bifrost && !invocation?.files.includes(targetFile)) invocation = null;
  const wrappers = new Map(), parentIds = new Map(), ids = new Map(), coordinates = new Map(), diagnostics = [];
  const expected = new Set(invocation?.files ?? []);
  let census = 0, childEvents = 0, overflow = false, recognized = 0, rejected = 0, targetFailure = null;
  let parentInvalid = false, childInvalid = false, diagnosticInvalid = false, relationalSeen = false, first = null, evaluated = 0, failed = 0, phase = 0;
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
      if (type === "test:diagnostic" && (typeof message !== "string" || (bifrost ? !message.startsWith(bifrostWorkerPrefix) : !message.startsWith(workerAbortPrefix) && !message.startsWith(workerAbortRelationalPrefix) && !message.startsWith(workerAbortRelationalPrefixV3)))) return;
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
        const relationalVersion = message.startsWith(workerAbortRelationalPrefixV3)?3:message.startsWith(workerAbortRelationalPrefix)?2:null;
        const relational = relationalVersion !== null; relationalSeen ||= relational;
        const record = bifrost ? parseBifrostWorkerDiagnostic(message.slice(bifrostWorkerPrefix.length)) : relational ? parseWorkerAbortPart(message.slice((relationalVersion===3?workerAbortRelationalPrefixV3:workerAbortRelationalPrefix).length)) : parseWorkerAbortDiagnostic(message.slice(workerAbortPrefix.length));
        if (relational && record?.v !== relationalVersion) { rejected = Math.min(limit, rejected + 1); gate(18, false); return; }
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
      let partMask = 0, duplicateMask = 0;
      for (const candidate of diagnostics) if ([2,3].includes(candidate.record.v)) {
        const bit = 2 ** workerAbortParts.indexOf(candidate.record.part); if (partMask & bit) duplicateMask |= bit; partMask |= bit;
      }
      const group = relationalSeen ? validateWorkerAbortGroup(matches.map(x => x.record)) : null;
      const groupMismatch = relationalSeen && (!group || duplicateMask !== 0 || matches.length !== 8 || diagnostics.length !== 8);
      bound = gate(25, (relationalSeen ? !groupMismatch : matches.length === 1 && diagnostics.length === 1)
        && rejected === 0 && !diagnosticInvalid) && bound;
      let record = null, records = [];
      if (bound && relationalSeen) {
        records = group.map(part => ({ v: part.v, kind: "worker_abort_relation", at: row.at, part: part.part, ref: part.ref, data: part.data }));
        if (!gate(26, records.every(value => decodeWorkerReporterRecord(value) !== null))) records = [];
      } else if (bound) {
        const data = matches[0].record;
        record = bifrost ? { v: 1, kind: "bifrost_worker", at: row.at, first: data.first, counts: data.counts }
          : { v: 1, kind: "worker_abort", at: row.at, stage: data.first,
            counts: [data.failures, data.undefinedFailures, data.reportingFailures], worker: data.worker, upstream: data.upstream };
        if (!gate(26, Buffer.byteLength(JSON.stringify(record)) <= 512)) record = null;
      }
      const admitted = record !== null || records.length === 8;
      if (!bifrost && !admitted && recognized) {
        record = { v: 1, kind: "worker_abort_unbound", reason: first?.reason ?? null, gates: first?.gates ?? [0, 0], fields: first?.fields ?? [0, 0, 0],
          census: [expected.size, wrappers.size, childEvents, ids.size, rows.length, matches.length],
          scope: [Boolean(invocation), !parentInvalid, Boolean(complete), !childInvalid, true] };
      }
      return { failure: recognized ? row?.failure ?? targetFailure : null, record, records,
        diagnostics: !relationalSeen && recognized ? [recognized, admitted ? 1 : 0, rejected, recognized - rejected - (admitted ? 1 : 0), overflow] : null,
        relational: relationalSeen ? [recognized, records.length, rejected, recognized - rejected - records.length, overflow, partMask, 255 ^ partMask, duplicateMask, groupMismatch] : null };

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
  const bf = own(value, "bifrostDiagnostics");
  if (get("kind") === "summary" && bf.present) {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !own(value, key).present)) return null;
    const base = decodeWorkerReporterRecord(Object.fromEntries(keys.filter(key => key !== "bifrostDiagnostics").map(key => [key, get(key)])));
    const counts = closedDiagnosticTuple(bf.value, 5, (x, i) => i === 4 ? typeof x === "boolean" : count(x));
    if (!base || !counts || counts[1] > 1 || counts[0] !== counts[1] + counts[2] + counts[3]) return null;
    const result = { ...base, bifrostDiagnostics: counts };
    return Buffer.byteLength(JSON.stringify(result)) <= 512 ? result : null;
  }
  if ([2,3].includes(get("v"))) {
    let result;
    if (get("kind") === "worker_abort_relation") {
      if (!exact(["v","kind","at","part","ref","data"])) return null;
      const at = closedDiagnosticTuple(get("at"),4,(v,i)=>i===0?v==="worker/test/litellm-model-discovery.test.mjs":count(v)&&(i===3||v>0));
      const part = decodeWorkerAbortPart({v:get("v"),kind:"worker_abort_part",part:get("part"),ref:get("ref"),data:get("data")});
      if(!at||!part)return null;
      result={v:part.v,kind:"worker_abort_relation",at,part:part.part,ref:part.ref,data:part.data};
    } else if(get("v")===2&&get("kind")==="summary") {
      const keys=["v","kind","failureEvents","reported","omittedEvents","unknownFiles","countsSaturated","relational"];
      if(!exact(keys))return null;
      const old=decodeWorkerReporterRecord(Object.fromEntries(keys.slice(0,-1).map(k=>[k,k==="v"?1:get(k)])));
      const r=closedDiagnosticTuple(get("relational"),9,(v,i)=>[4,8].includes(i)?typeof v==="boolean":count(v));
      if(!old||!r||![0,8].includes(r[1])||r[0]!==r[1]+r[2]+r[3]||r.slice(5,8).some(v=>v>255)||r[6] !== (255 ^ r[5])
        ||(r[7]&~r[5])!==0||r[1]===8&&(r[4]||r[5]!==255||r[6]||r[7]||r[8]))return null;
      result={...old,v:2,relational:r};
    } else return null;
    return Buffer.byteLength(JSON.stringify(result))<=512?result:null;
  }
  if (get("v") !== 1) return null;
  let result;
  if (get("kind") === "failure") {
    const keys = ["v", "kind", "file", "line", "failureType", "errorClass", "code"], file = get("file"), line = get("line");
    if (!exact(keys) || !(file === null || typeof file === "string" && file.length <= 240 && filePattern.test(file))
      || !(line === null || file !== null && count(line) && line > 0)
      || ![...failureTypes, "unknown"].includes(get("failureType")) || ![...codes, "unknown"].includes(get("code"))
      || !["missing", "undefined", "null", "native_error", "unknown"].includes(get("errorClass"))) return null;
    result = Object.fromEntries(keys.map(key => [key, get(key)]));
  } else if (get("kind") === "bifrost_worker") {
    if (!exact(["v", "kind", "at", "first", "counts"])) return null;
    const at = closedDiagnosticTuple(get("at"), 4, (x, i) => i === 0 ? x === "worker/test/bifrost-model-discovery.test.mjs" : count(x) && (i === 3 || x > 0));
    const data = decodeBifrostWorkerDiagnostic({ v: 1, kind: "bifrost_worker_stage", first: get("first"), counts: get("counts") });
    if (!at || !data) return null;
    result = { v: 1, kind: "bifrost_worker", at, first: data.first, counts: data.counts };
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

// Whole-pair decoder. The caller must derive the declaration line from the
// exact bound source; this function never assigns native ownership from payloads.
export function decodeBifrostWorkerGroup(records, declarationLine) {
  if (!Array.isArray(records) || types.isProxy(records) || records.length > 10 || !Number.isSafeInteger(declarationLine) || declarationLine < 1) return null;
  const rows = closedDiagnosticTuple(records, records.length, () => true)?.map(decodeWorkerReporterRecord);
  if (!rows || rows.some(row => !row) || new Set(rows.map(row => JSON.stringify(row))).size !== rows.length) return null;
  const summaries = rows.filter(row => row.kind === "summary"), stages = rows.filter(row => row.kind === "bifrost_worker");
  if (summaries.length !== 1 || stages.length !== 1 || JSON.stringify(summaries[0].bifrostDiagnostics) !== "[1,1,0,0,false]") return null;
  const stage = stages[0], matches = rows.filter(row => row.kind === "failure" && row.file === stage.at[0] && row.line === declarationLine);
  if (stage.at[1] !== declarationLine || matches.length !== 1 || rows.filter(row => row.kind === "failure").length !== summaries[0].reported
    || rows.length - 1 > 9 || rows.reduce((n, row) => n + Buffer.byteLength(annotation(row, "error")), 0) > 8192) return null;
  return { failure: matches[0], diagnostic: stage, summary: summaries[0] };
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
  const invocation = workerAbortInvocation(process, cwd);
  const admission = workerAbortAdmission(tracked, invocation), bifrost = workerAbortAdmission(tracked, invocation, true);
  let failures = 0, unknownFiles = 0;
  for await (const event of source) {
    admission.observe(event); bifrost.observe(event);
    if (own(event, "type").value !== "test:fail") continue;
    failures = Math.min(limit, failures + 1);
    const record = failureRecord(own(event, "data").value, tracked);
    if (record.file === null) unknownFiles = Math.min(limit, unknownFiles + 1);
    const bucket = record.failureType === "subtestsFailed" ? parents : leaves;
    const key = JSON.stringify(record);
    if (bucket.has(key) || bucket.size < 9) bucket.set(key, record);
  }
  const evidence = admission.finish();
  const prioritized = [...(evidence.failure ? [evidence.failure] : []), ...(evidence.records.length ? evidence.records : evidence.record ? [evidence.record] : [])];
  const bf = bifrost.finish();
  // Preserve the existing LiteLLM group. Reserve the complete Bifrost pair before
  // optional identities only when both records fit; otherwise report it omitted.
  const pair = bf.record && bf.failure && prioritized.length <= 7 ? [bf.failure, bf.record] : [];
  const reserved = [...prioritized, ...pair], reservedKeys = new Set(reserved.map(record => JSON.stringify(record)));
  const selected = [...reserved, ...[...leaves.values(), ...parents.values()].filter(record => !reservedKeys.has(JSON.stringify(record)))].slice(0, 9);
  const identities = selected.filter(record => record.kind === "failure").length;
  // Construct every command before yielding. A relational group is all eight or
  // none; native failure identities and the summary never depend on its validity.
  const summary = { v: evidence.relational ? 2 : 1, kind: "summary", failureEvents: failures, reported: identities,
    omittedEvents: Math.max(0, failures - identities), unknownFiles, countsSaturated: failures === limit,
    ...(evidence.diagnostics ? { diagnostics: evidence.diagnostics } : {}), ...(evidence.relational ? { relational: evidence.relational } : {}),
    ...(bf.diagnostics ? { bifrostDiagnostics: [bf.diagnostics[0], pair.length ? 1 : 0, bf.diagnostics[2], bf.diagnostics[0] - bf.diagnostics[2] - (pair.length ? 1 : 0), bf.diagnostics[4]] } : {}) };
  const commands = [...selected.map(record => annotation(record, "error")), annotation(summary, failures ? "error" : "notice")];
  if (commands.length > 10 || commands.reduce((n,line)=>n+Buffer.byteLength(line),0)>8192) throw new Error("worker diagnostic group exceeds quota");
  for (const command of commands) yield command;
}

export default workerFailureReport;
