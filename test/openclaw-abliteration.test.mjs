import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { types as nodeTypes } from "node:util";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const provider = snapshot.providers.find(provider => provider.id === "abliteration");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const models = ["abliterated-model-large-flash", "abliterated-model-large-v2", "abliterated-model", "abliterated-model-large"];
const efforts = [["off", "low", "high", "max"], ["off", "low", "high", "max"], ["off", "minimal", "low", "medium", "high", "xhigh", "max"], ["off", "high", "max"]];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const effortCases = efforts.flatMap((levels, i) => levels.map(level => ({ id: `abliteration_m${i}_${level}`, model: models[i], effort: level === "off" ? (i === 1 ? "low" : "none") : level })));
const charged = [...effortCases.map(row => row.id), "abliteration_simple", "abliteration_notools", "abliteration_image0", "abliteration_image2", "abliteration_observed", "abliteration_cached", "abliteration_error", "abliteration_cancel"];
const modelFor = id => effortCases.find(row => row.id === id)?.model ?? (/^abliteration_image[02]$/.test(id) ? models[Number(id.at(-1))] : models[0]);
const ids = [...charged, "abliteration_unpriced", "abliteration_foreign", "abliteration_revoked"];

// Execute the same closed protocol in Node, the copied SDK test and the Worker.
// Only Node receives the Proxy detector; Worker thrown values stay opaque.
const sdkText = await readFile(new URL("./fixtures/openclaw-abliteration-contract.test.ts", import.meta.url), "utf8");
const protocolStart = sdkText.indexOf("// BEGIN typed diagnostic protocol."), protocolEnd = sdkText.indexOf("// END typed diagnostic protocol.");
assert.ok(protocolStart >= 0 && protocolEnd > protocolStart);
const diagnosticCode = stripTypeScriptTypes(sdkText.slice(protocolStart, protocolEnd));
const makeDiagnostic = new Function(diagnosticCode + "; return diagnosticProtocol;")();
const diagnostic = makeDiagnostic(nodeTypes.isProxy);
const outerContext = operation => ({ source: "outer", test: "T00", scenario: "none", operation, ordinal: 0 });
// The optional metadata belongs only to outer-launcher records. The SDK/Worker
// wire protocol remains unchanged and still validates every received record.
function validateDiagnostic(record) {
  const plain = diagnostic.validate(record);
  if (plain) return plain;
  if (!record || typeof record !== "object" || nodeTypes.isProxy(record)) return null;
  const keys = ["v", "source", "test", "scenario", "operation", "ordinal", "reasons", "metadata"];
  if (Reflect.ownKeys(record).length !== keys.length) return null;
  const base = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    if (key !== "metadata") base[key] = descriptor.value;
  }
  const valid = diagnostic.validate(base), metadata = diagnostic.own(record, "metadata");
  if (!valid || valid.source !== "outer" || valid.test !== "T00" || !metadata || typeof metadata !== "object" || nodeTypes.isProxy(metadata)) return null;
  const fields = ["marker", "exit", "killed", "signal", "sdkRecords"];
  if (Reflect.ownKeys(metadata).length !== fields.length) return null;
  const safe = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    safe[key] = descriptor.value;
  }
  if (!["setup", "fixture_ready", "helper_entered", "helper_fulfilled", "helper_rejected", "diagnostics_received"].includes(safe.marker)) return null;
  if (safe.exit !== null && !(Number.isInteger(safe.exit) && Math.abs(safe.exit) <= 1_000_000)) return null;
  if (safe.killed !== null && typeof safe.killed !== "boolean") return null;
  if (safe.signal !== null && !["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP"].includes(safe.signal)) return null;
  if (safe.sdkRecords !== null && !(Number.isInteger(safe.sdkRecords) && safe.sdkRecords >= 0 && safe.sdkRecords <= 64)) return null;
  const result = { ...valid, metadata: safe };
  return Buffer.byteLength(JSON.stringify(result)) <= 2048 ? result : null;
}
function diagnosticStore() {
  const records = []; let suppressed = 0;
  return {
    add(record) {
      const valid = validateDiagnostic(record); if (!valid) return false;
      if (records.length < 63) records.push(valid); else suppressed = Math.min(suppressed + 1, 1_000_000);
      return true;
    },
    values() {
      return suppressed ? [...records, { ...diagnostic.record(outerContext("capacity"), undefined), ordinal: suppressed, reasons: [{ kind: "suppressed", depth: 0, actual: null, expected: null }] }] : [...records];
    },
  };
}
function emitDiagnostic(record, write = process.stdout.write.bind(process.stdout)) {
  const valid = validateDiagnostic(record);
  if (!valid) throw new Error("invalid diagnostic response");
  const escaped = JSON.stringify(valid).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  // TestContext.diagnostic is reporter-decorated; Actions requires the command
  // to begin the output line. Only this freshly validated record reaches stdout.
  write(`::error title=Abliteration contract diagnostic::${escaped}\n`);
}
function emitDiagnostics(records, failures, write) {
  try {
    const checked = records.map(record => { const valid = validateDiagnostic(record); if (!valid) throw new Error("invalid diagnostic response"); return valid; });
    if (failures.length || checked.some(record => !Object.hasOwn(record, "metadata"))) {
      const priority = record => record.observation ? (record.source === "worker" && record.operation === "worker_retire" ? 0 : record.observation.site === "sdk_join" ? 1 : 2) : Object.hasOwn(record, "metadata") ? 4 : 3;
      for (const record of checked.sort((a, b) => priority(a) - priority(b))) emitDiagnostic(record, write);
    }
  } catch (error) { failures.push(error); }
}
async function retrieveDiagnostics(origin) {
  const response = await fetch(origin + "/fixture/diagnostics", { redirect: "error", signal: AbortSignal.timeout(2000) });
  const text = await diagnostic.read(response.body, 128 * 1024);
  if (response.status !== 200) throw new Error("diagnostic retrieval failed");
  const records = JSON.parse(text);
  if (!Array.isArray(records) || records.length > 64) throw new Error("invalid diagnostic collection");
  const valid = records.map(record => diagnostic.validate(record));
  if (valid.some(record => !record)) throw new Error("invalid diagnostic collection");
  return valid;
}
function outerMetadata(marker, error, sdkRecords = null) {
  const metadata = { marker, exit: null, killed: null, signal: null, sdkRecords };
  if (error && (typeof error === "object" || typeof error === "function") && !nodeTypes.isProxy(error)) {
    // Missing metadata is unknown. A helper rejection does not prove that a
    // child started; never inspect message, stdout, stderr, stack or cause.
    const exit = diagnostic.own(error, "code"), killed = diagnostic.own(error, "killed"), signal = diagnostic.own(error, "signal");
    if (Number.isInteger(exit) && Math.abs(exit) <= 1_000_000) metadata.exit = exit;
    if (typeof killed === "boolean") metadata.killed = killed;
    if (["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP"].includes(signal)) metadata.signal = signal;
  }
  const operation = marker === "setup" || marker === "fixture_ready" ? "fixture_start" : marker === "diagnostics_received" ? "report" : "sdk_process";
  return { ...diagnostic.record(outerContext(operation), undefined), reasons: [{ kind: "unknown", depth: 0, actual: null, expected: null }], metadata };
}

