import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import vm from "node:vm";

const helperSource = readFileSync(new URL("./helpers/http-deadline.mjs", import.meta.url), "utf8");
const entrySource = readFileSync(new URL("./http-deadline.test.mjs", import.meta.url), "utf8");
const reporterSource = readFileSync(new URL("../scripts/worker-test-failure-reporter.mjs", import.meta.url), "utf8");
const cleanupSource = readFileSync(new URL("./helpers/fixture-cleanup.mjs", import.meta.url), "utf8");
const scenarios = ["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json-pre-body-progress"];
const sites = [...entrySource.matchAll(/case "([^"]+)": await t\.test\("HTTP source site:/g)].map(match => match[1]);
const literalLines = new Map(entrySource.split("\n").flatMap((line, index) => {
  const match = /await t\.test\("(HTTP source (?:case|site): [^"]+)"/.exec(line);
  return match ? [[match[1], index + 1]] : [];
}));

function extracted(extra = {}, source = helperSource) {
  const core = source.slice(source.indexOf("export async function runHttpDeadlineCases"), source.indexOf("\nasync function until")).replace("export async function", "async function");
  const runtime = { assert, Object, Set, Reflect, AggregateError, ...extra };
  vm.createContext(runtime);
  vm.runInContext(core + "\nglobalThis.extracted = { runHttpDeadlineCases, httpDeadlineAttribution, httpDeadlineThrow, cleanupHttpDeadlineFixture };", runtime);
  return runtime.extracted;
}
function markerFunction() {
  return vm.runInNewContext(entrySource.slice(entrySource.indexOf("const httpDeadlineSentinel")) + "\nreportHttpDeadlineFailure", { Object, Error, AggregateError });
}
async function rejection(operation) {
  let present = false, reason;
  try { await operation(); } catch (error) { present = true; reason = error; }
  assert.equal(present, true);
  return reason;
}
function members(error) { return error instanceof AggregateError ? Array.from(error.errors).flatMap(members) : [error]; }

