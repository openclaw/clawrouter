import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { affectsOpenClawContract } from "../scripts/openclaw-contract-changes.mjs";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "6de028c4e960db91bdf87882989cb6756a6429c3";
const scenarios = ["success", "unpriced", "denied", "stale", "malformed", "partial", "error", "redirect", "truncated", "rotation", "missing_key", "unsafe_headers", "preabort", "abort", "invalid_input"];
const profiles = [
  { provider: "groq", upstream: "whisper-large-v3-turbo", origin: "https://api.groq.com", path: "/openai/v1/audio/transcriptions" },
  { provider: "mistral", upstream: "voxtral-mini-latest", origin: "https://api.mistral.ai", path: "/v1/audio/transcriptions" },
];
const cases = profiles.flatMap(profile => scenarios.map(scenario => ({ ...profile, scenario,
  id: `${profile.provider}_${scenario}`, model: `${profile.provider}/${profile.upstream}`,
  route: `/v1/native/${profile.provider}/v1/audio/transcriptions`, format: `${profile.provider}.transcription`,
})));
const denied = new Set(["unpriced", "denied", "stale", "missing_key", "unsafe_headers", "preabort", "invalid_input"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const token = (row, rotated = false) => `clawrouter-live-${row.id}-${rotated ? "rotated-secret" : "fixture-secret"}`;
const manifests = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => parse(readFileSync(`providers/${path}`, "utf8")));
// Actual compilation precedes every Worker evaluation; never inject snapshot cards.
assert.deepEqual(compileProviderSnapshot(manifests), snapshot);

const audioSdkText = readFileSync(new URL("./fixtures/openclaw-groq-mistral-transcription-contract.test.ts", import.meta.url), "utf8");
const audioProtocolStart = audioSdkText.indexOf("// BEGIN audio diagnostic protocol."), audioProtocolEnd = audioSdkText.indexOf("// END audio diagnostic protocol.");
assert.ok(audioProtocolStart >= 0 && audioProtocolEnd > audioProtocolStart);
const audioProtocol = new Function(stripTypeScriptTypes(audioSdkText.slice(audioProtocolStart, audioProtocolEnd)) + "; return audioDiagnosticProtocol;")()(nodeTypes.isProxy);
assert.deepEqual([...audioProtocol.ids], cases.map(row => row.id));
assert.equal(audioProtocol.pin, sourceHead);

function audioDiagnosticSession(write = line => process.stdout.write(line)) {
  const emitter = audioProtocol.emitter(write), failures = [], observers = [];
  let evidence;
  function mark(phase, caseId, role, outcome, failed = false, error, counts = {}) {
    try { emitter.put(audioProtocol.record({ source: "outer", caseId, phase, role, outcome, ...(failed ? audioProtocol.errorClass(error) : {}),
      ...(phase === "upstream_sqlite" ? evidence ?? {} : {}), ...counts }, failed, error)); }
    catch (failure) { failures.push(failure); }
  }
  function rejected(error) {
    mark("helper", null, "primary", "rejected", true, error);
    const visited = new Set(), pending = [error], checkpoints = new Map(); let records = 0, invalid = 0, inputBytes = 0;
    // The helper's AggregateError owns an errors array. Do not walk prototypes,
    // getters, arbitrary messages or a speculative cause/serialization graph.
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || nodeTypes.isProxy(current) || !nodeTypes.isNativeError(current) || visited.has(current)) continue;
      if (visited.size >= 32) { invalid++; break; }
      visited.add(current);
      for (const key of ["stdout", "stderr"]) {
        const text = audioProtocol.own(current, key);
        if (typeof text === "string") inputBytes += Buffer.byteLength(text);
        if (inputBytes > 4 * 1024 * 1024) { invalid++; continue; }
        const parsed = audioProtocol.parse(text, row => {
          if (records >= 512) { invalid++; return; }
          emitter.put(row); records++;
          if (audioProtocol.checkpointIds.includes(row.caseId) && ["body", "checkpoint"].includes(row.phase) && Object.hasOwn(row, "checkpoint")) {
            const previous = checkpoints.get(row.caseId);
            if (!previous || row.phase === "checkpoint" || previous.phase !== "checkpoint") checkpoints.set(row.caseId, { ...row, errorCode: row.errorCode ?? previous?.errorCode });
          }
        });
        invalid += parsed.invalid;
      }
      const children = audioProtocol.own(current, "errors");
      if (!children || nodeTypes.isProxy(children) || !Array.isArray(children)) continue;
      const length = audioProtocol.own(children, "length");
      if (!Number.isSafeInteger(length) || length < 0 || length > 32) { invalid++; continue; }
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(children, String(i));
        if (!descriptor || !("value" in descriptor)) { invalid++; continue; }
        if (pending.length >= 32) { invalid++; break; }
        pending.push(descriptor.value);
      }
    }
    if (invalid) failures.push(new Error("incomplete audio child diagnostics"));
    const summary = {};
    for (const [index, key] of ["gs", "gr", "ms"].entries()) {
      const value = checkpoints.get(audioProtocol.checkpointIds[index]);
      Object.assign(summary, { [key + "Step"]: value?.checkpoint ?? null, [key + "Call"]: value?.callOutcome ?? "unseen",
        [key + "Defined"]: value?.callReasonDefined ?? null, [key + "Same"]: value?.bodyReasonSameAsCallReason ?? null,
        [key + "Code"]: value?.errorCode ?? "unobserved" });
    }
    mark("report", null, "summary", invalid ? "rejected" : records ? "fulfilled" : "unknown", invalid > 0, undefined,
      { records, invalid: Math.min(65535, invalid), ...summary });
    emitter.checkpoint();
  }
  function observe(phase, caseId, start) {
    let original;
    try { original = start(); } catch (error) { mark(phase, caseId, "cleanup", "rejected", true, error); throw error; }
    if (original instanceof Promise) observers.push(original.then(
      () => { mark(phase, caseId, "cleanup", "fulfilled"); },
      error => { mark(phase, caseId, "cleanup", "rejected", true, error); },
    ));
    else mark(phase, caseId, "cleanup", "fulfilled");
    return original;
  }
  return { mark, observe, evidence(step, caseId = null, calls = null, events = null, expected = null) {
    evidence = undefined;
    try {
      const detail = { sqlStep: step, sqlCase: caseId, sqlCalls: calls, sqlEvents: events, sqlExpected: expected };
      audioProtocol.record({ source: "outer", caseId: null, phase: "upstream_sqlite", role: "progress", outcome: "entered", ...detail });
      evidence = detail;
    } catch (error) { failures.push(error); }
  }, rejected(error) { try { rejected(error); } catch (failure) { failures.push(failure); } }, async finish() {
    await Promise.all(observers);
    await finishOwned(failures, [() => emitter.flush()]);
  } };
}

const audioDiagnosticContext = (changes = {}) => ({ source: "sdk", caseId: "groq_success", phase: "body", role: "primary", outcome: "rejected", ...changes });
test("audio closed diagnostics validate exact source, identities, fields and primitive bounds", async t => {
  const good = audioProtocol.record(audioDiagnosticContext(), true, undefined);
  assert.equal(audioProtocol.ids.size, 30); assert.equal(good.failurePresent, true);
  assert.equal(good.reasonDefined, false); assert.equal(good.reasonType, "undefined");
  let getters = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack", "stdout", "stderr", "cause"].map(key => [key, { get() { getters++; throw undefined; } }])));
  assert.equal(audioProtocol.record(audioDiagnosticContext(), true, hostile).reasonType, "object");
  for (const key of ["stdout", "stderr", "cause"]) assert.equal(audioProtocol.own(hostile, key), undefined);
  const proxy = new Proxy({}, { getPrototypeOf() { getters++; throw undefined; }, ownKeys() { getters++; throw undefined; }, getOwnPropertyDescriptor() { getters++; throw undefined; } });
  assert.equal(audioProtocol.validate(proxy), undefined); assert.equal(audioProtocol.own(proxy, "stdout"), undefined);
  assert.equal(audioProtocol.validate(Object.defineProperty({ ...good }, "phase", { get() { getters++; throw undefined; } })), undefined);
  assert.equal(getters, 0);
  const invalid = [{ pin: "wrong" }, { source: "worker" }, { caseId: "groq_other" }, { caseId: null },
    { phase: "foreign" }, { role: "foreign" }, { outcome: "fulfilled" }, { reasonType: "Error" }, { reasonDefined: true },
    { partialDelivery: true }, { records: -1 }, { records: 65536 }, { records: Infinity }, { records: "1" },
    { message: "private" }, { url: "private" }, { stack: "private" }, { arbitrary: true }];
  for (const [index, changes] of invalid.entries()) await t.test(String(index), () => assert.equal(audioProtocol.validate({ ...good, ...changes }), undefined));
  assert.ok(audioProtocol.validate({ ...good, records: 65535, invalid: 0, suppressed: 1 }));
});

test("audio closed diagnostics parse only complete column-zero child records", () => {
  const row = audioProtocol.record(audioDiagnosticContext(), true, undefined), accepted = [];
  const line = audioProtocol.prefix + JSON.stringify(row);
  const result = audioProtocol.parse("private prose\n # " + line + "\n\u001b[31m" + line + "\n" + line + "\n", value => accepted.push(value));
  assert.deepEqual(result, { records: 1, invalid: 0 }); assert.deepEqual(accepted, [row]);
  for (const value of ["{", JSON.stringify({ ...row, source: "outer" }), JSON.stringify({ ...row, pin: "wrong" }), "x".repeat(641)]) {
    assert.equal(audioProtocol.parse(audioProtocol.prefix + value + "\n", () => assert.fail()).invalid, 1);
  }
  assert.equal(audioProtocol.parse("x".repeat(2 * 1024 * 1024 + 1), () => assert.fail()).invalid, 1);
  assert.deepEqual(audioProtocol.parse((line + "\n").repeat(513), () => {}), { records: 512, invalid: 1 });
});

test("audio closed diagnostics preserve original AggregateError, undefined and cleanup outcomes", async () => {
  const lines = [], session = audioDiagnosticSession(line => lines.push(line));
  const record = audioProtocol.record(audioDiagnosticContext(), true, undefined);
  const child = Object.assign(new Error("private child"), { stdout: audioProtocol.prefix + JSON.stringify(record) + "\n", stderr: "private unrelated bytes" });
  let getters = 0;
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(child, key, { get() { getters++; throw undefined; } });
  const cleanup = new Error("private cleanup"), aggregate = new AggregateError([child, cleanup, undefined], "private aggregate");
  aggregate.errors.push(aggregate, child);
  session.rejected(aggregate);
  const outcome = Promise.reject(undefined);
  assert.equal(session.observe("worker_retirement", "groq_abort", () => outcome), outcome);
  const later = Promise.resolve(); assert.equal(session.observe("worker_retirement", "mistral_abort", () => later), later);
  const failures = [aggregate];
  let caught;
  try { await finishOwned(failures, [() => outcome, () => session.finish()]); } catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0], aggregate); assert.equal(caught.errors[1], undefined);
  assert.equal(getters, 0); assert.ok(lines.every(line => !line.includes("private")));
  const records = lines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length)));
  assert.equal(records.filter(row => row.source === "sdk" && row.caseId === "groq_success").length, 1);
  assert.ok(records.some(row => row.phase === "worker_retirement" && row.caseId === "groq_abort" && row.failurePresent && !row.reasonDefined));
  assert.ok(records.some(row => row.phase === "worker_retirement" && row.caseId === "mistral_abort" && row.outcome === "fulfilled"));
  const unchanged = audioDiagnosticSession(() => {});
  unchanged.rejected(aggregate);
  await assert.rejects(finishOwned([aggregate], [() => unchanged.finish()]), error => error === aggregate);
});

test("audio closed diagnostics never invoke child getters or walk unbounded error graphs", async () => {
  let getters = 0; const error = new Error("private");
  for (const key of ["stdout", "stderr", "errors", "cause"]) Object.defineProperty(error, key, { get() { getters++; throw undefined; } });
  const session = audioDiagnosticSession(() => {}); session.rejected(error); await session.finish(); assert.equal(getters, 0);
  const cyclic = new AggregateError([], "private"); cyclic.errors.push(cyclic);
  const cycleSession = audioDiagnosticSession(() => {}); cycleSession.rejected(cyclic); await cycleSession.finish();
  const tooMany = new AggregateError(Array.from({ length: 33 }, () => new Error("private")), "private");
  const limited = audioDiagnosticSession(() => {}); limited.rejected(tooMany); await assert.rejects(limited.finish(), /incomplete audio/);
  const malformed = audioDiagnosticSession(() => {}); malformed.rejected(Object.assign(new Error(), { stdout: audioProtocol.prefix + "{}\n" }));
  await assert.rejects(malformed.finish(), /incomplete audio/);
});

function fillAudioDiagnosticBudget(emitter) {
  for (const caseId of audioProtocol.ids) {
    emitter.put(audioProtocol.record(audioDiagnosticContext({ caseId }), true, undefined));
    emitter.put(audioProtocol.record(audioDiagnosticContext({ caseId, phase: "original_join", role: "cleanup" }), true, new Error()));
  }
  for (const caseId of ["groq_abort", "mistral_abort"]) emitter.put(audioProtocol.record(audioDiagnosticContext({ source: "outer", caseId, phase: "worker_retirement", role: "cleanup", outcome: "fulfilled" })));
  emitter.put(audioProtocol.record(audioDiagnosticContext({ source: "outer", caseId: null, phase: "report", role: "summary" }), true, undefined));
}
test("audio closed diagnostics reserve essential families within the step quota and deduplicate", () => {
  const lines = [], emitter = audioProtocol.emitter(line => lines.push(line));
  fillAudioDiagnosticBudget(emitter); emitter.flush(); emitter.flush();
  assert.equal(lines.length, 10); assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  assert.ok(lines.every(line => line.startsWith("::error title=Audio contract diagnostic::") && Buffer.byteLength(line) <= 768 && line.split("\n").length === 2));
  const records = lines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length)));
  assert.ok(records.every(row => audioProtocol.validate(row)));
  assert.ok(records.some(row => row.source === "sdk" && row.role === "primary"));
  assert.ok(records.some(row => row.source === "sdk" && row.phase === "original_join"));
  for (const caseId of ["groq_abort", "mistral_abort"]) assert.ok(records.some(row => row.phase === "worker_retirement" && row.caseId === caseId));
  assert.ok(records.some(row => row.phase === "report")); assert.equal(records.at(-1).phase, "capacity");
  const repeated = [], duplicate = audioProtocol.emitter(line => repeated.push(line));
  const row = audioProtocol.record(audioDiagnosticContext(), true, undefined);
  for (let i = 0; i < 20; i++) duplicate.put(row);
  duplicate.flush(); assert.equal(repeated.length, 1);
  const early = [], checkpoint = audioProtocol.emitter(line => early.push(line));
  checkpoint.put(audioProtocol.record(audioDiagnosticContext(), true, new Error())); checkpoint.checkpoint();
  assert.equal(early.length, 1);
  fillAudioDiagnosticBudget(checkpoint); checkpoint.flush();
  assert.ok(early.length <= 10);
  const earlyRows = early.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length)));
  assert.ok(earlyRows.some(row => row.failurePresent && row.reasonDefined === false));
  for (const caseId of ["groq_abort", "mistral_abort"]) assert.ok(earlyRows.some(row => row.phase === "worker_retirement" && row.caseId === caseId));
});

test("audio closed diagnostics retain delivery failure without masking original undefined", async () => {
  let attempts = 0; const session = audioDiagnosticSession(() => { attempts++; throw undefined; });
  session.rejected(undefined);
  let caught;
  try { await finishOwned([undefined], [() => session.finish()]); } catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0], undefined); assert.ok(caught.errors.length > 1); assert.ok(attempts > 0);
  const passing = []; const pass = audioDiagnosticSession(line => passing.push(line));
  await pass.observe("worker_retirement", "groq_abort", () => Promise.resolve()); await pass.finish(); assert.deepEqual(passing, []);
});

test("audio closed diagnostics SDK observer returns originals and retains reporter failures", async () => {
  const start = audioSdkText.indexOf("function audioCaseDiagnostics("), end = audioSdkText.indexOf("\ntype Case =", start);
  assert.ok(start >= 0 && end > start);
  const create = new Function("audioProtocol", "process", "finishOwned", "let audioRecordCount = 0;\n" + stripTypeScriptTypes(audioSdkText.slice(start, end)) + ";return audioCaseDiagnostics;");
  const lines = [], diagnostic = create(audioProtocol, { stdout: { write(line) { lines.push(line); } } }, finishOwned)("groq_success");
  const original = Promise.reject(undefined); assert.equal(diagnostic.track("original_join", () => original), original);
  await assert.rejects(original, error => error === undefined); await diagnostic.join();
  const rows = []; for (const line of lines) audioProtocol.parse(line, row => rows.push(row));
  assert.equal(rows[0].reasonDefined, false); assert.equal(rows[0].failurePresent, true);
  const token = {}; assert.equal(diagnostic.track("runtime_restore", () => token), token);
  let syncThrown = false; try { diagnostic.track("runtime_restore", () => { throw undefined; }); } catch (error) { syncThrown = true; assert.equal(error, undefined); }
  assert.equal(syncThrown, true); await diagnostic.join();
  const failing = create(audioProtocol, { stdout: { write() { throw undefined; } } }, finishOwned)("groq_success");
  const value = Promise.resolve(); assert.equal(failing.track("original_join", () => value), value);
  let present = false; try { await failing.join(); } catch (error) { present = true; assert.equal(error, undefined); } assert.equal(present, true);
});

test("audio diagnostic reporter subprocess", { skip: process.env.AUDIO813_REPORTER_TEST !== "1" }, () => {
  const emitter = audioProtocol.emitter(line => process.stdout.write(line)); fillAudioDiagnosticBudget(emitter); emitter.flush();
});
test("audio closed diagnostics survive the real Node24 reporter at column zero", { skip: process.env.AUDIO813_REPORTER_TEST === "1", timeout: 20000 }, async () => {
  assert.equal(process.version, "v24.22.1");
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    ["--test", "--test-name-pattern=^audio diagnostic reporter subprocess$", fileURLToPath(import.meta.url)],
    { env: { ...env, AUDIO813_REPORTER_TEST: "1" }, timeout: 15000, maxBuffer: 64 * 1024 },
    (error, value) => { if (error) reject(new Error("audio reporter subprocess failed")); else resolve(value); }));
  const prefix = "::error title=Audio contract diagnostic::", lines = stdout.split(/\r?\n/).filter(line => line.includes(prefix));
  assert.equal(lines.length, 10); assert.ok(lines.every(line => line.startsWith(prefix) && Buffer.byteLength(line) <= 768));
  assert.ok(lines.every(line => audioProtocol.validate(JSON.parse(line.slice(prefix.length)))));
  assert.ok(Buffer.byteLength(lines.join("\n")) <= 8192);
});


function createAssertionCheckpoints(caseId = "groq_success", write = () => {}) {
  const start = audioSdkText.indexOf("// BEGIN passive assertion checkpoints."), end = audioSdkText.indexOf("// END passive assertion checkpoints.");
  assert.ok(start >= 0 && end > start);
  const rows = [];
  const diagnostic = { mark(phase, role, outcome, failed = false, error, detail = {}) {
    const row = audioProtocol.record({ source: "sdk", caseId, phase, role, outcome, ...detail }, failed, error);
    rows.push(row); write(row);
  } };
  const factory = new Function("audioProtocol", "nodeTypes", "finishOwned",
    stripTypeScriptTypes(audioSdkText.slice(start, end)) + ";return audioAssertionCheckpoints;")(audioProtocol, nodeTypes, finishOwned);
  return { observer: factory(caseId, diagnostic), rows };
}
const checkpointRow = (caseId, changes = {}) => audioProtocol.record({ source: "sdk", caseId, phase: "checkpoint", role: "summary", outcome: "fulfilled",
  checkpoint: caseId === "groq_rotation" ? "old_rejection" : "native_rejection", callOutcome: "rejected", callReasonDefined: false, bodyReasonSameAsCallReason: true,
  bodyFailurePresent: true, callbackFailurePresent: true, scopeSameAsCallback: true, cleanupOutcome: "fulfilled", restoreEnvOutcome: "fulfilled", ...changes });

test("audio checkpoints preserve original calls, receiver, arguments and promise identity", async () => {
  const { observer, rows } = createAssertionCheckpoints(), receiver = {}, arg = {};
  let resolve, calls = 0;
  const original = new Promise(done => { resolve = done; });
  const wrapped = observer.call(function(value) { calls++; assert.equal(this, receiver); assert.equal(value, arg); return original; });
  observer.before("selected_call");
  assert.equal(Reflect.apply(wrapped, receiver, [arg]), original); assert.equal(calls, 1);
  assert.equal(observer.details().callOutcome, "pending");
  resolve({}); await original;
  assert.equal(observer.details().checkpoint, "result");
  observer.body(undefined); await observer.join();
  assert.equal(rows.at(-1).callOutcome, "fulfilled"); assert.equal(rows.at(-1).bodyReasonSameAsCallReason, null);
  const inactive = createAssertionCheckpoints("mistral_rotation");
  assert.equal(inactive.observer.call(wrapped), wrapped); await inactive.observer.join(); assert.deepEqual(inactive.rows, []);
  assert.equal(inactive.observer.scopeRole(), "progress");
});

test("audio checkpoints retain defined and undefined call rejection without changing assertions", async t => {
  for (const reason of [undefined, {}, null]) for (const synchronous of [true, false]) await t.test(`${typeof reason}/${synchronous}`, async () => {
    const { observer, rows } = createAssertionCheckpoints(); observer.before("native_rejection");
    let original;
    const call = observer.call(() => { if (synchronous) throw reason; return original = Promise.reject(reason); });
    let present = false;
    try { const result = call(); assert.equal(result, original); await result; } catch (error) { present = true; assert.equal(error, reason); observer.body(error); }
    assert.equal(present, true); await observer.join();
    const row = rows.at(-1); assert.equal(row.bodyReasonSameAsCallReason, true); assert.equal(row.callReasonDefined, reason !== undefined);
    assert.equal(row.callOutcome, synchronous ? "sync_throw" : "rejected");
  });
  const { observer } = createAssertionCheckpoints();
  await assert.rejects(observer.call(() => Promise.reject({}))()); observer.body({});
  assert.equal(observer.details().bodyReasonSameAsCallReason, false); await observer.join();
});

test("audio checkpoints preserve actual state methods and distinguish callback rethrow from cleanup", async () => {
  const { observer, rows } = createAssertionCheckpoints(); let state, cleanup, release, receiver;
  const args = [{}]; const descriptors = {
    restoreEnv: { configurable: true, enumerable: false, writable: true, value: function(...seen) { receiver = this; assert.deepEqual(seen, args); return release ??= Promise.resolve(); } },
    cleanup: { configurable: true, enumerable: true, writable: false, value: function(...seen) { assert.equal(this, state); assert.deepEqual(seen, args); return cleanup ??= Promise.resolve().then(() => Reflect.apply(state.restoreEnv, this, seen)); } },
  };
  state = Object.defineProperties({}, descriptors); observer.attach(state);
  const result = Reflect.apply(state.cleanup, state, args); assert.equal(result, cleanup);
  await result; assert.equal(receiver, state); assert.equal(Reflect.apply(state.restoreEnv, state, args), release);
  observer.body(undefined); observer.callback(undefined); observer.scope(undefined);
  assert.equal(observer.scopeRole(), "progress"); await observer.join();
  for (const key of ["cleanup", "restoreEnv"]) assert.deepEqual(Object.getOwnPropertyDescriptor(state, key), descriptors[key]);
  const summary = rows.at(-1); assert.equal(summary.scopeSameAsCallback, true); assert.equal(summary.callbackFailurePresent, true);
  assert.equal(summary.cleanupOutcome, "fulfilled"); assert.equal(summary.restoreEnvOutcome, "fulfilled");
  assert.ok(!rows.some(row => row.failurePresent));
});

test("audio checkpoints preserve simultaneous body and state failures including undefined", async t => {
  for (const reason of [undefined, {}]) await t.test(typeof reason, async () => {
    const body = {}, cleanup = Promise.reject(reason), release = Promise.reject(undefined), { observer, rows } = createAssertionCheckpoints();
    const state = { cleanup() { return cleanup; }, restoreEnv() { return release; } };
    const originals = Object.getOwnPropertyDescriptors(state); observer.attach(state); observer.body(body); observer.callback(body);
    assert.equal(state.cleanup(), cleanup); assert.equal(state.restoreEnv(), release);
    await Promise.allSettled([cleanup, release]); observer.scope(reason);
    assert.equal(observer.scopeRole(), "cleanup"); await observer.join();
    const faults = rows.filter(row => row.failurePresent); assert.equal(faults.length, 2);
    assert.equal(faults.find(row => row.phase === "state_restore").reasonDefined, false);
    const summary = rows.at(-1); assert.equal(summary.scopeSameAsCallback, false); assert.equal(summary.cleanupOutcome, "rejected");
    assert.deepEqual(Object.getOwnPropertyDescriptors(state), originals);
    let caught; try { await finishOwned([body, reason], []); } catch (error) { caught = error; }
    assert.deepEqual(caught.errors, [body, reason]);
  });
});