test("actual OpenClaw Abliteration configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  let mf, origin, temporary;
  const failures = [], diagnosticFailures = [], localDiagnostics = diagnosticStore();
  const recordMetadata = (...args) => {
    try { localDiagnostics.add(outerMetadata(...args)); } catch (error) { diagnosticFailures.push(error); }
  };
  let phase = "fixture_start", scenarioContext = { test: "T00", scenario: "none", ordinal: 0 };
  const selectScenario = id => {
    const scenario = id.slice("abliteration_".length);
    const test = Array.from({ length: 27 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`).find(test => diagnostic.identity(test, scenario));
    scenarioContext = test ? { test, scenario, ordinal: 0 } : { test: "T00", scenario: "none", ordinal: 0 };
  };
  const recordFailure = (error, operation = phase) => {
    try { localDiagnostics.add(diagnostic.record({ ...outerContext(operation), ...(operation === phase ? scenarioContext : {}) }, error)); } catch { /* preserve original */ }
  };
  try {
    recordMetadata("setup");
    assert.ok(endpoint);
    assert.deepEqual(provider.models.map(model => [model.id, model.upstream]), models.map(id => ["abliteration/" + id, id]));
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-abliteration-client-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    recordMetadata("fixture_ready");
    phase = "provision";
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "abliteration_foreign" ? "openai" : "abliteration"], models: models.map(id => `abliteration/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "abliteration_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { abliteration: ["abliteration"] }, environmentFallback: false } }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/abliteration", JSON.stringify({ providerId: "abliteration", enabled: true }));
    origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    phase = "catalog_assert";
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-abliteration_m0_high-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "abliteration_m0_high");
    const visible = catalog.providers.find(row => row.id === "abliteration"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "abliteration/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "abliteration/" + id && offer.routeKind === "native" && offer.eligible)));

    phase = "sdk_process";
    recordMetadata("helper_entered");
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-abliteration-contract.test.ts", import.meta.url),
      testPath: "extensions/abliteration/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, ABLIT_KEY: "must-not-fallback", ABLITERATION_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    recordMetadata("helper_fulfilled");
    phase = "worker_retire";
    const retirement = await fetch(origin + "/fixture/retire", { method: "POST" });
    assert.equal(retirement.status, 200);
    const joined = await retirement.json();
    assert.equal(joined.requests, charged.length + 4, "all real SDK requests, including four denials");
    assert.equal(joined.inputs.length, charged.length);
    for (const input of joined.inputs) {
      assert.equal(input.joined, true);
      assert.equal(input.locked, false);
      assert.ok(input.readers.length > 0);
      assert.ok(input.readers.every(reader => reader.unlocked && reader.pendingSettled));
    }
    phase = "cancel_assert";
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("abliteration_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("abliteration_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    phase = "upstream_assert";
    assert.equal(calls.filter(call => call.method === "GET").length, 0, "the actual registered catalog remains static");
    calls = calls.filter(call => call.method === "POST");
    assert.equal(calls.length, charged.length, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-abliteration");
      const id = charged.find(id => JSON.stringify(call.body.messages).includes(id)); assert.ok(id);
      selectScenario(id);
      const expected = modelFor(id);
      assert.equal(call.body.model, expected);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens, 128);
      assert.equal(call.body.max_completion_tokens, undefined);
      assert.equal(call.body.reasoning_effort, effortCases.find(row => row.id === id)?.effort ?? "high");
      assert.ok(call.body.messages.some(message => message.reasoning_content === "synthetic-prior-thinking"), "the registered host and actual serializer preserve reasoning history");
      if (id.startsWith("abliteration_image")) assert.ok(call.body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url" && part.image_url.url === "data:image/png;base64," + image)));
      assert.equal(call.body.prompt_cache_key, "synthetic-cache-affinity");
      assert.equal(call.body.prompt_cache_retention, undefined);
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"));
      if (id === "abliteration_notools") {
        assert.equal(call.body.tools, undefined);
        assert.ok(call.body.messages.some(message => message.role === "assistant" && message.content === '[tool call id=callfixture name=lookup] {}'));
        assert.ok(call.body.messages.some(message => message.role === "user" && message.content === '[tool result id=callfixture name=lookup] synthetic-tool-result'));
        assert.ok(call.body.messages.every(message => message.tool_calls === undefined && message.role !== "tool"));
      } else {
        assert.equal(call.body.tools[0].function.name, "lookup");
        assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
        assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      }
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of charged) {
      selectScenario(id);
      phase = "usage_wait";
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      phase = "usage_assert";
      const events = usage.usage.events.filter(event => event.capability === "llm.chat");
      assert.equal(events.length, 1);
      assert.equal(usage.usage.events.length, 1);
      const [event] = events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "abliteration"); assert.equal(event.model, `abliteration/${modelFor(id)}`);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "abliteration_error" ? "provider_error" : id === "abliteration_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "abliteration_observed" ? [4, 3, 7] : id === "abliteration_cached" ? [100, 20, 120] : [null, null, null]);
      assert.equal(event.cached_input_tokens, id === "abliteration_cached" ? 40 : null);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    phase = "denial_assert";
    for (const id of ["abliteration_revoked", "abliteration_unpriced", "abliteration_foreign"]) {
      selectScenario(id);
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      assert.equal(usage.budget.spentMicros, 0);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } catch (error) {
    recordFailure(error);
    if (phase === "sdk_process") recordMetadata("helper_rejected", error);
    failures.push(error);
  }
  finally {
    // Join the original Worker work before disposal, including failed assertions.
    // This cleanup call is not substituted for the successful retirement assertions.
    try {
      if (origin) {
        const response = await fetch(origin + "/fixture/retire", { method: "POST" });
        await response.arrayBuffer();
        assert.equal(response.status, 200, "Worker retirement must complete before disposal");
      }
    } catch (error) { recordFailure(error, "worker_retire"); failures.push(error); }
    // Reporting follows original retirement and cannot short-circuit disposal.
    try {
      if (origin) {
        const records = await retrieveDiagnostics(origin);
        recordMetadata("diagnostics_received", undefined, records.filter(record => record.source === "sdk").length);
        for (const record of records) localDiagnostics.add(record);
      }
    } catch (error) { recordFailure(error, "report"); failures.push(error); }
    try { await mf?.dispose(); } catch (error) { recordFailure(error, "dispose"); failures.push(error); }
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); } catch (error) { recordFailure(error, "scratch_cleanup"); failures.push(error); }
    failures.push(...diagnosticFailures);
    emitDiagnostics(localDiagnostics.values(), failures);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Abliteration contract or retirement failed");
});

function observeReaderOperation(operations, kind, pending, signals) {
  const operation = { kind, pending, expectedAbort: false }; operations.push(operation);
  void pending.then(() => {}, reason => {
    operation.expectedAbort = kind === "read" && reason !== undefined && signals.some(signal => signal?.aborted && signal.reason === reason);
  });
  return pending;
}
async function joinReaderOperations(operations) {
  const results = await Promise.allSettled(operations.map(operation => operation.pending));
  const failures = results.flatMap((result, index) => result.status === "rejected" && !operations[index].expectedAbort ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "original reader operations failed");
}

// Exercise the same functions embedded in the Worker and the actual TS fixture.
// This is observer coverage, not execution of the native OpenClaw SDK.
async function readerObservers() {
  const text = await readFile(new URL("./fixtures/openclaw-abliteration-contract.test.ts", import.meta.url), "utf8");
  const start = text.indexOf("type ReaderOperation = "), end = text.indexOf("\nbeforeEach(", start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(text.slice(start, end));
  const sdk = new Function(code + "; return { observeReaderOperation, joinReaderOperations, acceptStoredSdkCancel };")();
  return [["Worker", { observeReaderOperation, joinReaderOperations }], ["SDK fixture", sdk]];
}

test("retirement observers retain rejecting cancellation and body failures until every original operation joins", async t => {
  for (const [name, observer] of await readerObservers()) await t.test(name, async () => {
    const operations = [], bodyFailure = new Error("body read failed"), cancellationFailure = new Error("cancel failed");
    let body, rejectCancel;
    const broken = new ReadableStream({ start(controller) { body = controller; } }).getReader();
    const reading = broken.read();
    assert.equal(observer.observeReaderOperation(operations, "read", reading, []), reading);
    body.error(bodyFailure);
    const canceled = new ReadableStream({ cancel() { return new Promise((_, reject) => { rejectCancel = reject; }); } }).getReader();
    const cancellation = canceled.cancel();
    assert.equal(observer.observeReaderOperation(operations, "cancel", cancellation, []), cancellation);
    const joined = observer.joinReaderOperations(operations);
    let settled = false; void joined.then(() => { settled = true; }, () => { settled = true; });
    try {
      await reading.catch(() => {}); await Promise.resolve();
      assert.equal(settled, false, "body failure must not bypass a still-owned cancellation");
      rejectCancel(cancellationFailure);
      await assert.rejects(joined, error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === bodyFailure && error.errors[1] === cancellationFailure);
    } finally {
      rejectCancel(cancellationFailure);
      await Promise.allSettled([reading, cancellation, joined]);
      broken.releaseLock(); canceled.releaseLock();
    }
  });
});
test("retirement observers accept only exact owned read aborts and never cancellation rejection", async t => {
  for (const [name, observer] of await readerObservers()) await t.test(name, async () => {
    const controller = new AbortController(), reason = new Error("owned abort"), foreign = new Error("owned abort");
    const operations = []; controller.abort(reason);
    for (const [kind, value] of [["read", reason], ["read", foreign], ["cancel", reason], ["cancel", undefined]]) {
      const pending = Promise.reject(value);
      assert.equal(observer.observeReaderOperation(operations, kind, pending, [controller.signal]), pending);
    }
    await assert.rejects(observer.joinReaderOperations(operations), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === foreign && error.errors[1] === reason && error.errors[2] === undefined);
    const late = new AbortController(), lateOperations = [];
    observer.observeReaderOperation(lateOperations, "read", Promise.reject(reason), [late.signal]);
    await Promise.resolve(); late.abort(reason);
    await assert.rejects(observer.joinReaderOperations(lateOperations), error => error.errors[0] === reason);
  });
});



test("passive reader identity observes stored errors without accepting cancellation rejection", async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } }), reader = stream.getReader();
  const signal = new AbortController(), reason = new Error("fixed synthetic reason");
  const trace = diagnostic.readerTrace(reader, 1, 1, signal.signal, signal.signal, "guard_input");
  const operations = [];
  const read = trace.begin("read", []);
  const reading = trace.invoke(read, reader.read, reader, []);
  observeReaderOperation(operations, "read", reading, [signal.signal]);
  controller.error(reason); await Promise.allSettled([reading]);
  const cancel = trace.begin("cancel", [reason]);
  let actualPromise, actualReceiver, actualOperands;
  const original = reader.cancel;
  function call(...operands) { actualReceiver = this; actualOperands = operands; return actualPromise = Reflect.apply(original, this, operands); }
  const canceled = trace.invoke(cancel, call, reader, [reason]);
  assert.equal(canceled, actualPromise); assert.equal(actualReceiver, reader); assert.equal(actualOperands[0], reason);
  observeReaderOperation(operations, "cancel", canceled, [signal.signal]);
  await Promise.allSettled([canceled]);
  await assert.rejects(joinReaderOperations(operations), error => error.errors.length === 2 && error.errors.every(value => value === reason));
  const beforeUnlock = trace.snapshot(cancel);
  assert.equal(beforeUnlock.state, "rejected"); assert.equal(beforeUnlock.sameClosed, true); assert.equal(beforeUnlock.sameRead, true); assert.equal(beforeUnlock.sameOperand, true);
  assert.equal(beforeUnlock.closedAfterUnlock, false); assert.equal(beforeUnlock.unlockCallsBefore, 0); assert.equal(beforeUnlock.allSettled, true);
  assert.equal(beforeUnlock.effectiveSignalKnown, false); assert.equal(beforeUnlock.sameSignal, false);
  trace.unlocking(); reader.releaseLock(); trace.unlocked();
  const observation = { site: "cancel_join", ...trace.snapshot(cancel), joinAccepted: false, allUnlocked: true, bodyLocked: stream.locked };
  assert.ok(diagnostic.validate(diagnostic.record({ source: "worker", test: "T00", scenario: "none", operation: "worker_retire", ordinal: 1 }, undefined, observation)));
  assert.equal(observation.allSettled, true); assert.equal(observation.joinAccepted, false); assert.equal(observation.bodyLocked, false);
});