// This is an inert model of the original fixture interfaces, not a Worker or
// stream implementation. No product module, native process, socket or timer runs.
function fixtureModel(options = {}) {
  const trace = [], failures = [], markers = [], witnesses = [], pending = [];
  const occurrence = new Map(), finished = [];
  let scenario = null, now = 5_000, jsonValue = value => value;
  function effect(name, ...args) {
    trace.push([name, ...args]);
    const count = (occurrence.get(name) ?? 0) + 1; occurrence.set(name, count);
    for (const fault of options.faults ?? (options.fault ? [options.fault] : [])) {
      if (fault.name === name && count === (fault.at ?? 1)) throw fault.reason;
    }
  }
  function abortPending() {
    for (const item of pending.splice(0)) {
      if (item.signal.aborted) item.reject(options.invalidCancellation ? { name: "unrelated" } : item.signal.reason);
      else pending.push(item);
    }
  }
  class Controller {
    constructor() {
      effect("controller");
      this.signal = { aborted: false, reason: undefined, throwIfAborted() { if (this.aborted) throw this.reason; } };
    }
    abort(...args) {
      effect("abort", args.length);
      if (!this.signal.aborted) { this.signal.aborted = true; this.signal.reason = args[0] ?? new Error("synthetic default abort"); }
      abortPending();
    }
  }
  class Promises extends Promise {
    static all(values) { effect("promise.all"); return Promise.all(values); }
    static allSettled(values) {
      effect("promise.allSettled");
      const joined = Promise.allSettled(values);
      if (options.holdJoin) return joined.then(async value => { options.holdJoin.reached(); await options.holdJoin.promise; return value; });
      return joined;
    }
  }
  const signals = {
    timeout(ms) { effect("timeout", ms); return { aborted: false, reason: undefined }; },
    any(values) {
      effect("any", values.length);
      return { get aborted() { return values.some(value => value.aborted); }, get reason() { return values.find(value => value.aborted)?.reason; } };
    },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-11-16T00:00:00Z"])); }
    static now() { effect("now"); return now += 5; }
  }
  const canceled = () => scenario?.startsWith("cancel-");
  const timedOut = () => scenario === "headers" || scenario === "first-event";
  const state = () => ({ startedAt: 0, lastProgressAt: 2_000, progressCount: 50, complete: !canceled() && !timedOut(), aborted: canceled() || timedOut(), canceled: false, ...(scenario === "cancel-json-pre-body-progress" ? { firstPayloadAt: null } : {}) });
  const usage = () => ({ usage: { events: finished.map(name => ({ request_id: `deadline-${name}`, status: name === "headers" || name === "first-event" ? "timeout" : name.startsWith("cancel-") ? "client_error" : "success", status_code: name === "headers" || name === "first-event" ? 502 : 200, actual_cost_micros: 7, cost_basis: "policy_fixed", total_tokens: name.startsWith("cancel-") || name === "headers" || name === "first-event" ? null : 2 })), summary: { actualCostMicros: finished.length * 7 } } });
  function jsonResponse(value) {
    return { get status() { effect("observation.status"); return 200; }, async json() { effect("observation.json"); return jsonValue(value); } };
  }
  const kv = { async put(key, value) { effect("kv.put", key, value); } };
  const budgets = {
    idFromName(name) { effect("ledger.id", name); return name; },
    get(id) { effect("ledger.get", id); return { async fetch(url) {
      effect("ledger.fetch", url);
      return { async json() { effect("ledger.json"); return jsonValue(url.includes("fixture-reservations") ? finished.map(name => ({ reservation_id: `${id}-${name}`, settled: 1, dispatch_started: 1, reserved_micros: 7 })) : { spentMicros: finished.length * 7 }); } };
    } }; },
  };
  const mf = {
    async getKVNamespace(...args) { effect("kv.namespace", ...args); return kv; },
    async unsafeGetDirectURL(...args) { effect("direct.url", ...args); return { get origin() { effect("direct.origin"); return "https://fixture.invalid"; } }; },
    async getDurableObjectNamespace(...args) { effect("ledger.namespace", ...args); return budgets; },
    async dispose() { effect("dispose"); },
  };
  const fetch = async (url, init) => {
    effect("fetch", url.pathname, init.method ?? "GET");
    if (url.pathname === "/v1/usage") return jsonResponse(usage());
    if (url.pathname === "/fixture-state") return jsonResponse({ [scenario]: state() });
    if (url.pathname === "/fixture-ingress") return jsonResponse({ [`deadline-${scenario}`]: { abortedAt: 100_000 } });
    finished.push(scenario);
    let readCount = 0;
    const value = timedOut() ? '{"error":{"code":"provider_unavailable"}}' : scenario === "sse" ? 'data: {"type":"response.completed"}' : '{"status":"completed"}';
    const reader = {
      async read() {
        effect("reader.read");
        if (init.signal.aborted) throw options.invalidCancellation ? { name: "unrelated" } : init.signal.reason;
        if (canceled() && (scenario === "cancel-json-pre-body-progress" || readCount > 0)) return new Promise((resolve, reject) => pending.push({ signal: init.signal, resolve, reject }));
        return readCount++ === 0 ? { done: false, value: { byteLength: value.length, text: value } } : { done: true };
      },
      releaseLock() { effect("reader.release"); },
    };
    return { get status() { effect("response.status"); return options.invalidStatus ? 201 : timedOut() ? 502 : 200; }, headers: { get(name) { effect("response.header", name); return name === "x-request-id" ? `deadline-${scenario}` : scenario === "cancel-json-pre-body-progress" ? "gzip" : null; } }, get body() { effect("response.body"); return { getReader() { effect("reader.acquire"); return reader; } }; } };
  };
  const until = async (predicate, signal) => {
    effect("until");
    for (let i = 0; i < 30; i++) {
      signal?.throwIfAborted();
      if (await predicate()) return;
      await Promise.resolve();
    }
    throw new Error("synthetic predicate remained false");
  };
  const globals = {
    Promise: Promises, endpointMs: 500, limit: 1_000_000, secret: "http-deadline-fixture-secret", headers: { authorization: "fixture", "content-type": "application/json" },
    mkdtemp: async value => { effect("directory", value); return "/fixture"; }, tmpdir: () => "/tmp", join: (...args) => args.join("/"),
    rm: async (...args) => { effect("remove", args[0], args[1].recursive, args[1].force); },
    createHash: () => ({ update: () => ({ digest: () => "fake-digest" }) }),
    startWorkerdFixture: async (...args) => { effect("runtime", args[0], args[3].directRouter); return mf; },
    routerFixture: () => "fixed-router-source", upstreamFixture: () => "fixed-upstream-source", fetch, URL, AbortController: Controller, AbortSignal: signals, Date: Clock, until,
    TextDecoder: class { constructor() { effect("decoder"); } decode(part, options) { effect("decode", part?.text ?? null, options?.stream ?? false); return part?.text ?? ""; } },
    cleanupFixture: vm.runInNewContext(cleanupSource.replace("export async function", "async function") + "\ncleanupFixture", { AggregateError }),
  };
  const t = { async test(name, callback) {
    scenario = name; effect("case", name);
    try { await callback(); } catch (error) { failures.push({ scenario, error }); }
    effect("case.complete", name);
  }, diagnostic(value) { effect("diagnostic"); assert.equal(typeof value, "string"); } };
  return { globals, t, trace, failures, witnesses, markers, pending, async run(source = helperSource) {
    const core = source.slice(source.indexOf("export async function runHttpDeadlineCases"), source.indexOf("\nasync function until")).replace("export async function", "async function");
    const runtime = { assert, Object, Set, Reflect, AggregateError, ...globals };
    vm.createContext(runtime);
    const parseJSON = vm.runInContext("text => JSON.parse(text)", runtime);
    jsonValue = value => parseJSON(JSON.stringify(value));
    vm.runInContext(core + "\nglobalThis.run = runHttpDeadlineCases;", runtime);
    let thrown = false, reason;
    try { await runtime.run(t, options.scenarios ?? scenarios, async witness => { witnesses.push(witness); effect("report"); if (options.reportFault) throw options.reportReason; }); }
    catch (error) { thrown = true; reason = error; }
    return { thrown, reason, trace, failures, witnesses };
  } };
}