test("audio checkpoints keep synchronous state returns and throw undefined exact", async () => {
  const { observer, rows } = createAssertionCheckpoints(); const state = { cleanup() { return undefined; }, restoreEnv() { throw undefined; } };
  observer.attach(state); assert.equal(state.cleanup(), undefined);
  let failed = false; try { state.restoreEnv(); } catch (error) { failed = true; assert.equal(error, undefined); }
  assert.equal(failed, true); await observer.join();
  assert.equal(rows.at(-1).cleanupOutcome, "fulfilled"); assert.equal(rows.at(-1).restoreEnvOutcome, "sync_throw");
});

test("audio checkpoints preserve observer faults and independently restore owned descriptors", async () => {
  let writes = 0; const { observer } = createAssertionCheckpoints("groq_success", () => { writes++; throw undefined; });
  const state = { cleanup() { return Promise.resolve(); }, restoreEnv() { return undefined; } }, originals = Object.getOwnPropertyDescriptors(state);
  observer.attach(state); await state.cleanup(); state.restoreEnv();
  let caught; try { await finishOwned([undefined], [() => observer.join()]); } catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0], undefined); assert.ok(writes >= 3);
  assert.deepEqual(Object.getOwnPropertyDescriptors(state), originals);
  const foreign = createAssertionCheckpoints(), original = { cleanup() {}, restoreEnv() {} }, before = Object.getOwnPropertyDescriptors(original);
  foreign.observer.attach(original); const replacement = () => {}; original.cleanup = replacement;
  await assert.rejects(foreign.observer.join()); assert.equal(original.cleanup, replacement);
  assert.deepEqual(Object.getOwnPropertyDescriptor(original, "restoreEnv"), before.restoreEnv);
  let getters = 0; const hostile = Object.defineProperty({ restoreEnv() {} }, "cleanup", { configurable: true, get() { getters++; throw undefined; } });
  const guarded = createAssertionCheckpoints(); guarded.observer.attach(hostile); await assert.rejects(guarded.observer.join()); assert.equal(getters, 0);
  const proxied = createAssertionCheckpoints(); proxied.observer.attach(new Proxy({}, { getOwnPropertyDescriptor() { getters++; throw undefined; } }));
  await assert.rejects(proxied.observer.join()); assert.equal(getters, 0);
});

test("audio checkpoints validate strict case, phase, failure flags and summary applicability", () => {
  const good = checkpointRow("groq_success"); assert.ok(audioProtocol.validate(good));
  for (const changes of [{ caseId: "mistral_abort" }, { caseId: "groq_rotation" }, { source: "outer" }, { checkpoint: "unknown" }, { callOutcome: "value" },
    { callOutcome: "fulfilled" }, { callReasonDefined: null }, { bodyFailurePresent: false }, { callbackFailurePresent: false },
    { cleanupOutcome: "false" }, { scopeSameAsCallback: "yes" }, { bodyReasonSameAsCallReason: 1 }, { extra: false }]) {
    assert.equal(audioProtocol.validate({ ...good, ...changes }), undefined);
  }
  for (const key of ["checkpoint", "callOutcome", "scopeSameAsCallback", "restoreEnvOutcome"]) {
    const missing = { ...good }; delete missing[key]; assert.equal(audioProtocol.validate(missing), undefined);
  }
  assert.equal(audioProtocol.validate({ ...good, gsCall: "fulfilled" }), undefined);
  const lines = [], session = audioDiagnosticSession(line => lines.push(line));
  const records = audioProtocol.checkpointIds.map((id, index) => checkpointRow(id, { checkpoint: ["native_rejection", "old_status", "result"][index] }));
  session.rejected(Object.assign(new Error(), { stdout: records.map(row => audioProtocol.prefix + JSON.stringify(row)).join("\n") }));
  return session.finish().then(() => {
    const report = lines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length))).find(row => row.phase === "report");
    for (const [index, key] of ["gs", "gr", "ms"].entries()) {
      assert.equal(report[key + "Step"], records[index].checkpoint); assert.equal(report[key + "Call"], "rejected");
      assert.equal(report[key + "Defined"], false); assert.equal(report[key + "Same"], true);
    }
    for (const changes of [{ gsStep: "foreign" }, { gsStep: "rotate" }, { gsStep: null }, { gsCall: "unknown" }, { gsCall: "fulfilled" }, { gsSame: "yes" }, { phase: "helper" }]) assert.equal(audioProtocol.validate({ ...report, ...changes }), undefined);
    const missing = { ...report }; delete missing.msSame; assert.equal(audioProtocol.validate(missing), undefined);
  });
});

function checkpointBudgetChild() {
  const rows = [...audioProtocol.checkpointIds.flatMap(caseId => [
    audioProtocol.record({ ...audioDiagnosticContext({ caseId }), checkpoint: caseId === "groq_rotation" ? "selected_call" : "proxy_profile_rejected", callOutcome: "sync_throw", callReasonDefined: true, bodyReasonSameAsCallReason: true,
      ...audioProtocol.errorClass({ code: "ERR_INVALID_ARG_TYPE" }) }, true, {}),
    checkpointRow(caseId, { checkpoint: caseId === "groq_rotation" ? "selected_call" : "proxy_profile_rejected", callOutcome: "sync_throw", callReasonDefined: true }),
  ])];
  for (let i = 0; i < 5; i++) for (const caseId of audioProtocol.ids) {
    rows.push(audioProtocol.record(audioDiagnosticContext({ caseId }), true, undefined));
    rows.push(audioProtocol.record(audioDiagnosticContext({ caseId, phase: "original_join", role: "cleanup" }), true, {}));
  }
  return Object.assign(new Error("not forwarded"), { stdout: rows.map(row => audioProtocol.prefix + JSON.stringify(row)).join("\n"), stderr: "" });
}
function checkCheckpointSummary(lines) {
  assert.ok(lines.length <= 10); assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  assert.ok(lines.every(line => line.startsWith("::error title=Audio contract diagnostic::") && Buffer.byteLength(line) <= 768));
  const rows = lines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length)));
  assert.ok(rows.every(row => audioProtocol.validate(row))); const summary = rows.find(row => row.phase === "report"); assert.ok(summary);
  for (const key of ["gs", "gr", "ms"]) { assert.equal(summary[key + "Step"], key === "gr" ? "selected_call" : "proxy_profile_rejected"); assert.equal(summary[key + "Call"], "sync_throw"); assert.equal(summary[key + "Defined"], true); assert.equal(summary[key + "Same"], true); assert.equal(summary[key + "Code"], "invalid_argument"); }
  for (const caseId of ["groq_abort", "mistral_abort"]) assert.ok(rows.some(row => row.phase === "worker_retirement" && row.caseId === caseId));
  assert.ok(rows.some(row => row.role === "primary" && row.source === "sdk")); assert.ok(rows.some(row => row.phase === "original_join"));
  assert.ok(rows.some(row => row.failurePresent && row.reasonDefined === false)); assert.equal(rows.at(-1).phase, "capacity");
  assert.ok(rows.some(row => row.phase === "upstream_sqlite" && row.sqlStep === "egress_count"));
}
test("audio checkpoints retain all three summaries alongside essential failures at quota", async () => {
  const lines = [], session = audioDiagnosticSession(line => lines.push(line)); session.rejected(checkpointBudgetChild());
  for (const caseId of ["groq_abort", "mistral_abort"]) await session.observe("worker_retirement", caseId, () => Promise.resolve());
  session.evidence("egress_count", "groq_success", 0, null, 1);
  await assert.rejects(session.observe("upstream_sqlite", null, () => Promise.reject(undefined)), error => error === undefined);
  await session.finish(); checkCheckpointSummary(lines);
});
test("audio checkpoint subprocess", { skip: process.env.AUDIO813_CHECKPOINT_TEST !== "1" }, async () => {
  const session = audioDiagnosticSession(); session.rejected(checkpointBudgetChild());
  for (const caseId of ["groq_abort", "mistral_abort"]) await session.observe("worker_retirement", caseId, () => Promise.resolve());
  session.evidence("egress_count", "groq_success", 0, null, 1);
  await assert.rejects(session.observe("upstream_sqlite", null, () => Promise.reject(undefined)), error => error === undefined);
  await session.finish();
});
test("audio checkpoints retain column-zero summaries through real Node24 child output", { skip: process.env.AUDIO813_CHECKPOINT_TEST === "1", timeout: 20000 }, async () => {
  assert.equal(process.version, "v24.22.1"); const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
    ["--test", "--test-name-pattern=^audio checkpoint subprocess$", fileURLToPath(import.meta.url)],
    { env: { ...env, AUDIO813_CHECKPOINT_TEST: "1" }, timeout: 15000, maxBuffer: 64 * 1024 },
    (error, value) => error ? reject(new Error("audio checkpoint child failed")) : resolve(value)));
  const prefix = "::error title=Audio contract diagnostic::";
  checkCheckpointSummary(stdout.split(/\r?\n/).filter(line => line.includes(prefix)));
});

test("audio checkpoints inverse preserves every original runCase operand and all thirty IDs", () => {
  const start = audioSdkText.indexOf("async function runCase("), end = audioSdkText.indexOf("\ndescribe(", start);
  let restored = audioSdkText.slice(start, end)
    .replace(/^.*\/\/ passive checkpoint\n/gm, "")
    .replace('        expect(isMainThread).toBe(true); // Real host broker, never a simulated SQLite owner.\n', "")
    .replace(', headers: { "accept-encoding": "identity" }', "")
    .replace(/^.*\/\/ passive profile wrapper\n/gm, "").replaceAll("await writeProfile(", "await upsertAuthProfileAsync(")
    .replace(/ \/\* checkpoint:[a-z_]+ \*\/ checkpoint\.before\("[a-z_]+"\);/g, "")
    .replace("const call = checkpoint.call(", "const call = ").replace("})); // passive call wrapper", "});")
    .replace("checkpoint.body(error); /* passive body */ ", "")
    .replace(", error, checkpoint.details(transports, row.route));", ", error);")
    .replace("checkpoint.callback(error); /* passive callback */ ", "")
    .replace('checkpoint.scopeRole()', '"cleanup"')
    .replace("[() => checkpoint.join(), () => diagnostic.join()]", "[() => diagnostic.join()]");
  assert.equal(hash(restored), "9b1b0db04b9c69711f42a2a2c5bf07ba1059df10d3734b5cd40dc66184db6f54");
  assert.deepEqual([...audioProtocol.ids], cases.map(row => row.id)); assert.equal(cases.length, 30);
});


test("audio boundary profile wrapper preserves invocation, original return and undefined reasons", async t => {
  for (const mode of ["promise_reject", "promise_fulfill", "sync_throw", "sync_value"]) await t.test(mode, async () => {
    const { observer } = createAssertionCheckpoints(), owner = {}, operand = {};
    let calls = 0, resolve, reject, original;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const wrapped = observer.profile(function(...args) {
      calls++; assert.equal(this, owner); assert.deepEqual(args, [operand]);
      assert.equal(observer.details().checkpoint, "proxy_profile_invoke");
      if (mode === "sync_throw") throw undefined;
      return original = mode === "sync_value" ? operand : pending;
    });
    observer.before("proxy_profile");
    if (mode === "sync_throw") {
      let present = false; try { Reflect.apply(wrapped, owner, [operand]); } catch (error) { present = true; assert.equal(error, undefined); }
      assert.equal(present, true); assert.equal(observer.details().checkpoint, "proxy_profile_throw"); resolve();
    } else {
      const returned = Reflect.apply(wrapped, owner, [operand]); assert.equal(returned, original);
      assert.equal(observer.details().checkpoint, mode === "sync_value" ? "proxy_profile_value" : "proxy_profile_promise");
      if (mode === "promise_reject") { reject(undefined); await assert.rejects(returned, reason => reason === undefined); }
      else { resolve(operand); await returned; }
      assert.equal(observer.details().checkpoint, mode === "promise_reject" ? "proxy_profile_rejected" : mode === "sync_value" ? "proxy_profile_value" : "proxy_profile_fulfilled");
    }
    assert.equal(calls, 1); assert.equal(observer.details().callOutcome, "unseen"); await observer.join();
  });
});

test("audio boundary error categories use only own data and never inspect arbitrary payloads", () => {
  let invoked = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["code", "name", "message", "stack", "actual", "expected"].map(key => [key, { get() { invoked++; throw undefined; } }])));
  assert.deepEqual(audioProtocol.errorClass(hostile), { errorCode: "unobserved", errorName: "unobserved" });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { invoked++; throw undefined; } });
  assert.deepEqual(audioProtocol.errorClass(proxy), { errorCode: "unobserved", errorName: "unobserved" });
  const secret = { toString() { invoked++; throw undefined; } };
  assert.deepEqual(audioProtocol.errorClass({ code: secret, name: secret }), { errorCode: "other", errorName: "other" });
  assert.deepEqual(audioProtocol.errorClass(Object.create({ code: "ERR_ASSERTION", name: "AssertionError" })), { errorCode: "unobserved", errorName: "unobserved" });
  for (const [code, kind] of [["ERR_ASSERTION", "assertion"], ["SQLITE_BUSY", "sqlite_busy"], ["ERR_MODULE_NOT_FOUND", "module_missing"], ["private", "other"]]) {
    assert.equal(audioProtocol.errorClass({ code }).errorCode, kind);
  }
  assert.equal(invoked, 0);
  const good = audioProtocol.record({ ...audioDiagnosticContext(), ...audioProtocol.errorClass({ code: "ERR_ASSERTION", name: "AssertionError" }) }, true, {});
  assert.ok(audioProtocol.validate(good));
  for (const changes of [{ errorCode: "ERR_ASSERTION" }, { errorName: "private" }, { message: "private" }, { failurePresent: false, reasonDefined: null, reasonType: "none", outcome: "fulfilled" }]) assert.equal(audioProtocol.validate({ ...good, ...changes }), undefined);
});

test("audio boundary state methods retain invocation and original return-kind observations", async () => {
  const { observer, rows } = createAssertionCheckpoints(); const promise = Promise.resolve();
  const state = { cleanup() { assert.deepEqual(rows.at(-1).returnKind, "none"); return promise; }, restoreEnv() { throw undefined; } };
  observer.attach(state); assert.equal(state.cleanup(), promise);
  assert.equal(rows.at(-1).returnKind, "promise"); await promise;
  let present = false; try { state.restoreEnv(); } catch (error) { present = true; assert.equal(error, undefined); }
  assert.equal(present, true); await observer.join();
  assert.deepEqual(rows.filter(row => row.phase === "state_cleanup").map(row => [row.outcome, row.returnKind]), [["entered", "none"], ["entered", "promise"], ["fulfilled", "promise"]]);
  assert.deepEqual(rows.filter(row => row.phase === "state_restore").map(row => [row.outcome, row.returnKind, row.reasonDefined]), [["entered", "none", null], ["rejected", "none", false]]);
});

test("audio boundary SQLite observer names the original failed assertion and preserves counts and reason", async () => {
  const row = cases.find(row => row.id === "groq_success"), lines = [], session = audioDiagnosticSession(line => lines.push(line));
  let original;
  assert.throws(() => session.observe("upstream_sqlite", null, () => {
    try { assertShippingEvidence({ calls: [] }, { usage: { events: [] }, policies: [] }, [row], session.evidence); }
    catch (error) { original = error; throw error; }
  }), error => error === original);
  await session.finish(); const failure = lines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length))).find(row => row.phase === "upstream_sqlite");
  assert.equal(failure.sqlStep, "egress_count"); assert.equal(failure.sqlCase, "groq_success");
  assert.equal(failure.sqlCalls, 0); assert.equal(failure.sqlEvents, null); assert.equal(failure.sqlExpected, 1); assert.equal(failure.errorCode, "assertion");
  for (const changes of [{ sqlStep: "unknown" }, { sqlCase: "unknown" }, { sqlCase: null }, { sqlStep: "wire_auth" }, { sqlStep: "held" }, { sqlCalls: -1 }, { sqlEvents: 65536 }, { sqlExpected: 2 }, { phase: "helper" }]) assert.equal(audioProtocol.validate({ ...failure, ...changes }), undefined);
  const missing = { ...failure }; delete missing.sqlStep; assert.equal(audioProtocol.validate(missing), undefined);
  const undefinedLines = [], undefinedSession = audioDiagnosticSession(line => undefinedLines.push(line));
  assert.throws(() => undefinedSession.observe("upstream_sqlite", null, () => {
    assertShippingEvidence(Object.defineProperty({}, "calls", { get() { throw undefined; } }), {}, [row], undefinedSession.evidence);
  }), error => error === undefined);
  await undefinedSession.finish(); const undef = undefinedLines.map(line => JSON.parse(line.slice("::error title=Audio contract diagnostic::".length))).find(row => row.phase === "upstream_sqlite");
  assert.equal(undef.sqlStep, "row"); assert.equal(undef.reasonDefined, false); assert.equal(undef.failurePresent, true);
});


test("audio boundary transport metadata remains bounded and never reads credentials or response bodies", async () => {
  const { observer } = createAssertionCheckpoints(), error = Object.assign(new Error(), { code: "ERR_INVALID_ARG_TYPE", name: "AssertionError" });
  observer.before("selected_call"); await assert.rejects(observer.call(() => Promise.reject(error))()); observer.body(error);
  let reads = 0;
  const transport = path => Object.defineProperties({ path, status: 599 }, { credential: { get() { reads++; throw undefined; } }, body: { get() { reads++; throw undefined; } } });
  const detail = observer.details([transport("/v1/catalog"), transport("/owned")], "/owned");
  const record = audioProtocol.record({ ...audioDiagnosticContext(), ...detail, ...audioProtocol.errorClass(error) }, true, error);
  assert.equal(record.catalogCount, 1); assert.equal(record.uploadCount, 1); assert.equal(record.catalogStatus, 599); assert.equal(record.uploadStatus, 599);
  assert.equal(reads, 0); assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 640);
  for (const changes of [{ catalogCount: 65536 }, { uploadStatus: 600 }, { catalogStatus: "200" }, { source: "outer" }, { caseId: "groq_abort" }, { phase: "checkpoint" }]) assert.equal(audioProtocol.validate({ ...record, ...changes }), undefined);
  await observer.join();
});

test("audio boundary inverse preserves every original SQLite request and assertion operand", () => {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8"), start = text.indexOf("\nasync function verify(") + 1, end = text.indexOf("\nfunction assertShippingJoin", start);
  const restored = text.slice(start, end).replace(/^.*\/\/ passive evidence\n/gm, "")
    .replace(/\/\* evidence:[a-z_]+ \*\/ checkpoint\?\.\([^;]+\); /g, "")
    .replaceAll("rows, checkpoint)", "rows)")
    .replace(" assert.equal(call.producerActivePulls, 0); assert.equal(call.producerActiveCancels, 0); assert.equal(call.producerCallbacksJoined, true);", "")
    .replace('for (const field of ["input_tokens", "output_tokens", "total_tokens"]) { assert.equal(event[field], null); }', 'for (const field of ["input_tokens", "output_tokens", "total_tokens"]) assert.equal(event[field], null);');
  assert.equal(hash(restored), "aa72b8f76adb67c5a41df5e525fac44f9c3d02544fe20de8cd19fa1fe48c7f57");
});

function wav() {
  const bytes = Buffer.alloc(2048, 42);
  bytes.write("RIFF"); bytes.writeUInt32LE(2040, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2004, 40);
  return bytes;
}

async function finishOwned(failures, operations) {
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "transcription body or owned cleanup failed");
}

const livePhaseNames = ["setup", "temporary", "upload_dispatch", "upload_headers", "upload_body", "state_dispatch", "state_headers", "state_body", "abort_dispatch", "abort_headers", "abort_body", "join_dispatch", "join_headers", "join_body", "verify", "upstream_observe", "sqlite_dispatch", "sqlite_headers", "sqlite_body", "sqlite_observe", "dispose", "rm", "handler", "router_control", "control_accepted", "owner_control", "owner_abort", "router_join_control", "router_join_handler", "router_join_waituntil", "router_join_reader", "router_join_observers", "router_join_unlock", "router_join_producer", "producer_pull", "producer_timer", "producer_signal", "producer_cancel", "producer_pending", "producer_join", "waituntil", "waituntil_snapshot", "reader_read", "reader_cancel", "reader_closed", "reader_unlock", "http_wait", "http_census", "http_restore", "http_wait_join", "limit"];
function validateLivePhase(row) {
  const keys = new Set(["v", "isolate", "seq", "case", "phase", "state", "defined", "type", "status", "ordinal", "observed", "allowed", "role", "part", "inputState", "waitState", "callerBefore", "signalBefore", "callerNow", "signalNow", "sameInputReturn", "reasonCaller", "reasonSignal", "total", "pairs", "unclassified", "inputPending", "waitPending", "inputRejected", "waitRejected", "failures", "incomplete", "restored"]);
  if (!row || Object.getPrototypeOf(row) !== Object.prototype) throw new Error("phase object");
  for (const key of Reflect.ownKeys(row)) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!keys.has(key) || !descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("phase field");
  }
  if (row.v !== 1 || !["node", "router", "upstream"].includes(row.isolate) || !Number.isSafeInteger(row.seq) || row.seq < 1 || row.seq > 128
    || row.case !== "groq_abort" || !livePhaseNames.includes(row.phase) || !["enter", "fulfill", "reject"].includes(row.state)) throw new Error("phase identity");
  if (Object.hasOwn(row, "defined") && typeof row.defined !== "boolean") throw new Error("phase defined");
  if (Object.hasOwn(row, "type") && !["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"].includes(row.type)) throw new Error("phase type");
  if (Object.hasOwn(row, "status") && !(Number.isInteger(row.status) && row.status >= 100 && row.status <= 599)) throw new Error("phase status");
  if (Object.hasOwn(row, "ordinal") && !(Number.isSafeInteger(row.ordinal) && row.ordinal >= 1 && row.ordinal <= 128)) throw new Error("phase ordinal");
  if (Object.hasOwn(row, "observed") && !["pending", "fulfilled", "rejected", "sync_throw"].includes(row.observed)) throw new Error("phase observed");
  if (Object.hasOwn(row, "allowed") && typeof row.allowed !== "boolean") throw new Error("phase allowed");
  if (Object.hasOwn(row, "role") && !["fetch", "decoder", "unclassified"].includes(row.role)) throw new Error("wait role");
  if (Object.hasOwn(row, "part") && !["input", "wait"].includes(row.part)) throw new Error("wait part");
  for (const key of ["inputState", "waitState"]) if (Object.hasOwn(row, key) && !["pending", "fulfilled", "rejected", "sync_throw"].includes(row[key])) throw new Error("wait state");
  for (const key of ["callerBefore", "signalBefore", "callerNow", "signalNow", "sameInputReturn", "reasonCaller", "reasonSignal", "incomplete", "restored"]) if (Object.hasOwn(row, key) && typeof row[key] !== "boolean") throw new Error("wait boolean");
  for (const key of ["total", "pairs", "unclassified", "inputPending", "waitPending", "inputRejected", "waitRejected", "failures"]) if (Object.hasOwn(row, key) && !(Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 128)) throw new Error("wait count");
  return row;
}
function livePhaseWriter(isolate, write) {
  const [maxRecords, maxBytes] = { node: [48, 4608], router: [64, 6144], upstream: [16, 1536] }[isolate];
  let seq = 0, bytes = 0, stopped = false;
  const successfulPolls = new Set();
  const emit = (phase, state, fields = {}) => {
    if (stopped) return;
    // Dispatch entry plus headers outcome covers the same original request.
    // Original failure rows and in-memory ownership records are never coalesced.
    if (phase.endsWith("_dispatch") && state === "fulfill" || phase.endsWith("_headers") && state === "enter"
      || (phase.startsWith("router_join_") || phase === "http_wait_join") && state === "enter"
      || phase === "waituntil_snapshot" && fields.observed === "fulfilled"
      || phase === "producer_pull" && state === "fulfill" || phase === "producer_timer" && state === "enter") return;
    // Keep first poll milestones and every rejection; full operations remain owned.
    if (phase.startsWith("state_") && state !== "reject") {
      const key = phase + ":" + state;
      if (successfulPolls.has(key)) return;
      successfulPolls.add(key);
    }
    // Detailed main wait receipts carry the same census without duplicating fields.
    if (phase === "http_wait") {
      if (fields.observed === "pending") return;
      fields = Object.fromEntries(Object.entries(fields).filter(([key]) =>
        ["ordinal", "role", "part", "observed", "defined", "type", "reasonCaller", "reasonSignal"].includes(key)));
    }
    try {
      let row = validateLivePhase({ v: 1, isolate, seq: seq + 1, case: "groq_abort", phase, state, ...fields });
      let line = "AUDIO813_PHASE " + JSON.stringify(row) + " END";
      if (seq >= maxRecords - 1 || bytes + new TextEncoder().encode(line).byteLength > maxBytes - 180) {
        row = validateLivePhase({ v: 1, isolate, seq: seq + 1, case: "groq_abort", phase: "limit", state: "reject" });
        line = "AUDIO813_PHASE " + JSON.stringify(row) + " END"; stopped = true;
      }
      seq++; bytes += new TextEncoder().encode(line).byteLength; write(line);
    } catch { stopped = true; }
  };
  const rejected = error => ({ defined: error !== undefined, type: error === null ? "null" : typeof error });
  return { emit, get incomplete() { return stopped; }, watch(phase, original, headers = false) {
    emit(phase, "enter");
    // These observers never replace the original promise or throw into its owner.
    void original.then(value => {
      try { emit(phase, "fulfill", headers ? { status: value.status } : {}); } catch { stopped = true; }
    }, error => { emit(phase, "reject", rejected(error)); });
    return original;
  }, start(phase, start) {
    emit(phase, "enter");
    try {
      const original = start();
      if (original && typeof original.then === "function") void original.then(() => emit(phase, "fulfill"), error => emit(phase, "reject", rejected(error)));
      else emit(phase, "fulfill");
      return original;
    } catch (error) { emit(phase, "reject", rejected(error)); throw error; }
  } };
}
let nodePhases;
const phaseStart = (trace, phase, start) => trace ? trace.start(phase, start) : start();
function phaseFetch(kind, ...args) {
  nodePhases?.emit(kind + "_dispatch", "enter");
  try {
    const original = fetch(...args);
    nodePhases?.emit(kind + "_dispatch", "fulfill");
    return nodePhases ? nodePhases.watch(kind + "_headers", original, true) : original;
  } catch (error) { nodePhases?.emit(kind + "_dispatch", "reject", { defined: error !== undefined, type: error === null ? "null" : typeof error }); throw error; }
}