test("passive reader trace separates sync throw, pending closed, undefined identity and late abort", async () => {
  const reader = new ReadableStream().getReader(), signal = new AbortController();
  const trace = diagnostic.readerTrace(reader, 2, 3, signal.signal, signal.signal, "fetch_input");
  assert.equal(trace.snapshot().closedFinal, "pending");
  const sync = trace.begin("cancel", [undefined]);
  let caught = false;
  try { trace.invoke(sync, function () { assert.equal(this, reader); throw undefined; }, reader, [undefined]); }
  catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal(trace.snapshot(sync).state, "sync_throw");
  const op = trace.begin("cancel", [undefined]), original = Promise.reject(undefined);
  assert.equal(trace.invoke(op, () => original, reader, [undefined]), original);
  await Promise.allSettled([original]); signal.abort(new Error("late"));
  const value = trace.snapshot(op);
  assert.equal(value.state, "rejected"); assert.equal(value.signalAborted, false); assert.equal(value.rejectSignalAborted, false);
  for (const key of ["reasonDefined", "sameClosed", "sameRead", "sameOperand", "sameSignal", "sameCaller"]) assert.equal(value[key], false, key);
  assert.equal(value.operandPresent, true); assert.equal(value.operandDefined, false);
  trace.unlocking(); reader.releaseLock(); trace.unlocked(); await Promise.resolve();
  assert.equal(trace.snapshot(op).closedFinalAfterUnlock, true);
  assert.equal(trace.snapshot(op).sameClosedFinal, false);
});

test("passive observation schema and annotation priority retain all safe records and original failures", () => {
  let getters = 0;
  const observation = { site: "cancel_join", input: 1, reader: 1, op: 2, state: "rejected", reasonDefined: false, joinAccepted: false };
  const record = diagnostic.record({ source: "worker", test: "T00", scenario: "none", operation: "worker_retire", ordinal: 1 }, undefined, observation);
  assert.ok(validateDiagnostic(record));
  const getter = { ...observation }; Object.defineProperty(getter, "sameRead", { get() { getters++; return true; }, enumerable: true });
  assert.equal(validateDiagnostic({ ...record, observation: getter }), null);
  assert.equal(validateDiagnostic({ ...record, observation: new Proxy({}, { ownKeys() { getters++; return []; } }) }), null);
  assert.equal(validateDiagnostic({ ...record, observation: { ...observation, message: "forbidden" } }), null);
  assert.equal(validateDiagnostic({ ...record, observation: { ...observation, state: "secret" } }), null);
  const generic = outerMetadata("setup"), emitted = [], failures = [undefined];
  emitDiagnostics([generic, record], failures, line => emitted.push(JSON.parse(line.slice(line.indexOf("::{") + 2))));
  assert.equal(emitted.length, 2); assert.deepEqual(emitted[0], record); assert.deepEqual(emitted[1], generic);
  assert.deepEqual(failures, [undefined]);
  emitDiagnostics([record], failures, () => { throw undefined; }); assert.deepEqual(failures, [undefined, undefined]);
  assert.equal(getters, 0);
});

