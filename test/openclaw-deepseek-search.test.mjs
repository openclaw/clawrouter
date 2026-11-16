import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { types as nodeTypes } from "node:util";
import { runnerStartupRecord, runnerStartupCommand } from "./helpers/openclaw-runner-reporter.mjs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { deepSeekHeldFailure } from "../scripts/worker-test-failure-reporter.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "82dd065e23b678e61ad497f9d57fbb4c3da10eae";
const successful = ["default", "one", "ten", "empty", "fixed"];
const uncertain = ["malformed", "truncated", "oversized", "non_success", "redirect", "unsafe", "encoding", "abort"];
const denied = ["grant", "foreign", "policy", "revoked", "budget", "key", "long_query", "surrogate", "content", "country", "zero", "eleven", "fraction"];
const scenarios = [...successful, ...uncertain, ...denied];
const query = "site:example.com synthetic search";

// Decode only the fixture's closed, source-owned records. Ordinary runner output stays private.
const fixtureSha256 = "83214f47b280b563f350306bf8e9654c34fd0a25559a788777a27926adae9f5b", reporterSha256 = "71189036a0b33a2b9e709254d36ab71919e63e928b5f8e4f5b8717eee503637d";
const sdkText = readFileSync(new URL("./fixtures/openclaw-deepseek-search-contract.test.ts", import.meta.url), "utf8");
const protocolStart = sdkText.indexOf("// BEGIN DeepSeek failure capsule."), protocolEnd = sdkText.indexOf("// END DeepSeek failure capsule.");
assert.ok(protocolStart >= 0 && protocolEnd > protocolStart);
const failureProtocol = new Function(stripTypeScriptTypes(sdkText.slice(protocolStart, protocolEnd)) + "; return deepSeekFailureProtocol;")()();
assert.equal(failureProtocol.pin, sourceHead); assert.deepEqual(failureProtocol.cases, scenarios);

// Bits index the frozen capsule names, not native invocation or verdict states.
function deepSeekSummaryRecord(input) {
  assert.ok(input && typeof input === "object" && !nodeTypes.isProxy(input));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = ["v", "source", "records", "failedRecords", "omittedRecords", "cleanupFailures", "reportingFailures", "unobservedCapsuleMask"];
  assert.deepEqual(Reflect.ownKeys(descriptors), fields);
  assert.ok(fields.every(key => Object.hasOwn(descriptors[key], "value")));
  const row = Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
  assert.equal(row.v, 2); assert.equal(row.source, "summary");
  assert.equal(failureProtocol.cases.length, 26);
  for (const key of fields.slice(2)) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
  assert.ok(row.records <= 26 && row.failedRecords <= row.records);
  assert.ok(row.cleanupFailures <= 65535 && row.reportingFailures <= 65535);
  assert.equal(row.omittedRecords, row.records - (row.failedRecords ? 1 : 0));
  assert.ok(row.unobservedCapsuleMask < 2 ** 26);
  let unobserved = 0;
  for (let index = 0; index < 26; index++) if (row.unobservedCapsuleMask & (1 << index)) unobserved++;
  assert.equal(row.records + unobserved, 26);
  return row;
}