test("live held phase schema is closed, bounded and preserves original promises", async () => {
  const lines = [], trace = livePhaseWriter("node", line => lines.push(line));
  const original = Promise.resolve(1); assert.equal(trace.start("setup", () => original), original);
  await original; await Promise.resolve();
  const rejected = Promise.reject(undefined); assert.equal(trace.watch("upload_body", rejected), rejected);
  await assert.rejects(rejected); await Promise.resolve();
  assert.ok(lines.some(line => line.includes('"defined":false,"type":"undefined"')));
  const row = JSON.parse(lines[0].slice(15, -4)); validateLivePhase(row);
  for (const patch of [{ message: "forbidden" }, { isolate: "foreign" }, { phase: "unknown" }, { seq: 129 }, { status: "200" }, { defined: 0 }, { ordinal: 0 }, { ordinal: 129 }, { observed: "unknown" }, { allowed: 1 }]) assert.throws(() => validateLivePhase({ ...row, ...patch }));
  validateLivePhase({ ...row, phase: "waituntil_snapshot", ordinal: 1, observed: "pending" });
  validateLivePhase({ ...row, phase: "reader_cancel", ordinal: 4, observed: "rejected", allowed: false });
  assert.throws(() => validateLivePhase({ ...row, get type() { throw new Error("not read"); } }));
  for (let i = 0; i < 200; i++) trace.emit("setup", "enter");
  assert.ok(lines.length <= 48); assert.ok(Buffer.byteLength(lines.join("")) <= 4608);
  assert.equal(JSON.parse(lines.at(-1).slice(15, -4)).phase, "limit");
  assert.doesNotThrow(() => livePhaseWriter("node", () => { throw undefined; }).emit("setup", "enter"));
});

// Serialized into the Worker and exercised directly below: retain the original
// operation and classify a read rejection at that rejection, never at a later abort.
function observeOperation(records, kind, original, signal) {
  const record = { kind, original, settled: false, allowedReadAbort: false };
  records.push(record);
  void original.then(() => { record.settled = true; record.phase?.emit("waituntil", "fulfill", { ordinal: record.ordinal }); }, error => {
    record.settled = true; record.rejected = true;
    record.allowedReadAbort = kind === "read" && signal?.aborted === true && error === signal.reason;
    record.phase?.emit("waituntil", "reject", { ordinal: record.ordinal, defined: error !== undefined, type: error === null ? "null" : typeof error });
  });
  return original;
}
async function joinOperations(records) {
  const outcomes = await Promise.allSettled(records.map(record => record.original));
  const failures = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected" && !records[index].allowedReadAbort) failures.push(outcome.reason);
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "original transport operations failed");
}

// Retain original pull/cancel callback tails in the source request context.
// The pull promise owns a bounded real timer, not additional wire bytes.
// Signal notification is evidence only; it never substitutes for source cancel.
function pendingResponseProducer(signal, held, id, call, watchdog = 10000) {
  const phase = id === "groq_abort" && typeof upstreamPhases !== "undefined" ? upstreamPhases : null;
  if (!Number.isSafeInteger(watchdog) || watchdog < 1 || watchdog > 10000) throw new Error("producer watchdog bound");
  let sequence = 0, pending, observer, resolvePull, rejectPull, timer, expiry;
  const failures = [], callbacks = [];
  const completion = Promise.withResolvers();
  const lifetime = (async () => {
    const original = await Promise.allSettled([completion.promise]);
    const outcomes = [...original, ...await Promise.allSettled(callbacks)];
    call.producerCallbacksJoined = true;
    await finishOwned(outcomes.filter(row => row.status === "rejected").map(row => row.reason), []);
  })();
  void lifetime.catch(() => {}); // The original rejection remains retained by join/waitUntil.
  Object.assign(call, { producerPulls: 0, producerPending: false, producerSettled: false, producerRejected: false,
    producerJoined: false, producerJoinFailures: 0, producerActivePulls: 0, producerActiveCancels: 0,
    producerCallbacksJoined: false, timerActive: false, fixtureExpired: false,
    signalNotifications: 0, producerPullAt: 0, producerSettleAt: 0, producerCancelAt: 0, producerReturnAt: 0,
    producerSignalAt: 0, producerExpiryAt: 0, cancelRejected: false });
  const notified = () => { phase?.emit("producer_signal", "enter"); call.signalNotifications++; call.producerSignalAt = ++sequence; phase?.emit("producer_signal", "fulfill"); };
  signal.addEventListener("abort", notified);
  const body = new ReadableStream({
    start(controller) { held.set(id, controller); controller.enqueue(new TextEncoder().encode('{"text":"')); },
    pull(controller) {
      phase?.emit("producer_pull", "enter");
      if (pending) return pending;
      call.producerPulls++; call.producerPullAt = ++sequence; call.producerPending = true;
      pending = new Promise((resolve, reject) => { resolvePull = resolve; rejectPull = reject; });
      phase?.emit("producer_pending", "enter");
      observer = pending.then(() => {
        call.producerPending = false; call.producerSettled = true; call.producerSettleAt = ++sequence;
        phase?.emit("producer_pending", "fulfill");
      }, () => {
        call.producerPending = false; call.producerSettled = true;
        call.producerRejected = true; call.producerSettleAt = ++sequence;
        phase?.emit("producer_pending", "reject");
      });
      void observer.catch(error => { failures.push(error); });
      call.timerActive = true;
      phase?.emit("producer_timer", "enter");
      timer = setTimeout(() => {
        call.timerActive = false; call.fixtureExpired = true; call.producerExpiryAt = ++sequence;
        expiry = new Error("pending producer expired"); rejectPull(expiry); completion.reject(expiry);
        phase?.emit("producer_timer", "reject", { defined: true, type: "object" });
        try { controller.error(expiry); } catch (error) { failures.push(error); }
      }, watchdog);
      call.producerActivePulls++;
      const tail = pending.finally(() => { call.producerActivePulls--; });
      callbacks.push(tail); void tail.catch(() => {});
      phase?.emit("producer_pull", "fulfill");
      return pending;
    },
    cancel(reason) {
      call.producerActiveCancels++;
      const original = (async () => {
        phase?.emit("producer_cancel", "enter");
        call.cancelCalls++; call.producerCancelAt = ++sequence;
        call.cancelReasonType = reason === null ? "null" : typeof reason;
        try {
          await finishOwned([], [
            () => { clearTimeout(timer); call.timerActive = false; phase?.emit("producer_timer", "fulfill"); },
            () => { resolvePull?.(); }, () => held.delete(id),
            () => signal.removeEventListener("abort", notified),
            () => pending, () => observer,
          ]);
          call.cancelReturns++; call.producerReturnAt = ++sequence;
          phase?.emit("producer_cancel", "fulfill");
        } catch (error) { phase?.emit("producer_cancel", "reject", { defined: error !== undefined, type: error === null ? "null" : typeof error }); failures.push(error); call.cancelRejected = true; throw error; }
      })();
      const tail = original.then(() => {
        call.producerActiveCancels--; completion.resolve();
      }, error => {
        call.producerActiveCancels--; completion.reject(error); throw error;
      });
      callbacks.push(tail); void tail.catch(() => {});
      return original;
    },
  });
  return { body, lifetime, get pending() { return pending; }, async join() {
    phase?.emit("producer_join", "enter");
    const joined = [];
    for (const outcome of await Promise.allSettled([pending, observer, lifetime, ...callbacks])) if (outcome.status === "rejected") joined.push(outcome.reason);
    if (expiry !== undefined && !joined.includes(expiry)) joined.push(expiry);
    if (call.cancelCalls !== 1 || call.cancelReturns !== 1 || call.cancelRejected || held.has(id) || call.timerActive
      || call.producerActivePulls !== 0 || call.producerActiveCancels !== 0 || !call.producerCallbacksJoined) joined.push(new Error("producer retirement incomplete"));
    call.producerJoined = true; call.producerJoinFailures = joined.length + failures.length;
    try { await finishOwned([...failures, ...joined], []); phase?.emit("producer_join", "fulfill"); }
    catch (error) { phase?.emit("producer_join", "reject", { defined: error !== undefined, type: error === null ? "null" : typeof error }); throw error; }
  } };
}

// Closed, bounded telemetry. Reasons remain private references, never text.
function validateHeldRecords(records) {
  if (!Array.isArray(records) || records.length > 32 || new TextEncoder().encode(JSON.stringify(records)).byteLength > 8192) throw new Error("held evidence bound");
  const enums = { test: ["held_original"], case: ["groq_abort", "mistral_abort"], scenario: ["abort"],
    kind: ["fetch", "handler", "closed", "read", "cancel", "unlock", "control", "binding", "upstream", "sqlite", "cleanup", "summary", "restoration"],
    disposition: ["controlled_native_read_retired"], failureType: ["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"],
    state: ["pending", "fulfilled", "rejected", "sync_throw", "unknown"], reasonType: ["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"],
    operandType: ["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"], upReasonType: ["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"] };
  const numbers = new Set(["v", "op", "invoke", "settle", "pendingReads", "earlierReadFailures", "unlockBefore", "unlocks", "returns", "status", "posts", "held", "charged", "events", "spent", "cost", "failures", "upCancelCalls", "upCancelReturns", "producerPulls", "producerJoinFailures", "producerActivePulls", "producerActiveCancels", "signalNotifications", "producerPullAt", "producerSettleAt", "producerCancelAt", "producerReturnAt", "producerSignalAt", "producerExpiryAt"]);
  const booleans = new Set(["operandPresent", "reasonDefined", "operandDefined", "sameClosed", "sameRead", "sameOperand", "allowed", "locked", "bound", "responseSame", "bodySame", "closedCaptured", "expired", "tokensNull", "policyFixed", "identityMatched", "noReplay", "disposed", "removed", "handlerPending", "producerPending", "producerSettled", "producerRejected", "producerJoined", "producerCallbacksJoined", "timerActive", "cancelRejected", "attempted", "descriptorOwned", "restored", "failurePresent", "failureDefined", "liveIncomplete"]);
  for (const name of ["Ingress", "Control", "Combined", "Forwarded", "Fetch"]) for (const prefix of ["invoke", "settle"]) {
    booleans.add(prefix + name); booleans.add(prefix + name + "Reason");
  }
  for (const name of ["Ingress", "Control", "Combined", "Forwarded", "Fetch"]) { booleans.add("same" + name); booleans.add("operandSame" + name); }
  for (const row of records) {
    if (!row || typeof row !== "object" || Object.getPrototypeOf(row) !== Object.prototype) throw new Error("held evidence record");
    for (const key of Reflect.ownKeys(row)) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (typeof key !== "string" || !descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("held evidence field");
      const value = descriptor.value;
      if (enums[key] ? !enums[key].includes(value) : numbers.has(key) ? !(value === null || Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) : booleans.has(key) ? !(value === null || typeof value === "boolean") : true) throw new Error("held evidence value");
    }
    if (row.v !== 1 || row.test !== "held_original" || row.scenario !== "abort" || !enums.case.includes(row.case) || !enums.kind.includes(row.kind) || !enums.state.includes(row.state)) throw new Error("held evidence identity");
  }
  const receipt = records.filter(row => row.kind === "restoration");
  const ordinary = records.filter(row => row.kind !== "restoration");
  if (receipt.length > 1 || ordinary.length > 31
    || new TextEncoder().encode(JSON.stringify(ordinary)).byteLength > 7680
    || receipt.length && new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 512) throw new Error("restoration evidence reserve");
  return records;
}
// One controlled R0 disposition after original retirement, never native error classification.
function controlledNativeRead(entry, signals, readers, operations, production, pairs) {
  if (!entry || !["groq_abort", "mistral_abort"].includes(entry.id) || entry.signals !== signals
    || entry.ingress.signal !== signals.Ingress || entry.forwarded.signal !== signals.Forwarded
    || readers.length !== 1 || entry.body !== readers[0].body || entry.response !== entry.returnedResponse
    || entry.response?.body !== entry.body || entry.handlerStatus !== 499
    || !entry.control?.accepted || entry.control.state !== "fulfilled") return null;
  const one = kind => { const rows = operations.filter(op => op.kind === kind); return rows.length === 1 ? rows[0] : null; };
  const reads = operations.filter(op => op.kind === "read");
  const [prefix, read] = reads, cancel = one("cancel"), closed = one("closed"), unlock = one("unlock");
  const control = one("control"), fetch = one("fetch"), handler = one("handler"), acquisition = readers[0];
  if (reads.length !== 2 || !cancel || !closed || !unlock || !control || !fetch || !handler
    || [prefix, read, cancel, closed, unlock].some(op => op.receiver !== acquisition.reader)
    || closed.original !== acquisition.closed || fetch.original !== entry.nativeFetch
    || fetch.state !== "fulfilled" || fetch.value !== entry.response
    || handler.original !== entry.outcome || handler.state !== "fulfilled" || handler.value?.status !== 499) return null;
  if (prefix.state !== "fulfilled" || prefix.value?.done !== false
    || !ArrayBuffer.isView(prefix.value.value) || prefix.value.value.byteLength === 0
    || prefix.settle >= read.invoke || read.invoke >= control.invoke || !control.handlerPending
    || control.pendingReads !== 1 || control.earlierReadFailures !== 0 || control.state !== "fulfilled"
    || Object.values(control.before).some(value => !value || value.aborted)
    || read.before.Fetch?.aborted !== false || read.state !== "rejected"
    || read.reason === null || typeof read.reason !== "object" || read.after.Fetch?.aborted !== true
    || !(control.invoke < cancel.invoke && cancel.invoke < read.settle)
    || cancel.pendingReads !== 1 || cancel.earlierReadFailures !== 0
    || cancel.args.length !== 1 || cancel.args[0] !== signals.Control.reason
    || cancel.args[0] === undefined || cancel.before.Fetch?.reason !== cancel.args[0]
    || ["Control", "Combined", "Forwarded", "Fetch"].some(name =>
      cancel.before[name]?.aborted !== true || cancel.before[name]?.reason !== cancel.args[0])
    || cancel.state !== "fulfilled" || closed.state !== "fulfilled"
    || unlock.state !== "fulfilled" || acquisition.body.locked
    || [read, cancel, closed].some(op => !op.settle || op.settle >= unlock.invoke)
    || operations.some(op => ["rejected", "sync_throw"].includes(op.state) && op !== read)) return null;
  if (production.length === 0 || production.some(record =>
    record.kind !== "waitUntil" || !record.original || !record.settled || record.rejected)) return null;
  const fetched = pairs.filter(pair => pair.role === "fetch"), decoded = pairs.filter(pair => pair.role === "decoder");
  if (fetched.length !== 1 || decoded.length !== 1) return null;
  const f = fetched[0], d = decoded[0];
  if (f.info !== d.info || f.info.entry !== entry || f.info.caller !== signals.Forwarded
    || f.info.signal !== signals.Fetch || f.input.original !== entry.nativeFetch
    || f.input.state !== "fulfilled" || f.wait.state !== "fulfilled"
    || !["fulfilled", "rejected"].includes(d.input.state) || d.wait.state !== "rejected"
    || d.wait.reason !== signals.Forwarded.reason || d.wait.reason !== signals.Fetch.reason
    || !d.wait.after?.caller || !d.wait.after?.signal
    || pairs.some(pair => pair.info.entry !== entry || pair.info.caller !== signals.Forwarded
      || pair.role === "unclassified" && (pair.input.state !== "fulfilled" || pair.wait.state !== "fulfilled"))) return null;
  return read;
}

function heldReaderWitness(signals, phase) {
  let seq = 0, unlocks = 0, returns = 0, entry;
  const operations = [], observers = [], observationFailures = [], readers = [];
  const sample = () => Object.fromEntries(["Ingress", "Control", "Combined", "Forwarded", "Fetch"].map(name => {
    const signal = signals[name]; return [name, signal ? { aborted: signal.aborted, reason: signal.reason } : null];
  }));
  const type = value => value === null ? "null" : typeof value;
  const same = (left, right) => left !== undefined && right !== undefined && left === right;
  const begin = (kind, args = [], receiver) => {
    const op = { kind, receiver, op: operations.length + 1, invoke: ++seq, settle: 0, state: "pending", args, before: sample(), after: null,
      pendingReads: operations.filter(row => row.kind === "read" && row.state === "pending").length,
      earlierReadFailures: operations.filter(row => row.kind === "read" && ["rejected", "sync_throw"].includes(row.state)).length, unlockBefore: unlocks, reason: undefined, allowed: false };
    operations.push(op);
    if (["read", "cancel", "closed", "unlock"].includes(kind)) phase?.emit("reader_" + kind, "enter", { ordinal: op.op, observed: "pending" });
    return op;
  };
  const settle = (op, state, reason) => {
    op.state = state; op.reason = reason; op.settle = ++seq; op.after = sample();
    // Raw rejections are never accepted at settlement; final original joins decide disposition.
    if (["read", "cancel", "closed", "unlock"].includes(op.kind)) phase?.emit("reader_" + op.kind, state === "fulfilled" ? "fulfill" : "reject", { ordinal: op.op, observed: state, allowed: op.allowed,
      ...(["rejected", "sync_throw"].includes(state) ? { defined: reason !== undefined, type: type(reason) } : {}) });
  };
  const enroll = (op, original) => {
    op.original = original;
    const observer = original.then(value => { op.value = value; settle(op, "fulfilled"); }, reason => { settle(op, "rejected", reason); });
    observers.push(observer); void observer.catch(error => { observationFailures.push(error); });
    return original;
  };
  return {
    bind(originalEntry) {
      if (entry || originalEntry.signals !== signals) throw new Error("reader request binding");
      entry = originalEntry;
    },
    watch(kind, original) { return enroll(begin(kind), original); },
    control(start) { const op = begin("control"); op.handlerPending = operations.some(row => row.kind === "handler" && row.state === "pending"); try { const value = start(); settle(op, "fulfilled"); return value; } catch (error) { settle(op, "sync_throw", error); throw error; } },
    acquire(reader, body) {
      const retained = { reader, body, closed: undefined }; readers.push(retained);
      const op = begin("closed", [], reader);
      try {
        const closed = reader.closed; retained.closed = closed;
        if (!closed || typeof closed.then !== "function") throw new Error("original closed missing");
        enroll(op, closed);
      } catch (error) { settle(op, "sync_throw", error); observationFailures.push(error); }
    },
    invoke(kind, original, receiver, args) {
      const op = begin(kind, args, receiver);
      try { return enroll(op, Reflect.apply(original, receiver, args)); }
      catch (error) { settle(op, "sync_throw", error); throw error; }
    },
    unlock(original, receiver, args) {
      const op = begin("unlock", args, receiver); unlocks++;
      try { const value = Reflect.apply(original, receiver, args); returns++; settle(op, "fulfilled"); return value; }
      catch (error) { settle(op, "sync_throw", error); throw error; }
    },
    failure(error) { observationFailures.push(error); },
    async join(production = [], pairs = []) {
      await Promise.allSettled(operations.flatMap(op => op.original ? [op.original] : []));
      await Promise.allSettled(observers);
      const failures = [...observationFailures];
      for (const op of operations) { op.allowed = false; delete op.disposition; }
      const candidate = controlledNativeRead(entry, signals, readers, operations, production, pairs);
      if (candidate) { candidate.allowed = true; candidate.disposition = "controlled_native_read_retired"; }
      for (const op of operations) {
        if (["rejected", "sync_throw"].includes(op.state) && !op.allowed) failures.push(op.reason);
        if (op.state === "pending") failures.push(new Error("unsettled original"));
        if (op.kind === "unlock" && operations.some(prior => ["read", "cancel", "closed"].includes(prior.kind) && prior.original && prior.invoke < op.invoke && (prior.settle === 0 || prior.settle > op.invoke))) failures.push(new Error("early original unlock"));
      }
      for (const retained of readers) if (!retained.closed || retained.body.locked) failures.push(new Error("missing original closure"));
      if (readers.length && (unlocks !== readers.length || returns !== readers.length)) failures.push(new Error("original unlock count"));
      await finishOwned(failures, []);
    },
    records(id) {
      const closed = operations.find(op => op.kind === "closed" && op.state === "rejected");
      const read = operations.find(op => op.kind === "read" && op.state === "rejected");
      return operations.map(op => {
        const row = { v: 1, test: "held_original", case: id, scenario: "abort", kind: op.kind, state: op.state, op: op.op, invoke: op.invoke, settle: op.settle, ...(op.disposition ? { disposition: op.disposition } : {}) };
        if (["read", "cancel", "closed"].includes(op.kind)) {
          Object.assign(row, { pendingReads: op.pendingReads, earlierReadFailures: op.earlierReadFailures, unlockBefore: op.unlockBefore,
            reasonDefined: op.reason !== undefined, reasonType: type(op.reason), operandPresent: op.args.length > 0, operandDefined: op.args[0] !== undefined, operandType: type(op.args[0]),
            sameClosed: same(op.reason, closed?.reason), sameRead: same(op.reason, read?.reason), sameOperand: same(op.reason, op.args[0]), allowed: op.allowed });
          for (const name of Object.keys(op.before)) {
            row["invoke" + name] = op.before[name]?.aborted ?? null; row["invoke" + name + "Reason"] = op.before[name] ? op.before[name].reason !== undefined : null;
            row["settle" + name] = op.after?.[name]?.aborted ?? null; row["settle" + name + "Reason"] = op.after?.[name] ? op.after[name].reason !== undefined : null;
            row["same" + name] = same(op.reason, op.after?.[name]?.reason); row["operandSame" + name] = same(op.args[0], op.before[name]?.reason);
          }
        }
        if (op.kind === "unlock") Object.assign(row, { unlocks, returns, locked: readers.some(retained => retained.body.locked), closedCaptured: readers.every(retained => !!retained.closed) });
        if (op.kind === "control") {
          Object.assign(row, { handlerPending: op.handlerPending, pendingReads: op.pendingReads, earlierReadFailures: op.earlierReadFailures });
          for (const name of Object.keys(op.before)) {
            row["invoke" + name] = op.before[name]?.aborted ?? null; row["invoke" + name + "Reason"] = op.before[name] ? op.before[name].reason !== undefined : null;
            row["settle" + name] = op.after?.[name]?.aborted ?? null; row["settle" + name + "Reason"] = op.after?.[name] ? op.after[name].reason !== undefined : null;
          }
        }
        return row;
      });
    },
  };
}
function bindHeldFetch(input, init, entries) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  if (!["https://api.groq.com", "https://api.mistral.ai"].includes(url.origin)) return null;
  const method = init?.method !== undefined ? init.method : request?.method ?? "GET";
  const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers);
  const provider = url.origin === "https://api.groq.com" ? "groq" : "mistral";
  const matches = [...entries.values()].filter(entry => entry.dispatching && entry.id.startsWith(provider + "_") && entry.ingress.method === "POST"
    && new URL(entry.ingress.url).pathname === `/v1/native/${provider}/v1/audio/transcriptions`);
  const entry = matches[0];
  if (matches.length !== 1 || method !== "POST" || url.pathname !== (provider === "groq" ? "/openai/v1/audio/transcriptions" : "/v1/audio/transcriptions")
    || url.search || headers.get("authorization") !== `Bearer fixture-upstream-${provider}` || !entry.forwarded || entry.forwarded.signal !== entry.signals.Forwarded) throw new Error("ambiguous original transcription owner");
  const signal = init?.signal !== undefined ? init.signal : request?.signal;
  if (!signal) throw new Error("missing original fetch signal");
  entry.signals.Fetch = signal; return entry;
}