test("SDK afterEach snapshots settled original products without accepting failed retirement", async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } }), reader = body.getReader();
  const trace = diagnostic.readerTrace(reader, 1, 1, undefined, undefined, "guard_input");
  const op = trace.begin("read", []), reading = trace.invoke(op, reader.read, reader, []);
  controller.error(undefined); await Promise.allSettled([reading]);
  const canceledOp = trace.begin("cancel", []), canceled = trace.invoke(canceledOp, reader.cancel, reader, []);
  const operations = []; observeReaderOperation(operations, "read", reading, []); observeReaderOperation(operations, "cancel", canceled, []);
  operations[1].detail = () => trace.snapshot(canceledOp);
  await Promise.allSettled([reading, canceled]); trace.unlocking(); reader.releaseLock(); trace.unlocked();
  const context = { source: "sdk", test: "T26", scenario: "error", operation: "reader_join", ordinal: 1 };
  const release = Promise.resolve(), records = diagnostic.store(); let cleanup;
  const acquisitions = [{ context, returned: Promise.resolve({}), released: release, releasePending: [release], releaseCalls: 1, releaseSettled: 1, releaseFulfilled: 1, body, readers: [{ pending: operations, unlocked: true, trace }] }];
  const code = stripTypeScriptTypes(sdkText.slice(sdkText.indexOf("afterEach(async () => {"), sdkText.indexOf("\nasync function start(")));
  new Function("afterEach", "acquisitions", "joinReaderOperations", "mark", "remember", "current", "observationErrors", "vi", "diagnostic", "failureRecords", "origin", "diagnosticFetch", "bodyPassed", "started", "acceptStoredSdkCancel", code)(
    fn => { cleanup = fn; }, acquisitions, joinReaderOperations, () => {}, (ctx, error, observation) => { assert.equal(records.add(diagnostic.record(ctx, error, observation)), true); }, context, [],
    { restoreAllMocks() {} }, diagnostic, records, "https://fixture.example", async () => new Response(null, { status: 204 }), true, 1, () => false);
  const result = await Promise.allSettled([cleanup()]);
  assert.equal(result[0].status, "rejected"); assert.equal(result[0].reason.errors[0].errors[0], undefined);
  const snapshot = records.values().find(record => record.observation?.site === "sdk_join");
  assert.ok(snapshot); assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2048);
  assert.equal(snapshot.observation.allSettled, true); assert.equal(snapshot.observation.allReleasesFulfilled, true);
  assert.equal(snapshot.observation.allUnlocked, true); assert.equal(snapshot.observation.bodyLocked, false); assert.equal(snapshot.observation.joinAccepted, false);
  assert.equal(snapshot.observation.sameClosed, false); assert.equal(snapshot.observation.sameRead, false);
});

function sdkCleanupHarness(acquisitions, { bodyPassed = true, started = acquisitions.length, observationErrors = [] } = {}, acceptStoredSdkCancel) {
  const records = diagnostic.store(); let cleanup;
  const context = { source: "sdk", test: "T26", scenario: "error", operation: "reader_join", ordinal: 0 };
  const code = stripTypeScriptTypes(sdkText.slice(sdkText.indexOf("afterEach(async () => {"), sdkText.indexOf("\nasync function start(")));
  const expect = value => ({ toBeGreaterThan(n) { assert.ok(value > n); }, toBe(other) { assert.equal(value, other); }, toEqual(other) { assert.deepEqual(value, other); }, toHaveLength(n) { assert.equal(value.length, n); } });
  new Function("afterEach", "acquisitions", "joinReaderOperations", "mark", "remember", "current", "observationErrors", "vi", "diagnostic", "failureRecords", "origin", "diagnosticFetch", "bodyPassed", "started", "acceptStoredSdkCancel", "expect", code)(
    fn => { cleanup = fn; }, acquisitions, sdkJoinForCleanup, () => {}, (ctx, reason, observation) => { assert.equal(records.add(diagnostic.record(ctx, reason, observation)), true); }, context, observationErrors,
    { restoreAllMocks() {} }, diagnostic, records, "https://fixture.example", async () => new Response(null, { status: 204 }), bodyPassed, started, acceptStoredSdkCancel, expect);
  return { cleanup, records };
}
// Bound once from the actual SDK helper source, never the Worker classifier.
const sdkHelpers = new Function(stripTypeScriptTypes(sdkText.slice(sdkText.indexOf("type ReaderOperation = "), sdkText.indexOf("\nbeforeEach("))) + ";return { observeReaderOperation, joinReaderOperations, acceptStoredSdkCancel };")();
const sdkJoinForCleanup = sdkHelpers.joinReaderOperations;
async function nativeStoredErrorCase(options = {}) {
  const reason = options.undefinedReason ? undefined : new Error("fixed native stored error"), foreign = new Error("fixed native stored error");
  const guard = new AbortController(), caller = new AbortController(); let controller;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { if (options.underlyingFailure) throw foreign; } });
  const reader = body.getReader(), trace = diagnostic.readerTrace(reader, 1, 1, guard.signal, options.t27 ? caller.signal : undefined, "guard_input");
  if (!options.lateAbort) { guard.abort(reason); if (options.t27) caller.abort(reason); }
  const readOp = trace.begin("read", []), reading = trace.invoke(readOp, reader.read, reader, []), operations = [];
  sdkHelpers.observeReaderOperation(operations, "read", reading, [guard.signal]);
  if (!options.underlyingFailure) controller.error(options.foreignStored ? foreign : reason);
  const unlock = () => { trace.unlocking(); reader.releaseLock(); trace.unlocked(); };
  if (options.afterUnlock) unlock();
  const cancelOp = trace.begin("cancel", []), canceled = trace.invoke(cancelOp, reader.cancel, reader, []);
  sdkHelpers.observeReaderOperation(operations, "cancel", canceled, [guard.signal]);
  operations[1].detail = () => trace.snapshot(cancelOp);
  if (!options.missingWitness) operations[1].storedError = (value, needCaller) => trace.storedErrorCancel(cancelOp, canceled, value, needCaller);
  if (!options.locked && !options.afterUnlock) unlock();
  await Promise.allSettled([reading, canceled]);
  if (options.lateAbort) { guard.abort(reason); if (options.t27) caller.abort(reason); }
  if (options.unrelatedRead) { const pending = Promise.reject(foreign); sdkHelpers.observeReaderOperation(operations, "read", pending, [guard.signal]); await Promise.allSettled([pending]); }
  const release = options.releaseFailure ? Promise.reject(foreign) : Promise.resolve(); await Promise.allSettled([release]);
  const context = { source: "sdk", test: options.t27 ? "T27" : "T26", scenario: options.t27 ? "cancel" : "error", operation: "guard", ordinal: 1 };
  const row = { context, returned: Promise.resolve({}), released: Promise.resolve(), releasePending: [release], releaseCalls: 1, releaseSettled: 1, releaseFulfilled: options.releaseFailure ? 0 : 1, body, readers: [{ reader, pending: operations, unlocked: !options.locked, trace }] };
  return { reason, foreign, row, trace, cancelOp, operations, finish() { if (body.locked) unlock(); } };
}
function flattenedFailures(error) { return error instanceof AggregateError ? error.errors.flatMap(flattenedFailures) : [error]; }