test("HTTP attribution retains immutable branch-local private reasons", () => {
  const { httpDeadlineAttribution } = extracted();
  for (const scenario of scenarios) for (const reason of [undefined, null, false, { original: scenario }]) {
    const owner = httpDeadlineAttribution(), a = owner.branch(scenario), b = owner.branch("sse");
    a.at("request_join");b.at("watch_progress");a.failed(reason);const first = owner.first();b.failed(reason);
    assert.equal(owner.first(), first);assert.equal(Object.isFrozen(first), true);
    assert.equal(first.scenario, scenario);assert.equal(first.site, "request_join");assert.equal(first.reason, reason);
    assert.equal(first.reasonPresent, true);assert.equal(first.reasonDefined, reason !== undefined);
  }
  const owner=httpDeadlineAttribution();owner.branch(null).failed(undefined);assert.equal(owner.first().scenario,null);
});

test("HTTP assertion attribution preserves callee receiver argument order and original return", () => {
  const { httpDeadlineAttribution }=extracted();
  for (const fail of ["callee","argument","call",null]) {
    const trace=[],reason={},owner=httpDeadlineAttribution(),branch=owner.branch("json"),result={};
    const callee=()=>{trace.push("callee");if(fail==="callee")throw reason;return function(...args){trace.push("call");assert.equal(this,assert);assert.deepEqual(args,[1,2]);if(fail==="call")throw reason;return result;};};
    const args=()=>{trace.push("argument");if(fail==="argument")throw reason;return [1,2];};
    let got;
    try{got=branch.assertion("check_01",callee,args);}catch(error){assert.equal(error,reason);}
    assert.deepEqual(trace,fail==="callee"?["callee"]:fail==="argument"?["callee","argument"]:["callee","argument","call"]);
    if(fail){assert.equal(owner.first().site,fail==="call"?"check_01_assertion":"check_01_operands");assert.equal(owner.first().reason,reason);}else{assert.equal(got,result);assert.equal(owner.first(),undefined);}
  }
});

test("HTTP cleanup keeps undefined and independent original reasons in source order", async () => {
  const { httpDeadlineAttribution,cleanupHttpDeadlineFixture }=extracted();
  for(const body of [undefined,{}]) for(const disposal of [undefined,{}]) for(const removal of [undefined,{}]) {
    const owner=httpDeadlineAttribution(),branch=owner.branch(null),trace=[];
    const error=await rejection(()=>cleanupHttpDeadlineFixture([["runtime_dispose",()=>{trace.push("dispose");throw disposal;}],["directory_remove",()=>{trace.push("remove");throw removal;}]],{failed:true,error:body},branch));
    assert.deepEqual(trace,["dispose","remove"]);assert.deepEqual(Array.from(error.errors),[body,disposal,removal]);assert.equal(owner.first().reason,disposal);assert.equal(owner.first().scenario,null);
  }
});

test("HTTP literal markers bind the same first witness and keep reporting errors independent", async () => {
  const report=markerFunction();
  for(const scenario of scenarios) for(const site of sites) {
    const witness=Object.freeze({scenario,site,reasonPresent:true,reasonDefined:false,reason:undefined}),rows=[];
    await report({async test(name,callback){let threw=false;try{callback();}catch(error){threw=true;assert.equal(error.diagnostic,"http-deadline-source-boundary");}assert.equal(threw,true);rows.push(name);}},witness);
    assert.deepEqual(rows,[`HTTP source case: ${scenario}`,`HTTP source site: ${site}`]);
    assert.notEqual(literalLines.get(rows[0]),literalLines.get(rows[1]));
  }
  const rows=[];await report({async test(name){rows.push(name);}},{scenario:null,site:"runtime_dispose"});assert.deepEqual(rows,["HTTP source site: runtime_dispose"]);
  const first=undefined,second={};let count=0;
  const error=await rejection(()=>report({async test(){if(count++===0)throw first;throw second;}},{scenario:"json",site:"request_join"}));
  assert.deepEqual(Array.from(error.errors),[first,second]);assert.equal(count,2);
});

test("HTTP expected cancellation and all seven affirmative fake cases have no markers", async () => {
  const model=fixtureModel();const result=await model.run();
  assert.equal(result.thrown,false);assert.equal(result.failures.length,0);assert.equal(result.witnesses.length,0);
  assert.deepEqual(result.trace.filter(x=>x[0]==="case").map(x=>x[1]),scenarios);
  assert.deepEqual(result.trace.slice(-2).map(x=>x[0]),["dispose","remove"]);
});