test("pending producer preserves expiry, signal-only and original cancellation failures", async t => {
  for (const mode of ["expiry", "signal_only", "cancel_object", "cancel_undefined", "primary_cleanup"]) await t.test(mode, async () => {
    const control = new AbortController(), held = new Map(), call = { cancelCalls: 0, cancelReturns: 0 };
    const producer = pendingResponseProducer(control.signal, held, "groq_abort", call, mode === "expiry" ? 5 : 10000);
    const reader = producer.body.getReader(), witness = heldReaderWitness({ Fetch: control.signal });
    witness.acquire(reader, producer.body);
    await witness.invoke("read", reader.read, reader, []);
    const reading = witness.invoke("read", reader.read, reader, []);
    const originalPending = producer.pending; assert.ok(originalPending instanceof Promise);
    const outcomes = Promise.allSettled([reading, reader.closed]);
    const primary = new Error("primary"), failure = mode === "cancel_undefined" ? undefined : new Error("cleanup");
    if (mode === "expiry") {
      assert.ok((await outcomes).every(row => row.status === "rejected"));
      await assert.rejects(producer.join());
      assert.equal(call.fixtureExpired, true); assert.equal(held.size, 1); assert.equal(call.cancelCalls, 0);
    } else {
      control.abort(primary);
      assert.equal(call.signalNotifications, 1); assert.equal(call.cancelCalls, 0); assert.equal(held.size, 1);
      assert.equal(call.producerPending, true); assert.equal(call.timerActive, true);
      if (mode !== "signal_only") held.delete = () => { throw failure; };
      const operations = [() => witness.invoke("cancel", reader.cancel, reader, [primary]), () => producer.join()];
      if (mode === "signal_only") await finishOwned([], operations);
      else await assert.rejects(finishOwned(mode === "primary_cleanup" ? [primary] : [], operations), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], mode === "primary_cleanup" ? primary : failure);
        assert.ok(error.errors.includes(failure)); return true;
      });
      await outcomes;
      assert.equal(call.cancelCalls, 1); assert.equal(call.cancelReturns, mode === "signal_only" ? 1 : 0);
      assert.equal(call.fixtureExpired, false);
    }
    assert.equal(producer.pending, originalPending); assert.equal(call.producerSettled, true); assert.equal(call.timerActive, false);
    witness.unlock(reader.releaseLock, reader, []);
    if (mode === "signal_only") await witness.join(); else await assert.rejects(witness.join());
    validateHeldRecords(witness.records("groq_abort"));
  });
});

test("producer lifetime joins original cancellation callback before source acceptance", async t => {
  for (const mode of ["before_pull", "pending_read", "held_cancel", "undefined_cancel"]) await t.test(mode, async () => {
    const control = new AbortController(), held = new Map(), call = { cancelCalls: 0, cancelReturns: 0 };
    const producer = pendingResponseProducer(control.signal, held, "groq_abort", call);
    let reader, reading;
    if (mode !== "before_pull") {
      reader = producer.body.getReader();
      await reader.read(); reading = reader.read();
    }
    const blocker = Promise.withResolvers();
    if (mode === "held_cancel") control.signal.removeEventListener = () => blocker.promise;
    if (mode === "undefined_cancel") control.signal.removeEventListener = () => { throw undefined; };
    let settled = false;
    const retained = producer.lifetime.then(() => { settled = true; }, () => { settled = true; });
    const cancellation = reader ? reader.cancel(new Error("owned cancellation")) : producer.body.cancel();
    const observed = Promise.allSettled([cancellation, reading, producer.lifetime]);
    if (mode === "held_cancel") {
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(call.producerSettled, true);
      assert.equal(call.producerActiveCancels, 1);
      assert.equal(call.cancelReturns, 0); assert.equal(settled, false);
      blocker.resolve();
    }
    const results = await observed; await retained;
    assert.equal(call.producerActivePulls, 0); assert.equal(call.producerActiveCancels, 0);
    assert.equal(call.producerCallbacksJoined, true); assert.equal(call.fixtureExpired, false);
    if (mode === "undefined_cancel") {
      assert.equal(results[0].status, "rejected"); assert.equal(results[0].reason, undefined);
      await assert.rejects(producer.join(), error => error instanceof AggregateError && error.errors.includes(undefined));
      assert.equal(call.cancelRejected, true);
    } else {
      assert.ok(results.every(result => result.status === "fulfilled"));
      await producer.join(); assert.equal(call.cancelCalls, 1); assert.equal(call.cancelReturns, 1);
      assert.equal(call.producerJoined, true); assert.equal(call.producerJoinFailures, 0);
    }
    if (reader) reader.releaseLock();
  });
});