function deepSeekDiagnostics(write = line => process.stdout.write(line)) {
  const rows = new Map(), faults = [];
  let runner, primary, cleanup = 0, finished = false, bytes = 0, inputBytes = 0;
  const protect = run => { try { run(); } catch (error) { faults.push(error); } };
  function parse(text) {
    if (typeof text !== "string") return;
    inputBytes += Buffer.byteLength(text); assert.ok(inputBytes <= 4 * 1024 * 1024);
    for (const row of failureProtocol.parse(text)) {
      assert.equal(rows.has(row.caseId), false, "duplicate SDK capsule"); rows.set(row.caseId, row);
    }
  }
  function rejected(error) {
    const pending = [error], seen = new Set(); let visited = 0;
    while (pending.length) {
      assert.ok(++visited <= 32, "bounded original error graph");
      const value = pending.pop();
      if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || !nodeTypes.isNativeError(value) || seen.has(value)) continue;
      seen.add(value);
      const own = key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, "value") ? d.value : undefined; };
      for (const key of ["stdout", "stderr"]) parse(own(key));
      const children = own("errors");
      if (!children || nodeTypes.isProxy(children) || !Array.isArray(children)) continue;
      const length = Object.getOwnPropertyDescriptor(children, "length")?.value;
      assert.ok(Number.isSafeInteger(length) && length <= 32);
      for (let i = length - 1; i >= 0; i--) {
        const d = Object.getOwnPropertyDescriptor(children, String(i));
        assert.ok(d && Object.hasOwn(d, "value")); pending.push(d.value);
      }
    }
  }
  return {
    diagnostic(text) { protect(() => parse(text)); },
    runner(packet) { protect(() => { assert.equal(runner, undefined, "duplicate runner packet"); runner = runnerStartupRecord(packet); }); },
    failed(error, phase) { primary ??= { phase, failurePresent: true, reasonDefined: error !== undefined }; if (phase === "helper") protect(() => rejected(error)); },
    cleanup(error) { cleanup++; primary ??= { phase: "cleanup", failurePresent: true, reasonDefined: error !== undefined }; },
    finish() {
      if (finished) return []; finished = true;
      const failed = [...rows.values()].filter(row => row.failurePresent);
      if (!primary && !failed.length && !faults.length && rows.size === failureProtocol.cases.length) return [];
      const commands = [];
      const command = row => "::error title=DeepSeek contract diagnostic::" + JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") + "\n";
      if (failed.length) commands.push(command({ source: "sdk", ...failed[0] }));
      if (primary) commands.push(command({ v: 1, source: "outer", ...primary }));
      // Startup supplements never substitute a case outcome or a missing resource observation.
      if (runner && (primary?.phase === "helper" || rows.size < failureProtocol.cases.length)) commands.push(runnerStartupCommand(runner));
      const unobservedCapsuleMask = failureProtocol.cases.reduce((mask, name, index) => rows.has(name) ? mask : mask | (1 << index), 0);
      commands.push(command(deepSeekSummaryRecord({ v: 2, source: "summary", records: rows.size, failedRecords: failed.length,
        omittedRecords: rows.size - (failed.length ? 1 : 0), cleanupFailures: cleanup, reportingFailures: faults.length, unobservedCapsuleMask })));
      assert.ok(commands.length <= 9);
      for (const line of commands) protect(() => { const n = Buffer.byteLength(line); assert.ok(n <= 768 && bytes + n <= 8192); bytes += n; write(line); });
      return faults;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// One actual upstream is held open. Only its original request cancellation or
// deadline may close it during the witness; disposal is never a join oracle.
async function abortBarrier() {
  const seen = deferred(), closed = deferred(), socketClosed = deferred();
  const state = { requests: 0, responseClosed: false, socketClosed: false, teardown: false };
  let held;
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    if (request.url === "/hold") {
      if (held) { response.writeHead(409); response.end(); return; }
      held = response;
      state.requests++;
      response.once("close", () => { state.responseClosed = true; closed.resolve(); });
      request.socket.once("close", () => { state.socketClosed = true; socketClosed.resolve(); });
      seen.resolve();
    } else if (request.url === "/seen") {
      await seen.promise; response.end("seen");
    } else if (request.url === "/closed") {
      await closed.promise; response.end("closed");
    } else if (request.url === "/socket-closed") {
      await socketClosed.promise; response.end("socket-closed");
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state: () => ({ ...state }),
    async close() {
      state.teardown = true;
      held?.end("teardown");
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("DeepSeek held upstream joins original cancellation before teardown", { timeout: 60_000 }, async t => {
  const failures = [], cancellationFailures = [], cleanupFailures = [], reportingFailures = [];
  const reason = new Error("synthetic DeepSeek raw cancellation");
  const caller = new AbortController();
  let barrier, temporary, mf, reader, cancellation, phase = "setup", observed;
  let firstFailurePhase;
  let cancelAttempted = false, cancelCompletion, cancelResult, cancelObserverFailure, stoppedForObserver = false;
  const beginCancellation = () => {
    cancelAttempted = true;
    cancellation = reader.cancel(reason);
    // One original subscription, with its outcome retained before the observer
    // tail can fail. Cleanup joins the same tail without resubscribing.
    const observer = cancellation.then(
      value => { cancelResult = { status: "fulfilled", value }; },
      error => { cancelResult = { status: "rejected", reason: error }; },
    );
    cancelCompletion = observer.then(undefined, error => { cancelObserverFailure = { error }; });
  };
  const report = write => { try { write(); } catch (error) { reportingFailures.push(error); } };
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded DeepSeek ownership probe expired")), 45_000); });
  const bounded = promise => Promise.race([promise, expired]);
  try {
    barrier = await abortBarrier();
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-deepseek-cancel-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture([]), upstreamFixture(barrier.origin), { directRouter: true, preventEviction: true });
    const upstream = await mf.getWorker("upstream");
    const response = await bounded(upstream.fetch("https://api.deepseek.com/v1/tools/search", {
      method: "POST", headers: { authorization: "Bearer managed-ds_abort", "content-type": "application/json" },
      body: JSON.stringify({ query, count: 5, need_content: false }), signal: caller.signal,
    }));
    reader = response.body.getReader();
    phase = "prefix";
    assert.equal(new TextDecoder().decode((await bounded(reader.read())).value), '{"results":[');
    phase = "acquired";
    assert.equal(await bounded(fetch(barrier.origin + "/seen").then(response => response.text())), "seen");
    assert.deepEqual(barrier.state(), { requests: 1, responseClosed: false, socketClosed: false, teardown: false });
    caller.abort(reason);
    phase = "cancel";
    beginCancellation();
    await bounded(cancelCompletion);
    if (cancelObserverFailure) { stoppedForObserver = true; throw cancelObserverFailure.error; }
    const canceled = cancelResult;
    reader.releaseLock(); reader = undefined;
    phase = "retirement";
    observed = await bounded(upstream.fetch("https://fixture.example/state").then(response => response.json()));
    report(() => console.log("deepseek-held-ownership", JSON.stringify({ phase, cancellation: { status: canceled.status, originalCallerReason: canceled.status === "rejected" && canceled.reason === reason }, barrier: barrier.state(), calls: observed.map(call => ({ finished: call.finished, abort: call.abort })) })));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].finished, true, "original nested fetch must settle before teardown");
    assert.equal(await bounded(fetch(barrier.origin + "/socket-closed").then(response => response.text())), "socket-closed");
    assert.equal(barrier.state().teardown, false);
  } catch (error) { if (!stoppedForObserver) { failures.push(error); firstFailurePhase = phase === "setup" ? "setup" : "upstream"; } }
  finally {
    try { clearTimeout(timer); } catch (error) { cleanupFailures.push(error); }
    report(() => console.log("deepseek-held-cleanup", JSON.stringify({ phase, beforeTeardown: barrier?.state() })));
    try { caller.abort(reason); } catch (error) { cleanupFailures.push(error); }
    try { await barrier?.close(); } catch (error) { cleanupFailures.push(error); }
    if (reader && !cancelAttempted) {
      try { beginCancellation(); } catch (error) { cancellationFailures.push(error); }
    }
    if (cancelCompletion) {
      try { await cancelCompletion; } catch (error) { cancellationFailures.push(error); }
      if (cancelResult?.status === "rejected") cancellationFailures.push(cancelResult.reason);
      if (cancelObserverFailure) cancellationFailures.push(cancelObserverFailure.error);
    }
    if (reader) try { reader.releaseLock(); } catch (error) { cleanupFailures.push(error); }
    try { await mf?.dispose(); } catch (error) { cleanupFailures.push(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  }
  const primaryFailureCount = failures.length;
  failures.push(...cancellationFailures, ...cleanupFailures);
  if (failures.length || reportingFailures.length) report(() => console.log("deepseek-held-failures", JSON.stringify([...failures, ...reportingFailures].map(error => ({ defined: error !== undefined, originalCallerReason: error === reason })))));
  if (failures.length || reportingFailures.length) report(() => t.diagnostic(deepSeekHeldFailure(primaryFailureCount ? firstFailurePhase : "cleanup", failures, reportingFailures)));
  failures.push(...reportingFailures);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "DeepSeek cancellation or cleanup failed");
});

test("actual OpenClaw DeepSeek native Search through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(row => row.id === "deepseek");
  const endpoint = provider?.endpoints.find(row => row.id === "search");
  assert.equal(provider.base_urls.default, "https://api.deepseek.com");
  assert.equal(endpoint.request_format, "deepseek.search");
  assert.equal(endpoint.response_format, "deepseek.search");
  assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.path, "/v1/tools/search");
  assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.requestPricing.successfulNonemptyRequestMicros, 750);
  assert.equal(endpoint.requestPricing.emptyRequestMicros, 0);
  const ids = scenarios.map(name => `ds_${name}`), failures = [];
  const diagnostics = deepSeekDiagnostics();
  let barrier, temporary, mf, phase = "setup";
  try {
    barrier = await abortBarrier();
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-deepseek-client-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(ids), upstreamFixture(barrier.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const initialized = await fetch(`${origin}/__deepseek/init`, { method: "POST" });
    assert.equal(initialized.status, 200, await initialized.text());
    phase = "helper";
    await runOpenClawConsumer({ diagnostic: text => diagnostics.diagnostic(text) }, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-deepseek-search-contract.test.ts", import.meta.url),
      testPath: "src/agents/tools/worker-clawrouter-deepseek-contract.test.ts",
      runnerReport: { expectedInvocations: 1, fixtureSha256, reporterSha256, onReport: packet => diagnostics.runner(packet) },
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CONTROL: barrier.origin, CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead },
    });
    phase = "upstream";
    const upstream = await mf.getWorker("upstream");
    const calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.deepEqual(await (await fetch(`${origin}/__deepseek/audit`)).json(), [], "blocked egress/route attempts are failures too");
    assert.equal(calls.length, successful.length + uncertain.length, "no alternate URL, provider, retry or paid denial");
    for (const name of scenarios) {
      const id = `ds_${name}`, paid = !denied.includes(name);
      const selected = calls.filter(call => call.id === id);
      assert.equal(selected.length, paid ? 1 : 0, name);
      if (paid) {
        assert.deepEqual(selected[0].request, {
          url: "https://api.deepseek.com/v1/tools/search", method: "POST", originalBearer: true, noCredentialOverride: true,
          body: { query, count: name === "one" ? 1 : name === "ten" ? 10 : 5, need_content: false },
        });
      }
      phase = "worker_receipt";
      const joined = await (await fetch(`${origin}/__deepseek/join/${id}`)).json();
      assert.equal(joined.calls, paid ? 1 : 0, name);
      assert.equal(joined.retired, true, name);
      assert.equal(joined.charged, 0, "actual original waitUntil/reader joins precede disposal");
      if (paid) {
        assert.equal(joined.activeReads, 0, name);
        assert.equal(joined.unlocked, true, name);
        assert.equal(joined.sourceLocked, false, name);
        assert.equal(joined.physicalLocked, false, name);
        assert.ok(joined.eof || joined.canceled || joined.readRejected, name);
        assert.equal(joined.readResults.length, joined.readCalls, name);
        assert.ok(joined.readResults.every(status => status === "fulfilled" || status === "rejected"), name);
        assert.equal(joined.readResults.includes("rejected"), joined.readRejected, name);
        assert.equal(joined.cancelCalls, joined.canceled ? 1 : 0, name);
        assert.equal(joined.cancelResults.length, joined.cancelCalls, name);
        assert.ok(joined.cancelResults.every(status => status === "fulfilled"), "original reader.cancel must settle successfully");
        assert.equal(joined.reservedBeforeFetch, name === "fixed" ? 17 : 750, name);
      }
      phase = "accounting";
      const receipt = await (await fetch(`${origin}/__deepseek/usage/${id}`)).json();
      if (paid) {
        assert.equal(receipt.usage.events.length, 1, name);
        const [event] = receipt.usage.events;
        const cost = name === "empty" ? 0 : name === "fixed" ? 17 : 750;
        assert.equal(event.provider, "deepseek");
        assert.equal(event.model, null, "Search never borrows Chat model authority");
        assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
        assert.equal(event.capability, "search.web");
        assert.equal(event.reserved_cost_micros, name === "fixed" ? 17 : 750);
        assert.equal(event.cost_basis, name === "fixed" ? "policy_fixed" : uncertain.includes(name) ? "manifest_request_reservation" : "manifest_request");
        assert.equal(event.actual_cost_micros, cost);
        assert.equal(event.pricing_ref, name === "fixed" ? null : "deepseek-search-2026-11-01");
        assert.equal(receipt.budget.spentMicros, cost);
        assert.equal(event.grant_key, `oauth/${id}/deepseek`);
      } else {
        assert.ok(receipt.usage.events.every(event => event.actual_cost_micros === 0), name);
        assert.equal(receipt.budget.spentMicros, 0, name);
      }
      assert.doesNotMatch(JSON.stringify(receipt.usage.events), /fixture-secret|managed-ds_|must-not-fallback|synthetic search|Synthetic summary/);
    }
    assert.equal(calls.find(call => call.id === "ds_abort").finished, true, "held upstream really ended before teardown");
  } catch (error) { failures.push(error); diagnostics.failed(error, phase); }
  finally {
    try { await barrier?.close(); } catch (error) { failures.push(error); diagnostics.cleanup(error); }
    try { await mf?.dispose(); } catch (error) { failures.push(error); diagnostics.cleanup(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); diagnostics.cleanup(error); }
  }
  try { failures.push(...diagnostics.finish()); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "DeepSeek contract or owned cleanup failed");
});