test("SDK stored-error classification accepts only original native identities after full retirement", async t => {
  for (const t27 of [false, true]) await t.test(t27 ? "T27 caller abort" : "T26 guard finalization", async () => {
    const actual = await nativeStoredErrorCase({ t27 });
    try {
      const { cleanup } = sdkCleanupHarness([actual.row], {}, sdkHelpers.acceptStoredSdkCancel);
      await cleanup();
      assert.equal(actual.trace.snapshot(actual.cancelOp).closedAfterUnlock, true);
      assert.equal(actual.trace.snapshot(actual.cancelOp).sameClosedFinal, true);
      assert.equal(actual.trace.snapshot(actual.cancelOp).eof, false);
      assert.equal(actual.body?.locked ?? actual.row.body.locked, false);
    } finally { actual.finish(); }
  });
});

test("SDK stored-error classification rejects missing, foreign, late and incomplete evidence", async t => {
  for (const options of [{ underlyingFailure: true }, { foreignStored: true }, { undefinedReason: true }, { missingWitness: true }, { afterUnlock: true }, { lateAbort: true }, { unrelatedRead: true }, { releaseFailure: true }, { locked: true }, { bodyPassed: false }]) await t.test(Object.keys(options)[0], async () => {
    const actual = await nativeStoredErrorCase(options);
    try {
      const { cleanup } = sdkCleanupHarness([actual.row], { bodyPassed: options.bodyPassed !== false }, sdkHelpers.acceptStoredSdkCancel);
      const result = await Promise.allSettled([cleanup()]);
      assert.equal(result[0].status, "rejected");
      if (options.unrelatedRead || options.releaseFailure || options.foreignStored) assert.ok(flattenedFailures(result[0].reason).includes(actual.foreign));
      if (options.undefinedReason) assert.ok(flattenedFailures(result[0].reason).includes(undefined));
      if (options.bodyPassed === false) {
        const primary = undefined, both = await Promise.allSettled([Promise.reject(primary), Promise.reject(result[0].reason)]);
        assert.equal(both[0].status, "rejected"); assert.equal(both[0].reason, primary); assert.equal(both[1].reason, result[0].reason);
      }
    } finally { actual.finish(); }
  });
});

test("SDK stored-error admission waits for original release and operation joins", async () => {
  const actual = await nativeStoredErrorCase(); let release, finishOperation;
  const heldRelease = new Promise(resolve => { release = resolve; }), heldRead = new Promise(resolve => { finishOperation = resolve; });
  actual.row.released = heldRelease; actual.row.releasePending = [heldRelease];
  sdkHelpers.observeReaderOperation(actual.operations, "read", heldRead, []);
  const { cleanup } = sdkCleanupHarness([actual.row], {}, sdkHelpers.acceptStoredSdkCancel);
  let ended = false; const result = cleanup(); void result.then(() => { ended = true; }, () => { ended = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
    finishOperation(); await result;
  } finally { release(); finishOperation(); await Promise.allSettled([result]); actual.finish(); }
});

test("SDK stored-error predicate cannot accept synchronous throws or foreign operation ownership", async () => {
  const actual = await nativeStoredErrorCase();
  try {
    const op = actual.trace.begin("cancel", []);
    assert.throws(() => actual.trace.invoke(op, () => { throw actual.reason; }, actual.row.readers[0].reader, []), error => error === actual.reason);
    assert.equal(actual.trace.storedErrorCancel(op, actual.operations[1].pending, actual.reason, false), false);
    assert.equal(actual.trace.storedErrorCancel({ ...actual.cancelOp }, actual.operations[1].pending, actual.reason, false), false);
    assert.equal(sdkHelpers.acceptStoredSdkCancel({ test: "T25", scenario: "invalid" }, actual.operations[1], actual.reason, true), false);
    assert.equal(sdkHelpers.acceptStoredSdkCancel({ test: "T27", scenario: "cancel" }, actual.operations[1], actual.reason, true), false);
  } finally { actual.finish(); }
});

test("Abliteration diagnostics map all 27 registered tests and 30 scenarios without interpolated-title assumptions", () => {
  const registered = [];
  const registration = sdkText.slice(sdkText.indexOf('describe("actual Abliteration'));
  new Function("describe", "caseTest", "efforts", registration)((_title, body) => body(), (id, title, body) => registered.push({ id, title, body }), efforts);
  assert.equal(registered.length, 27);
  assert.equal(new Set(registered.map(row => row.id)).size, 27);
  assert.equal(new Set(registered.map(row => row.title)).size, 27);
  assert.equal(diagnostic.scenarios.length, 30);
  for (const scenario of diagnostic.scenarios) assert.equal(registered.filter(row => diagnostic.identity(row.id, scenario)).length, 1);
  assert.deepEqual(diagnostic.scenarios.filter(scenario => diagnostic.identity("T25", scenario)), ["invalid", "foreign", "revoked", "unpriced"]);
  assert.equal(diagnostic.identity("T25", "error"), false);
});

test("Abliteration diagnostic schema rejects getters, proxies and private strings without observing them", () => {
  let traps = 0;
  const secret = "private-value-must-not-escape";
  const error = Object.create(Error.prototype, {
    name: { get() { traps++; return "AssertionError"; } },
    message: { get() { traps++; return secret; } },
    stack: { get() { traps++; return secret; } },
    toJSON: { value() { traps++; return secret; } },
  });
  const proxy = new Proxy(error, { getOwnPropertyDescriptor() { traps++; throw undefined; }, getPrototypeOf() { traps++; throw undefined; }, ownKeys() { traps++; throw undefined; } });
  assert.equal(diagnostic.classify(proxy)[0].kind, "proxy");
  assert.equal(diagnostic.validate(proxy), null);
  const record = diagnostic.record(outerContext("assert"), error);
  assert.ok(diagnostic.validate(record));
  assert.doesNotMatch(JSON.stringify(record), /private-value/);
  const invalid = { ...record, toJSON() { traps++; return secret; } };
  assert.equal(diagnostic.validate(invalid), null);
  const accessor = { ...record }; Object.defineProperty(accessor, "operation", { get() { traps++; return "assert"; } });
  assert.equal(diagnostic.validate(accessor), null);
  const assertion = Object.assign(new Error(secret), { name: "AssertionError", actual: secret, expected: 7 });
  assert.deepEqual(diagnostic.classify(assertion), [{ kind: "assertion", depth: 0, actual: null, expected: 7 }]);
  const aggregate = new AggregateError([new AggregateError([undefined, null, secret]), proxy, error]);
  const reasons = diagnostic.classify(aggregate);
  assert.equal(reasons.length, 4); assert.deepEqual(reasons.map(row => row.depth), [0, 1, 2, 2]);
  assert.equal(traps, 0);
  const opaque = makeDiagnostic();
  assert.equal(opaque.record(outerContext("guard"), proxy).reasons[0].kind, "unknown");
  assert.equal(traps, 0);
});

test("Abliteration diagnostic relay bounds bytes, record count, schema and fresh annotations", async () => {
  const relay = diagnostic.relay(), record = diagnostic.record({ source: "sdk", test: "T25", scenario: "invalid", operation: "guard", ordinal: 1 }, undefined);
  const send = (body, method = "POST") => relay(new Request("https://fixture.example/fixture/diagnostic", { method, body, duplex: "half" }));
  assert.equal((await send(JSON.stringify({ ...record, message: "never allowed" }))).status, 400);
  let cancelled = false;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2049)); }, cancel() { cancelled = true; } });
  assert.equal((await send(oversized)).status, 400); assert.equal(cancelled, true); assert.equal(oversized.locked, false);
  for (let i = 0; i < 70; i++) assert.equal((await send(JSON.stringify(record))).status, 204);
  const response = await relay(new Request("https://fixture.example/fixture/diagnostics"));
  const records = JSON.parse(await diagnostic.read(response.body, 128 * 1024));
  assert.equal(records.length, 64); assert.equal(records.at(-1).operation, "capacity"); assert.equal(records.at(-1).ordinal, 7);
  assert.ok(records.every(row => diagnostic.validate(row)));
  assert.throws(() => emitDiagnostic({ ...record, operation: "private\n::error" }, () => { throw new Error("must not reach"); }), /invalid diagnostic/);
  const tooLarge = new Response(new Uint8Array(128 * 1024 + 1));
  await assert.rejects(diagnostic.read(tooLarge.body, 128 * 1024), /capacity/); assert.equal(tooLarge.body.locked, false);
});