test("typed held observer rejects undefined, foreign, late, synchronous, missing and early outcomes", async t => {
  for (const fault of ["undefined", "foreign", "late", "sync", "missing", "early"]) await t.test(fault, async () => {
    const controller = new AbortController(), reason = new Error("owned"), foreign = new Error("foreign");
    const witness = heldReaderWitness({ Fetch: controller.signal });
    let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
    const body = { locked: true }, reader = { closed: fault === "missing" ? undefined : closed };
    witness.acquire(reader, body);
    if (fault === "undefined" || fault === "foreign") {
      const actual = fault === "undefined" ? undefined : foreign;
      controller.abort(reason);
      const original = Promise.reject(actual); assert.equal(witness.invoke("cancel", () => original, reader, [reason]), original);
    } else if (fault === "late") {
      const original = Promise.reject(reason); witness.invoke("read", () => original, reader, []); await Promise.resolve(); controller.abort(reason);
    } else if (fault === "sync") assert.throws(() => witness.invoke("cancel", () => { throw undefined; }, reader, []), error => error === undefined);
    if (fault !== "early") { resolveClosed(); await Promise.resolve(); }
    witness.unlock(() => { body.locked = false; }, reader, []);
    resolveClosed();
    await assert.rejects(witness.join());
    const records = validateHeldRecords(witness.records("groq_abort")); assert.ok(records.some(row => row.kind === "closed"));
  });
});
test("typed held observer keeps ambiguous ownership and primary/cleanup failures closed", async () => {
  const controller = new AbortController(), ingress = new Request("https://fixture.example/v1/native/groq/v1/audio/transcriptions", { method: "POST" });
  const forwarded = new Request(ingress, { signal: controller.signal });
  const entry = { id: "groq_abort", dispatching: true, ingress, forwarded, signals: { Forwarded: forwarded.signal } };
  assert.throws(() => bindHeldFetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", signal: controller.signal, headers: { authorization: "Bearer fixture-upstream-groq" } }, new Map([[1, entry], [2, entry]])));
  assert.throws(() => bindHeldFetch(new Request("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { authorization: "Bearer fixture-upstream-groq" } }), { headers: {}, signal: controller.signal }, new Map([[1, entry]])));
  const primary = new Error("primary"), calls = [];
  await assert.rejects(finishOwned([primary], [() => { calls.push(1); throw undefined; }, () => { calls.push(2); throw new Error("cleanup"); }]), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === undefined && error.errors.length === 3);
  assert.deepEqual(calls, [1, 2]);
  assert.throws(() => validateHeldRecords([{ v: 1, test: "held_original", case: "groq_abort", scenario: "abort", kind: "summary", state: "rejected", message: "forbidden" }]));
  assert.throws(() => validateHeldRecords(Array.from({ length: 33 }, () => ({ v: 1, test: "held_original", case: "groq_abort", scenario: "abort", kind: "summary", state: "rejected" }))));
});

test("Groq/Mistral declarations compile to native-only offers and preserve the consumer selector", () => {
  assert.deepEqual(snapshot.providers.map(provider => provider.id).sort(), manifests.map(manifest => manifest.id).sort(),
    "compiled snapshot must contain every bundled provider manifest exactly once");
  for (const profile of profiles) {
    const provider = snapshot.providers.find(row => row.id === profile.provider);
    const endpoint = provider.endpoints.find(row => row.id === "transcription");
    assert.equal(endpoint.native_proxy, true); assert.deepEqual(endpoint.methods, ["POST"]);
    assert.equal(endpoint.request_format, `${profile.provider}.transcription`);
    assert.equal(endpoint.response_format, endpoint.request_format);
    const models = provider.models.filter(row => row.capabilities.includes("audio.transcription"));
    assert.deepEqual(models.map(row => row.id), [`${profile.provider}/${profile.upstream}`]);
    assert.equal(models[0].pricing, null); assert.equal(models[0].pricing_ref, null);
  }
  const rows = parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8")).jobs.consumer.strategy.matrix.include;
  assert.equal(new Set(rows.map(row => row.consumer)).size, rows.length);
  assert.equal(parse(readFileSync(".github/workflows/openclaw-contract.yml", "utf8")).jobs.consumer.strategy["max-parallel"], 4);
  assert.deepEqual(rows.filter(row => row.consumer === "groq-mistral-transcription"), [{ consumer: "groq-mistral-transcription", ref: sourceHead, test: "test/openclaw-groq-mistral-transcription.test.mjs" }]);
  for (const path of ["test/openclaw-groq-mistral-transcription.test.mjs", "test/fixtures/openclaw-groq-mistral-transcription-contract.test.ts"])
    assert.equal(affectsOpenClawContract(path), true);
});

test("transcription fixtures bundle with the installed Wrangler compiler", async () => {
  const { build } = createRequire(import.meta.resolve("wrangler/package.json"))("esbuild");
  for (const contents of [routerFixture(), upstreamFixture()]) {
    const result = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
    assert.equal(result.outputFiles.length, 1);
  }
});

test("original cleanup rejects cancel/foreign/late failures and preserves every reason", async t => {
  for (const kind of ["cancel", "read"]) for (const reason of [undefined, new Error("original failure")]) {
    await t.test(`${kind} ${reason === undefined ? "undefined" : "object"}`, async () => {
      const records = [], caller = new AbortController(), original = Promise.reject(reason);
      assert.equal(observeOperation(records, kind, original, caller.signal), original);
      await Promise.resolve(); caller.abort(reason);
      await assert.rejects(joinOperations(records), error => error === reason);
    });
  }
  const caller = new AbortController(), reason = new Error("owned abort"); caller.abort(reason);
  const records = []; observeOperation(records, "read", Promise.reject(reason), caller.signal);
  await joinOperations(records);
  observeOperation(records, "cancel", Promise.reject(undefined), caller.signal);
  observeOperation(records, "read", Promise.reject(new Error("unrelated")), caller.signal);
  await assert.rejects(joinOperations(records), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined);
});

test("both real cleanup helpers attempt original join and later cleanup after failures", async t => {
  const text = readFileSync(new URL("./fixtures/openclaw-groq-mistral-transcription-contract.test.ts", import.meta.url), "utf8");
  const start = text.indexOf("async function finishOwned("), end = text.indexOf("\n// END owned cleanup", start);
  assert.ok(start >= 0 && end > start);
  const sdkFinish = new Function(stripTypeScriptTypes(text.slice(start, end)) + "; return finishOwned;")();
  for (const [name, finish] of [["outer", finishOwned], ["SDK", sdkFinish]]) await t.test(name, async () => {
    let release; const original = new Promise(resolve => { release = resolve; }), calls = [];
    const primary = new Error("body"), dispose = new Error("dispose");
    const finishing = finish([primary], [() => { calls.push("release"); throw undefined; }, () => { calls.push("join"); return original; }, () => { calls.push("dispose"); throw dispose; }, () => { calls.push("remove"); }]);
    let settled = false; void finishing.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false); release();
    await assert.rejects(finishing, error => { assert.deepEqual(error.errors, [primary, undefined, dispose]); return true; });
    assert.deepEqual(calls, ["release", "join", "dispose", "remove"]);
  });
});

async function json(response) {
  const text = await response.text();
  assert.ok(response.headers.get("content-type")?.includes("application/json"), `fixture returned non-JSON status ${response.status}`);
  const value = JSON.parse(text); assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
async function setup(temporary) {
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
  try {
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const row of cases) {
      await kv.put(`policies/${row.id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [row.provider], models: row.scenario === "denied" ? [`${row.provider}/not-granted`] : [row.model], tenantId: "fixture", monthlyBudgetMicros: 10000, requestCostMicros: row.scenario === "unpriced" ? null : 700, budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { [row.provider]: [row.provider] }, environmentFallback: false } }));
      await kv.put(`credentials/${row.id}`, JSON.stringify({ enabled: true, secretSha256: hash("fixture-secret"), policyId: row.id, policyGeneration: "fixture" }));
    }
    for (const row of profiles) await kv.put(`connections/${row.provider}`, JSON.stringify({ providerId: row.provider, enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    for (const row of cases) await json(await fetch(`${origin}/v1/admin/upstream-grants/policies/${row.id}/${row.provider}`, { method: "PUT", headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, body: JSON.stringify({ provider: row.provider, kind: "api_key", enabled: true, credentials: { apiKey: `fixture-upstream-${row.provider}` } }) }));
    return { mf, origin };
  } catch (error) { await finishOwned([error], [() => phaseStart(nodePhases, "dispose", () => mf.dispose())]); }
}
const control = (origin, action, id) => (nodePhases && ["state", "abort"].includes(action) ? phaseFetch(action, `${origin}/fixture/${action}/${id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } }) : fetch(`${origin}/fixture/${action}/${id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } })).then(response => phaseStart(nodePhases, action + "_body", () => json(response)));
function form(row) {
  const body = new FormData(); body.set("model", row.upstream); body.set("language", "en");
  if (row.provider === "groq") body.set("prompt", "Synthetic café 東京");
  body.set("file", new File([wav()], `${row.id}.wav`, { type: "audio/wav" })); return body;
}
function assertCatalog(catalog, row) {
  const provider = catalog.providers.find(value => value.id === row.provider);
  const offers = provider.offers.filter(value => value.endpoint === "transcription" && value.modelId === row.model);
  assert.equal(offers.length, 1); assert.equal(offers[0].routeKind, "native"); assert.equal(offers[0].route, row.route); assert.equal(offers[0].eligible, true);
  assert.ok(provider.offers.filter(value => value.endpoint === "transcription").every(value => value.routeKind !== "manifest"));
  const route = provider.routes.find(value => value.endpoint === "transcription");
  assert.deepEqual(route.methods, ["POST"]); assert.equal(route.path, "/v1/audio/transcriptions");
  assert.equal(route.requestFormat, row.format); assert.equal(route.responseFormat, row.format);
}
async function verify(origin, rows, checkpoint) {
  checkpoint?.("state_request"); // passive evidence
  const state = await control(origin, "state", "all");
  checkpoint?.("state_return"); // passive evidence
  checkpoint?.("usage_request"); // passive evidence
  const usage = await json(await fetch(`${origin}/v1/admin/usage`, { headers: { authorization: "Bearer fixture-admin" } }));
  checkpoint?.("usage_return"); // passive evidence
  assertShippingEvidence(state, usage, rows, checkpoint);
}
function assertShippingEvidence(state, usage, rows, checkpoint) {
  for (const row of rows) {
    checkpoint?.("row", row.id); // passive evidence
    const calls = state.calls.filter(value => value.id === row.id), expected = denied.has(row.scenario) ? 0 : 1;
    /* evidence:egress_count */ checkpoint?.("egress_count", row.id, calls.length, null, expected); assert.equal(calls.length, expected, `${row.id}: no denied egress, replay or fallback`);
    checkpoint?.("events_select", row.id, calls.length, null, expected); // passive evidence
    const events = usage.usage.events.filter(value => value.credential_id === row.id);
    if (!expected) {
      /* evidence:denied_cost */ checkpoint?.("denied_cost", row.id, calls.length, events.length, expected); assert.ok(events.every(value => value.actual_cost_micros === 0));
      /* evidence:denied_budget */ checkpoint?.("denied_budget", row.id, calls.length, events.length, expected); assert.equal(usage.policies.find(value => value.policyId === row.id).budget.spentMicros, 0); continue;
    }
    const call = calls[0];
    /* evidence:wire_url */ checkpoint?.("wire_url", row.id, calls.length, events.length, expected); assert.equal(call.url, row.origin + row.path); /* evidence:wire_method */ checkpoint?.("wire_method", row.id, calls.length, events.length, expected); assert.equal(call.method, "POST"); /* evidence:wire_redirect */ checkpoint?.("wire_redirect", row.id, calls.length, events.length, expected); assert.equal(call.redirect, "manual");
    /* evidence:wire_auth */ checkpoint?.("wire_auth", row.id, calls.length, events.length, expected); assert.equal(call.authorization, `Bearer fixture-upstream-${row.provider}`); /* evidence:wire_other_key */ checkpoint?.("wire_other_key", row.id, calls.length, events.length, expected); assert.equal(call.otherKey, null);
    /* evidence:wire_model */ checkpoint?.("wire_model", row.id, calls.length, events.length, expected); assert.equal(call.model, row.upstream); /* evidence:wire_language */ checkpoint?.("wire_language", row.id, calls.length, events.length, expected); assert.equal(call.language, "en");
    /* evidence:wire_prompt */ checkpoint?.("wire_prompt", row.id, calls.length, events.length, expected); assert.equal(call.prompt, row.provider === "groq" ? "Synthetic café 東京" : null);
    /* evidence:wire_filename */ checkpoint?.("wire_filename", row.id, calls.length, events.length, expected); assert.equal(call.fileName, `${row.id}.wav`); /* evidence:wire_mime */ checkpoint?.("wire_mime", row.id, calls.length, events.length, expected); assert.equal(call.mime, "audio/wav"); /* evidence:wire_bytes */ checkpoint?.("wire_bytes", row.id, calls.length, events.length, expected); assert.equal(call.bytes, 2048); /* evidence:wire_digest */ checkpoint?.("wire_digest", row.id, calls.length, events.length, expected); assert.equal(call.digest, hash(wav()));
    /* evidence:wire_fields */ checkpoint?.("wire_fields", row.id, calls.length, events.length, expected); assert.deepEqual(call.fields, row.provider === "groq" ? ["model", "language", "prompt", "file"] : ["model", "language", "file"]);
    /* evidence:event_count */ checkpoint?.("event_count", row.id, calls.length, events.length, expected); assert.equal(events.length, 1); const event = events[0];
    /* evidence:event_provider */ checkpoint?.("event_provider", row.id, calls.length, events.length, expected); assert.equal(event.provider, row.provider); /* evidence:event_model */ checkpoint?.("event_model", row.id, calls.length, events.length, expected); assert.equal(event.model, row.model); /* evidence:event_capability */ checkpoint?.("event_capability", row.id, calls.length, events.length, expected); assert.equal(event.capability, "audio.transcription");
    /* evidence:event_policy */ checkpoint?.("event_policy", row.id, calls.length, events.length, expected); assert.equal(event.policy_id, row.id);
    if (row.scenario === "abort") {
      /* evidence:abort_status */ checkpoint?.("abort_status", row.id, calls.length, events.length, expected); assert.equal(event.status, "client_error"); /* evidence:abort_code */ checkpoint?.("abort_code", row.id, calls.length, events.length, expected); assert.equal(event.status_code, 499);
      /* evidence:cancel_calls */ checkpoint?.("cancel_calls", row.id, calls.length, events.length, expected); assert.equal(call.cancelCalls, 1); /* evidence:cancel_returns */ checkpoint?.("cancel_returns", row.id, calls.length, events.length, expected); assert.equal(call.cancelReturns, 1); /* evidence:cancel_rejected */ checkpoint?.("cancel_rejected", row.id, calls.length, events.length, expected); assert.equal(call.cancelRejected, false);
      /* evidence:producer_pulls */ checkpoint?.("producer_pulls", row.id, calls.length, events.length, expected); assert.equal(call.producerPulls, 1); /* evidence:producer_settled */ checkpoint?.("producer_settled", row.id, calls.length, events.length, expected); assert.equal(call.producerSettled, true); /* evidence:producer_pending */ checkpoint?.("producer_pending", row.id, calls.length, events.length, expected); assert.equal(call.producerPending, false);
      /* evidence:producer_joined */ checkpoint?.("producer_joined", row.id, calls.length, events.length, expected); assert.equal(call.producerJoined, true); /* evidence:producer_join_failures */ checkpoint?.("producer_join_failures", row.id, calls.length, events.length, expected); assert.equal(call.producerJoinFailures, 0); assert.equal(call.producerActivePulls, 0); assert.equal(call.producerActiveCancels, 0); assert.equal(call.producerCallbacksJoined, true); /* evidence:producer_rejected */ checkpoint?.("producer_rejected", row.id, calls.length, events.length, expected); assert.equal(call.producerRejected, false);
      /* evidence:producer_expired */ checkpoint?.("producer_expired", row.id, calls.length, events.length, expected); assert.equal(call.fixtureExpired, false); /* evidence:producer_expiry_at */ checkpoint?.("producer_expiry_at", row.id, calls.length, events.length, expected); assert.equal(call.producerExpiryAt, 0); /* evidence:producer_timer */ checkpoint?.("producer_timer", row.id, calls.length, events.length, expected); assert.equal(call.timerActive, false);
      /* evidence:producer_failures */ checkpoint?.("producer_failures", row.id, calls.length, events.length, expected); assert.equal(state.producerFailures, 0);
    }
    /* evidence:cost */ checkpoint?.("cost", row.id, calls.length, events.length, expected); assert.equal(event.actual_cost_micros, 700); /* evidence:cost_basis */ checkpoint?.("cost_basis", row.id, calls.length, events.length, expected); assert.equal(event.cost_basis, "policy_fixed"); /* evidence:retained */ checkpoint?.("retained", row.id, calls.length, events.length, expected); assert.equal(event.content_retained, false);
    for (const field of ["input_tokens", "output_tokens", "total_tokens"]) { /* evidence:tokens */ checkpoint?.(field, row.id, calls.length, events.length, expected); assert.equal(event[field], null); }
    /* evidence:spent */ checkpoint?.("spent", row.id, calls.length, events.length, expected); assert.equal(usage.policies.find(value => value.policyId === row.id).budget.spentMicros, 700);
    /* evidence:privacy */ checkpoint?.("privacy", row.id, calls.length, events.length, expected); assert.doesNotMatch(JSON.stringify(event), /fixture-secret|fixture-upstream|Synthetic café/);
  }
  /* evidence:held */ checkpoint?.("held"); assert.equal(state.held, 0); /* evidence:charged */ checkpoint?.("charged"); assert.equal(state.charged, 0);
  checkpoint?.("complete"); // passive evidence
}

function assertShippingJoin({ row, status, result }) {
  assert.equal(status, 200, "original join failed");
  assert.equal(result.retired, true);
  if (row.scenario !== "abort") return;
  assert.equal(result.provisional, true);
  const records = validateHeldRecords(result.typed);
  const reads = records.filter(value => value.kind === "read" && value.state === "rejected");
  assert.equal(reads.length, 1); assert.equal(reads[0].disposition, "controlled_native_read_retired");
  assert.equal(reads[0].allowed, true); assert.equal(reads[0].reasonDefined, true); assert.equal(reads[0].reasonType, "object");
  const restored = records.filter(value => value.kind === "restoration");
  assert.equal(restored.length, 1); assert.equal(restored[0].attempted, true);
  assert.equal(restored[0].descriptorOwned, true); assert.equal(restored[0].restored, true);
  assert.equal(restored[0].failurePresent, false); assert.equal(restored[0].liveIncomplete, false);
  const summary = records.filter(value => value.kind === "summary");
  assert.equal(summary.length, 1); assert.equal(summary[0].failures, 0);
}

async function runShippingRows(selected, t) {
  if (selected.length === 1 && selected[0].id === "groq_abort") nodePhases = livePhaseWriter("node", line => process.stdout.write(line + "\n"));
  const temporary = await phaseStart(nodePhases, "temporary", () => mkdtemp(join(tmpdir(), "clawrouter-native-transcription-"))); let mf; const failures = [];
  let origin; const typed = []; const joined = new Set(), joinReceipts = [];
  try {
    ({ mf, origin } = await phaseStart(nodePhases, "setup", () => setup(temporary)));
    for (const row of selected) {
      if (["success", "stale"].includes(row.scenario)) assertCatalog(await json(await fetch(`${origin}/v1/catalog`, { headers: { authorization: `Bearer ${token(row)}` } })), row);
      if (row.scenario === "rotation") {
        await control(origin, "rotate", row.id);
        const refused = await fetch(`${origin}/v1/catalog`, { headers: { authorization: `Bearer ${token(row)}` } });
        assert.equal(refused.status, 401); await refused.arrayBuffer();
      }
      const pending = phaseFetch("upload", origin + row.route, { method: "POST", headers: { authorization: `Bearer ${token(row, row.scenario === "rotation")}` }, body: form(row) });
      if (row.scenario === "abort") {
        const failures = []; let held = false;
        try {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const state = await control(origin, "state", "all");
            if (state.held === 1 && state.calls.some(value => value.id === row.id)) { held = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(held, true);
        } catch (error) { failures.push(error); }
        await finishOwned(failures, [() => control(origin, "abort", row.id), async () => { await pending; }]);
      }
      const response = await pending; nodePhases?.emit("handler", "fulfill", { status: response.status });
      const value = await phaseStart(nodePhases, "upload_body", () => response.json());
      const status = ["success", "rotation"].includes(row.scenario) ? 200 : row.scenario === "stale" || row.scenario === "denied" ? 403 : row.scenario === "unpriced" ? 400 : row.scenario === "abort" ? 499 : 502;
      assert.equal(response.status, status, `${row.id}: ${value.error?.code}`);
      if (status === 200) assert.equal(value.text, "café 東京 🦊");
      if (row.scenario === "stale") assert.equal(value.error.code, "proxy_key_revoked");
      if (row.scenario === "unpriced") assert.equal(value.error.code, "pricing_required");
      joined.add(row.id);
      const responseJoin = await phaseFetch("join", `${origin}/fixture/join/${row.id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } });
      const resultJoin = await phaseStart(nodePhases, "join_body", () => responseJoin.json());
      if (row.scenario === "abort") typed.push(...validateHeldRecords(resultJoin.typed));
      joinReceipts.push({ row, status: responseJoin.status, result: resultJoin });
    }
  } catch (error) { failures.push(error); }
  const heldRow = selected.length === 1 && selected[0].scenario === "abort" ? selected[0] : null;
  const facts = heldRow ? { v: 1, test: "held_original", case: heldRow.id, scenario: "abort" } : null;
  let disposed = false, removed = false;
  const attempt = async start => { try { await start(); } catch (error) { failures.push(error); } };
  if (heldRow && origin) {
    await attempt(async () => {
      if (joined.has(heldRow.id)) return;
      joined.add(heldRow.id);
      const response = await phaseFetch("join", `${origin}/fixture/join/${heldRow.id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } });
      const result = await phaseStart(nodePhases, "join_body", () => response.json()); typed.push(...validateHeldRecords(result.typed));
      joinReceipts.push({ row: heldRow, status: response.status, result });
    });
    await attempt(async () => {
      const state = await phaseStart(nodePhases, "upstream_observe", () => control(origin, "state", "all")), posts = state.calls.filter(call => call.id === heldRow.id);
      typed.push({ ...facts, kind: "upstream", state: "fulfilled", posts: posts.length, held: state.held, charged: state.charged,
        noReplay: posts.length === 1, expired: posts[0]?.fixtureExpired ?? null, upCancelCalls: posts[0]?.cancelCalls ?? null, upCancelReturns: posts[0]?.cancelReturns ?? null, upReasonType: posts[0]?.cancelReasonType ?? "undefined",
        ...Object.fromEntries(["producerPulls", "producerPending", "producerSettled", "producerRejected", "producerJoined", "producerJoinFailures", "producerActivePulls", "producerActiveCancels", "producerCallbacksJoined", "timerActive", "signalNotifications", "producerPullAt", "producerSettleAt", "producerCancelAt", "producerReturnAt", "producerSignalAt", "producerExpiryAt", "cancelRejected"].map(key => [key, posts[0]?.[key] ?? null])) });
      assert.equal(posts.length, 1); assert.equal(posts[0].fixtureExpired, false);
      assert.equal(posts[0].cancelCalls, 1); assert.equal(posts[0].cancelReturns, 1); assert.equal(state.held, 0);
      assert.equal(posts[0].producerJoined, true); assert.equal(posts[0].producerJoinFailures, 0);
      assert.equal(posts[0].producerSettled, true); assert.equal(posts[0].timerActive, false);
    });
    await attempt(async () => {
      const response = await phaseFetch("sqlite", `${origin}/v1/admin/usage`, { headers: { authorization: "Bearer fixture-admin" } });
      const usage = await phaseStart(nodePhases, "sqlite_body", () => json(response)), events = usage.usage.events.filter(event => event.credential_id === heldRow.id);
      const event = events[0], budget = usage.policies.find(policy => policy.policyId === heldRow.id)?.budget;
      typed.push({ ...facts, kind: "sqlite", state: "fulfilled", events: events.length, spent: budget?.spentMicros ?? null, cost: event?.actual_cost_micros ?? null,
        tokensNull: event ? [event.input_tokens, event.output_tokens, event.total_tokens].every(value => value === null) : null,
        policyFixed: event ? event.cost_basis === "policy_fixed" : null, identityMatched: event ? event.provider === heldRow.provider && event.model === heldRow.model && event.policy_id === heldRow.id : null });
    });
  }
  // A router candidate is provisional. Independent wire/producer/SQLite checks
  // run even when its join failed; each failure survives through later cleanup.
  if (origin) await attempt(() => phaseStart(nodePhases, "verify", () => verify(origin, selected)));
  for (const receipt of joinReceipts) await attempt(() => assertShippingJoin(receipt));
  if (heldRow && joinReceipts.length !== 1) failures.push(new Error("missing held join receipt"));
  if (nodePhases?.incomplete) failures.push(new Error("node observation quota incomplete"));
  await attempt(async () => { await phaseStart(nodePhases, "dispose", () => mf?.dispose()); disposed = true; });
  await attempt(async () => { await phaseStart(nodePhases, "rm", () => rm(temporary, { recursive: true, force: true })); removed = true; });
  if (facts) {
    typed.push({ ...facts, kind: "cleanup", state: disposed && removed ? "fulfilled" : "rejected", disposed, removed, failures: failures.length });
    await attempt(() => { t.diagnostic("AUDIO813_TYPED " + JSON.stringify(validateHeldRecords(typed))); });
  }
  if (nodePhases?.incomplete) failures.push(new Error("node final observation incomplete"));
  nodePhases = undefined;
  await finishOwned(failures, []);
}
test("native transcription response keeps the SDK complete-JSON wire contract", { timeout: 30000 }, async t => {
  for (const encoding of [undefined, "identity"]) {
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-audio-encoding-"));
    let mf; const failures = [];
    try {
      let origin; ({ mf, origin } = await setup(temporary));
      for (const row of cases.filter(row => row.scenario === "success")) {
        const response = await fetch(origin + row.route, { method: "POST", body: form(row),
          headers: { authorization: `Bearer ${token(row)}`, ...(encoding ? { "accept-encoding": encoding } : {}) } });
        t.diagnostic(JSON.stringify({ provider: row.provider, requested: encoding ?? "default", status: response.status,
          type: response.headers.get("content-type"), encoding: response.headers.get("content-encoding"),
          range: response.headers.get("content-range"), redirected: response.redirected }));
        assert.equal(response.status, 200); assert.equal((await response.json()).text, "café 東京 🦊");
        if (encoding === "identity") {
          assert.equal(response.redirected, false); assert.equal(response.headers.has("content-range"), false);
          assert.ok([null, "identity"].includes(response.headers.get("content-encoding")));
          assert.equal(response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(), "application/json");
        }
        await control(origin, "join", row.id);
      }
    } catch (error) { failures.push(error); }
    await finishOwned(failures, [() => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
  }
});

test("real shipping Groq/Mistral multipart catalog, grants, denial and SQLite", { timeout: 60000 }, async t => {
  await runShippingRows(cases.filter(row => ["success", "unpriced", "denied", "stale", "malformed", "partial", "error", "redirect", "truncated", "rotation"].includes(row.scenario)), t);
});
for (const row of cases.filter(row => row.scenario === "abort")) test(`typed original held response ${row.id}`, { timeout: 60000 }, async t => {
  await runShippingRows([row], t);
});

test("registered OpenClaw Groq/Mistral native transcription through Worker and SQLite", { skip: !source, timeout: 300000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-transcription-")); let mf, origin; const failures = [];
  const diagnostics = audioDiagnosticSession();
  try {
    ({ mf, origin } = await setup(temporary));
    await runOpenClawConsumer(t, { source, sourceHead, audioHost: true, fixture: new URL("./fixtures/openclaw-groq-mistral-transcription-contract.test.ts", import.meta.url), testPath: "extensions/clawrouter/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_CASES: JSON.stringify(cases), CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead } });
  } catch (error) { failures.push(error); diagnostics.rejected(error); }
  await finishOwned(failures, [
    ...cases.filter(row => row.scenario === "abort").map(row => () => origin && diagnostics.observe("worker_abort", row.id, () => control(origin, "abort", row.id))),
    ...cases.map(row => () => origin && diagnostics.observe("worker_retirement", row.id, () => control(origin, "join", row.id))),
    () => origin && diagnostics.observe("upstream_sqlite", null, () => verify(origin, cases, diagnostics.evidence)),
    () => mf && diagnostics.observe("worker_dispose", null, () => mf.dispose()),
    () => diagnostics.observe("scratch_cleanup", null, () => rm(temporary, { recursive: true, force: true })),
    () => diagnostics.finish(),
  ]);
});


function ownerAbortControl(entry, start, context, trace) {
  let resolveNotification, accepted = false, state = "pending";
  const notification = new Promise(resolve => { resolveNotification = resolve; });
  const controlTask = notification.then(command => {
    if (command !== 1) throw new Error("owner control command");
    trace?.emit("owner_control", "enter");
    try { const result = phaseStart(trace, "owner_abort", start); state = "fulfilled"; return result; }
    catch (error) { state = "rejected"; throw error; }
  });
  // Register this exact owner-created task before the entry becomes observable.
  context.waitUntil(controlTask);
  return {
    controlTask, get accepted() { return accepted; }, get state() { return state; },
    request(candidate, command) {
      if (candidate !== entry || command !== 1) throw new Error("owner control identity");
      if (accepted) return false;
      accepted = true;
      trace?.emit("control_accepted", "fulfill");
      resolveNotification(1);
      return true;
    },
  };
}

// One operation per actual fixture generation. Pin its promise before any
// retirement effect can reenter; repeated callers only observe that operation.
function singleFixtureRetirement(owner, retire) {
  let operation;
  return candidate => {
    if (candidate !== owner) throw new Error("retirement generation mismatch");
    if (!operation) operation = Promise.resolve().then(retire);
    return operation;
  };
}

function freezeRetirementReceipt(body) {
  if (body.typed) {
    for (const row of body.typed) Object.freeze(row);
    Object.freeze(body.typed);
  }
  return Object.freeze({ body: Object.freeze(body), status: body.retired ? 200 : 500 });
}

test("single fixture retirement shares one pending operation and immutable receipt", async () => {
  const owner = {}, foreign = {}, held = Promise.withResolvers(), calls = [];
  class Original { wait(pending, failure, discard) { return pending; } }
  const descriptor = Object.getOwnPropertyDescriptor(Original.prototype, "wait");
  const tap = installHttpWaitTap(Original, () => {});
  let original, reentrant, completed = false;
  const join = singleFixtureRetirement(owner, async () => {
    calls.push("retirement"); reentrant = join(owner);
    await held.promise; calls.push("producer");
    const failures = [], restoration = restoreWaitReceipt(tap, "groq_abort", false, failures);
    calls.push("restoration"); await finishOwned(failures, [() => calls.push("later-cleanup")]);
    return freezeRetirementReceipt({ retired: true, typed: [restoration] });
  });
  original = join(owner); const concurrent = join(owner);
  assert.equal(concurrent, original); assert.throws(() => join(foreign), /generation mismatch/);
  const observed = original.then(() => { completed = true; });
  await Promise.resolve(); assert.equal(reentrant, original); assert.equal(completed, false);
  assert.deepEqual(calls, ["retirement"]);
  held.resolve(); const receipt = await original; await observed;
  assert.equal(join(owner), original); assert.equal(await join(owner), receipt);
  assert.deepEqual(calls, ["retirement", "producer", "restoration", "later-cleanup"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Original.prototype, "wait"), descriptor);
  assert.equal(receipt.status, 200); assert.equal(receipt.body.typed[0].restored, true);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.body) && Object.isFrozen(receipt.body.typed) && Object.isFrozen(receipt.body.typed[0]));
  assert.throws(() => { receipt.body.retired = false; }, TypeError);
  let otherRuns = 0; const other = singleFixtureRetirement(foreign, () => { otherRuns++; return 2; });
  assert.notEqual(other(foreign), original); assert.equal(await other(foreign), 2); assert.equal(otherRuns, 1);
});

test("single fixture retirement retains original rejection and every cleanup failure", async t => {
  for (const primary of [undefined, new Error("fixture body")]) await t.test(primary === undefined ? "undefined primary" : "object primary", async () => {
    const owner = {}, cleanup = new Error("fixture cleanup"), calls = [];
    const join = singleFixtureRetirement(owner, async () => {
      await finishOwned([primary], [
        () => { calls.push("producer"); throw cleanup; },
        () => { calls.push("restoration"); throw undefined; },
        () => { calls.push("later-cleanup"); },
      ]);
    });
    const original = join(owner), repeated = join(owner); assert.equal(repeated, original);
    const results = await Promise.allSettled([original, repeated]);
    assert.ok(results.every(value => value.status === "rejected"));
    assert.equal(results[0].reason, results[1].reason);
    assert.ok(results[0].reason instanceof AggregateError);
    assert.deepEqual(results[0].reason.errors, [primary, cleanup, undefined]);
    const later = await Promise.allSettled([join(owner)]); assert.equal(later[0].reason, results[0].reason);
    assert.deepEqual(calls, ["producer", "restoration", "later-cleanup"]);
  });
  const owner = {}; let attempts = 0;
  const join = singleFixtureRetirement(owner, () => { attempts++; throw undefined; });
  const result = await Promise.allSettled([join(owner), join(owner)]);
  assert.deepEqual(result, [{ status: "rejected", reason: undefined }, { status: "rejected", reason: undefined }]);
  assert.equal(attempts, 1);
});

test("single fixture retirement never conceals failed or foreign restoration", async t => {
  for (const mode of ["foreign", "undefined", "stale-success"]) await t.test(mode, async () => {
    const owner = {}, calls = [], failures = [];
    class Original { wait(pending, failure, discard) { return pending; } }
    const descriptor = Object.getOwnPropertyDescriptor(Original.prototype, "wait");
    const realTap = installHttpWaitTap(Original, () => {}), foreign = () => {};
    let tap = realTap;
    if (mode === "foreign") Object.defineProperty(Original.prototype, "wait", { ...descriptor, value: foreign });
    if (mode === "undefined") tap = { restore() { throw undefined; }, disposition: realTap.disposition };
    if (mode === "stale-success") {
      assert.equal(realTap.restore(), true);
      Object.defineProperty(Original.prototype, "wait", { ...descriptor, value: foreign });
    }
    const join = singleFixtureRetirement(owner, async () => {
      const restoration = restoreWaitReceipt(tap, "groq_abort", false, failures); calls.push("restore");
      await finishOwned([], [() => { calls.push("later-cleanup"); }]);
      return freezeRetirementReceipt({ retired: failures.length === 0, typed: [restoration] });
    });
    const original = join(owner), receipt = await original;
    assert.equal(join(owner), original); assert.equal(await join(owner), receipt);
    assert.equal(receipt.status, 500); assert.equal(receipt.body.retired, false);
    assert.equal(receipt.body.typed[0].restored, false); assert.equal(receipt.body.typed[0].state, "rejected");
    assert.equal(receipt.body.typed[0].failurePresent, true); assert.equal(failures.length, 1);
    if (mode === "undefined") { assert.equal(failures[0], undefined); assert.equal(realTap.restore(), true); }
    else assert.equal(Original.prototype.wait, foreign);
    assert.deepEqual(calls, ["restore", "later-cleanup"]);
  });
});

function routerFixture() {
  return `import handler from './worker/index.ts'; export * from './worker/index.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
import { HttpOperation } from './worker/http-operation.ts';
${installHttpWaitTap.toString()}
${restoreWaitReceipt.toString()}
${singleFixtureRetirement.toString()}
${freezeRetirementReceipt.toString()}
${ownerAbortControl.toString()}
${observeOperation.toString()}
${joinOperations.toString()}
${finishOwned.toString()}
${validateHeldRecords.toString()}
${controlledNativeRead.toString()}
${heldReaderWitness.toString()}
${bindHeldFetch.toString()}
const livePhaseNames = ${JSON.stringify(livePhaseNames)};
${validateLivePhase.toString()}
${livePhaseWriter.toString()}
const phaseStart = ${phaseStart.toString()};
const routerPhases = livePhaseWriter("router", line => console.log(line));
const records = new Map(), readers = new Map(), controllers = new Map(), requests = [];
const retirements = new WeakMap();
const originalFetch = globalThis.fetch, originalGetReader = ReadableStream.prototype.getReader, bodies = new WeakMap();
globalThis.fetch = function(input, init) {
  const entry = bindHeldFetch(input, init, controllers);
  const original = Reflect.apply(originalFetch, this, [input, init]);
  if (!entry) return original;
  entry.tap?.bindFetch(entry, entry.signals.Fetch, original);
  entry.nativeFetch = original; entry.witness.watch('fetch', original);
  const observer = original.then(response => {
    entry.response = response; entry.returnedResponse = response; entry.body = response.body;
    if (!response.body) throw new Error('original response body absent');
    bodies.set(response.body, entry);
  }, () => {});
  entry.observers.push(observer); void observer.catch(error => { entry.witness.failure(error); });
  return original;
};
ReadableStream.prototype.getReader = function(...args) {
  const reader = Reflect.apply(originalGetReader, this, args), entry = bodies.get(this);
  if (entry) {
    entry.witness.acquire(reader, this);
    const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
    const state = { reader, body: this, unlocked: false }; (readers.get(entry.id) ?? readers.set(entry.id, []).get(entry.id)).push(state);
    reader.read = function(...args) { return entry.witness.invoke('read', read, this, args); };
    reader.cancel = function(...args) { return entry.witness.invoke('cancel', cancel, this, args); };
    reader.releaseLock = function(...args) { const value = entry.witness.unlock(unlock, this, args); state.unlocked = true; return value; };
  }
  return reader;
};
export default { ...handler, async fetch(request, env, context) {
  env = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: ${JSON.stringify(hash("fixture-admin"))} };
  const admin = async (path, body) => {
    const response = await handler.fetch(new Request('https://fixture.example/v1/admin/' + path, { method: 'POST', headers: { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, context);
    const result = await response.json(); if (!response.ok) throw new Error('authority mutation refused: ' + response.status + ' ' + result.error?.code + ' ' + (['rotation accepts only secretSha256', 'secretSha256 must be a SHA-256 hex digest', 'credential must be a JSON object', 'invalid credential id'].includes(result.error?.message) ? result.error.message : 'other'));
  };
  const url = new URL(request.url);
  if (url.pathname.startsWith('/fixture/') && request.headers.get('x-fixture-control') === 'transcription') {
    const [, , action, id] = url.pathname.split('/');
    if (action === 'rotate') { await admin('credentials/' + id + '/rotate', { secretSha256: ${JSON.stringify(hash("rotated-secret"))} }); return Response.json({ rotated: true }); }
    if (action === 'abort') { const entry = controllers.get(id); if (!entry || entry.id !== id || !entry.control) throw new Error('original control owner missing'); if (id === 'groq_abort') routerPhases.emit("router_control", "enter"); const accepted = entry.control.request(entry, 1); if (id === 'groq_abort') routerPhases.emit("router_control", "fulfill"); return Response.json({ accepted }); }
    if (action === 'join') {
      const list = records.get(id) ?? [], entry = controllers.get(id);
      if (!records.has(id)) records.set(id, list);
      const owner = entry ?? list;
      let join = retirements.get(owner);
      if (!join) {
        join = singleFixtureRetirement(owner, async () => {
          const failures = [];
          const trace = id === "groq_abort" ? routerPhases : null;
          const attempt = async (start, phase) => { try { await phaseStart(trace, phase, start); } catch (error) { failures.push(error); } };
          await attempt(() => entry?.outcome, "router_join_handler");
          await attempt(() => entry?.control?.controlTask, "router_join_control");
          if (id === "groq_abort") entry?.tap?.census(entry);
          await attempt(async () => { for (let count = -1; count !== list.length;) {
            count = list.length;
            for (const record of list) trace?.emit('waituntil_snapshot', 'fulfill', { ordinal: record.ordinal, observed: record.settled ? record.rejected ? 'rejected' : 'fulfilled' : 'pending' });
            await joinOperations(list);
          } }, "router_join_waituntil");
          await attempt(() => entry?.tap?.join(entry), "http_wait_join");
          await attempt(() => entry?.witness.join(list, entry?.tap?.pairs(entry) ?? []), "router_join_reader");
          await attempt(async () => { for (const result of await Promise.allSettled(entry?.observers ?? [])) if (result.status === 'rejected') failures.push(result.reason); }, "router_join_observers");
          await attempt(() => { for (const value of readers.get(id) ?? []) if (!value.unlocked || value.body.locked) throw new Error('original reader remains owned'); }, "router_join_unlock");
          if (id === 'groq_abort' || id === 'mistral_abort') await attempt(async () => {
            const state = await (await originalFetch('https://fixture.example/state', { headers: { 'x-fixture-producer-join': id } })).json();
            if (state.producerFailures !== 0) throw new Error('original upstream producer join failed');
          }, "router_join_producer");
          if (entry?.tap) await attempt(() => {
            entry.restoration = restoreWaitReceipt(entry.tap, id, id === "groq_abort" && routerPhases.incomplete, failures);
            if (id === "groq_abort") routerPhases.emit("http_restore", entry.restoration.restored ? "fulfill" : "reject", { restored: entry.restoration.restored });
            entry.restoration.liveIncomplete ||= id === "groq_abort" && routerPhases.incomplete;
            if (!entry.restoration.restored || entry.restoration.liveIncomplete) throw new Error("wait observer restoration or quota incomplete");
          }, "http_wait_join");
          if (entry) entry.joinFailures = Object.freeze(failures);
          let typed;
          if (id === 'groq_abort' || id === 'mistral_abort') {
            typed = entry?.witness.records(id) ?? [];
            typed.push({ v: 1, test: 'held_original', case: id, scenario: 'abort', kind: 'binding', state: entry ? 'fulfilled' : 'rejected',
              bound: !!entry && entry.id === id && entry.ingress.signal === entry.signals.Ingress && entry.forwarded.signal === entry.signals.Forwarded,
              responseSame: !!entry && entry.response === entry.returnedResponse, bodySame: !!entry && entry.body === entry.response?.body, status: entry?.handlerStatus ?? null });
            typed.push({ v: 1, test: 'held_original', case: id, scenario: 'abort', kind: 'summary', state: failures.length ? 'rejected' : 'fulfilled', failures: failures.length });
            if (entry?.restoration) typed.push(entry.restoration);
            validateHeldRecords(typed);
          }
          return freezeRetirementReceipt({ retired: failures.length === 0, provisional: !!typed, ...(typed ? { typed } : {}), operations: list.length, readers: (readers.get(id) ?? []).length, charged: bodyBudgetCharged() });
        });
        retirements.set(owner, join);
      }
      const receipt = await join(owner);
      return Response.json(receipt.body, { status: receipt.status });
    }
    if (action === 'state') {
      const state = await (await originalFetch('https://fixture.example/state')).json();
      return Response.json({ ...state, requests, charged: bodyBudgetCharged() });
    }
    return new Response(null, { status: 404 });
  }
  const match = /^Bearer clawrouter-live-((?:groq|mistral)_[a-z_]+)-(?:fixture|rotated)-secret$/.exec(request.headers.get('authorization') ?? '');
  const id = match?.[1];
  if (id && url.pathname !== '/v1/usage') requests.push({ id, path: url.pathname, method: request.method, otherKey: request.headers.get('x-api-key') });
  if (!id) return handler.fetch(request, env, context);
  const list = records.get(id) ?? []; records.set(id, list);
  const ownedContext = { waitUntil(pending) {
    const original = pending, ordinal = list.length + 1;
    observeOperation(list, 'waitUntil', original);
    if (id === 'groq_abort') {
      const record = list[list.length - 1]; record.ordinal = ordinal; record.phase = routerPhases;
      routerPhases.emit('waituntil', 'enter', { ordinal });
    }
    context.waitUntil(original);
  } };
  if (request.method === 'POST' && url.pathname.startsWith('/v1/native/')) {
    const controller = new AbortController(), combined = AbortSignal.any([request.signal, controller.signal]);
    const forwarded = new Request(request, { signal: combined });
    const signals = { Ingress: request.signal, Control: controller.signal, Combined: combined, Forwarded: forwarded.signal };
    const entry = { id, ingress: request, forwarded, signals, witness: heldReaderWitness(signals, id === 'groq_abort' ? routerPhases : null), observers: [], dispatching: true };
    entry.witness.bind(entry);
    if (id === "groq_abort" || id === "mistral_abort") {
      entry.tap = installHttpWaitTap(HttpOperation, (phase, state, fields) => { if (id === "groq_abort") routerPhases.emit(phase, state, fields); });
      entry.tap.bind(entry);
    }
    const reason = new Error('controlled original Worker cancellation');
    if (id === 'groq_abort' || id === 'mistral_abort') entry.control = ownerAbortControl(entry, () => entry.witness.control(() => controller.abort(reason)), context, id === 'groq_abort' ? routerPhases : null);
    controllers.set(id, entry);
    if (id === 'groq_abort') routerPhases.emit('handler', 'enter');
    const original = handler.fetch(forwarded, env, ownedContext); entry.outcome = original; entry.witness.watch('handler', original);
    try { const response = await original; entry.handlerStatus = response.status; if (id === 'groq_abort') routerPhases.emit('handler', 'fulfill', { status: response.status }); return response; } catch (error) { if (id === 'groq_abort') routerPhases.emit('handler', 'reject', { defined: error !== undefined, type: error === null ? 'null' : typeof error }); throw error; } finally { entry.dispatching = false; }
  }
  const response = await handler.fetch(request, env, ownedContext);
  if (url.pathname === '/v1/catalog' && id.endsWith('_stale') && response.ok) await admin('credentials/' + id + '/revoke');
  return response;
} };`;
}

function upstreamFixture() {
  return `${finishOwned.toString()}
${pendingResponseProducer.toString()}
const livePhaseNames = ${JSON.stringify(livePhaseNames)};
${validateLivePhase.toString()}
${livePhaseWriter.toString()}
const phaseStart = ${phaseStart.toString()};
const upstreamPhases = livePhaseWriter("upstream", line => console.log(line));
const calls = [], held = new Map(), producers = new Map(), producerFailures = [];
export default { async fetch(request, env, context) {
  if (request.url === 'https://fixture.example/state') {
    const id = request.headers.get('x-fixture-producer-join');
    if (id) {
      const producer = producers.get(id);
      if (!producer) producerFailures.push(new Error('original producer absent'));
      else try { await producer.join(); } catch (error) { producerFailures.push(error); }
    }
    return Response.json({ calls, held: held.size, producerFailures: producerFailures.length });
  }
  const body = await request.formData(), file = body.get('file');
  const id = file.name.slice(0, -4), bytes = await file.arrayBuffer();
  const call = { id, url: request.url, method: request.method, redirect: request.redirect, authorization: request.headers.get('authorization'), otherKey: request.headers.get('x-api-key'), fields: [...body.keys()], model: body.get('model'), language: body.get('language'), prompt: body.get('prompt'), fileName: file.name, mime: file.type, bytes: bytes.byteLength,
    digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('') };
  call.cancelCalls = 0; call.cancelReturns = 0; call.cancelReasonType = "undefined";
  calls.push(call);
  if (id.endsWith('_redirect')) return new Response(null, { status: 307, headers: { location: 'https://must-not-follow.example/transcriptions' } });
  if (id.endsWith('_abort')) {
    const producer = pendingResponseProducer(request.signal, held, id, call); producers.set(id, producer); context.waitUntil(producer.lifetime);
    return new Response(producer.body, { headers: { 'content-type': 'application/json' } });
  }
  if (id.endsWith('_malformed') || id.endsWith('_truncated')) return new Response(id.endsWith('_truncated') ? '{"text":"prefix' : '{invalid', { headers: { 'content-type': 'application/json' } });
  return Response.json({ text: 'café 東京 🦊', ...(id.endsWith('_error') ? { error: 'synthetic failure' } : {}), ...(id.endsWith('_partial') ? { finish_reason: 'length' } : {}), usage: { prompt_audio_seconds: 2, input_tokens: 999 }, duration: 2 });
} };`;
}


// Controlled native diagnostic only; these deliberate errors do not qualify application retirement.
async function originalRetirementNativeUnit(mode, context) {
  const events = [], outcomes = [], observers = [], originals = [];
  const reason = new Error("controlled input retirement diagnostic");
  let controller, nativeRead, nativeCancel, released = 0, releaseAttempts = 0;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const reader = body.getReader(), closed = reader.closed;
  function event(op, state, error) {
    if (events.length === 32) throw new Error("unit observation limit");
    events.push({ seq: events.length + 1, op, state, defined: state === "rejected" && error !== undefined,
      type: state === "rejected" ? error === null ? "null" : typeof error : null,
      sameReason: state === "rejected" && error === reason, locked: body.locked });
  }
  function observe(op, original) {
    const record = { op, state: "pending", reason: undefined, value: undefined };
    outcomes.push(record); originals.push(original);
    observers.push(original.then(value => {
      record.state = "fulfilled"; record.value = value; event(op, "fulfilled");
    }, error => {
      record.state = "rejected"; record.reason = error; event(op, "rejected", error);
    }));
    return original;
  }
  observe("closed", closed);
  const originalCancel = reader.cancel, originalRelease = reader.releaseLock;
  Object.defineProperty(reader, "cancel", { value: function (operand) {
    event("cancel", "invoked");
    try {
      nativeCancel = Reflect.apply(originalCancel, this, [operand]);
      observe("cancel", nativeCancel);
      return nativeCancel;
    } catch (error) { event("cancel", "rejected", error); throw error; }
  } });
  Object.defineProperty(reader, "releaseLock", { value: function () {
    releaseAttempts++; event("release", "invoked");
    try {
      const result = Reflect.apply(originalRelease, this, []);
      released++; event("release", "fulfilled"); return result;
    } catch (error) { event("release", "rejected", error); throw error; }
  } });
  const owner = inputRetirement(reader), ownerRetired = owner.retired;
  event("F0", "invoked");
  const F0 = owner.read(() => {
    event("N0", "invoked");
    nativeRead = Reflect.apply(reader.read, reader, []);
    observe("N0", nativeRead); return nativeRead;
  });
  observe("F0", F0);
  const pendingBeforeControl = outcomes.every(row => row.state === "pending");
  event("control", "invoked");
  if (mode === "eof") controller.close();
  else controller.error(reason);
  event("control", "fulfilled");
  event("T0", "invoked");
  const T0 = owner.retire(mode === "eof" ? "eof" : "cancel", reason);
  observe("T0", T0);
  const originalJoin = Promise.allSettled(originals);
  const observerJoin = Promise.allSettled(observers);
  const complete = Promise.all([originalJoin, observerJoin]);
  context.waitUntil(complete);
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); });
  const result = await Promise.race([complete, deadline]);
  clearTimeout(timer);
  const summary = outcomes.map(row => ({ op: row.op, state: row.state,
    defined: row.state === "rejected" && row.reason !== undefined,
    type: row.state === "rejected" ? row.reason === null ? "null" : typeof row.reason : null,
    sameReason: row.state === "rejected" && row.reason === reason }));
  return { v: 1, mode, applicationAcceptance: false, watchdog: result === null,
    pendingBeforeControl, T0IsRetired: T0 === ownerRetired && T0 === owner.retired,
    F0IsN0: F0 === nativeRead, cancelPresent: nativeCancel !== undefined,
    closedCapturedBeforeRead: events[0].op === "F0",
    releaseAttempts, released, locked: body.locked,
    sourceRetired: outcomes.find(row => row.op === "T0").state === "fulfilled" && released === 1 && !body.locked,
    diagnosticFailures: outcomes.filter(row => row.state === "rejected").length,
    observerFailures: result === null ? null : result[1].filter(row => row.status === "rejected").length,
    readDone: outcomes.find(row => row.op === "N0").value?.done ?? null, outcomes: summary, events };
}

function validateRetirementUnitReceipt(value) {
  const keys = ["v", "mode", "applicationAcceptance", "watchdog", "pendingBeforeControl", "T0IsRetired",
    "F0IsN0", "cancelPresent", "closedCapturedBeforeRead", "releaseAttempts", "released", "locked",
    "sourceRetired", "diagnosticFailures", "observerFailures", "readDone", "outcomes", "events"];
  assert.deepEqual(Object.keys(value), keys);
  assert.equal(value.v, 1);
  assert.ok(["eof", "controlled_error"].includes(value.mode));
  assert.equal(value.applicationAcceptance, false);
  for (const key of keys.filter(key => !["v", "mode", "releaseAttempts", "released", "diagnosticFailures", "observerFailures", "readDone", "outcomes", "events"].includes(key))) assert.equal(typeof value[key], "boolean");
  for (const key of ["releaseAttempts", "released", "diagnosticFailures"]) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 32);
  assert.ok(value.observerFailures === null || Number.isSafeInteger(value.observerFailures) && value.observerFailures >= 0 && value.observerFailures <= 32);
  assert.ok(value.readDone === null || typeof value.readDone === "boolean");
  assert.ok(Array.isArray(value.events) && value.events.length <= 32);
  assert.ok(Array.isArray(value.outcomes) && value.outcomes.length <= 5);
  for (const [rows, isEvent] of [[value.events, true], [value.outcomes, false]]) for (const [index, row] of rows.entries()) {
    assert.deepEqual(Object.keys(row), isEvent ? ["seq", "op", "state", "defined", "type", "sameReason", "locked"] : ["op", "state", "defined", "type", "sameReason"]);
    if (isEvent) { assert.equal(row.seq, index + 1); assert.equal(typeof row.locked, "boolean"); }
    assert.ok(["N0", "F0", "T0", "closed", "cancel", "release", "control"].includes(row.op));
    assert.ok(["pending", "invoked", "fulfilled", "rejected"].includes(row.state));
    assert.equal(typeof row.defined, "boolean"); assert.equal(typeof row.sameReason, "boolean");
    assert.ok([null, "undefined", "object", "string", "number", "boolean", "symbol", "bigint", "function", "null"].includes(row.type));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192);
  return value;
}

test("original input retirement native Workerd diagnostic", { timeout: 28000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-input-retirement-unit-"));
  let mf, mayDispose = true, disposed = false;
  const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const script = `import { inputRetirement } from './worker/input-retirement.ts';
export * from './worker/index.ts';
${originalRetirementNativeUnit.toString()}
export default { async fetch(request, env, context) {
  const mode = new URL(request.url).pathname.slice(1);
  if (mode !== 'eof' && mode !== 'controlled_error') return new Response(null, { status: 400 });
  return Response.json(await originalRetirementNativeUnit(mode, context));
} };`;
    mf = await startWorkerdFixture(temporary, script, "export default { fetch() { return new Response(null, { status: 404 }); } };");
    for (const mode of ["eof", "controlled_error"]) {
      mayDispose = false;
      const response = await mf.dispatchFetch(`https://unit.example/${mode}`);
      const receipt = validateRetirementUnitReceipt(await response.json());
      mayDispose = receipt.sourceRetired;
      process.stdout.write("AUDIO813_UNIT " + JSON.stringify(receipt) + " END\n");
      assert.equal(response.status, 200);
      assert.equal(receipt.watchdog, false); assert.equal(receipt.sourceRetired, true);
      assert.equal(receipt.pendingBeforeControl, true); assert.equal(receipt.T0IsRetired, true);
      assert.equal(receipt.F0IsN0, false); assert.equal(receipt.closedCapturedBeforeRead, true);
      assert.equal(receipt.releaseAttempts, 1); assert.equal(receipt.released, 1); assert.equal(receipt.locked, false);
      assert.equal(receipt.observerFailures, 0); assert.equal(receipt.cancelPresent, mode === "controlled_error");
      assert.equal(receipt.diagnosticFailures, mode === "eof" ? 0 : 4);
      assert.equal(receipt.readDone, mode === "eof" ? true : null);
      for (const outcome of receipt.outcomes) {
        const rejected = mode === "controlled_error" && outcome.op !== "T0";
        assert.equal(outcome.state, rejected ? "rejected" : "fulfilled");
        assert.equal(outcome.sameReason, rejected); assert.equal(outcome.defined, rejected);
      }
    }
  } catch (error) { failures.push(error); }
  await finishOwned(failures, [
    async () => {
      if (!mayDispose) throw new Error("native original retirement incomplete; no normal disposal proof");
      if (mf) await mf.dispose();
      disposed = true;
    },
    async () => { if (disposed) await rm(temporary, { recursive: true, force: true }); },
  ]);
});


// Fetch controls observe two real request scopes; neither is application acceptance.
function fetchRetirementControl(arm) {
  const records = [], observers = [], events = [], faults = [];
  const controller = new AbortController(), reason = new Error("controlled Fetch retirement diagnostic");
  let body, reader, owner, nativeRead, F0, T0, returned = false, pendingAtAbort = false;
  let releaseAttempts = 0, releases = 0, waitRegistered = false, waitSame = false, joinState = "pending";
  function event(op, state, error) {
    if (events.length >= 32) throw new Error("Fetch control event bound");
    events.push({ seq: events.length + 1, op, state, defined: state === "rejected" && error !== undefined,
      type: state === "rejected" ? error === null ? "null" : typeof error : null,
      sameReason: state === "rejected" && error === reason,
      aborted: controller.signal.aborted, handlerReturned: returned });
  }
  function watch(op, original) {
    const record = { op, original, state: "pending", reason: undefined };
    records.push(record);
    observers.push(original.then(() => { record.state = "fulfilled"; event(op, "fulfilled"); },
      error => { record.state = "rejected"; record.reason = error; event(op, "rejected", error); }));
    return original;
  }
  function snapshot() {
    return { v: 1, arm, applicationAcceptance: false, handlerReturned: returned, signalAborted: controller.signal.aborted,
      pendingAtAbort, T0IsRetired: !!T0 && T0 === owner.retired, F0IsN0: !!F0 && F0 === nativeRead,
      waitRegistered, waitSame, releaseAttempts, releases, locked: body?.locked ?? null, joinState,
      diagnosticFailures: records.filter(row => row.state === "rejected").length, faults: faults.length,
      outcomes: records.map(row => ({ op: row.op, state: row.state, defined: row.state === "rejected" && row.reason !== undefined,
        type: row.state === "rejected" ? row.reason === null ? "null" : typeof row.reason : null,
        sameReason: row.state === "rejected" && row.reason === reason })), events };
  }
  async function run(context) {
    try {
      event("fetch", "invoked");
      const originalFetch = fetch("https://upstream.example/stream/" + arm, { signal: controller.signal });
      const response = await watch("fetch", originalFetch);
      body = response.body; reader = body.getReader();
      watch("closed", reader.closed);
      const cancel = reader.cancel, release = reader.releaseLock;
      Object.defineProperty(reader, "cancel", { value: function (operand) {
        event("cancel", "invoked");
        try { const original = Reflect.apply(cancel, this, [operand]); watch("cancel", original); return original; }
        catch (error) { faults.push(error); event("cancel", "rejected", error); throw error; }
      } });
      Object.defineProperty(reader, "releaseLock", { value: function () {
        releaseAttempts++; event("release", "invoked");
        try { const result = Reflect.apply(release, this, []); releases++; event("release", "fulfilled"); return result; }
        catch (error) { faults.push(error); event("release", "rejected", error); throw error; }
      } });
      owner = inputRetirement(reader);
      const prefix = owner.read(() => {
        event("prefixNative", "invoked"); const original = Reflect.apply(reader.read, reader, []); watch("prefixNative", original); return original;
      });
      const first = await watch("prefixOwner", prefix);
      if (first.done || first.value.byteLength !== 9) throw new Error("Fetch control prefix");
      event("F0", "invoked");
      F0 = owner.read(() => {
        event("N0", "invoked"); nativeRead = Reflect.apply(reader.read, reader, []); watch("N0", nativeRead); return nativeRead;
      });
      watch("F0", F0);
      pendingAtAbort = records.find(row => row.op === "N0").state === "pending" && records.find(row => row.op === "F0").state === "pending";
      event("abort", "invoked"); controller.abort(reason); event("abort", "fulfilled");
      event("T0", "invoked"); T0 = owner.retire("cancel", reason); watch("T0", T0);
      const originalJoin = Promise.allSettled(records.map(row => row.original));
      const observerJoin = Promise.allSettled(observers);
      const observedJoin = Promise.all([originalJoin, observerJoin]).then(([, observed]) => {
        for (const result of observed) if (result.status === "rejected") faults.push(result.reason);
        joinState = "fulfilled";
      }, error => { faults.push(error); joinState = "rejected"; });
      void observedJoin.catch(error => { faults.push(error); });
      if (arm === "returned") {
        event("waitUntil", "invoked"); const original = T0;
        context.waitUntil(original); waitRegistered = true; waitSame = original === owner.retired;
        event("waitUntil", "fulfilled");
      } else {
        await T0;
        await observedJoin;
      }
      returned = true; event("handler", "fulfilled");
      return new Response(null, { status: 499 });
    } catch (error) {
      faults.push(error); returned = true; event("handler", "rejected", error);
      return new Response(null, { status: 500 });
    }
  }
  return { run, snapshot };
}

function fetchRetirementControlRouter() {
  return `import { inputRetirement } from './worker/input-retirement.ts';
export * from './worker/index.ts';
${fetchRetirementControl.toString()}
const controls = new Map();
export default { async fetch(request, env, context) {
  const [, operation, arm] = new URL(request.url).pathname.split('/');
  if (arm !== 'active' && arm !== 'returned') return new Response(null, { status: 400 });
  if (operation === 'run') {
    if (controls.has(arm)) return new Response(null, { status: 409 });
    const control = fetchRetirementControl(arm); controls.set(arm, control);
    return control.run(context);
  }
  if (operation === 'state') return Response.json(controls.get(arm)?.snapshot() ?? null);
  if (operation === 'source') return fetch('https://upstream.example/state/' + arm);
  return new Response(null, { status: 404 });
} };`;
}

function fetchRetirementControlUpstream() {
  return `${finishOwned.toString()}
${pendingResponseProducer.toString()}
const sources = new Map(), held = new Map();
export default { async fetch(request, env, context) {
  const [, operation, arm] = new URL(request.url).pathname.split('/');
  if (arm !== 'active' && arm !== 'returned') return new Response(null, { status: 400 });
  if (operation === 'stream') {
    if (sources.has(arm)) return new Response(null, { status: 409 });
    const call = { cancelCalls: 0, cancelReturns: 0, cancelReasonType: 'undefined' };
    const producer = pendingResponseProducer(request.signal, held, arm, call);
    sources.set(arm, { call, producer, join: undefined, joinFailures: [] });
    context.waitUntil(producer.lifetime);
    return new Response(producer.body, { headers: { 'content-type': 'application/json' } });
  }
  if (operation === 'state') {
    const entry = sources.get(arm); if (!entry) return Response.json(null);
    if (!entry.join && entry.call.producerSettled) {
      entry.join = entry.producer.join();
      try { await entry.join; } catch (error) { entry.joinFailures.push(error); }
    }
    const c = entry.call;
    return Response.json({ arm, held: held.has(arm), pulls: c.producerPulls, pending: c.producerPending,
      settled: c.producerSettled, rejected: c.producerRejected, joined: c.producerJoined,
      cancelCalls: c.cancelCalls, cancelReturns: c.cancelReturns, cancelRejected: c.cancelRejected,
      expiry: c.fixtureExpired, timerActive: c.timerActive, signalNotifications: c.signalNotifications,
      pullAt: c.producerPullAt, signalAt: c.producerSignalAt, cancelAt: c.producerCancelAt,
      settleAt: c.producerSettleAt, returnAt: c.producerReturnAt, expiryAt: c.producerExpiryAt,
      joinFailures: entry.joinFailures.length + c.producerJoinFailures });
  }
  return new Response(null, { status: 404 });
} };`;
}

function emitFetchRetirementReceipt(receipt) {
  const enums = new Set(["active", "returned", "start", "complete", "timeout", "failed", "disposed",
    "pending", "invoked", "fulfilled", "rejected", "fetch", "closed", "prefixNative", "prefixOwner",
    "F0", "N0", "cancel", "release", "abort", "T0", "waitUntil", "handler",
    "undefined", "object", "null", "string", "number", "boolean", "bigint", "symbol", "function"]);
  const keys = new Set(["arm", "phase", "status", "controller", "source", "v", "applicationAcceptance",
    "handlerReturned", "signalAborted", "pendingAtAbort", "T0IsRetired", "F0IsN0", "waitRegistered", "waitSame",
    "releaseAttempts", "releases", "locked", "joinState", "diagnosticFailures", "faults", "outcomes", "events",
    "op", "state", "defined", "type", "sameReason", "seq", "aborted", "held", "pulls", "pending", "settled",
    "rejected", "joined", "cancelCalls", "cancelReturns", "cancelRejected", "expiry", "timerActive",
    "signalNotifications", "pullAt", "signalAt", "cancelAt", "settleAt", "returnAt", "expiryAt", "joinFailures"]);
  function validate(value) {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 10000); return; }
    if (typeof value === "string") { assert.ok(enums.has(value)); return; }
    if (Array.isArray(value)) { assert.ok(value.length <= 32); for (const item of value) validate(item); return; }
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const [key, item] of Object.entries(value)) { assert.ok(keys.has(key)); validate(item); }
  }
  validate(receipt); const text = JSON.stringify(receipt); assert.ok(Buffer.byteLength(text) <= 8192);
  process.stdout.write("AUDIO813_FETCH_UNIT " + text + " END\n");
}

test("original Fetch body retirement Workerd lifetime controls", { timeout: 28000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-fetch-retirement-unit-"));
  let mf, disposed = false, allRetired = true;
  const failures = [], dispatches = [], observers = [], retirements = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, fetchRetirementControlRouter(), fetchRetirementControlUpstream());
    for (const arm of ["active", "returned"]) {
      emitFetchRetirementReceipt({ arm, phase: "start" });
      allRetired = false;
      let armRetired = false;
      try {
      let timer;
      const deadlineReason = new Error("Fetch control watchdog");
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(deadlineReason), 10000); });
      const operation = (async () => {
        const original = mf.dispatchFetch("https://unit.example/run/" + arm);
        dispatches.push(original);
        const response = await original; await response.arrayBuffer();
        const stateResponse = await mf.dispatchFetch("https://unit.example/state/" + arm);
        const controller = await stateResponse.json();
        const sourceResponse = await mf.dispatchFetch("https://unit.example/source/" + arm);
        const source = await sourceResponse.json();
        return { arm, phase: "complete", status: response.status, controller, source };
      })();
      observers.push(operation.then(() => undefined, error => { if (!failures.includes(error)) failures.push(error); }));
      let receipt;
      try { receipt = await Promise.race([operation, deadline]); }
      catch (error) {
        emitFetchRetirementReceipt({ arm, phase: error === deadlineReason ? "timeout" : "failed" });
        throw error;
      } finally { clearTimeout(timer); }
      emitFetchRetirementReceipt(receipt);
      const c = receipt.controller, s = receipt.source;
      armRetired = c.joinState === "fulfilled" && c.releases === 1 && !c.locked &&
        s.joined && s.joinFailures === 0 && s.cancelReturns === 1 && !s.held && !s.timerActive && !s.expiry;
      assert.equal(receipt.status, 499); assert.equal(armRetired, true);
      assert.equal(c.applicationAcceptance, false); assert.equal(c.T0IsRetired, true); assert.equal(c.F0IsN0, false);
      assert.equal(c.pendingAtAbort, true); assert.equal(c.signalAborted, true); assert.equal(c.handlerReturned, true);
      assert.equal(c.waitRegistered, arm === "returned"); assert.equal(c.waitSame, arm === "returned");
      assert.equal(c.releaseAttempts, 1); assert.equal(c.faults, 0);
      assert.equal(c.outcomes.find(row => row.op === "T0").state, "fulfilled");
      assert.ok(c.outcomes.every(row => row.state !== "pending"));
      assert.equal(s.pulls, 1); assert.equal(s.cancelCalls, 1); assert.equal(s.cancelRejected, false);
      assert.equal(s.settled, true); assert.equal(s.rejected, false);
      } catch (error) { if (!failures.includes(error)) failures.push(error); }
      finally { retirements.push(armRetired); allRetired = retirements.length === 2 && retirements.every(Boolean); }
    }
  } catch (error) { if (!failures.includes(error)) failures.push(error); }
  await finishOwned(failures, [
    async () => {
      if (!allRetired) throw new Error("Fetch originals incomplete; normal disposal withheld");
      for (const result of await Promise.allSettled(dispatches)) if (result.status === "rejected") failures.push(result.reason);
      for (const result of await Promise.allSettled(observers)) if (result.status === "rejected") failures.push(result.reason);
    },
    async () => {
      if (!allRetired) throw new Error("Fetch source retirement unknown");
      if (mf) await mf.dispose(); disposed = true;
      emitFetchRetirementReceipt({ phase: "disposed" });
    },
    async () => { if (disposed) await rm(temporary, { recursive: true, force: true }); },
  ]);
});