test("HTTP case failure remains a child failure and does not stop later cases", async () => {
  const original={};const model=fixtureModel({fault:{name:"response.status",at:2,reason:original}});const result=await model.run();
  assert.equal(result.thrown,false);assert.equal(result.failures.length,1);assert.equal(result.failures[0].scenario,"json");
  assert.equal(result.witnesses.length,1);assert.equal(result.witnesses[0].scenario,"json");assert.equal(result.witnesses[0].site,"check_02_operands");assert.equal(result.witnesses[0].reason,original);
  assert.deepEqual(result.trace.filter(x=>x[0]==="case").map(x=>x[1]),scenarios);
  assert.deepEqual(result.trace.slice(-3).map(x=>x[0]),["dispose","remove","report"]);
});

test("HTTP shared setup and report failures retain ordered identity without fabricated case", async () => {
  for(const reason of [undefined,{}]) {
    const report={};const model=fixtureModel({fault:{name:"direct.origin",reason},reportFault:true,reportReason:report});const result=await model.run();
    assert.equal(result.thrown,true);assert.deepEqual(Array.from(result.reason.errors),[reason,report]);assert.equal(result.witnesses[0].scenario,null);assert.equal(result.witnesses[0].reason,reason);
    assert.deepEqual(result.trace.slice(-3).map(x=>x[0]),["dispose","remove","report"]);
  }
});

// Compile only the actual closed reporter/decoder functions; supplied event and
// filesystem identities are fake. All synthetic commands stay in this test.
function reporter() {
  const prefix=reporterSource.slice(reporterSource.indexOf("const failureTypes"),reporterSource.indexOf("// Node-side fixture evidence"));
  const tail=reporterSource.slice(reporterSource.indexOf("function failureRecord("),reporterSource.indexOf("export default workerFailureReport")).replace("export async function*","async function*");
  const decoder=reporterSource.slice(reporterSource.indexOf("export function decodeWorkerReporterRecord"),reporterSource.indexOf("function trackedTestFiles")).replace("export function", "function");
  const context={types,Buffer,process:{cwd:()=>"/fixture"},trackedTestFiles:()=>file=>file,workerAbortInvocation:()=>null,workerAbortAdmission:()=>({observe(){},finish(){return {failure:null,records:[],record:null};}})};
  vm.createContext(context);vm.runInContext(prefix+decoder+tail+"\nglobalThis.report=workerFailureReport;globalThis.decode=decodeWorkerReporterRecord;",context);return { report:context.report, decode:context.decode };
}

test("HTTP source marker quota loss remains unknown and same-line identities deduplicate", async () => {
  const { report,decode }=reporter(),file="test/http-deadline.test.mjs",caseLine=literalLines.get("HTTP source case: json"),siteLine=literalLines.get("HTTP source site: request_join");
  const failure=(file,line)=>({type:"test:fail",data:{file,line,details:{error:{failureType:"testCodeFailure",code:"ERR_TEST_FAILURE"}}}});
  for(const earlier of [0,7,8,9]) {
    const events=Array.from({length:earlier},(_,i)=>failure("test/other.test.mjs",i+1));events.push(failure(file,caseLine),failure(file,siteLine));
    const commands=[];for await(const command of report((async function*(){yield*events;})()))commands.push(command);
    const records=commands.map(line=>JSON.parse(line.slice(line.indexOf("::",2)+2).trim().replaceAll("%0A","\n").replaceAll("%0D","\r").replaceAll("%25","%")));
    for(const record of records) assert.notEqual(decode(record),null);
    const pair=records.filter(r=>r.file===file);assert.equal(pair.length,earlier<=7?2:earlier===8?1:0);
    const complete=pair.some(r=>r.line===caseLine)&&pair.some(r=>r.line===siteLine);assert.equal(complete,earlier<=7);
    assert.ok(commands.length<=10);assert.ok(commands.every(x=>Buffer.byteLength(x)<=768));assert.ok(commands.reduce((n,x)=>n+Buffer.byteLength(x),0)<=8192);
  }
  const commands=[];for await(const command of report((async function*(){yield failure(file,caseLine);yield failure(file,caseLine);})()))commands.push(command);
  assert.equal(commands.length,2);
});

test("HTTP actual callbacks distinguish all seven operand failures from assertion calls", async () => {
  for (const scenario of scenarios) {
    for (const reason of [undefined, {}]) {
      const result = await fixtureModel({ scenarios: [scenario], fault: { name: "response.status", at: 2, reason } }).run();
      assert.equal(result.failures.length, 1);
      assert.equal(result.witnesses.length, 1);
      assert.equal(result.witnesses[0].scenario, scenario);
      assert.equal(result.witnesses[0].site, "check_02_operands");
      assert.equal(result.witnesses[0].reason, reason);
      assert.equal(result.trace.filter(row => row[0] === "response.status").length, 2);
    }
    const result = await fixtureModel({ scenarios: [scenario], invalidStatus: true }).run();
    assert.equal(result.failures.length, 1);
    assert.equal(result.witnesses[0].scenario, scenario);
    assert.equal(result.witnesses[0].site, "check_02_assertion");
    assert.equal(result.trace.filter(row => row[0] === "response.status").length, 2);
  }
});