test("Abliteration annotation command survives the actual Node 24 default spec reporter", { timeout: 20_000 }, async () => {
  assert.match(process.version, /^v24\.22\./);
  // Only this fresh synthetic fixture's output is inspected. Never read the
  // native SDK helper's child stdout/stderr or any historical job output.
  const temporary = await mkdtemp(join(tmpdir(), "abliteration-reporter-"));
  const file = join(temporary, "annotation.test.mjs");
  const record = diagnostic.record(outerContext("assert"), undefined);
  const failures = [];
  const program = `import test from "node:test";
import { types as nodeTypes } from "node:util";
${diagnosticCode}
const diagnostic = diagnosticProtocol(nodeTypes.isProxy);
${validateDiagnostic.toString()}
${emitDiagnostic.toString()}
test("fresh synthetic annotation", () => emitDiagnostic(${JSON.stringify(record)}));
`;
  try {
    await writeFile(file, program);
    // Match the repository's standalone test-runner probes: the inherited
    // child-v8 marker would make Node skip this nested --test invocation.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--test", file], { env, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, output) => {
        if (error) reject(new Error("synthetic reporter subprocess failed"));
        else resolve(output);
      });
    });
    assert.match(stdout, /✔ fresh synthetic annotation/, "the real child must use Node 24 default spec reporting");
    assert.match(stdout, /tests 1/);
    const prefix = "::error title=Abliteration contract diagnostic::";
    const lines = stdout.split(/\r?\n/).filter(line => line.includes(prefix));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], prefix + JSON.stringify(record), "the final stdout line must start with the Actions command, without reporter decoration");
    assert.deepEqual(JSON.parse(lines[0].slice(prefix.length)), record);
  } catch (error) { failures.push(error); }
  finally { try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "reporter regression or cleanup failed");
});

test("Abliteration outer metadata is closed, unknown-preserving and shares the 64-record cap", () => {
  const missing = outerMetadata("helper_rejected", undefined);
  assert.deepEqual(missing.metadata, { marker: "helper_rejected", exit: null, killed: null, signal: null, sdkRecords: null });
  assert.ok(validateDiagnostic(missing));
  let reads = 0;
  const error = Object.defineProperties({}, {
    code: { value: 1 }, killed: { value: false }, signal: { value: "SIGTERM" },
    message: { get() { reads++; throw undefined; } },
    stdout: { get() { reads++; throw undefined; } }, stderr: { get() { reads++; throw undefined; } },
  });
  assert.deepEqual(outerMetadata("helper_rejected", error).metadata, { marker: "helper_rejected", exit: 1, killed: false, signal: "SIGTERM", sdkRecords: null });
  const accessor = Object.defineProperty({}, "code", { get() { reads++; return 1; } });
  assert.equal(outerMetadata("helper_rejected", accessor).metadata.exit, null);
  const proxy = new Proxy(error, { getOwnPropertyDescriptor() { reads++; throw undefined; }, ownKeys() { reads++; throw undefined; } });
  assert.equal(outerMetadata("helper_rejected", proxy).metadata.exit, null);
  assert.equal(validateDiagnostic({ ...missing, metadata: proxy }), null);
  assert.equal(validateDiagnostic({ ...missing, metadata: { ...missing.metadata, signal: "private-signal" } }), null);
  assert.equal(validateDiagnostic({ ...missing, metadata: { ...missing.metadata, childStarted: true } }), null);
  assert.equal(reads, 0);
  assert.equal(outerMetadata("diagnostics_received", undefined, 0).metadata.sdkRecords, 0);
  const store = diagnosticStore();
  for (let i = 0; i < 70; i++) assert.equal(store.add(missing), true);
  assert.equal(store.values().length, 64); assert.equal(store.values().at(-1).ordinal, 7);
  assert.ok(store.values().every(record => validateDiagnostic(record)));
});

test("Abliteration direct sink failures preserve original body and cleanup failures including undefined", () => {
  const body = new Error("body"), cleanup = new Error("cleanup");
  const records = [outerMetadata("helper_rejected", undefined), diagnostic.record(outerContext("assert"), undefined)];
  const failures = [undefined, body, cleanup]; let writes = 0;
  emitDiagnostics(records, failures, () => { writes++; throw undefined; });
  assert.deepEqual(failures, [undefined, body, cleanup, undefined]); assert.equal(writes, 1);
  let reached = false;
  emitDiagnostics([outerMetadata("helper_fulfilled")], [], () => { reached = true; });
  assert.equal(reached, false, "setup/helper observations alone must not emit a false error on success");
  const rejected = [body];
  emitDiagnostics([{ ...records[1], operation: "unsafe\n::error" }], rejected, () => { reached = true; });
  assert.equal(rejected[0], body); assert.equal(rejected.length, 2); assert.equal(reached, false);
});

function sdkDiagnosticHarness(send) {
  const begin = sdkText.indexOf("const diagnostic = diagnosticProtocol(nodeTypes.isProxy);"), end = sdkText.indexOf("// Observe the shipped guard", begin);
  const helpers = stripTypeScriptTypes(sdkText.slice(begin, end));
  return new Function("diagnosticProtocol", "nodeTypes", "globalThis", "it", helpers + `; return {
    caseBody, remember, mark,
    set(context) { current = context; },
    context() { return { ...current }; },
    records() { return failureRecords.values(); },
    flush(origin) { return diagnostic.flush(failureRecords.values(), origin, diagnosticFetch); },
  };`)(makeDiagnostic, nodeTypes, { fetch: send }, () => {});
}

test("Abliteration diagnostics retain late T25 operation identity and original undefined body failure", async () => {
  const relay = diagnostic.relay();
  const harness = sdkDiagnosticHarness((input, init) => relay(new Request(input, init)));
  let reject;
  const original = new Promise((_, fail) => { reject = fail; });
  const first = { source: "sdk", test: "T25", scenario: "invalid", operation: "read", ordinal: 1 };
  harness.set(first);
  const captured = harness.context();
  void original.then(() => {}, error => harness.remember(captured, error));
  harness.set({ ...first, scenario: "unpriced", operation: "assert", ordinal: 4 });
  const body = await Promise.allSettled([harness.caseBody("T25", async () => { throw undefined; })()]);
  assert.equal(body[0].status, "rejected"); assert.equal(body[0].reason, undefined);
  reject(undefined); await Promise.allSettled([original]);
  harness.mark("reader_join");
  await harness.flush("https://fixture.example");
  const records = await (await relay(new Request("https://fixture.example/fixture/diagnostics"))).json();
  assert.deepEqual(records.map(row => [row.scenario, row.operation, row.ordinal]), [["unpriced", "assert", 4], ["invalid", "read", 1]]);
  assert.ok(records.every(row => row.reasons[0].kind === "undefined"));
});