// Only the public F0 rejection determines when this original Fetch owner retires.
function fetchErrorFirstControl() {
  const records = [], observers = [], events = [], faults = [];
  const controller = new AbortController(), abortReason = new Error("controlled error-first diagnostic");
  let body, reader, owner, N0, F0, T0, f0Reason, f0ReasonPresent = false, handlerReturned = false;
  let pendingAtAbort = false, releaseAttempts = 0, releases = 0, waitSame = false, joinState = "pending";
  let cancelOperandPresent = false, cancelOperandSame = false;
  function event(op, state, error) {
    if (events.length >= 32) throw new Error("error-first event bound");
    const row = { seq: events.length + 1, op, state, reasonPresent: state === "rejected",
      defined: state === "rejected" && error !== undefined,
      type: state === "rejected" ? error === null ? "null" : typeof error : null,
      f0ReasonPresent, sameF0: state === "rejected" && f0ReasonPresent && error === f0Reason,
      sameSignal: state === "rejected" && error === controller.signal.reason,
      aborted: controller.signal.aborted, handlerReturned };
    events.push(row);
    try { console.log("AUDIO813_ERROR_FIRST " + JSON.stringify({ phase: "event", event: row }) + " END"); }
    catch (error) { faults.push(error); }
  }
  function watch(op, original) {
    const row = { op, original, state: "pending", reason: undefined }; records.push(row);
    observers.push(original.then(() => { row.state = "fulfilled"; event(op, "fulfilled"); },
      error => { row.state = "rejected"; row.reason = error; event(op, "rejected", error); }));
    return original;
  }
  function snapshot() {
    return { applicationAcceptance: false, f0ReasonPresent, f0ReasonDefined: f0ReasonPresent && f0Reason !== undefined,
      f0ReasonType: f0ReasonPresent ? f0Reason === null ? "null" : typeof f0Reason : null,
      pendingAtAbort, handlerReturned, aborted: controller.signal.aborted,
      T0IsRetired: !!T0 && T0 === owner.retired, F0IsN0: !!F0 && F0 === N0,
      cancelOperandPresent, cancelOperandSame, waitSame, releaseAttempts, releases, locked: body?.locked ?? null,
      joinState, faults: faults.length, diagnosticFailures: records.filter(row => row.state === "rejected").length,
      outcomes: records.map(row => ({ op: row.op, state: row.state, reasonPresent: row.state === "rejected",
        defined: row.state === "rejected" && row.reason !== undefined,
        type: row.state === "rejected" ? row.reason === null ? "null" : typeof row.reason : null,
        sameF0: row.state === "rejected" && f0ReasonPresent && row.reason === f0Reason,
        sameSignal: row.state === "rejected" && row.reason === controller.signal.reason })), events };
  }
  async function run(context) {
    try {
      event("fetch", "invoked");
      const originalFetch = fetch("https://upstream.example/stream/returned", { signal: controller.signal });
      const response = await watch("fetch", originalFetch);
      body = response.body; reader = body.getReader(); watch("closed", reader.closed);
      const originalCancel = reader.cancel, originalRelease = reader.releaseLock;
      Object.defineProperty(reader, "cancel", { value: function (operand) {
        cancelOperandPresent = arguments.length === 1; cancelOperandSame = f0ReasonPresent && operand === f0Reason;
        event("cancel", "invoked");
        try { const original = Reflect.apply(originalCancel, this, [operand]); watch("cancel", original); return original; }
        catch (error) { faults.push(error); event("cancel", "rejected", error); throw error; }
      } });
      Object.defineProperty(reader, "releaseLock", { value: function () {
        releaseAttempts++; event("release", "invoked");
        try { const value = Reflect.apply(originalRelease, this, []); releases++; event("release", "fulfilled"); return value; }
        catch (error) { faults.push(error); event("release", "rejected", error); throw error; }
      } });
      owner = inputRetirement(reader);
      const prefix = owner.read(() => {
        event("prefixNative", "invoked"); const original = Reflect.apply(reader.read, reader, []); watch("prefixNative", original); return original;
      });
      const first = await watch("prefixOwner", prefix);
      if (first.done || first.value.byteLength !== 9) throw new Error("error-first prefix");
      event("F0", "invoked");
      F0 = owner.read(() => {
        event("N0", "invoked"); N0 = Reflect.apply(reader.read, reader, []); watch("N0", N0); return N0;
      });
      watch("F0", F0);
      pendingAtAbort = records.find(row => row.op === "N0").state === "pending" && records.find(row => row.op === "F0").state === "pending";
      event("abort", "invoked"); controller.abort(abortReason); event("abort", "fulfilled");
      try { await F0; } catch (error) { f0ReasonPresent = true; f0Reason = error; event("F0Catch", "rejected", error); }
      if (!f0ReasonPresent) throw new Error("error-first read did not reject");
      event("T0", "invoked"); T0 = owner.retire("cancel", f0Reason); watch("T0", T0);
      const originalJoin = Promise.allSettled(records.map(row => row.original));
      const observerJoin = Promise.allSettled(observers);
      const joined = Promise.all([originalJoin, observerJoin]).then(([, observed]) => {
        for (const result of observed) if (result.status === "rejected") faults.push(result.reason);
        joinState = "fulfilled";
      }, error => { faults.push(error); joinState = "rejected"; });
      void joined.catch(error => { faults.push(error); });
      event("waitUntil", "invoked"); const original = T0; context.waitUntil(original);
      waitSame = original === owner.retired; event("waitUntil", "fulfilled");
      handlerReturned = true; event("handler", "fulfilled");
      return new Response(null, { status: 499 });
    } catch (error) {
      faults.push(error); handlerReturned = true; event("handler", "rejected", error);
      return new Response(null, { status: 500 });
    }
  }
  return { run, snapshot };
}