test("HTTP expected read cancellation differs from an escaping validation rejection", async () => {
  for (const scenario of scenarios.filter(name => name.startsWith("cancel-"))) {
    const accepted = await fixtureModel({ scenarios: [scenario] }).run();
    assert.equal(accepted.failures.length, 0); assert.equal(accepted.witnesses.length, 0);
    const denied = await fixtureModel({ scenarios: [scenario], invalidCancellation: true }).run();
    assert.equal(denied.failures.length, 1);
    // The original assert.rejects promise rejects. That join alone does not
    // identify an inner transport cause or qualify a different rejection.
    assert.equal(denied.witnesses[0].site, "cancellation_join");
    assert.equal(denied.witnesses[0].scenario, scenario);
  }
});

test("HTTP reporting waits for the held original join and all cleanup attempts", async () => {
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const promise = new Promise(resolve => { release = resolve; });
  const reason = {}, model = fixtureModel({ scenarios: ["json"], fault: { name: "response.status", at: 2, reason }, holdJoin: { reached, promise } });
  const running = model.run();
  await entered;
  assert.equal(model.witnesses.length, 0);
  assert.equal(model.trace.some(row => row[0] === "dispose"), false);
  assert.equal(model.trace.some(row => row[0] === "remove"), false);
  release();
  const result = await running;
  assert.equal(result.witnesses[0].reason, reason);
  assert.deepEqual(result.trace.slice(-3).map(row => row[0]), ["dispose", "remove", "report"]);
});

test("HTTP body and every independent cleanup failure retain ordered original identities", async () => {
  for (const undefinedReasons of [false, true]) {
    const errors = Array.from({ length: 9 }, () => undefinedReasons ? undefined : {});
    const [body, watchAbort, callerAbort, join, drain, diagnostic, dispose, remove, reporting] = errors;
    const result = await fixtureModel({ scenarios: ["json"], faults: [
      { name: "response.status", at: 2, reason: body },
      { name: "abort", at: 1, reason: watchAbort },
      { name: "abort", at: 2, reason: callerAbort },
      { name: "promise.allSettled", reason: join },
      { name: "until", reason: drain },
      { name: "diagnostic", reason: diagnostic },
      { name: "dispose", reason: dispose }, { name: "remove", reason: remove },
    ], reportFault: true, reportReason: reporting }).run();
    assert.equal(result.thrown, true);
    assert.equal(result.failures.length, 1);
    const child = members(result.failures[0].error);
    assert.equal(child[0], body);
    // Undefined request errors also make the original error.name bookkeeping
    // throw. It is retained beside the original rather than replacing it.
    if (undefinedReasons) { assert.equal(child.length, 7); assert.equal(types.isNativeError(child[1]), true); }
    else assert.equal(child.length, 6);
    assert.deepEqual(child.slice(-5), [watchAbort, callerAbort, join, drain, diagnostic]);
    assert.deepEqual(members(result.reason), [drain, dispose, remove, reporting]);
    assert.equal(result.witnesses[0].reason, body);
    assert.equal(result.witnesses[0].reasonDefined, !undefinedReasons);
    assert.deepEqual(result.trace.filter(row => ["abort", "promise.allSettled", "until", "diagnostic", "dispose", "remove", "report"].includes(row[0])).map(row => row[0]),
      ["abort", "abort", "promise.allSettled", "until", "diagnostic", "dispose", "remove", "report"]);
  }
});

test("HTTP read failure stays first beside release and bookkeeping failures", async () => {
  for (const reason of [undefined, {}]) {
    const release = {};
    const result = await fixtureModel({ scenarios: ["json"], faults: [
      { name: "reader.read", reason }, { name: "reader.release", reason: release },
    ] }).run();
    assert.equal(result.witnesses[0].site, "reader_read");
    assert.equal(result.witnesses[0].reason, reason);
    assert.deepEqual(members(result.failures[0].error), [reason, release]);
    assert.equal(result.trace.filter(row => row[0] === "reader.release").length, 1);
  }
});

test("HTTP concurrent equal undefined failures retain branch ownership without reason matching", async () => {
  const result = await fixtureModel({ scenarios: ["cancel-sse"], faults: [
    { name: "observation.status", at: 2, reason: undefined },
    { name: "response.status", at: 2, reason: undefined },
  ] }).run();
  assert.equal(result.failures.length, 1);
  assert.equal(result.witnesses[0].site, "check_01_operands");
  assert.equal(result.witnesses[0].reason, undefined);
  assert.equal(result.witnesses[0].scenario, "cancel-sse");
  assert.equal(result.trace.filter(row => row[0] === "response.status").length, 2);
  assert.equal(result.trace.filter(row => row[0] === "promise.allSettled").length, 1);
});