function routerFixture(ids) {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
import { budgetStatus } from "./worker/ledgers.ts";
const ids = IDS, rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const requests = new Map(), inputs = new Map(), ingested = new Map(ids.map(id => [id, deferred()])), violations = [];
function refuse(reason) { violations.push(reason); throw new Error(reason); }
let fixtureEnv;
function retainDeepSeekObserver(proof, observer) {
  proof.observers.push(observer);
  try { proof.observers.push(observer.then(undefined, () => {})); }
  catch (error) { proof.failures.push(error); throw error; }
  return observer;
}
const policy = id => ({ enabled: true, generation: "fixture", providers: id === "ds_policy" ? ["openai"] : ["deepseek"], tenantId: "fixture",
  monthlyBudgetMicros: id === "ds_budget" ? 749 : 10000, requestCostMicros: id === "ds_fixed" ? 17 : null,
  budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== "https://api.deepseek.com/v1/tools/search" || request.method !== "POST") refuse("unexpected provider egress");
  const id = /^Bearer managed-(ds_[a-z_]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!ids.includes(id) || inputs.has(id)) refuse("unknown owner or repeated provider egress");
  const proof = { activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, terminal: deferred(),
    readCalls: 0, reads: [], cancelCalls: 0, cancels: [], observers: [], failures: [], sourceRejected: false,
    reservedBeforeFetch: (await budgetStatus(fixtureEnv, id, policy(id))).spentMicros };
  inputs.set(id, proof);
  const response = await rawFetch(request), physical = response.body;
  if (!physical) throw new Error("missing real upstream body");
  proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    pull(controller) { return retainDeepSeekObserver(proof, (async () => {
      proof.activeReads++;
      try {
        proof.readCalls++;
        let original;
        try { original = reader.read(); } catch (error) { proof.failures.push(error); throw error; }
        proof.reads.push(original);
        let next;
        try { next = await original; } catch (error) { proof.readRejected = true; throw error; }
        if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
      }
      catch (error) { proof.sourceRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.sourceRejected) unlock(); }
    })()); },
    cancel(reason) { return retainDeepSeekObserver(proof, (async () => {
      proof.canceled = true; proof.cancelCalls++;
      try { const original = reader.cancel(reason); proof.cancels.push(original); await original; }
      finally { unlock(); }
    })()); },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
const joinOwners = new Map();
function join(id) {
  let state = joinOwners.get(id);
  if (!state) { state = { entries: new Map(), lists: new Map(), fields: new Map(), records: [], items: [], faults: new Map(), version: 0 }; joinOwners.set(id, state); }
  if (state.active) return state.active;
  let resolve, reject;
  const result = new Promise((a, b) => { resolve = a; reject = b; });
  state.active = result;
  const fault = (owner, field, error) => {
    let fields = state.faults.get(owner);
    if (!fields) { fields = new Set(); state.faults.set(owner, fields); }
    if (!fields.has(field)) { fields.add(field); state.items.push({ failure: { error } }); }
  };
  const bound = (owner, field, read) => {
    let fields = state.fields.get(owner);
    if (!fields) { fields = new Map(); state.fields.set(owner, fields); }
    try {
      const value = read();
      if (!fields.has(field) && value !== undefined) fields.set(field, value);
      if (fields.has(field) && fields.get(field) !== value) fault(owner, field, new Error("DeepSeek join ownership changed"));
    } catch (error) { fault(owner, field, error); }
    return fields.get(field);
  };
  const observe = (original, fatal) => {
    if (original === state.active || state.runner && original === state.runner || state.completion && original === state.completion) {
      fault(state, "self", new Error("DeepSeek join cannot own itself")); return;
    }
    let entry = state.entries.get(original);
    if (entry) { if (fatal && !entry.fatal) { entry.fatal = true; state.version++; } return; }
    entry = { original, fatal, done: false }; state.entries.set(original, entry); state.items.push(entry); state.version++;
    try {
      const observer = original.then(
        value => { entry.outcome = { status: "fulfilled", value }; },
        error => { entry.outcome = { status: "rejected", reason: error }; },
      );
      entry.joined = observer.then(() => { entry.done = true; }, error => { entry.observerFailure = { error }; entry.done = true; });
    } catch (error) { entry.registrationFailure = { error }; entry.done = true; }
  };
  const list = (owner, field, visit) => {
    const values = bound(owner, field, () => owner[field]);
    if (!Array.isArray(values)) { fault(owner, field, new Error("DeepSeek join ledger is missing")); return; }
    let fields = state.lists.get(owner);
    if (!fields) { fields = new Map(); state.lists.set(owner, fields); }
    let cursor = fields.get(field);
    if (!cursor) { cursor = []; fields.set(field, cursor); }
    if (values.length < cursor.length || cursor.some((value, index) => values[index] !== value)) {
      fault(values, "prefix", new Error("DeepSeek join ledger changed"));
    }
    while (cursor.length < values.length) {
      const index = cursor.length, value = values[index]; cursor.push(value);
      try { visit(value); } catch (error) { fault(values, index, error); }
    }
  };
  const scan = () => {
    const records = bound(state, "requests", () => requests.get(id));
    if (records) {
      if (records.length < state.records.length || state.records.some((record, index) => records[index] !== record)) fault(state, "records", new Error("DeepSeek request ledger changed"));
      while (state.records.length < records.length) state.records.push(records[state.records.length]);
    }
    for (const record of state.records) {
      observe(bound(record, "returned", () => record.returned.promise), true);
      list(record, "pending", promise => observe(promise, true));
      list(record, "failures", error => state.items.push({ failure: { error } }));
    }
    const p = bound(state, "proof", () => inputs.get(id));
    if (p) {
      observe(bound(p, "terminal", () => p.terminal.promise), true);
      list(p, "reads", promise => observe(promise, false));
      list(p, "cancels", promise => observe(promise, true));
      list(p, "observers", promise => observe(promise, true));
      list(p, "failures", error => state.items.push({ failure: { error } }));
    }
    return p;
  };
  state.runner = (async () => {
    let p;
    for (;;) {
      const version = state.version;
      scan();
      await Promise.all([...state.entries.values()].filter(entry => !entry.done).map(entry => entry.joined));
      p = scan();
      if (version === state.version) break;
    }
    const failures = [];
    for (const entry of state.items) {
      if (entry.failure) failures.push(entry.failure.error);
      if (entry.registrationFailure) failures.push(entry.registrationFailure.error);
      if ("original" in entry && !entry.outcome && !entry.registrationFailure && !entry.observerFailure) failures.push(new Error("DeepSeek original settlement is missing"));
      if (entry.fatal && entry.outcome?.status === "rejected") failures.push(entry.outcome.reason);
      if (entry.observerFailure) failures.push(entry.observerFailure.error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "DeepSeek original work or observation failed");
    return { paths: (state.fields.get(state).get("requests") ?? []).map(row => row.path), calls: p ? 1 : 0, retired: true, charged: bodyBudgetCharged(), ...(p ? {
      activeReads: p.activeReads, eof: p.eof, canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked,
      sourceLocked: p.source.locked, physicalLocked: p.physical.locked, reservedBeforeFetch: p.reservedBeforeFetch,
      readCalls: p.readCalls, readResults: p.reads.map(original => state.entries.get(original).outcome.status),
      cancelCalls: p.cancelCalls, cancelResults: p.cancels.map(original => state.entries.get(original).outcome.status),
    } : {}) };
  })();
  state.completion = state.runner.then(value => { state.active = undefined; resolve(value); }, error => { state.active = undefined; reject(error); });
  return result;
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    const path = new URL(request.url).pathname;
    if (path === "/__deepseek/audit") return Response.json(violations);
    if (path === "/__deepseek/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", ids.map(policyId => ({ policyId, policy: policy(policyId) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", ids.map(credentialId => ({ credentialId, credential: { enabled: true, secretSha256, policyId: credentialId, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [{ providerId: "deepseek", enabled: true }]);
      for (const id of ids) if (id !== "ds_grant") await putGrantCredentials(env, "oauth/" + id + "/deepseek",
        { provider: id === "ds_foreign" ? "openai" : "deepseek", kind: "api_key", enabled: true, credential: "managed-" + id });
      return Response.json({ ready: true });
    }
    const control = /^\/__deepseek\/(join|usage|revoke)\/(ds_[a-z_]+)$/.exec(path);
    if (control && ids.includes(control[2])) {
      const [, action, id] = control;
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && id === "ds_revoked" && request.method === "POST") {
        await revokeGrantCredentials(env, "oauth/" + id + "/deepseek"); return Response.json({ revoked: true });
      }
      if (action === "usage") {
        await join(id); if (inputs.has(id)) await ingested.get(id).promise;
        const response = await worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
        return response;
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-(ds_[a-z_]+)-/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!ids.includes(id)) refuse("unknown client credential");
    if (!["/v1/catalog", "/v1/native/deepseek/v1/tools/search"].includes(path)) refuse("unexpected client route");
    const records = requests.get(id) ?? []; requests.set(id, records);
    if (records.some(row => row.path === path)) refuse("repeated client route");
    const record = { path, pending: [], failures: [], returned: deferred() }; records.push(record);
    const ctx = { waitUntil(promise) {
      record.pending.push(promise);
      try { context.waitUntil(promise); } catch (error) { record.failures.push(error); throw error; }
    } };
    try { return await worker.fetch(request, { ...env, DEEPSEEK_API_KEY: "must-not-fallback-deepseek" }, ctx); }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) {
    await worker.queue(batch, env);
    for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve();
  },
};
`.replace("IDS", JSON.stringify(ids));
}

function upstreamFixture(control) {
  return String.raw`
const calls = [];
const result = { title: "Synthetic result", url: "https://example.com/result", summary: "Synthetic summary", snippet: "Lower-priority snippet",
  date: "2026-11-01T00:00:00Z", site_name: "Example" };
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const id = /^Bearer managed-(ds_[a-z_]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const noCredentialOverride = !["x-api-key", "x-deepseek-api-key", "api-key"].some(name => request.headers.has(name));
  const call = { id, request: { url: request.url, method: request.method, originalBearer: !!id, noCredentialOverride, body: await request.json() }, finished: false };
  calls.push(call);
  if (!id || request.url !== "https://api.deepseek.com/v1/tools/search" || request.method !== "POST" || !noCredentialOverride) return new Response(null, { status: 400 });
  const scenario = id.slice(3), headers = { "content-type": "application/json" };
  if (scenario === "abort") {
    const trace = call.abort = { pulls: 0, requestAbort: 0, sourceCancel: 0, fetchStarted: 0, fetchSettled: 0, bodyCancelSettled: 0 };
    const onAbort = () => { trace.requestAbort++; };
    request.signal.addEventListener("abort", onAbort, { once: true });
    let started = false;
    return new Response(new ReadableStream({ async pull(controller) {
      trace.pulls++;
      if (started) return; started = true; controller.enqueue(new TextEncoder().encode('{"results":['));
      try {
        trace.fetchStarted++;
        const held = await fetch(CONTROL + "/hold", { signal: request.signal });
        trace.fetchSettled++;
        await held.body?.cancel(); trace.bodyCancelSettled++; throw new Error("held response ended without original cancellation");
      } catch (error) { controller.error(error); }
      finally { trace.fetchSettled ||= 1; call.finished = true; request.signal.removeEventListener("abort", onAbort); }
    }, cancel() {
      trace.sourceCancel++;
    } }, { highWaterMark: 0 }), { headers });
  }
  call.finished = true;
  if (scenario === "truncated") return new Response('{"results":[', { headers });
  if (scenario === "malformed") return Response.json({ results: {} });
  if (scenario === "oversized") return Response.json({ results: [{ ...result, summary: "x".repeat(1024 * 1024 + 1) }] });
  if (scenario === "non_success") return Response.json({ error: "synthetic rejection" }, { status: 503 });
  if (scenario === "redirect") return new Response("redirect refused", { status: 307, headers: { ...headers, location: "https://alternate.example/search" } });
  if (scenario === "unsafe") return Response.json({ results: [{ ...result, url: "javascript:void(0)" }] });
  if (scenario === "encoding") return Response.json({ results: [] }, { headers: { "content-encoding": "unsupported-encoding" } });
  return Response.json({ results: ["empty", "fixed"].includes(scenario) ? [] : [result] });
} };
`.replace("CONTROL", JSON.stringify(control));
}