function errorFirstRouter() {
  return `import { inputRetirement } from './worker/input-retirement.ts';
export * from './worker/index.ts';
${fetchErrorFirstControl.toString()}
const controls = new Map();
export default { async fetch(request, env, context) {
  const [, operation, arm] = new URL(request.url).pathname.split('/');
  if (arm !== 'returned') return new Response(null, { status: 400 });
  if (operation === 'run') {
    if (controls.has(arm)) return new Response(null, { status: 409 });
    const control = fetchErrorFirstControl(); controls.set(arm, control); return control.run(context);
  }
  if (operation === 'state') return Response.json(controls.get(arm)?.snapshot() ?? null);
  if (operation === 'source') return fetch('https://upstream.example/state/' + arm);
  return new Response(null, { status: 404 });
} };`;
}

function emitErrorFirstReceipt(receipt) {
  const enums = new Set(["returned", "start", "event", "complete", "timeout", "failed", "disposed",
    "pending", "invoked", "fulfilled", "rejected", "fetch", "closed", "prefixNative", "prefixOwner",
    "F0", "N0", "F0Catch", "cancel", "release", "abort", "T0", "waitUntil", "handler",
    "undefined", "object", "null", "string", "number", "boolean", "bigint", "symbol", "function"]);
  const keys = new Set(["arm", "phase", "event", "status", "controller", "source", "applicationAcceptance",
    "handlerReturned", "aborted", "pendingAtAbort", "T0IsRetired", "F0IsN0", "waitSame",
    "releaseAttempts", "releases", "locked", "joinState", "diagnosticFailures", "faults", "outcomes", "events",
    "op", "state", "reasonPresent", "defined", "type", "sameF0", "sameSignal", "seq", "held", "pulls", "pending",
    "settled", "rejected", "joined", "cancelCalls", "cancelReturns", "cancelRejected", "expiry", "timerActive",
    "signalNotifications", "pullAt", "signalAt", "cancelAt", "settleAt", "returnAt", "expiryAt", "joinFailures",
    "f0ReasonPresent", "f0ReasonDefined", "f0ReasonType", "cancelOperandPresent", "cancelOperandSame"]);
  function validate(value) {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 10000); return; }
    if (typeof value === "string") { assert.ok(enums.has(value)); return; }
    if (Array.isArray(value)) { assert.ok(value.length <= 32); for (const item of value) validate(item); return; }
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const [key, item] of Object.entries(value)) { assert.ok(keys.has(key)); validate(item); }
  }
  validate(receipt); const text = JSON.stringify(receipt); assert.ok(Buffer.byteLength(text) <= 8192);
  process.stdout.write("AUDIO813_ERROR_FIRST " + text + " END\n");
}

test("original Fetch F0 rejection precedes input retirement", { timeout: 28000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-error-first-unit-"));
  const failures = [];
  let mf, retired = true, disposed = false, operation, observed;
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, errorFirstRouter(), fetchRetirementControlUpstream());
    retired = false; emitErrorFirstReceipt({ phase: "start" });
    operation = (async () => {
      const original = mf.dispatchFetch("https://unit.example/run/returned");
      const response = await original; await response.arrayBuffer();
      const controller = await (await mf.dispatchFetch("https://unit.example/state/returned")).json();
      const source = await (await mf.dispatchFetch("https://unit.example/source/returned")).json();
      return { phase: "complete", status: response.status, controller, source };
    })();
    observed = operation.then(() => undefined, error => { failures.push(error); });
    let timer, receipt;
    const deadlineReason = new Error("error-first watchdog");
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(deadlineReason), 10000); });
    try { receipt = await Promise.race([operation, deadline]); }
    catch (error) {
      emitErrorFirstReceipt({ phase: error === deadlineReason ? "timeout" : "failed" }); throw error;
    } finally { clearTimeout(timer); }
    emitErrorFirstReceipt(receipt);
    const c = receipt.controller, s = receipt.source;
    retired = c.joinState === "fulfilled" && c.releases === 1 && !c.locked &&
      s.joined && s.joinFailures === 0 && s.cancelReturns === 1 && !s.held && !s.timerActive && !s.expiry;
    assert.equal(receipt.status, 499); assert.equal(retired, true); assert.equal(c.applicationAcceptance, false);
    assert.equal(c.f0ReasonPresent, true); assert.equal(c.cancelOperandPresent, true); assert.equal(c.cancelOperandSame, true);
    assert.equal(c.T0IsRetired, true); assert.equal(c.F0IsN0, false); assert.equal(c.waitSame, true);
    assert.equal(c.pendingAtAbort, true); assert.equal(c.releaseAttempts, 1); assert.equal(c.faults, 0);
    assert.equal(c.outcomes.find(row => row.op === "F0").state, "rejected");
    assert.equal(c.outcomes.find(row => row.op === "T0").state, "fulfilled");
    assert.ok(c.outcomes.every(row => row.state !== "pending"));
    assert.ok(c.events.find(row => row.op === "F0Catch").seq < c.events.find(row => row.op === "T0").seq);
    assert.equal(s.pulls, 1); assert.equal(s.cancelCalls, 1); assert.equal(s.cancelRejected, false);
    assert.equal(s.settled, true); assert.equal(s.rejected, false);
  } catch (error) { if (!failures.includes(error)) failures.push(error); }
  await finishOwned(failures, [
    async () => {
      if (!retired) throw new Error("error-first original joins incomplete");
      for (const result of await Promise.allSettled([operation, observed])) if (result.status === "rejected") failures.push(result.reason);
    },
    async () => {
      if (!retired) throw new Error("error-first source retirement unknown");
      if (mf) await mf.dispose(); disposed = true; emitErrorFirstReceipt({ phase: "disposed" });
    },
    async () => { if (disposed) await rm(temporary, { recursive: true, force: true }); },
  ]);
});


// The original decoder owns B1/R1; this observer can see only its public promise and R0.
function originalMultipartControl() {
  const records = [], observers = [], events = [], faults = [];
  const control = new AbortController(), reason = new Error("controlled multipart diagnostic");
  let body, reader, D0, secondReadReason, secondReadReasonPresent = false, handlerReturned = false;
  let routeQualified = false, reads = 0, acquisitions = 0, prefixObserved = false, pendingAtAbort = false;
  let releases = 0, releaseAttempts = 0, joinState = "pending", registeredOriginal = false;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  function event(op, state, error) {
    if (events.length >= 32) throw new Error("multipart event bound");
    const row = { seq: events.length + 1, op, state, defined: state === "rejected" && error !== undefined,
      type: state === "rejected" ? error === null ? "null" : typeof error : null,
      sameSignal: state === "rejected" && error === control.signal.reason, aborted: control.signal.aborted,
      handlerReturned, prefixObserved };
    events.push(row);
    try { console.log("AUDIO813_MULTIPART_UNIT " + JSON.stringify({ phase: "event", event: row }) + " END"); }
    catch (error) { faults.push(error); }
  }
  function watch(op, original) {
    const record = { op, original, state: "pending", reason: undefined }; records.push(record);
    observers.push(original.then(value => {
      record.state = "fulfilled";
      if (op === "prefix") prefixObserved = !value.done && value.value?.byteLength === 9;
      event(op, "fulfilled");
    }, error => {
      record.state = "rejected"; record.reason = error;
      if (op === "N0") { secondReadReasonPresent = true; secondReadReason = error; }
      event(op, "rejected", error);
    }));
    return original;
  }
  function snapshot() {
    return { applicationAcceptance: false, routeQualified, acquisitions, reads, prefixObserved, pendingAtAbort,
      handlerReturned, aborted: control.signal.aborted, registeredOriginal, releaseAttempts, releases,
      locked: body?.locked ?? null, T0State: null, joinState, faults: faults.length,
      diagnosticFailures: records.filter(row => row.state === "rejected").length,
      secondReadReasonPresent,
      outcomes: records.map(row => ({ op: row.op, state: row.state, defined: row.state === "rejected" && row.reason !== undefined,
        type: row.state === "rejected" ? row.reason === null ? "null" : typeof row.reason : null,
        sameSignal: row.state === "rejected" && row.reason === control.signal.reason,
        sameReadReason: row.state === "rejected" && secondReadReasonPresent && row.reason === secondReadReason })), events };
  }
  async function run(context) {
    try {
      const route = multipartRoute("/v1/native/groq/v1/audio/transcriptions");
      if (!route || !route.native) throw new Error("original native route absent");
      const selection = multipartSelection(route);
      routeQualified = selection.provider === route.provider && selection.endpoint === route.endpoints[0]
        && selection.model.upstream === route.contract.model;
      if (!routeQualified) throw new Error("original route selection mismatch");
      event("route", "fulfilled"); event("fetch", "invoked");
      const originalFetch = fetch("https://upstream.example/stream/returned", { signal: control.signal });
      const response = await watch("fetch", originalFetch);
      body = response.body;
      const originalGetReader = body.getReader;
      Object.defineProperty(body, "getReader", { value: function (...args) {
        event("getReader", "invoked");
        const originalReader = Reflect.apply(originalGetReader, this, args);
        acquisitions++; reader = originalReader; watch("closed", reader.closed);
        const originalRead = reader.read, originalCancel = reader.cancel, originalRelease = reader.releaseLock;
        Object.defineProperty(reader, "read", { value: function (...readArgs) {
          const number = ++reads, op = number === 1 ? "prefix" : number === 2 ? "N0" : "extraRead";
          event(op, "invoked");
          try {
            const original = Reflect.apply(originalRead, this, readArgs); watch(op, original);
            if (number === 2) readyResolve();
            return original;
          } catch (error) { faults.push(error); event(op, "rejected", error); throw error; }
        } });
        Object.defineProperty(reader, "cancel", { value: function (...cancelArgs) {
          event("cancel", "invoked");
          try { const original = Reflect.apply(originalCancel, this, cancelArgs); watch("cancel", original); return original; }
          catch (error) { faults.push(error); event("cancel", "rejected", error); throw error; }
        } });
        Object.defineProperty(reader, "releaseLock", { value: function (...releaseArgs) {
          releaseAttempts++; event("release", "invoked");
          try { const value = Reflect.apply(originalRelease, this, releaseArgs); releases++; event("release", "fulfilled"); return value; }
          catch (error) { faults.push(error); event("release", "rejected", error); throw error; }
        } });
        event("getReader", "fulfilled"); return originalReader;
      } });
      event("decoder", "invoked"); D0 = readMultipartResponse(route, response, control.signal); watch("decoder", D0);
      async function join() {
        await Promise.allSettled(records.map(row => row.original));
        const results = await Promise.allSettled(observers);
        for (const result of results) if (result.status === "rejected") faults.push(result.reason);
        joinState = "fulfilled"; event("join", "fulfilled");
      }
      const originalJoinObserver = D0.then(join, join);
      void originalJoinObserver.catch(error => { faults.push(error); joinState = "rejected"; });
      event("waitUntil", "invoked"); context.waitUntil(D0); registeredOriginal = true; event("waitUntil", "fulfilled");
      await ready;
      pendingAtAbort = prefixObserved && reads === 2 && records.find(row => row.op === "N0").state === "pending";
      if (!pendingAtAbort) throw new Error("original second read not pending");
      event("abort", "invoked"); control.abort(reason); event("abort", "fulfilled");
      handlerReturned = true; event("handler", "fulfilled"); return new Response(null, { status: 499 });
    } catch (error) {
      faults.push(error); handlerReturned = true; event("handler", "rejected", error);
      return new Response(null, { status: 500 });
    }
  }
  return { run, snapshot };
}

function originalMultipartControlRouter() {
  return `import { multipartRoute, multipartSelection, readMultipartResponse } from './worker/transcription-protocol.ts';
export * from './worker/index.ts';
${originalMultipartControl.toString()}
const controls = new Map();
export default { async fetch(request, env, context) {
  const [, operation, arm] = new URL(request.url).pathname.split('/');
  if (arm !== 'returned') return new Response(null, { status: 400 });
  if (operation === 'run') {
    if (controls.has(arm)) return new Response(null, { status: 409 });
    const control = originalMultipartControl(); controls.set(arm, control); return control.run(context);
  }
  if (operation === 'state') return Response.json(controls.get(arm)?.snapshot() ?? null);
  if (operation === 'source') return fetch('https://upstream.example/state/' + arm);
  return new Response(null, { status: 404 });
} };`;
}

function emitMultipartUnit(receipt) {
  const enums = new Set(["returned", "start", "event", "complete", "timeout", "failed", "disposed", "observed",
    "pending", "invoked", "fulfilled", "rejected", "route", "fetch", "getReader", "closed", "prefix", "N0",
    "extraRead", "cancel", "release", "abort", "decoder", "waitUntil", "handler", "join",
    "undefined", "object", "null", "string", "number", "boolean", "bigint", "symbol", "function"]);
  const keys = new Set(["arm", "phase", "event", "status", "controller", "source", "applicationAcceptance", "routeQualified",
    "acquisitions", "reads", "prefixObserved", "handlerReturned", "aborted", "pendingAtAbort", "registeredOriginal",
    "releaseAttempts", "releases", "locked", "T0State", "joinState", "diagnosticFailures", "faults", "outcomes", "events",
    "op", "state", "defined", "type", "sameSignal", "sameReadReason", "secondReadReasonPresent", "seq", "held", "pulls",
    "pending", "settled", "rejected", "joined", "cancelCalls", "cancelReturns", "cancelRejected", "expiry", "timerActive",
    "signalNotifications", "pullAt", "signalAt", "cancelAt", "settleAt", "returnAt", "expiryAt", "joinFailures"]);
  function validate(value) {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 10000); return; }
    if (typeof value === "string") { assert.ok(enums.has(value)); return; }
    if (Array.isArray(value)) { assert.ok(value.length <= 32); for (const item of value) validate(item); return; }
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const [key, item] of Object.entries(value)) { assert.ok(keys.has(key)); validate(item); }
  }
  validate(receipt); const text = JSON.stringify(receipt); assert.ok(Buffer.byteLength(text) <= 8192);
  process.stdout.write("AUDIO813_MULTIPART_UNIT " + text + " END\n");
}

test("original multipart two-reader Fetch retirement control", { timeout: 28000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-multipart-retirement-unit-"));
  let mf, operation, observed, disposed = false, retired = true, expired = false, lastReceipt = null;
  const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, originalMultipartControlRouter(), fetchRetirementControlUpstream());
    retired = false; emitMultipartUnit({ phase: "start" });
    const deadlineReason = new Error("multipart control watchdog");
    let timer;
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { expired = true; reject(deadlineReason); }, 10000); });
    operation = (async () => {
      const originalDispatch = mf.dispatchFetch("https://unit.example/run/returned");
      const response = await originalDispatch; await response.arrayBuffer();
      const source = await (await mf.dispatchFetch("https://unit.example/source/returned")).json();
      do {
        const controller = await (await mf.dispatchFetch("https://unit.example/state/returned")).json();
        lastReceipt = { phase: "observed", status: response.status, controller, source };
        if (controller.joinState !== "pending") return { ...lastReceipt, phase: "complete" };
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (!expired);
      throw deadlineReason;
    })();
    observed = operation.then(() => undefined, error => { failures.push(error); });
    let receipt;
    try { receipt = await Promise.race([operation, deadline]); }
    catch (error) {
      if (lastReceipt) emitMultipartUnit(lastReceipt);
      emitMultipartUnit({ phase: error === deadlineReason ? "timeout" : "failed" }); throw error;
    } finally { clearTimeout(timer); expired = true; }
    emitMultipartUnit(receipt);
    const c = receipt.controller, s = receipt.source;
    retired = c.joinState === "fulfilled" && c.releases === 1 && !c.locked &&
      s.joined && s.joinFailures === 0 && s.cancelReturns === 1 && !s.held && !s.timerActive && !s.expiry;
    assert.equal(receipt.status, 499); assert.equal(retired, true); assert.equal(c.applicationAcceptance, false);
    assert.equal(c.routeQualified, true); assert.equal(c.acquisitions, 1); assert.equal(c.reads, 2);
    assert.equal(c.prefixObserved, true); assert.equal(c.pendingAtAbort, true); assert.equal(c.registeredOriginal, true);
    assert.equal(c.releaseAttempts, 1); assert.equal(c.faults, 0); assert.equal(c.T0State, null);
    assert.equal(c.outcomes.find(row => row.op === "decoder").state, "rejected");
    assert.ok(c.outcomes.every(row => row.state !== "pending"));
    assert.equal(s.pulls, 1); assert.equal(s.cancelCalls, 1); assert.equal(s.cancelRejected, false);
    assert.equal(s.settled, true); assert.equal(s.rejected, false);
  } catch (error) { if (!failures.includes(error)) failures.push(error); }
  await finishOwned(failures, [
    async () => {
      if (!retired) throw new Error("multipart original joins incomplete");
      for (const result of await Promise.allSettled([operation, observed])) if (result.status === "rejected") failures.push(result.reason);
    },
    async () => {
      if (!retired) throw new Error("multipart source retirement unknown");
      if (mf) await mf.dispose(); disposed = true; emitMultipartUnit({ phase: "disposed" });
    },
    async () => { if (disposed) await rm(temporary, { recursive: true, force: true }); },
  ]);
});






// Request-bound diagnostics: originals are called once and never replaced by observers.
function restoreWaitReceipt(tap, id, liveIncomplete, failures = []) {
  let failurePresent = false, failure;
  try {
    if (tap.restore() !== true) throw new Error("original wait descriptor restoration refused");
    const state = tap.disposition();
    if (!state.restored || !state.descriptorOwned || state.incomplete || state.failures)
      throw new Error("original wait descriptor restoration incomplete");
  } catch (error) { failurePresent = true; failure = error; failures.push(error); }
  const result = tap.disposition(), restored = result.restored && !failurePresent;
  return { v: 1, test: "held_original", case: id, scenario: "abort", kind: "restoration",
    state: restored ? "fulfilled" : "rejected", attempted: true,
    descriptorOwned: result.descriptorOwned, restored,
    failurePresent, failureDefined: failurePresent && failure !== undefined,
    failureType: failure === null ? "null" : typeof failure, liveIncomplete };
}