test("HTTP physical sentinel registrations pass the unchanged Node reporter and closed decoder", () => {
  const file = fileURLToPath(new URL("./http-deadline.test.mjs", import.meta.url));
  const start = entrySource.indexOf("const httpDeadlineSentinel");
  const source = "\n".repeat(entrySource.slice(0, start).split("\n").length - 1) + entrySource.slice(start) + "\nglobalThis.report = reportHttpDeadlineFailure;";
  // Only the literal registration function runs in this builtin-only child.
  // Its synthetic failure output is captured, never sent to the CI reporter.
  const script = `const vm=require('node:vm'),test=require('node:test');vm.runInThisContext(${JSON.stringify(source)},{filename:${JSON.stringify(file)}});test('isolated synthetic marker parent',async t=>report(t,Object.freeze({scenario:'json',site:'request_join'})));`;
  const env = { ...process.env, NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0" };
  delete env.FORCE_COLOR; delete env.GH_FORCE_TTY; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--test-reporter", fileURLToPath(new URL("../scripts/worker-test-failure-reporter.mjs", import.meta.url)), "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8", maxBuffer: 16384, timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  assert.equal(child.status, 1); assert.equal(child.stderr, "");
  assert.equal(child.stdout.includes("\x1b"), false);
  const { decode } = reporter();
  const commands = child.stdout.trim().split("\n");
  assert.ok(commands.every(line => /^::(?:error|notice) title=Worker test identity::\{/.test(line)));
  const records = commands.map(line => decode(JSON.parse(line.slice(line.indexOf("::", 2) + 2).replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%"))));
  assert.equal(records.includes(null), false);
  const pair = records.filter(row => row.file === "test/http-deadline.test.mjs");
  assert.deepEqual(pair.map(row => row.line), [literalLines.get("HTTP source case: json"), literalLines.get("HTTP source site: request_join")]);
  assert.equal(pair.length, 2);
  assert.ok(commands.length <= 10); assert.ok(commands.every(line => Buffer.byteLength(line + "\n") <= 768));
  assert.ok(Buffer.byteLength(child.stdout) <= 8192);
});

test("HTTP literal pair keeps its original invocation witness across reporting awaits", async () => {
  const { httpDeadlineAttribution } = extracted(), owner = httpDeadlineAttribution(), report = markerFunction();
  owner.branch("headers").sync("check_01_operands", () => undefined);
  const branch = owner.branch("json"), reason = {};
  branch.at("request_join"); branch.failed(reason);
  const first = owner.first(), rows = [];
  await report({ async test(name, callback) {
    rows.push(name);
    try { callback(); } catch (sentinel) { assert.equal(sentinel.diagnostic, "http-deadline-source-boundary"); }
    const later = owner.branch("sse"); later.at("check_39_assertion"); later.failed(undefined);
    await Promise.resolve();
  } }, first);
  assert.equal(owner.first(), first); assert.equal(first.reason, reason);
  assert.deepEqual(rows, ["HTTP source case: json", "HTTP source site: request_join"]);
});

test("HTTP setup and disposal failures never acquire an unobserved case", async () => {
  for (const name of ["directory", "runtime", "direct.url", "direct.origin", "dispose", "remove"]) {
    for (const reason of [undefined, {}]) {
      const result = await fixtureModel({ scenarios: ["json"], fault: { name, reason } }).run();
      assert.equal(result.thrown, true);
      assert.equal(result.reason, reason);
      assert.equal(result.witnesses[0].scenario, null);
      assert.equal(result.witnesses[0].reason, reason);
      assert.equal(result.witnesses[0].reasonDefined, reason !== undefined);
      assert.equal(result.trace.filter(row => row[0] === "remove").length, name === "directory" ? 0 : 1);
    }
  }
});

test("HTTP literal marker vocabulary stays closed and parent timeout/scenario order stays exact", async () => {
  assert.equal(new Set(sites).size, sites.length);
  const branchSites = [...helperSource.slice(0, helperSource.indexOf("\nasync function until")).matchAll(/\.(?:at|sync)\("([^"]+)"/g)].map(match => match[1]);
  for (const site of branchSites) assert.ok(sites.includes(site));
  for (let i = 1; i <= 39; i++) {
    const key = `check_${String(i).padStart(2, "0")}`;
    assert.ok(sites.includes(`${key}_operands`)); assert.ok(sites.includes(`${key}_assertion`));
  }
  assert.match(entrySource, /\{ timeout: 60_000 \}/);
  assert.ok(entrySource.includes(JSON.stringify(scenarios).replaceAll(",", ", ")));
  const report = markerFunction(), lines = [];
  const reason = await rejection(() => report({ async test(name) { lines.push(name); } }, { scenario: "foreign", site: "foreign" }));
  assert.equal(reason.errors.length, 2); assert.deepEqual(lines, []);
});

test("HTTP watcher failure retains each later request release occurrence after the original join", async () => {
  for (const first of [undefined, {}]) for (const release of [undefined, {}]) {
    const result = await fixtureModel({ scenarios: ["cancel-sse"], faults: [
      { name: "until", at: 1, reason: first }, { name: "reader.release", reason: release },
    ] }).run();
    assert.equal(result.thrown, false); // Original child completion still fulfills.
    assert.equal(result.failures.length, 1);
    assert.deepEqual(Array.from(result.failures[0].error.errors), [first, release]);
    assert.equal(result.witnesses[0].reason, first);
    assert.equal(result.witnesses[0].site, "watch_progress");
    assert.equal(result.trace.filter(row => row[0] === "reader.release").length, 1);
    assert.equal(result.trace.filter(row => row[0] === "promise.allSettled").length, 1);
    assert.deepEqual(result.trace.slice(-3).map(row => row[0]), ["dispose", "remove", "report"]);
  }
  const same = {};
  const result = await fixtureModel({ scenarios: ["cancel-sse"], faults: [
    { name: "until", at: 1, reason: same }, { name: "reader.release", reason: same },
  ] }).run();
  assert.deepEqual(Array.from(result.failures[0].error.errors), [same, same]);
});

test("HTTP already propagated request cleanup occurrences are represented once", async () => {
  for (const reason of [undefined, {}]) {
    const result = await fixtureModel({ scenarios: ["json"], fault: { name: "reader.release", reason } }).run();
    assert.equal(result.failures.length, 1);
    const retained = members(result.failures[0].error);
    assert.equal(retained[0], reason);
    assert.equal(retained.length, reason === undefined ? 2 : 1);
    if (reason === undefined) assert.equal(types.isNativeError(retained[1]), true);
    assert.equal(result.trace.filter(row => row[0] === "reader.release").length, 1);
    assert.equal(result.trace.filter(row => row[0] === "promise.allSettled").length, 1);
  }
});

test("HTTP watcher-first bookkeeping and release failures retain distinct occurrences", async () => {
  for (const first of [undefined, {}]) for (const bookkeeping of [undefined, {}]) {
    const result = await fixtureModel({ scenarios: ["cancel-sse"], faults: [
      { name: "until", at: 1, reason: first }, { name: "now", at: 5, reason: bookkeeping },
    ] }).run();
    assert.equal(result.thrown, false);
    assert.deepEqual(Array.from(result.failures[0].error.errors), [first, bookkeeping]);
    assert.equal(result.witnesses[0].reason, first);
    const releaseAt = result.trace.findIndex(row => row[0] === "reader.release");
    assert.equal(result.trace[releaseAt + 1][0], "now");
    assert.equal(result.trace.filter(row => row[0] === "reader.release").length, 1);
    assert.equal(result.trace.filter(row => row[0] === "promise.allSettled").length, 1);
  }
  for (const same of [undefined, {}]) {
    const result = await fixtureModel({ scenarios: ["cancel-sse"], faults: [
      { name: "until", at: 1, reason: same }, { name: "reader.release", reason: same },
      { name: "now", at: 5, reason: same },
    ] }).run();
    assert.deepEqual(Array.from(result.failures[0].error.errors), [same, same, same]);
    assert.equal(result.witnesses[0].reason, same);
    assert.deepEqual(result.trace.slice(-3).map(row => row[0]), ["dispose", "remove", "report"]);
  }
});

test("HTTP direct request propagation represents both cleanup occurrences without duplicates", async () => {
  for (const release of [undefined, {}]) for (const bookkeeping of [undefined, {}]) {
    const result = await fixtureModel({ scenarios: ["json"], faults: [
      { name: "reader.release", reason: release }, { name: "now", at: 6, reason: bookkeeping },
    ] }).run();
    assert.equal(result.thrown, false);
    assert.deepEqual(Array.from(result.failures[0].error.errors), [release, bookkeeping]);
    assert.equal(result.witnesses[0].reason, release);
    assert.equal(result.trace.filter(row => row[0] === "reader.release").length, 1);
    assert.equal(result.trace.filter(row => row[0] === "promise.allSettled").length, 1);
  }
});

// Execute the authored router wrapper with fake handler I/O and in-memory Node
// Responses. Node does not implement Workers' encodeBody compression semantics.
function extractedRouterFixture(handler, ResponseType = Response) {
  const start = helperSource.indexOf("function routerFixture()");
  const end = helperSource.indexOf("\nfunction upstreamFixture()", start);
  const generated = vm.runInNewContext(helperSource.slice(start, end) + "\nrouterFixture()", { endpointMs: 500 });
  const wrapper = generated.slice(generated.indexOf("const ingress = {};"));
  const scope = { handler, Response: ResponseType, Headers, URL, Date };
  vm.runInNewContext(wrapper.replace("export default", "globalThis.router ="), scope);
  return { router: scope.router, ingress: vm.runInNewContext("ingress", scope) };
}

function routerRequest(requestId, path = "/v1/responses") {
  const observations = { headerReads: 0, listeners: [] };
  const request = {
    url: `https://fixture.invalid${path}`,
    headers: { get(name) { assert.equal(name, "x-request-id"); observations.headerReads++; return requestId; } },
    signal: { aborted: false, addEventListener(...args) { observations.listeners.push(args); } },
  };
  return { request, observations };
}

test("HTTP gzip fixture establishes only downstream encoding and preserves the original response body", async () => {
  const original = new Response("fixture payload", { status: 202, statusText: "Fixture Accepted", headers: {
    "content-type": "application/json", "content-length": "15", "x-request-id": "owned", "x-fixture": "preserved",
  } });
  const before = [...original.headers], calls = [], constructions = [], env = {}, context = {};
  const { request, observations } = routerRequest("deadline-cancel-json-pre-body-progress");
  const handler = { async fetch(...args) { calls.push({ receiver: this, args }); return original; } };
  let fixture;
  class RecordedResponse extends Response {
    constructor(body, init) {
      assert.equal(fixture.ingress["deadline-cancel-json-pre-body-progress"].status, 202);
      constructions.push({ body, init }); super(body, init);
    }
  }
  fixture = extractedRouterFixture(handler, RecordedResponse);
  const response = await fixture.router.fetch(request, env, context);
  assert.notEqual(response, original); assert.equal(response instanceof Response, true);
  assert.equal(response.body, original.body); assert.equal(response.body.locked, false);
  assert.equal(response.status, 202); assert.equal(response.statusText, "Fixture Accepted");
  assert.deepEqual([...response.headers], [...new Headers({ "content-type": "application/json", "content-encoding": "gzip", "x-request-id": "owned", "x-fixture": "preserved" })]);
  assert.deepEqual([...original.headers], before);
  assert.equal(constructions.length, 1); assert.equal(constructions[0].body, original.body);
  assert.equal(constructions[0].init.encodeBody, "automatic");
  assert.deepEqual(calls, [{ receiver: handler, args: [request, env, context] }]);
  assert.equal(observations.headerReads, 1); assert.equal(observations.listeners.length, 1);
});

test("HTTP gzip fixture leaves every other scenario and unrelated route response identical", async () => {
  const ids = scenarios.filter(scenario => scenario !== "cancel-json-pre-body-progress").map(scenario => `deadline-${scenario}`);
  ids.push(null, "deadline-cancel-json-pre-body-progress-extra", "cancel-json-pre-body-progress");
  for (const [id, path] of [...ids.map(id => [id, "/v1/responses"]), ["deadline-cancel-json-pre-body-progress", "/other"]]) {
    const original = new Response("plain", { headers: { "content-length": "5", "x-fixture": "unchanged" } });
    let calls = 0;
    const handler = { async fetch() { calls++; return original; } };
    class ForbiddenResponse { constructor() { assert.fail("unrelated response was replaced"); } }
    const fixture = extractedRouterFixture(handler, ForbiddenResponse);
    const { request, observations } = routerRequest(id, path);
    assert.equal(await fixture.router.fetch(request, {}, {}), original); assert.equal(calls, 1);
    assert.equal(original.headers.get("content-encoding"), null); assert.equal(original.headers.get("content-length"), "5");
    assert.equal(observations.headerReads, path === "/v1/responses" ? 1 : 0);
  }
});

test("HTTP gzip fixture preserves same-body cancellation and the independent ingress abort listener", async () => {
  for (const reason of [undefined, { canceled: true }]) {
    const cancellations = [];
    const body = new ReadableStream({ pull() { assert.fail("wrapper pulled the body"); }, cancel(...args) { cancellations.push(args); } }, { highWaterMark: 0 });
    const original = new Response(body);
    const fixture = extractedRouterFixture({ async fetch() { return original; } });
    const { request, observations } = routerRequest("deadline-cancel-json-pre-body-progress");
    const response = await fixture.router.fetch(request, {}, {});
    assert.equal(response.body, body); assert.equal(cancellations.length, 0);
    await response.body.cancel(reason);
    assert.equal(cancellations.length, 1); assert.equal(cancellations[0].length, 1); assert.equal(cancellations[0][0], reason);
    const [name, listener, options] = observations.listeners[0];
    assert.equal(name, "abort"); assert.equal(options.once, true);
    assert.equal(fixture.ingress["deadline-cancel-json-pre-body-progress"].abortedAt, null);
    listener();
    assert.equal(typeof fixture.ingress["deadline-cancel-json-pre-body-progress"].abortedAt, "number");
  }
});

test("HTTP gzip fixture retains handler and wrapping failures including undefined", async () => {
  for (const reason of [undefined, {}]) for (const boundary of ["handler", "response"]) {
    let calls = 0, constructions = 0;
    const original = new Response("plain");
    class FailingResponse { constructor() { constructions++; throw reason; } }
    const fixture = extractedRouterFixture({ async fetch() { calls++; if (boundary === "handler") throw reason; return original; } }, FailingResponse);
    const { request } = routerRequest("deadline-cancel-json-pre-body-progress");
    assert.equal(await rejection(() => fixture.router.fetch(request, {}, {})), reason);
    assert.equal(calls, 1); assert.equal(constructions, boundary === "response" ? 1 : 0);
    assert.equal(typeof fixture.ingress["deadline-cancel-json-pre-body-progress"].failedAt, "number");
    assert.equal(original.body.locked, false);
  }
});