test("Abliteration diagnostics join original cleanup before reporting and preserve body, undefined cancellation and writer failures", async () => {
  const bodyFailure = new Error("body"), writerFailure = new Error("writer");
  let release, readDone = false, restored = false, sent = 0;
  const held = new Promise(resolve => { release = () => { readDone = true; resolve(); }; });
  const canceled = Promise.reject(undefined); void canceled.catch(() => {});
  const acquisitions = [{ returned: Promise.resolve({}), released: Promise.resolve(), releasePending: [], readers: [{ pending: [{ kind: "cancel", pending: canceled, expectedAbort: false }, { kind: "read", pending: held, expectedAbort: false }] }] }];
  const records = diagnostic.store(); records.add(diagnostic.record(outerContext("assert"), bodyFailure));
  const begin = sdkText.indexOf("afterEach(async () => {"), end = sdkText.indexOf("\nasync function start(", begin);
  const code = stripTypeScriptTypes(sdkText.slice(begin, end));
  let cleanup;
  new Function("afterEach", "acquisitions", "joinReaderOperations", "mark", "remember", "current", "observationErrors", "vi", "diagnostic", "failureRecords", "origin", "diagnosticFetch", "bodyPassed", "started", "acceptStoredSdkCancel", code)(
    callback => { cleanup = callback; }, acquisitions, joinReaderOperations, () => {}, () => {}, outerContext("reader_join"), [],
    { restoreAllMocks() { restored = true; } }, diagnostic, records, "https://fixture.example",
    async () => { sent++; assert.equal(readDone, true); assert.equal(restored, true); throw writerFailure; }, false, 1, () => false);
  let finished = false; const pending = cleanup().finally(() => { finished = true; }); void pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0); assert.equal(finished, false);
  release();
  const results = await Promise.allSettled([Promise.reject(bodyFailure), pending]);
  assert.equal(results[0].reason, bodyFailure);
  const cleanupError = results[1].reason;
  assert.equal(cleanupError.errors[1], writerFailure);
  assert.equal(cleanupError.errors[0].errors[0].errors[0], undefined);
  assert.equal(sent, 1);
});

test("Abliteration diagnostic reporting uses one two-second deadline and joins abort without retry", { timeout: 5000 }, async () => {
  let sent = 0, retired = false, signal;
  const record = diagnostic.record(outerContext("assert"), undefined);
  await assert.rejects(diagnostic.flush([record, record], "https://fixture.example", async (_input, init) => {
    sent++; signal = init.signal;
    try { await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
    finally { retired = true; }
  }));
  assert.equal(signal.aborted, true); assert.equal(sent, 1); assert.equal(retired, true);
});

test("Abliteration diagnostic Worker control relay bypasses product dispatch and retains retirement", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-abliteration-diagnostic-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf; const failures = [];
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const origin = String(await mf.ready).replace(/\/$/, "");
    const record = diagnostic.record({ source: "sdk", test: "T01", scenario: "m0_off", operation: "catalog", ordinal: 0 }, undefined, { site: "sdk_join", input: 1, reader: 1, state: "rejected", allSettled: true, joinAccepted: false });
    await diagnostic.flush([record], origin, fetch);
    assert.deepEqual(await retrieveDiagnostics(origin), [record]);
    const retirement = await fetch(origin + "/fixture/retire", { method: "POST" });
    assert.equal(retirement.status, 200); assert.deepEqual(await retirement.json(), { requests: 0, inputs: [] });
    assert.deepEqual(await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json(), []);
  } catch (error) { failures.push(error); }
  finally {
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "diagnostic relay or cleanup failed");
});

test("actual Worker waitUntil retirement failure retains its typed site through the existing control relay", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-abliteration-retire-site-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf; const failures = [];
  try {
    const source = routerFixture().replace("const records = [], inputs = [], rawFetch = globalThis.fetch;", "const failure = Promise.reject(undefined); void failure.catch(() => {}); const records = [{ returned: { promise: Promise.resolve() }, pending: [failure] }], inputs = [], rawFetch = globalThis.fetch;");
    mf = await startWorkerdFixture(temporary, source, upstreamFixture());
    const origin = String(await mf.ready).replace(/\/$/, "");
    const response = await fetch(origin + "/fixture/retire", { method: "POST" });
    assert.equal(response.status, 500); await response.arrayBuffer();
    const records = await retrieveDiagnostics(origin);
    assert.ok(records.some(record => record.observation?.site === "wait_until" && record.observation.input === 1 && record.observation.op === 1 && record.observation.reasonDefined === false && record.observation.joinAccepted === false));
  } catch (error) { failures.push(error); }
  finally { try { await mf?.dispose(); } catch (error) { failures.push(error); } try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "retirement site or cleanup failed");
});