function installHttpWaitTap(HttpOperation, emit) {
  const prototype = HttpOperation.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, "wait");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function"
    || descriptor.value.length !== 3 || !descriptor.configurable) throw new Error("original wait descriptor unsupported");
  const originalWait = descriptor.value, then = Promise.prototype.then;
  const entries = new WeakMap(), operations = new WeakMap(), signalOwners = new WeakMap(), states = new WeakMap();
  const globalFailures = []; let globalIncomplete = false, restored = false, descriptorOwned = false, restorationFailure;
  function fault(state, reason) {
    if (state) { state.incomplete = true; state.failures.push(reason); }
    else { globalIncomplete = true; globalFailures.push(reason); }
  }
  function safeEmit(state, phase, status, fields) {
    try { emit(phase, status, fields); } catch (error) { fault(state, error); }
  }
  const signalState = info => ({ caller: info.caller.aborted, signal: info.signal.aborted,
    callerReason: info.caller.reason, signalReason: info.signal.reason });
  function describe(pair, part) {
    const value = pair[part], now = value.after ?? signalState(pair.info);
    return { ordinal: pair.id, role: pair.role, part, observed: value.state,
      inputState: pair.input.state, waitState: pair.wait.state,
      callerBefore: pair.before.caller, signalBefore: pair.before.signal, callerNow: now.caller, signalNow: now.signal,
      sameInputReturn: pair.input.original === pair.wait.original,
      ...(value.state === "rejected" || value.state === "sync_throw" ? {
        defined: value.reason !== undefined, type: value.reason === null ? "null" : typeof value.reason,
        reasonCaller: now.caller && value.reason === now.callerReason,
        reasonSignal: now.signal && value.reason === now.signalReason,
      } : {}) };
  }
  function publish(pair, part) {
    if (pair.role !== "unclassified") safeEmit(pair.owner, "http_wait", "fulfill", describe(pair, part));
  }
  function observe(pair, part, original) {
    const value = pair[part]; value.original = original;
    const settle = (state, reason) => {
      try { value.state = state; value.reason = reason; value.after = signalState(pair.info); publish(pair, part); }
      catch (error) { fault(pair.owner, error); }
    };
    try {
      const observer = Reflect.apply(then, original, [() => settle("fulfilled"), reason => settle("rejected", reason)]);
      pair.owner.observers.push(observer);
    } catch (error) { fault(pair.owner, error); }
  }
  function begin(receiver, args) {
    if (Object.getPrototypeOf(receiver) !== prototype) return null;
    const caller = Object.getOwnPropertyDescriptor(receiver, "caller"), signal = Object.getOwnPropertyDescriptor(receiver, "signal");
    if (!caller || !Object.hasOwn(caller, "value") || !signal || !Object.hasOwn(signal, "value")) return null;
    const entry = entries.get(caller.value); if (!entry) return null;
    const state = states.get(entry); state.total++;
    if (entry.forwarded.signal !== caller.value || entry.signals.Forwarded !== caller.value) {
      fault(state, new Error("caller binding changed")); return null;
    }
    let info = operations.get(receiver);
    if (info && (info.entry !== entry || info.caller !== caller.value || info.signal !== signal.value)) {
      fault(state, new Error("operation binding changed")); return null;
    }
    if (!info) {
      if (signalOwners.has(signal.value)) { fault(state, new Error("ambiguous operation signal")); return null; }
      info = { receiver, entry, caller: caller.value, signal: signal.value };
      operations.set(receiver, info); signalOwners.set(signal.value, info);
    }
    if (state.pairs.length === 16) { state.overflow++; fault(state, new Error("wait census bound")); return null; }
    let role = "unclassified";
    if (state.main === info && args[1] === "upstream") {
      if (args[0] === state.nativeFetch && args.length === 3 && typeof args[2] === "function") role = "fetch";
      else if (args[0] !== state.nativeFetch && args.length === 2) role = "decoder";
      else fault(state, new Error("unqualified main wait"));
      if (role !== "unclassified" && state.pairs.some(pair => pair.role === role)) fault(state, new Error("duplicate main wait"));
    }
    const pair = { id: state.pairs.length + 1, info, owner: state, role, args, before: signalState(info),
      input: { original: args[0], state: "pending", reason: undefined, after: null },
      wait: { original: undefined, state: "pending", reason: undefined, after: null } };
    state.pairs.push(pair); return pair;
  }
  function tappedWait(pending, failure, discard) {
    let pair;
    try { pair = begin(this, arguments); } catch (error) { fault(undefined, error); }
    let returned;
    try { returned = Reflect.apply(originalWait, this, arguments); }
    catch (reason) {
      if (pair) {
        try { pair.wait.state = "sync_throw"; pair.wait.reason = reason; pair.wait.after = signalState(pair.info); observe(pair, "input", pending); publish(pair, "wait"); }
        catch (error) { fault(pair.owner, error); }
      }
      throw reason;
    }
    if (pair) {
      try { pair.wait.original = returned; publish(pair, "input"); observe(pair, "input", pending); observe(pair, "wait", returned); }
      catch (error) { fault(pair.owner, error); }
    }
    return returned;
  }
  Object.defineProperty(prototype, "wait", { ...descriptor, value: tappedWait });
  function restore() {
    const current = Object.getOwnPropertyDescriptor(prototype, "wait");
    if (!current || !Object.hasOwn(current, "value") || current.value !== tappedWait || current.writable !== descriptor.writable
      || current.enumerable !== descriptor.enumerable || current.configurable !== descriptor.configurable) {
      fault(undefined, new Error("wait descriptor changed")); return false;
    }
    descriptorOwned = true;
    try {
      Object.defineProperty(prototype, "wait", descriptor);
      const after = Object.getOwnPropertyDescriptor(prototype, "wait");
      restored = !!after && Object.hasOwn(after, "value") && after.value === originalWait
        && after.writable === descriptor.writable && after.enumerable === descriptor.enumerable && after.configurable === descriptor.configurable;
      return restored;
    } catch (error) { restorationFailure = error; fault(undefined, error); throw error; }
  }
  return {
    bind(entry) {
      const signal = entry.forwarded.signal;
      if (entry.signals.Forwarded !== signal || entries.has(signal) || states.has(entry)) throw new Error("duplicate caller binding");
      entries.set(signal, entry); states.set(entry, { pairs: [], observers: [], failures: [], total: 0, overflow: 0,
        incomplete: false, main: null, nativeFetch: undefined, fetchCaptures: 0 });
    },
    bindFetch(entry, signal, original) {
      const state = states.get(entry), info = signalOwners.get(signal);
      if (!state) { fault(undefined, new Error("fetch entry absent")); return false; }
      if (!info || info.entry !== entry || info.caller !== entry.forwarded.signal || ++state.fetchCaptures !== 1) {
        fault(state, new Error("fetch owner missing or ambiguous")); return false;
      }
      state.main = info; state.nativeFetch = original; return true;
    },
    pairs(entry) { return states.get(entry)?.pairs ?? []; },
    census(entry) {
      const state = states.get(entry); if (!state) return;
      const other = state.pairs.filter(pair => pair.role === "unclassified");
      safeEmit(state, "http_census", "fulfill", { total: state.total, pairs: state.pairs.length, unclassified: other.length,
        inputPending: other.filter(pair => pair.input.state === "pending").length,
        waitPending: other.filter(pair => pair.wait.state === "pending").length,
        inputRejected: other.filter(pair => pair.input.state === "rejected").length,
        waitRejected: other.filter(pair => ["rejected", "sync_throw"].includes(pair.wait.state)).length,
        failures: state.failures.length + globalFailures.length, incomplete: state.incomplete || globalIncomplete });
    },
    async join(entry) {
      const state = states.get(entry); if (!state) throw new Error("wait entry absent");
      await Promise.allSettled(state.pairs.flatMap(pair => [pair.input.original, pair.wait.original]));
      const results = await Promise.allSettled(state.observers);
      const failures = [...globalFailures, ...state.failures];
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      if (state.incomplete || globalIncomplete || state.fetchCaptures !== 1
        || state.pairs.filter(pair => pair.role === "fetch").length !== 1
        || state.pairs.filter(pair => pair.role === "decoder").length !== 1)
        failures.push(new Error("wait diagnostic incomplete"));
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "wait observation failed");
    },
    restore,
    disposition() { return { restored, descriptorOwned, restorationFailure, incomplete: globalIncomplete, failures: globalFailures.length }; },
  };
}

test("HTTP wait tap preserves originals, undefined throws and descriptor ownership", async t => {
  const { HttpOperation } = await import("../worker/http-operation.ts");
  await t.test("original return identity and exact native owner association", async () => {
    const before = Object.getOwnPropertyDescriptor(HttpOperation.prototype, "wait"), lines = [];
    const tap = installHttpWaitTap(HttpOperation, (phase, state, fields) => lines.push(validateLivePhase({ v: 1, isolate: "router", seq: lines.length + 1, case: "groq_abort", phase, state, ...fields })));
    const forwarded = new Request("https://fixture.example", { signal: new AbortController().signal });
    const entry = { forwarded, signals: { Forwarded: forwarded.signal } }; tap.bind(entry);
    try {
      const operation = new HttpOperation(forwarded.signal);
      const first = Promise.resolve(1), firstWait = operation.wait(first);
      assert.equal(tap.pairs(entry)[0].input.original, first); assert.equal(tap.pairs(entry)[0].wait.original, firstWait);
      assert.notEqual(first, firstWait); await firstWait;
      const native = Promise.resolve(new Response(null));
      assert.equal(tap.bindFetch(entry, operation.signal, native), true);
      const fetchWait = operation.wait(native, "upstream", () => undefined); await fetchWait;
      const decoder = Promise.resolve(2), decoderWait = operation.wait(decoder, "upstream"); await decoderWait;
      await tap.join(entry); tap.census(entry);
      assert.deepEqual(tap.pairs(entry).map(pair => pair.role), ["unclassified", "fetch", "decoder"]);
      assert.ok(lines.some(row => row.phase === "http_wait" && row.role === "decoder"));
      assert.throws(() => validateLivePhase({ ...lines[0], privateMessage: "forbidden" }));
      assert.throws(() => validateLivePhase({ ...lines[0], part: "unknown" }));
      operation.stop("complete");
    } finally { assert.equal(tap.restore(), true); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(HttpOperation.prototype, "wait"), before);
  });
  await t.test("synchronous undefined remains the exact original throw", async () => {
    let calls = 0;
    class Original {
      constructor(caller) { this.caller = caller; this.signal = new AbortController().signal; }
      wait(pending, failure, discard) { calls++; throw undefined; }
    }
    const tap = installHttpWaitTap(Original, () => undefined), signal = new AbortController().signal;
    const entry = { forwarded: { signal }, signals: { Forwarded: signal } }; tap.bind(entry);
    const input = Promise.resolve(); let present = false, actual;
    try { new Original(signal).wait(input); } catch (reason) { present = true; actual = reason; }
    await input; await Promise.resolve();
    assert.equal(present, true); assert.equal(actual, undefined); assert.equal(calls, 1);
    assert.equal(tap.pairs(entry)[0].wait.state, "sync_throw"); assert.equal(tap.pairs(entry)[0].wait.reason, undefined);
    assert.equal(tap.restore(), true);
  });
  await t.test("foreign descriptor is never overwritten", () => {
    class Original { wait(pending, failure, discard) { return pending; } }
    const tap = installHttpWaitTap(Original, () => undefined), foreign = function () {};
    Object.defineProperty(Original.prototype, "wait", { value: foreign });
    assert.equal(tap.restore(), false); assert.equal(Original.prototype.wait, foreign);
    assert.equal(tap.disposition().incomplete, true);
  });
});

test("owner control notification is one-shot and retains the original task", async t => {
  await t.test("acceptance precedes owner continuation and exact abort", async () => {
    const entry = {}, controller = new AbortController(), reason = new Error("fixed owner reason"), tasks = [], rows = [];
    const trace = livePhaseWriter("router", line => rows.push(JSON.parse(line.slice(15, -4))));
    let starts = 0;
    const control = ownerAbortControl(entry, () => { starts++; controller.abort(reason); }, { waitUntil(task) { tasks.push(task); } }, trace);
    assert.equal(tasks.length, 1); assert.equal(tasks[0], control.controlTask);
    assert.throws(() => control.request({}, 1)); assert.throws(() => control.request(entry, true));
    assert.equal(controller.signal.aborted, false); assert.equal(starts, 0);
    assert.equal(control.request(entry, 1), true);
    assert.equal(controller.signal.aborted, false); assert.equal(starts, 0);
    assert.equal(control.request(entry, 1), false);
    await control.controlTask;
    assert.equal(starts, 1); assert.equal(controller.signal.reason, reason);
    assert.deepEqual(rows.map(row => [row.phase, row.state]), [
      ["control_accepted", "fulfill"], ["owner_control", "enter"], ["owner_abort", "enter"], ["owner_abort", "fulfill"],
    ]);
    assert.equal(control.request(entry, 1), false);
  });
  await t.test("original undefined abort failure and later cleanup both survive", async () => {
    const entry = {}, tasks = [], cleanup = new Error("owned cleanup"), failures = [];
    let joined = false, present = false, actual;
    const control = ownerAbortControl(entry, () => { throw undefined; }, { waitUntil(task) { tasks.push(task); } });
    assert.equal(tasks[0], control.controlTask);
    assert.equal(control.request(entry, 1), true);
    try { await finishOwned(failures, [
      async () => { try { await control.controlTask; } finally { joined = true; } },
      () => { throw cleanup; },
    ]); } catch (error) { present = true; actual = error; }
    assert.equal(present, true); assert.equal(joined, true);
    assert.ok(actual instanceof AggregateError); assert.deepEqual(actual.errors, [undefined, cleanup]);
    assert.equal(control.request(entry, 1), false);
  });
});

test("controlled native read disposition requires every original boundary", async t => {
  const { HttpOperation } = await import("../worker/http-operation.ts");
  for (const fault of ["none", "wrong_reader", "wrong_request", "no_prefix", "done_prefix", "late_abort", "prior_failure",
    "undefined", "sync_read", "cancel_undefined", "closed_undefined", "missing_cancel", "early_unlock", "duplicate_unlock",
    "production_pending", "production_failure", "control_failure", "observer_undefined", "wrong_wait_reason", "foreign_fetch"]) {
    await t.test(fault, async () => {
      const controller = new AbortController(), reason = new Error("original control"), nativeError = new Error("native read");
      const ingress = new Request("https://fixture.example/original");
      const forwarded = new Request(ingress, { signal: controller.signal });
      const operation = new HttpOperation(forwarded.signal);
      const signals = { Ingress: ingress.signal, Control: controller.signal, Combined: controller.signal, Forwarded: forwarded.signal, Fetch: operation.signal };
      const witness = heldReaderWitness(signals), closed = Promise.withResolvers(), pending = Promise.withResolvers();
      const handler = Promise.withResolvers(), decoder = Promise.withResolvers(), productionPending = Promise.withResolvers();
      const body = { locked: true }, reader = { closed: closed.promise }, response = { body };
      const entry = { id: "groq_abort", ingress, forwarded, signals, body, response, returnedResponse: response,
        outcome: handler.promise, nativeFetch: Promise.resolve(response), handlerStatus: 499 };
      witness.bind(entry); witness.acquire(reader, body);
      witness.watch("fetch", entry.nativeFetch); witness.watch("handler", handler.promise);
      const tap = installHttpWaitTap(HttpOperation, () => {});
      tap.bind(entry);
      // Associate the actual instance before the exact native fetch wait.
      await operation.wait(Promise.resolve());
      assert.equal(tap.bindFetch(entry, operation.signal, entry.nativeFetch), true);
      await operation.wait(entry.nativeFetch, "upstream", () => {});
      const decoderWait = operation.wait(decoder.promise, "upstream");
      const decoderObserved = Promise.allSettled([decoder.promise, decoderWait]);
      const production = [];
      const task = fault === "production_pending" ? productionPending.promise : fault === "production_failure" ? Promise.reject(undefined) : Promise.resolve();
      observeOperation(production, "waitUntil", task);
      const taskObserved = task.then(() => {}, () => {});
      const controlTasks = [];
      entry.control = ownerAbortControl(entry, () => witness.control(() => {
        controller.abort(reason);
        if (fault === "control_failure") throw undefined;
      }), { waitUntil(task) { controlTasks.push(task); } });
      const prefix = { done: fault === "done_prefix", value: new Uint8Array(fault === "no_prefix" ? 0 : 9) };
      await witness.invoke("read", () => Promise.resolve(prefix), reader, []);
      if (fault === "prior_failure") witness.failure(undefined);
      const rawRead = fault === "sync_read" ? null : pending.promise;
      const readObserved = rawRead?.then(() => {}, () => {});
      if (fault === "sync_read") assert.throws(() => witness.invoke("read", () => { throw undefined; }, reader, []), error => error === undefined);
      else witness.invoke("read", () => rawRead, fault === "wrong_reader" ? {} : reader, []);
      if (fault === "late_abort") { pending.reject(nativeError); await readObserved; }
      assert.equal(entry.control.request(entry, 1), true);
      await Promise.allSettled(controlTasks);
      if (fault === "early_unlock") witness.unlock(() => { body.locked = false; }, reader, []);
      let cancellation;
      if (fault !== "missing_cancel") cancellation = witness.invoke("cancel", () => {
        pending.reject(fault === "undefined" ? undefined : nativeError);
        if (fault === "closed_undefined") closed.reject(undefined); else closed.resolve();
        return fault === "cancel_undefined" ? Promise.reject(undefined) : Promise.resolve();
      }, reader, [reason]);
      else { pending.reject(nativeError); closed.resolve(); }
      await Promise.allSettled([pending.promise, closed.promise, cancellation, readObserved]);
      if (fault !== "early_unlock") witness.unlock(() => { body.locked = false; }, reader, []);
      if (fault === "duplicate_unlock") witness.unlock(() => {}, reader, []);
      handler.resolve({ status: 499 }); decoder.reject(nativeError);
      await decoderObserved; await tap.join(entry);
      if (fault !== "production_pending") await taskObserved;
      if (fault === "wrong_request") entry.forwarded = new Request("https://fixture.example/foreign");
      if (fault === "foreign_fetch") entry.nativeFetch = Promise.resolve(response);
      if (fault === "observer_undefined") witness.failure(undefined);
      // Corrupt only the test observation to exercise the final reason guard.
      if (fault === "wrong_wait_reason") tap.pairs(entry).find(pair => pair.role === "decoder").wait.reason = nativeError;
      try {
        if (fault === "none") {
          await witness.join(production, tap.pairs(entry));
          const read = witness.records(entry.id).find(row => row.disposition);
          assert.equal(read.disposition, "controlled_native_read_retired");
          assert.equal(read.reasonDefined, true); assert.equal(read.sameFetch, false);
        } else await assert.rejects(witness.join(production, tap.pairs(entry)));
      } finally {
        productionPending.resolve(); await taskObserved;
        assert.equal(tap.restore(), true);
        operation.stop("complete");
      }
    });
  }
});

test("shipping adjudication rejects incomplete producer, wire, SQLite and restoration evidence", async t => {
  const row = cases.find(row => row.id === "groq_abort");
  const state = { held: 0, charged: 0, producerFailures: 0, calls: [{
    id: row.id, url: row.origin + row.path, method: "POST", redirect: "manual",
    authorization: "Bearer fixture-upstream-groq", otherKey: null, model: row.upstream, language: "en",
    prompt: "Synthetic café 東京", fileName: row.id + ".wav", mime: "audio/wav", bytes: 2048, digest: hash(wav()),
    fields: ["model", "language", "prompt", "file"], cancelCalls: 1, cancelReturns: 1, cancelRejected: false,
    producerPulls: 1, producerSettled: true, producerPending: false, producerJoined: true, producerJoinFailures: 0,
    producerActivePulls: 0, producerActiveCancels: 0, producerCallbacksJoined: true,
    producerRejected: false, fixtureExpired: false, producerExpiryAt: 0, timerActive: false,
  }] };
  const usage = { usage: { events: [{ credential_id: row.id, policy_id: row.id, provider: row.provider, model: row.model,
    capability: "audio.transcription", status: "client_error", status_code: 499, actual_cost_micros: 700,
    cost_basis: "policy_fixed", content_retained: false, input_tokens: null, output_tokens: null, total_tokens: null }] },
    policies: [{ policyId: row.id, budget: { spentMicros: 700 } }] };
  assertShippingEvidence(state, usage, [row]);
  const changes = [
    s => { s.calls[0].producerPending = true; }, s => { s.calls[0].producerJoinFailures = 1; },
    s => { s.calls[0].fixtureExpired = true; }, s => { s.calls[0].producerExpiryAt = 1; },
    s => { s.calls[0].cancelCalls = 0; }, s => { s.calls.push({ ...s.calls[0] }); },
    s => { s.charged = 1; }, s => { s.calls[0].authorization = "wrong"; },
    s => { s.calls[0].model = "wrong"; }, s => { s.calls[0].digest = "wrong"; },
    (s, u) => { u.usage.events[0].provider = "wrong"; }, (s, u) => { u.usage.events[0].policy_id = "wrong"; },
    (s, u) => { u.usage.events[0].actual_cost_micros = 0; }, (s, u) => { u.usage.events[0].status = "timeout"; },
    (s, u) => { u.usage.events[0].input_tokens = 0; }, (s, u) => { u.policies[0].budget.spentMicros = 0; },
    s => { s.calls[0].producerActivePulls = 1; }, s => { s.calls[0].producerActiveCancels = 1; },
    s => { s.calls[0].producerCallbacksJoined = false; },
  ];
  for (const [index, change] of changes.entries()) await t.test("evidence_" + index, () => {
    const s = structuredClone(state), u = structuredClone(usage); change(s, u);
    let seen;
    assert.throws(() => assertShippingEvidence(s, u, [row], (step, id) => { seen = { step, id }; }));
    assert.equal(seen.step, ["producer_pending", "producer_join_failures", "producer_expired", "producer_expiry_at", "cancel_calls", "egress_count", "charged", "wire_auth", "wire_model", "wire_digest", "event_provider", "event_policy", "cost", "abort_status", "input_tokens", "spent", "producer_join_failures", "producer_join_failures", "producer_join_failures"][index]);
  });
  const facts = { v: 1, test: "held_original", case: row.id, scenario: "abort" };
  const receipt = { row, status: 200, result: { retired: true, provisional: true, typed: [
    { ...facts, kind: "read", state: "rejected", disposition: "controlled_native_read_retired", allowed: true, reasonDefined: true, reasonType: "object" },
    { ...facts, kind: "restoration", state: "fulfilled", attempted: true, descriptorOwned: true, restored: true, failurePresent: false, liveIncomplete: false },
    { ...facts, kind: "summary", state: "fulfilled", failures: 0 },
  ] } };
  assertShippingJoin(receipt);
  for (const fault of ["missing", "foreign", "overflow", "failure"]) {
    const changed = structuredClone(receipt), restoration = changed.result.typed[1];
    if (fault === "missing") changed.result.typed.splice(1, 1);
    if (fault === "foreign") restoration.descriptorOwned = false;
    if (fault === "overflow") restoration.liveIncomplete = true;
    if (fault === "failure") restoration.failurePresent = true;
    assert.throws(() => assertShippingJoin(changed));
  }
  const primary = {}, failures = [primary], ran = [];
  await assert.rejects(finishOwned(failures, [
    () => { ran.push("independent"); throw undefined; },
    () => { ran.push("candidate"); assertShippingJoin({ ...receipt, status: 500 }); },
    () => { ran.push("dispose"); throw undefined; }, () => { ran.push("rm"); },
  ]), error => error instanceof AggregateError && error.errors[0] === primary && error.errors.filter(value => value === undefined).length === 2);
  assert.deepEqual(ran, ["independent", "candidate", "dispose", "rm"]);
});

test("restoration receipt survives live quota and preserves full descriptor identity", () => {
  const lines = [], trace = livePhaseWriter("router", line => lines.push(line));
  for (let n = 0; n < 1000; n++) trace.emit("state_body", "fulfill");
  assert.equal(lines.length, 1); assert.equal(trace.incomplete, false);
  for (let n = 0; n < 1000; n++) trace.emit("setup", "enter");
  assert.equal(trace.incomplete, true);
  class Original { wait(pending, failure, discard) { return pending; } }
  const before = Object.getOwnPropertyDescriptor(Original.prototype, "wait");
  const tap = installHttpWaitTap(Original, () => {});
  const receipt = restoreWaitReceipt(tap, "groq_abort", trace.incomplete);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Original.prototype, "wait"), before);
  assert.equal(receipt.descriptorOwned, true); assert.equal(receipt.restored, true); assert.equal(receipt.liveIncomplete, true);
  validateHeldRecords([receipt]);
  const second = installHttpWaitTap(Original, () => {}), foreign = () => {};
  Object.defineProperty(Original.prototype, "wait", { ...before, value: foreign });
  const refused = restoreWaitReceipt(second, "groq_abort", false);
  assert.equal(refused.restored, false); assert.equal(Original.prototype.wait, foreign);
  const retainedFailures = [];
  const thrown = restoreWaitReceipt({ restore() { throw undefined; }, disposition() { return { restored: false, descriptorOwned: true }; } }, "groq_abort", false, retainedFailures);
  assert.deepEqual(retainedFailures, [undefined]);
  assert.equal(thrown.failurePresent, true); assert.equal(thrown.failureDefined, false);
  validateHeldRecords([thrown]);
  assert.throws(() => validateHeldRecords([receipt, receipt]));
  assert.throws(() => validateHeldRecords(Array.from({ length: 32 }, () => ({ v: 1, test: "held_original", case: "groq_abort", scenario: "abort", kind: "summary", state: "fulfilled" }))));
});

test("complete controlled retirement phase sequences fit unchanged quotas", () => {
  const lines = [], traces = Object.fromEntries(["node", "router", "upstream"].map(isolate =>
    [isolate, livePhaseWriter(isolate, line => lines.push(line))]));
  const pair = (isolate, phase, fields = {}) => { traces[isolate].emit(phase, "enter", fields); traces[isolate].emit(phase, "fulfill", fields); };
  for (const phase of ["temporary", "setup", "upload_dispatch", "upload_headers", "state_dispatch", "state_headers",
    "state_body", "abort_dispatch", "abort_headers", "abort_body"]) pair("node", phase);
  traces.node.emit("handler", "fulfill", { status: 499 });
  for (const phase of ["upload_body", "join_dispatch", "join_headers", "join_body", "upstream_observe",
    "sqlite_dispatch", "sqlite_headers", "sqlite_body", "verify", "dispose", "rm"]) pair("node", phase);
  // Even repeated successful polls retain only first milestones, without changing I/O.
  for (let n = 0; n < 1000; n++) for (const phase of ["state_dispatch", "state_headers", "state_body"]) pair("node", phase);
  pair("router", "handler", { status: 499 });
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    pair("router", "waituntil", { ordinal });
    traces.router.emit("waituntil_snapshot", "fulfill", { ordinal, observed: "fulfilled" });
  }
  for (const phase of ["router_control", "owner_abort"]) pair("router", phase);
  traces.router.emit("control_accepted", "fulfill"); traces.router.emit("owner_control", "enter");
  for (const [ordinal, phase] of ["reader_closed", "reader_read", "reader_read", "reader_cancel", "reader_unlock"].entries()) {
    traces.router.emit(phase, "enter", { ordinal: ordinal + 1, observed: "pending" });
    traces.router.emit(phase, ordinal === 2 ? "reject" : "fulfill", { ordinal: ordinal + 1,
      observed: ordinal === 2 ? "rejected" : "fulfilled", allowed: false, defined: true, type: "object" });
  }
  for (const role of ["fetch", "decoder"]) for (const part of ["input", "wait"]) {
    traces.router.emit("http_wait", "fulfill", { ordinal: 12, role, part, observed: role === "fetch" ? "fulfilled" : "rejected",
      inputState: "rejected", waitState: "rejected", callerBefore: false, signalBefore: false, callerNow: true, signalNow: true,
      sameInputReturn: false, defined: true, type: "object", reasonCaller: false, reasonSignal: false });
  }
  traces.router.emit("http_census", "fulfill", { total: 12, pairs: 12, unclassified: 10, inputPending: 0, waitPending: 0,
    inputRejected: 0, waitRejected: 0, failures: 0, incomplete: false });
  for (const phase of ["router_join_handler", "router_join_control", "router_join_waituntil", "router_join_reader",
    "router_join_observers", "router_join_unlock", "router_join_producer", "http_wait_join", "http_wait_join"]) pair("router", phase);
  traces.router.emit("http_restore", "fulfill", { restored: true });
  for (const phase of ["producer_pull", "producer_timer", "producer_pending", "producer_signal", "producer_cancel", "producer_join"]) pair("upstream", phase);
  for (const [isolate, trace] of Object.entries(traces)) assert.equal(trace.incomplete, false, isolate);
  assert.ok(lines.length <= 128); assert.ok(Buffer.byteLength(lines.join("")) <= 12288);
  // Failures remain present even for phase categories whose normal milestones coalesce.
  traces.node.emit("state_body", "reject", { defined: false, type: "undefined" });
  assert.ok(lines.at(-1).includes('"defined":false'));
});