test("native fulfilled sibling cancel survives the Worker failed-read branch and real control relay", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-abliteration-sibling-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  const body = new ReadableStream(), reader = body.getReader(), trace = diagnostic.readerTrace(reader, 1, 1, undefined, undefined, "fetch_input");
  const operand = {}, cancelOp = trace.begin("cancel", [operand]), canceled = trace.invoke(cancelOp, reader.cancel, reader, [operand]);
  const pending = []; observeReaderOperation(pending, "cancel", canceled, []); pending[0].detail = () => trace.snapshot(cancelOp);
  await canceled; trace.unlocking(); reader.releaseLock(); trace.unlocked();
  const readOp = trace.begin("read", []), reading = trace.invoke(readOp, reader.read, reader, []);
  observeReaderOperation(pending, "read", reading, []); pending[1].detail = () => trace.snapshot(readOp);
  await Promise.allSettled([reading]);
  const proof = { returned: Promise.resolve(), body, ordinal: 1, errors: [], readers: [{ pending, unlocked: true, terminal: { promise: Promise.resolve() }, trace }] };
  const records = [], opaque = makeDiagnostic(), source = routerFixture();
  const retireCode = source.slice(source.indexOf("async function retire()"), source.indexOf("\nexport default", source.indexOf("async function retire()")));
  const retire = new Function("records", "inputs", "joinReaderOperations", "remember", "workerContext", retireCode + ";return retire;")([], [proof], joinReaderOperations,
    (context, observation) => records.push(opaque.record(context, undefined, observation)), (operation, ordinal) => ({ source: "worker", test: "T00", scenario: "none", operation, ordinal }));
  const retiring = retire(); let mf; const failures = [];
  try {
    await assert.rejects(retiring, AggregateError);
    assert.equal(proof.readers[0].pendingSettled, undefined);
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const origin = String(await mf.ready).replace(/\/$/, "");
    await diagnostic.flush(records, origin, fetch);
    const arrived = await retrieveDiagnostics(origin), sibling = arrived.find(record => record.observation?.kind === "cancel");
    assert.ok(sibling); assert.equal(sibling.observation.state, "fulfilled"); assert.equal(sibling.observation.op, 1);
    assert.equal(sibling.observation.operandPresent, true); assert.equal(sibling.observation.operandDefined, true);
    assert.ok(sibling.observation.unlockInvokeSeq > sibling.observation.settleSeq); assert.ok(sibling.observation.unlockReturnSeq > sibling.observation.unlockInvokeSeq);
    assert.equal(sibling.observation.operandSameRead, false);
    assert.equal(sibling.observation.allUnlocked, true); assert.equal(sibling.observation.bodyLocked, false); assert.equal(sibling.observation.joinAccepted, false);
    assert.equal(arrived.find(record => record.observation?.kind === "read").observation.state, "rejected");
  } catch (error) { failures.push(error); }
  finally {
    await Promise.allSettled([reading, canceled, retiring]);
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "sibling evidence or cleanup failed");
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const records = [], inputs = [], rawFetch = globalThis.fetch;
${diagnosticCode}
const diagnostic = diagnosticProtocol(), diagnosticRelay = diagnostic.relay();
const workerContext = (operation, ordinal = 0) => ({ source: "worker", test: "T00", scenario: "none", operation, ordinal });
const remember = (context, observation) => { try { diagnosticRelay.add(diagnostic.record(context, undefined, observation)); } catch {} };
function requestIdentity(request) {
  const authorization = request.headers.get("authorization");
  const scenario = diagnostic.scenarios.find(id => authorization === (id === "invalid" ? "Bearer clawrouter-live-abliteration_m0_high-invalid" : "Bearer clawrouter-live-abliteration_" + id + "-fixture-secret"));
  const test = scenario && Array.from({ length: 27 }, (_, i) => "T" + String(i + 1).padStart(2, "0")).find(test => diagnostic.identity(test, scenario));
  return test ? { source: "worker", test, scenario, operation: "stream", ordinal: records.length + 1 } : workerContext("stream", records.length + 1);
}
${observeReaderOperation.toString()}
${joinReaderOperations.toString()}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
globalThis.fetch = function(input, init) {
  const pending = Reflect.apply(rawFetch, this, [input, init]);
  const url = input instanceof Request ? input.url : String(input);
  if (url !== ${JSON.stringify(provider.base_urls.default.replace(/\/$/, "") + endpoint.path)}) return pending;
  const signals = [init?.signal, input instanceof Request ? input.signal : undefined];
  const proof = { returned: pending, body: undefined, readers: [], errors: [], ordinal: inputs.length + 1 }; inputs.push(proof);
  void pending.then(response => {
    try {
      proof.body = response.body;
      if (!proof.body) { proof.errors.push(new Error("upstream body missing")); return; }
      const getReader = proof.body.getReader;
      proof.body.getReader = function(...args) {
        const reader = Reflect.apply(getReader, this, args);
        const trace = diagnostic.readerTrace(reader, proof.ordinal, proof.readers.length + 1, init?.signal ?? (input instanceof Request ? input.signal : undefined), undefined, "fetch_input");
        const row = { pending: [], unlocked: false, terminal: deferred(), pendingSettled: false, trace }; proof.readers.push(row);
        for (const name of ["read", "cancel"]) {
          const original = reader[name];
          reader[name] = function(...operands) {
            const detail = trace.begin(name, operands);
            let pending;
            try { pending = trace.invoke(detail, original, this, operands); }
            catch (error) { remember(workerContext(name, proof.ordinal), { site: name === "cancel" ? "cancel_join" : "read_join", ...trace.snapshot(detail), joinAccepted: false }); throw error; }
            const returned = observeReaderOperation(row.pending, name, pending, signals);
            const operation = row.pending.at(-1);
            operation.detail = () => trace.snapshot(detail);
            void pending.then(() => {}, () => { if (!operation.expectedAbort) remember(workerContext(name, proof.ordinal), { site: name === "cancel" ? "cancel_join" : "read_join", ...trace.snapshot(detail), joinAccepted: false }); });
            return returned;
          };
        }
        const release = reader.releaseLock;
        reader.releaseLock = function() {
          trace.unlocking();
          const result = Reflect.apply(release, this, []); trace.unlocked(); row.unlocked = true; row.terminal.resolve(); return result;
        };
        return reader;
      };
    } catch (error) { remember(workerContext("acquire", proof.ordinal), { site: "observer", input: proof.ordinal, joinAccepted: false }); proof.errors.push(error); }
  }, () => { remember(workerContext("guard", proof.ordinal), { site: "fetch", input: proof.ordinal, joinAccepted: false }); });
  return pending;
};
async function retire() {
  const failures = [];
  for (const record of records) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) {
      const batch = record.pending.slice(cursor); cursor += batch.length;
      for (const [index, result] of (await Promise.allSettled(batch)).entries()) if (result.status === "rejected") {
        remember(workerContext("worker_retire", records.indexOf(record) + 1), { site: "wait_until", input: records.indexOf(record) + 1, op: cursor - batch.length + index + 1, state: "rejected", reasonDefined: result.reason !== undefined, joinAccepted: false });
        failures.push(result.reason);
      }
    }
  }
  const joined = await Promise.allSettled(inputs.map(async proof => {
    try { await proof.returned; } catch (error) { remember(workerContext("worker_retire", proof.ordinal), { site: "fetch", input: proof.ordinal, state: "rejected", reasonDefined: error !== undefined, joinAccepted: false }); throw error; }
    const readers = await Promise.allSettled(proof.readers.map(async row => {
      await row.terminal.promise;
      try { await joinReaderOperations(row.pending); row.pendingSettled = true; }
      catch (error) {
        for (const operation of row.pending) {
          const detail = operation.detail?.();
          if (detail && (operation.kind === "cancel" || (detail.state === "rejected" && !operation.expectedAbort))) remember(workerContext("worker_retire", proof.ordinal), {
            site: operation.kind === "cancel" ? "cancel_join" : "read_join", ...detail, allUnlocked: row.unlocked, bodyLocked: proof.body?.locked ?? null, joinAccepted: false,
          });
        }
        throw error;
      }
    }));
    const failures = [...proof.errors, ...readers.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
    if (!proof.readers.length) { remember(workerContext("worker_retire", proof.ordinal), { site: "missing_reader", input: proof.ordinal, joinAccepted: false }); failures.push(new Error("upstream reader observation missing")); }
    if (failures.length) throw new AggregateError(failures, "upstream reader retirement failed");
    proof.joined = true;
  }));
  for (const result of joined) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, "original Worker work failed");
  return { requests: records.length, inputs: inputs.map(proof => ({ joined: proof.joined, locked: proof.body.locked,
    readers: proof.readers.map(row => ({ unlocked: row.unlocked, pendingSettled: row.pendingSettled })) })) };
}
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/diagnostic" || path === "/fixture/diagnostics") return await diagnosticRelay(request) ?? new Response(null, { status: 405 });
  if (path === "/fixture/retire") {
    try { return Response.json(await retire()); } catch (error) { remember(workerContext("worker_retire")); throw error; }
  }
  if (path === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/abliteration", { provider: "abliteration", kind: "api_key", enabled: true, credential: "fixture-upstream-abliteration" });
    await revokeGrantCredentials(env, "oauth/abliteration_revoked/abliteration");
    return new Response(null, { status: 204 });
  }
  if (path !== "/v1/native/abliteration/chat/completions") return handler.fetch(request, env, context);
  const identity = requestIdentity(request);
  const record = { returned: deferred(), pending: [] }; records.push(record);
  try {
    return await handler.fetch(request, { ...env, ABLIT_KEY: "must-not-fallback", ABLITERATION_API_KEY: "must-not-fallback" }, {
      waitUntil(pending) { record.pending.push(pending); context.waitUntil(pending); }
    });
  } catch (error) { remember(identity); throw error; } finally { record.returned.resolve(); }
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("abliteration_error"), cancel = input.includes("abliteration_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(input.includes("abliteration_observed") ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : input.includes("abliteration_cached") ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } } } : {}) }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        // Heartbeats keep the synthetic request live and make downstream
        // disconnection observable. The bound never substitutes for an abort.
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
          resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
