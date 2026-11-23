import { createCatalogDiagnosticHarness } from "./helpers/catalog-diagnostic-harness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const contracts = {
  cerebras: { endpoint: "public_models", format: "cerebras.public_catalog", native: false,
    urls: ["https://api.cerebras.ai/public/v1/models"] },
  nvidia: { endpoint: "public_models", format: "nvidia.public_catalog", native: false,
    urls: ["https://integrate.api.nvidia.com/v1/models", "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json"] },
  chutes: { endpoint: "models_list", format: "chutes.models", native: true,
    urls: ["https://llm.chutes.ai/v1/models"] },
  venice: { endpoint: "models_list", format: "venice.models", native: true,
    urls: ["https://api.venice.ai/api/v1/models?type=text"] },
};
const scenarios = ["table", "empty", "stale", "malformed", "abort"];
const cases = Object.entries(contracts).flatMap(([provider, contract]) => {
  const compiled = snapshot.providers.find(row => row.id === provider);
  const endpoint = compiled?.endpoints.find(row => row.id === contract.endpoint);
  assert.equal(endpoint?.request_format, contract.format);
  assert.equal(endpoint.response_format, contract.format);
  assert.equal(endpoint.native_proxy, contract.native);
  assert.deepEqual(endpoint.methods, ["GET"]);
  const model = compiled.models[0];
  return scenarios.map(scenario => ({ id: `${provider}_${scenario}`, provider, scenario, ...contract,
    route: contract.native ? `/v1/native/${provider}/models` : `/v1/proxy/${provider}/${contract.endpoint}`,
    endpointPath: endpoint.path, model: model.id, upstream: model.upstream }));
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Execute the SDK fixture's exact wire assertion without loading the SDK.
const sdkFixtureText = readFileSync(new URL("./fixtures/openclaw-public-catalogs-contract.test.ts", import.meta.url), "utf8");
const assertionStart = sdkFixtureText.indexOf("function assertRawCatalogOffer(");
const assertionEnd = sdkFixtureText.indexOf("// END raw catalog assertion", assertionStart);
assert.ok(assertionStart >= 0 && assertionEnd > assertionStart);
const assertRawCatalogOffer = new Function(stripTypeScriptTypes(sdkFixtureText.slice(assertionStart, assertionEnd)) + "; return assertRawCatalogOffer;")();

// BEGIN catalog diagnostic protocol
const diagnosticProviders = ["cerebras", "nvidia", "chutes", "venice"];
const diagnosticTestIds = new Set(["none", ...diagnosticProviders.flatMap(provider => ["inventory", "stale", "malformed", "abort"].map(kind => provider + "_" + kind))]);
const diagnosticCaseIds = new Set(["none", ...diagnosticProviders.flatMap(provider => ["table", "empty", "stale", "malformed", "abort"].map(kind => provider + "_" + kind))]);
const diagnosticPhases = new Set(["setup", "facade_load", "registration", "body", "native_fetch", "offer_observation", "offer_json", "provider_find", "routes_select", "offer_assert", "route_assert", "stale_revocation", "transport_join", "worker_join", "restoration", "state_cleanup", "worker_acquisition", "sdk_process", "case_verify", "worker_retirement", "sql_receipt", "upstream_contract", "producer_release", "control_close", "worker_dispose", "scratch_cleanup", "relay"]);
const diagnosticCategories = new Set(["error", "assertion", "aggregate", "undefined", "null", "unknown", "child_process", "limit"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "AssertionError", "AggregateError", "AbortError", "TimeoutError", "undefined", "null", "unknown"]);
const diagnosticFields = new Set(["none", "assertion", "exit_code", "killed", "sdk_records", "suppressed", "status", "retirement", "receipt", "upstream", "close", "cache", "provider_present", "route_count", "offer_count", "route_kind", "offer_route", "offer_eligible", "route_methods", "route_path", "request_format", "response_format"]);
const diagnosticCodes = new Set(["ERR_ASSERTION", "ERR_ASSERTION_ERROR", "ECONNRESET", "ABORT_ERR", "UND_ERR_ABORTED", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT", "SIGTERM", "SIGKILL"]);
function diagnosticData(value, key) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function diagnosticPrimitive(value) {
  return value === null || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000;
}
function safeDiagnosticRecord(value) {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const keys = Reflect.ownKeys(value), required = ["v", "layer", "testId", "caseId", "phase", "category", "name", "field"];
    if (keys.some(key => typeof key !== "string" || ![...required, "expected", "actual", "code"].includes(key))) return;
    const result = {};
    for (const key of required) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return; result[key] = descriptor.value; }
    if (result.v !== 1 || !["sdk", "outer"].includes(result.layer)
      || !diagnosticTestIds.has(result.testId) || !diagnosticCaseIds.has(result.caseId)
      || !diagnosticPhases.has(result.phase) || !diagnosticCategories.has(result.category)
      || !diagnosticNames.has(result.name) || !diagnosticFields.has(result.field)) return;
    for (const key of ["expected", "actual", "code"]) if (keys.includes(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return;
      if (key === "code" ? !diagnosticCodes.has(descriptor.value) : !diagnosticPrimitive(descriptor.value)) return;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return; }
}
function failureDiagnostic(layer, testId, caseId, phase, error, field = "none") {
  let name = error === undefined ? "undefined" : error === null ? "null" : diagnosticData(error, "name");
  if (name === undefined) { try { name = diagnosticData(Object.getPrototypeOf(error), "name"); } catch {} }
  if (typeof name !== "string" || !diagnosticNames.has(name)) name = "unknown";
  const category = error === undefined ? "undefined" : error === null ? "null" : name === "AssertionError" ? "assertion" : name === "AggregateError" ? "aggregate" : name === "unknown" ? "unknown" : "error";
  const record = { v: 1, layer, testId, caseId, phase, category, name, field };
  const code = diagnosticData(error, "code"); if (typeof code === "string" && diagnosticCodes.has(code)) record.code = code;
  if (category === "assertion") for (const key of ["expected", "actual"]) {
    const value = diagnosticData(error, key); if (diagnosticPrimitive(value)) record[key] = value;
  }
  return safeDiagnosticRecord(record);
}
// END catalog diagnostic protocol

const annotationEscape = value => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const diagnosticTestFor = caseId => diagnosticCaseIds.has(caseId) && caseId !== "none"
  ? caseId.replace(/_(table|empty)$/, "_inventory") : "none";
const { createDiagnostics, barriers } = createCatalogDiagnosticHarness({ cases, safeDiagnosticRecord, failureDiagnostic,
  diagnosticTestFor, diagnosticData, diagnosticPrimitive, annotationEscape, deferred });

/** @param {Array<{kind: "read" | "cancel", pending: Promise<unknown>, expectedAbort: boolean}>} operations */
function observeReaderOperation(operations, kind, pending, signal) {
  const operation = { kind, pending, expectedAbort: false }; operations.push(operation);
  void pending.then(() => {}, reason => {
    operation.expectedAbort = kind === "read" && reason !== undefined && signal?.aborted === true && signal.reason === reason;
  });
  return pending;
}
async function joinReaderOperations(operations) {
  const failures = [];
  for (let cursor = 0; cursor < operations.length;) {
    const batch = operations.slice(cursor); cursor += batch.length;
    const results = await Promise.allSettled(batch.map(operation => operation.pending));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected" && !batch[index].expectedAbort) failures.push(result.reason);
    }
  }
  if (failures.length) throw new AggregateError(failures, "original reader operations failed");
}
async function joinOriginalWork(records, proofs) {
  const results = await Promise.allSettled([
    ...records.map(async record => {
      const failures = [];
      const returned = await Promise.allSettled([record.returned.promise]);
      for (const result of returned) if (result.status === "rejected") failures.push(result.reason);
      for (let cursor = 0; cursor < record.pending.length;) {
        const batch = record.pending.slice(cursor); cursor += batch.length;
        for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") failures.push(result.reason);
      }
      failures.push(...record.errors);
      if (failures.length) throw new AggregateError(failures, "original Worker request or settlement failed");
    }),
    ...proofs.map(async proof => {
      const failures = [];
      try { await proof.terminal.promise; } catch (error) { failures.push(error); }
      try { await joinReaderOperations(proof.pending); } catch (error) { failures.push(error); }
      failures.push(...proof.errors);
      if (failures.length) throw new AggregateError(failures, "original upstream retirement failed");
    }),
  ]);
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "original catalog work failed");
  for (const proof of proofs) proof.pendingSettled = true;
}
async function finishOwnedCleanup(failures, steps) {
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "catalog contract or owned cleanup failed");
}

async function withWorker(run) {
  const failures = [], diagnostics = createDiagnostics(); let gates, temporary, mf, retire, phase = "worker_acquisition";
  try {
    gates = await barriers(diagnostics);
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-public-catalogs-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(gates.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const command = async (path, method = "GET") => {
      try {
        const response = await fetch(origin + path, { method });
        const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
      } catch (error) {
        const id = path.split("/").at(-1), caseId = diagnosticCaseIds.has(id) ? id : "none";
        diagnostics.failure(path.includes("/usage/") ? "sql_receipt" : path.includes("/join/") || path.endsWith("/retire") ? "worker_retirement" : "worker_acquisition", error, caseId, "status");
        throw error;
      }
    };
    await command("/__catalog/init", "POST");
    retire = () => command("/__catalog/retire", "POST");
    phase = "body";
    await run({ origin, control: gates.origin, command, mf, diagnostics });
  } catch (error) { diagnostics.failure(phase, error); failures.push(error); }
  // Release real producers, then join every original operation before disposal.
  // No failed cleanup step may hide the body error or skip a later owner.
  const steps = [
    ["producer_release", () => gates?.releaseAll()], ["worker_retirement", () => retire?.()],
    ["control_close", () => gates?.close()], ["worker_dispose", () => mf?.dispose()],
    ["scratch_cleanup", () => temporary === undefined ? undefined : rm(temporary, { recursive: true, force: true })],
  ];
  try {
    await finishOwnedCleanup(failures, steps.map(([phase, step]) => async () => {
      try { await step(); } catch (error) { diagnostics.failure(phase, error); throw error; }
    }));
  } finally { diagnostics.finish(); }
}

async function verifyCase(f, row) {
  try { return await verifyCaseResult(f, row); }
  catch (error) { f.diagnostics.failure("case_verify", error, row.id, "assertion"); throw error; }
}
async function verifyCaseResult(f, row) {
  const joined = await f.command(`/__catalog/join/${row.id}`);
  assert.equal(joined.retired, true, row.id);
  assert.equal(joined.charged, 0, row.id);
  assert.equal(joined.calls, row.scenario === "stale" ? 0 : row.urls.length, row.id);
  for (const input of joined.inputs) {
    assert.equal(input.onlyExpectedHeaders, true, row.id);
    assert.equal(input.activeReads, 0, row.id);
    assert.equal(input.unlocked, true, row.id);
    assert.equal(input.sourceLocked, false, row.id);
    assert.equal(input.physicalLocked, false, row.id);
    assert.equal(input.pendingSettled, true, "join original read/cancel promises, not only an unlock flag");
    assert.ok(input.eof || input.canceled || input.readRejected, row.id);
    if (["table", "empty", "abort"].includes(row.scenario)) {
      assert.equal(input.eof, true, row.id); assert.equal(input.canceled, false, row.id); assert.equal(input.readRejected, false, row.id);
    }
  }
  if (row.scenario !== "stale") {
    try {
      const receipt = await f.command(`/__catalog/usage/${row.id}`);
      assert.equal(receipt.usage.events.length, 1, row.id);
      const [event] = receipt.usage.events;
      assert.equal(event.provider, row.provider); assert.equal(event.credential_id, row.id); assert.equal(event.policy_id, row.id);
      assert.equal(event.capability, "models.list"); assert.equal(event.model, null);
      assert.equal(event.cost_basis, "none"); assert.equal(event.actual_cost_micros, 0);
      assert.equal(receipt.budget.spentMicros, 0);
      assert.doesNotMatch(JSON.stringify(event), /fixture-secret|catalog-owner-|must-not-fallback/);
    } catch (error) { f.diagnostics.failure("sql_receipt", error, row.id, "receipt"); throw error; }
  }
  return joined;
}

function retirementFailures(error) {
  return error instanceof AggregateError ? error.errors.flatMap(retirementFailures) : [error];
}
function operationProof() {
  return { pending: [], errors: [], terminal: { promise: Promise.resolve() }, pendingSettled: false };
}

test("catalog retirement rejects original cancellation errors, including undefined", async t => {
  for (const reason of [new Error("original cancel failed"), undefined]) await t.test(reason === undefined ? "undefined" : "Error", async () => {
    const stream = new ReadableStream({ cancel() { return Promise.reject(reason); } });
    const reader = stream.getReader(), proof = operationProof();
    const cancellation = reader.cancel();
    assert.equal(observeReaderOperation(proof.pending, "cancel", cancellation), cancellation);
    try {
      await assert.rejects(joinOriginalWork([], [proof]), error => {
        assert.deepEqual(retirementFailures(error), [reason]); return true;
      });
      assert.equal(proof.pendingSettled, false);
    } finally { await Promise.allSettled([cancellation]); reader.releaseLock(); }
    assert.equal(stream.locked, false);
  });
});

test("catalog retirement waits for an original pending cancel after body and settlement failures", async () => {
  const bodyFailure = new Error("original body failed"), settlementFailure = new Error("original settlement failed"), cancelFailure = new Error("original cancel failed");
  let controller, rejectCancel, released = false;
  const body = new ReadableStream({ start(value) { controller = value; } }), bodyReader = body.getReader();
  const cancelBody = new ReadableStream({ cancel() { return new Promise((_, reject) => { rejectCancel = reject; }); } }), cancelReader = cancelBody.getReader();
  const proof = operationProof(), read = bodyReader.read(), cancel = cancelReader.cancel();
  assert.equal(observeReaderOperation(proof.pending, "read", read), read);
  assert.equal(observeReaderOperation(proof.pending, "cancel", cancel), cancel);
  controller.error(bodyFailure);
  const record = { returned: { promise: Promise.resolve() }, pending: [Promise.reject(settlementFailure)], errors: [undefined] };
  const joined = joinOriginalWork([record], [proof]); let settled = false;
  void joined.then(() => { settled = true; }, () => { settled = true; });
  try {
    await read.catch(() => {}); await Promise.resolve();
    assert.equal(settled, false, "a failed body/settlement must not bypass the original pending cancellation");
    assert.equal(proof.pendingSettled, false);
    rejectCancel(cancelFailure); released = true;
    await assert.rejects(joined, error => {
      assert.deepEqual(retirementFailures(error), [settlementFailure, undefined, bodyFailure, cancelFailure]); return true;
    });
    assert.equal(proof.pendingSettled, false);
  } finally {
    if (!released) rejectCancel(cancelFailure);
    await Promise.allSettled([read, cancel, joined]); bodyReader.releaseLock(); cancelReader.releaseLock();
  }
  assert.equal(body.locked, false); assert.equal(cancelBody.locked, false);
});

test("catalog retirement admits only the transport's exact already-signaled read reason", async t => {
  for (const mode of ["owned", "foreign", "late", "undefined"]) await t.test(mode, async () => {
    const transport = new AbortController(), reason = new Error("original transport abort");
    const rejection = mode === "foreign" ? new Error(reason.message) : mode === "undefined" ? undefined : reason;
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } }), reader = stream.getReader();
    const proof = operationProof(), pending = reader.read();
    assert.equal(observeReaderOperation(proof.pending, "read", pending, transport.signal), pending);
    if (mode !== "late") transport.abort(reason);
    controller.error(rejection);
    await pending.catch(() => {}); // Record the original rejection before a late signal can change state.
    if (mode === "late") transport.abort(reason);
    try {
      if (mode === "owned") { await joinOriginalWork([], [proof]); assert.equal(proof.pendingSettled, true); }
      else {
        await assert.rejects(joinOriginalWork([], [proof]), error => {
          assert.deepEqual(retirementFailures(error), [rejection]); return true;
        });
        assert.equal(proof.pendingSettled, false);
      }
    } finally { reader.releaseLock(); }
    assert.equal(stream.locked, false);
  });
});

test("catalog cleanup retains the primary body error and every cleanup failure without skipping later owners", async () => {
  const bodyFailure = new Error("body assertion failed"), cancelFailure = new Error("cleanup cancel failed");
  const reader = new ReadableStream({ cancel() { return Promise.reject(cancelFailure); } }).getReader();
  const failures = [bodyFailure], reached = [];
  try {
    await assert.rejects(finishOwnedCleanup(failures, [
      () => { reached.push("release"); throw undefined; },
      () => { reached.push("retire"); return reader.cancel(); },
      () => { reached.push("dispose"); },
    ]), error => {
      assert.deepEqual(retirementFailures(error), [bodyFailure, undefined, cancelFailure]); return true;
    });
    assert.deepEqual(reached, ["release", "retire", "dispose"]);
  } finally { reader.releaseLock(); }
});

test("catalog diagnostic schema rejects control text, extra data and hostile getters", () => {
  const base = failureDiagnostic("sdk", "cerebras_inventory", "cerebras_table", "body", undefined);
  assert.equal(base.category, "undefined"); assert.equal(base.name, "undefined");
  assert.equal(failureDiagnostic("sdk", "none", "none", "setup", null).category, "null");
  assert.equal(failureDiagnostic("sdk", "none", "none", "setup", "untrusted throw").category, "unknown");
  for (const extra of [{ message: "private" }, { field: "status\r\n::error::injection" }, { actual: "private" }, { expected: NaN }, { actual: 1_000_000_001 }]) {
    assert.equal(safeDiagnosticRecord({ ...base, ...extra }), undefined);
  }
  let getters = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "code", "expected", "actual", "message", "stack"].map(key => [key, { get() { getters++; throw new Error("must not run"); } }])));
  assert.equal(failureDiagnostic("sdk", "none", "none", "setup", hostile).category, "unknown");
  assert.equal(safeDiagnosticRecord(Object.defineProperty({ ...base }, "field", { get() { getters++; return "none"; } })), undefined);
  const chaiLike = Object.create(Object.defineProperty({}, "name", { get() { getters++; throw new Error("must not call prototype name getter"); } }));
  assert.equal(failureDiagnostic("sdk", "none", "none", "offer_assert", chaiLike, "offer_eligible").category, "unknown");
  assert.equal(getters, 0);
  const assertion = new assert.AssertionError({ expected: 4, actual: 1, operator: "strictEqual", message: "not relayed" });
  assert.deepEqual(failureDiagnostic("sdk", "chutes_inventory", "chutes_table", "body", assertion, "cache"), {
    v: 1, layer: "sdk", testId: "chutes_inventory", caseId: "chutes_table", phase: "body", category: "assertion", name: "AssertionError", field: "cache", code: "ERR_ASSERTION", expected: 4, actual: 1,
  });
  assert.equal(annotationEscape("%\r\n::error::"), "%25%0D%0A::error::");
});

test("catalog diagnostic relay accepts only new typed SDK records and rejects oversized input", async () => {
  const lines = [], diagnostics = createDiagnostics(line => lines.push(line)), gates = await barriers(diagnostics);
  const post = async body => {
    const response = await fetch(gates.origin + "/diagnostic", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer(); return response.status;
  };
  try {
    const record = failureDiagnostic("sdk", "nvidia_stale", "nvidia_stale", "stale_revocation", null);
    assert.equal(await post(JSON.stringify(record)), 204);
    assert.equal(await post(JSON.stringify({ ...record, layer: "outer" })), 400);
    assert.equal(await post(JSON.stringify({ ...record, caseId: "unknown" })), 400);
    assert.equal(await post(JSON.stringify({ ...record, message: "not allowed" })), 400);
    assert.equal(await post("{"), 400);
    assert.equal(await post(" ".repeat(2_049)), 413);
    assert.deepEqual(lines, ["::error title=Catalog contract diagnostic::" + JSON.stringify(record) + "\n"]);
  } finally { await gates.close(); diagnostics.finish(); }
});

test("catalog diagnostic relay caps annotations and reports only safe child metadata", () => {
  const lines = [], diagnostics = createDiagnostics(line => lines.push(line));
  let getters = 0;
  const child = Object.defineProperties({ code: 1, killed: false, signal: "SIGTERM" }, Object.fromEntries(["message", "stdout", "stderr"].map(key => [key, { get() { getters++; throw new Error("must not read child output"); } }])));
  diagnostics.child(child);
  for (let index = 0; index < 100; index++) diagnostics.emit(failureDiagnostic("sdk", "venice_abort", "venice_abort", "transport_join", undefined));
  diagnostics.finish(); diagnostics.finish();
  assert.equal(getters, 0); assert.equal(lines.length, 64);
  const records = lines.map(line => JSON.parse(line.slice("::error title=Catalog contract diagnostic::".length)));
  assert.deepEqual(records.slice(0, 3).map(row => [row.field, row.actual]), [["exit_code", 1], ["killed", false], ["sdk_records", 0]]);
  assert.equal(records[2].code, "SIGTERM");
  assert.equal(records.at(-1).field, "suppressed"); assert.equal(records.at(-1).actual, 40);
  assert.ok(lines.every(line => !line.includes("\r") && line.split("\n").length === 2));
});

test("catalog diagnostic reporting failure preserves undefined body and all cleanup failures", async () => {
  const diagnosticFailure = new Error("diagnostic sink failed"), cleanupFailure = new Error("original cleanup failed");
  const diagnostics = createDiagnostics(() => { throw diagnosticFailure; }), failures = [];
  try { throw undefined; } catch (error) { diagnostics.failure("body", error); failures.push(error); }
  let laterOwner = false;
  await assert.rejects(finishOwnedCleanup(failures, [
    () => { try { throw cleanupFailure; } catch (error) { diagnostics.failure("worker_retirement", error); throw error; } },
    () => { try { throw undefined; } catch (error) { diagnostics.failure("worker_dispose", error); throw error; } },
    () => { laterOwner = true; },
  ]), error => { assert.deepEqual(retirementFailures(error), [undefined, cleanupFailure, undefined]); return true; });
  diagnostics.finish(); assert.equal(laterOwner, true);
});

// This is real Worker/SQLite preparation proof, not an execution of the SDK.
test("four compiled public catalogs preserve owner isolation, bodyless formats and physical reader retirement", { timeout: 120_000 }, async t => {
  await withWorker(async f => {
    const selected = cases.filter(row => row.scenario !== "abort");
    for (const row of selected) {
      await f.command(`/__catalog/activate/${row.id}`, "POST");
      const headers = { authorization: `Bearer clawrouter-live-${row.id}-fixture-secret` };
      const catalog = await (await fetch(`${f.origin}/v1/catalog`, { headers })).json();
      assertRawCatalogOffer(catalog, row, assert.deepEqual, () => {});
      const provider = catalog.providers.find(value => value.id === row.provider);
      assert.deepEqual(provider.offers.filter(offer => offer.endpoint === row.endpoint).map(offer => offer.route), [row.route]);
      if (row.scenario === "table") {
        const malformed = [
          ["missing route", "route_count", value => { value.routes = value.routes.filter(route => route.endpoint !== row.endpoint); }],
          ["duplicate offer", "offer_count", value => { value.offers.push(value.offers.find(offer => offer.endpoint === row.endpoint)); }],
          ["wrong offer kind", "route_kind", value => { value.offers.find(offer => offer.endpoint === row.endpoint).routeKind = "wrong"; }],
          ["wrong offer route", "offer_route", value => { value.offers.find(offer => offer.endpoint === row.endpoint).route = "/wrong"; }],
          ["ineligible offer", "offer_eligible", value => { value.offers.find(offer => offer.endpoint === row.endpoint).eligible = false; }],
          ["wrong method", "route_methods", value => { value.routes.find(route => route.endpoint === row.endpoint).methods = ["POST"]; }],
          ["wrong path", "route_path", value => { value.routes.find(route => route.endpoint === row.endpoint).path = "/wrong"; }],
          ["missing request format", "request_format", value => { delete value.routes.find(route => route.endpoint === row.endpoint).requestFormat; }],
          ["wrong request format", "request_format", value => { value.routes.find(route => route.endpoint === row.endpoint).requestFormat = "wrong"; }],
          ["wrong response format", "response_format", value => { value.routes.find(route => route.endpoint === row.endpoint).responseFormat = "wrong"; }],
        ];
        for (const [name, expectedField, mutate] of malformed) await t.test(row.provider + " " + name, () => {
          const copy = structuredClone(catalog); mutate(copy.providers.find(value => value.id === row.provider));
          let field;
          assert.throws(() => assertRawCatalogOffer(copy, row, assert.deepEqual, (_, value) => { field = value; }), assert.AssertionError);
          assert.equal(field, expectedField);
        });
      }
      if (row.scenario === "stale") await f.command(`/__catalog/revoke/${row.id}`, "POST");
      const response = await fetch(f.origin + row.route, { headers });
      const body = await response.json();
      if (row.scenario === "stale") {
        assert.equal(response.status, 503, JSON.stringify(body));
        assert.equal(body.error.code, "upstream_grant_pool_unavailable");
      } else if (row.scenario === "malformed") {
        assert.equal(response.status, 502, JSON.stringify(body));
        assert.equal(body.error.code, row.native ? "invalid_model_discovery_response" : "provider_catalog_invalid");
      } else {
        if (response.status !== 200) {
          const upstream = await f.mf.getWorker("upstream");
          assert.fail(JSON.stringify({ case: row.id, status: response.status, error: body.error?.code, calls: await (await upstream.fetch("https://fixture.example/state")).json(), state: await f.command(`/__catalog/state/${row.id}`) }));
        }
        const rows = row.native ? body.data : body.catalog;
        assert.deepEqual(rows.map(value => value.id), row.scenario === "empty" ? [] : [row.upstream]);
        if (!row.native && rows.length) assert.equal(rows[0].pricing, null);
      }
      await verifyCase(f, row);
    }
    await verifyCalls(f, selected);
  });
});

test("actual registered four-provider discovery through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  await withWorker(async f => {
    try { await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL("./fixtures/openclaw-public-catalogs-contract.test.ts", import.meta.url),
      testPath: "extensions/clawrouter/worker-public-catalogs-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_CONTROL: f.control,
        CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead, CLAWROUTER_CONTRACT_CATALOG_CASES: JSON.stringify(cases) } });
    } catch (error) { f.diagnostics.child(error); throw error; }
    for (const row of cases) await verifyCase(f, row);
    await verifyCalls(f, cases);
  });
});

async function verifyCalls(f, selected) {
  try { await verifyCallResults(f, selected); }
  catch (error) { f.diagnostics.failure("upstream_contract", error, "none", "upstream"); throw error; }
}
async function verifyCallResults(f, selected) {
  const upstream = await f.mf.getWorker("upstream");
  const calls = await (await upstream.fetch("https://fixture.example/state")).json();
  assert.equal(calls.length, selected.reduce((sum, row) => sum + (row.scenario === "stale" ? 0 : row.urls.length), 0));
  for (const row of selected) {
    assert.deepEqual(calls.filter(call => call.id === row.id), row.scenario === "stale" ? [] : row.urls.map(url => ({
      id: row.id, url, method: "GET", bodyless: true, headers: [["accept", "application/json"], ["cf-worker", "router.example.com"]],
    })), row.id);
  }
}

function routerFixture() {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
${observeReaderOperation.toString()}
${joinReaderOperations.toString()}
${joinOriginalWork.toString()}
const cases = CASES, rawFetch = globalThis.fetch.bind(globalThis);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const records = new Map(), inputs = new Map(), ingested = new Map(cases.map(row => [row.id, deferred()]));
let active;
const policy = row => ({ enabled: true, generation: "fixture", providers: [row.provider], models: [row.model], tenantId: "fixture",
  monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
const grant = row => ({ provider: row.provider, kind: "api_key", enabled: true, credential: "catalog-owner-" + row.id });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), row = cases.find(value => value.id === active);
  if (!row || !row.urls.includes(request.url)) throw new Error("unexpected provider egress");
  const list = inputs.get(row.id) ?? []; inputs.set(row.id, list);
  if (list.some(value => value.url === request.url)) throw new Error("repeated provider egress");
  const proof = { url: request.url, onlyExpectedHeaders: JSON.stringify([...request.headers]) === JSON.stringify([["accept", "application/json"]]),
    activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, aborted: false, terminal: deferred(), pending: [], errors: [] };
  list.push(proof);
  request.signal.addEventListener("abort", () => { proof.aborted = true; }, { once: true });
  let response;
  try { response = await rawFetch(request); }
  catch (error) { proof.errors.push(error); proof.readRejected = true; proof.terminal.resolve(); throw error; }
  const physical = response.body;
  if (!physical) {
    const error = new Error("missing real public catalog body");
    proof.errors.push(error); proof.readRejected = true; proof.terminal.resolve(); throw error;
  }
  proof.status = response.status; proof.headers = [...response.headers]; proof.physical = physical;
  let reader;
  try { reader = physical.getReader(); }
  catch (error) { proof.errors.push(error); proof.terminal.resolve(); throw error; }
  const unlock = () => {
    if (proof.unlocked) return;
    try { reader.releaseLock(); proof.unlocked = true; }
    catch (error) { proof.errors.push(error); throw error; }
    finally { proof.terminal.resolve(); }
  };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++;
      try {
        let pending;
        try { pending = reader.read(); } catch (error) { proof.errors.push(error); throw error; }
        const next = await observeReaderOperation(proof.pending, "read", pending, request.signal);
        try {
          if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
        } catch (error) { proof.errors.push(error); throw error; }
      } catch (error) {
        proof.readRejected = true;
        try { controller.error(error); } catch (failure) { proof.errors.push(failure); throw failure; }
      }
      finally { proof.activeReads--; if (proof.eof || proof.readRejected) unlock(); }
    },
    async cancel(reason) {
      proof.canceled = true;
      try {
        let pending;
        try { pending = reader.cancel(reason); } catch (error) { proof.errors.push(error); throw error; }
        await observeReaderOperation(proof.pending, "cancel", pending, request.signal);
      } finally { unlock(); }
    },
  }, { highWaterMark: 0 });
  proof.source = source;
  return new Response(source, { status: response.status, headers: response.headers });
};
const view = (id, retired = false) => ({ calls: (inputs.get(id) ?? []).length, retired, charged: bodyBudgetCharged(),
  inputs: (inputs.get(id) ?? []).map(p => ({ status: p.status, headers: p.headers, onlyExpectedHeaders: p.onlyExpectedHeaders, activeReads: p.activeReads, eof: p.eof,
    canceled: p.canceled, readRejected: p.readRejected, unlocked: p.unlocked, aborted: p.aborted,
    sourceLocked: p.source?.locked ?? false, physicalLocked: p.physical?.locked ?? false, pendingSettled: p.pendingSettled === true })) });
async function join(id) {
  const original = records.get(id); if (!original?.length) throw new Error("no original client request");
  await joinOriginalWork(original, inputs.get(id) ?? []);
  return view(id, true);
}
export default {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === "/__catalog/init" && request.method === "POST") {
      await authorityCall(env, "/policies/initialize-all", cases.map(row => ({ policyId: row.id, policy: policy(row) })));
      const secretSha256 = await sha256Hex("fixture-secret");
      await authorityCall(env, "/credentials/initialize-all", cases.map(row => ({ credentialId: row.id, credential: { enabled: true, secretSha256, policyId: row.id, policyGeneration: "fixture" } })));
      await authorityCall(env, "/connections/initialize-all", [...new Set(cases.map(row => row.provider))].map(providerId => ({ providerId, enabled: true })));
      for (const row of cases) await putGrantCredentials(env, "oauth/" + row.id + "/" + row.provider, grant(row));
      return Response.json({ ready: true });
    }
    if (path === "/__catalog/retire" && request.method === "POST") {
      const results = await Promise.allSettled([...records.keys()].map(join));
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "catalog retirement failed");
      return Response.json({ retired: results.length });
    }
    const control = /^\/__catalog\/(activate|state|join|revoke|usage)\/([a-z_]+)$/.exec(path);
    if (control) {
      const [, action, id] = control, row = cases.find(value => value.id === id);
      if (!row) return new Response(null, { status: 404 });
      if (action === "activate" && request.method === "POST") {
        active = id;
        const response = await rawFetch("https://fixture.example/activate/" + id, { method: "POST" });
        if (!response.ok) throw new Error("fixture activation failed"); await response.arrayBuffer();
        return Response.json({ activated: id });
      }
      if (action === "state") return Response.json(view(id));
      if (action === "join") return Response.json(await join(id));
      if (action === "revoke" && request.method === "POST") {
        await putGrantCredentials(env, "oauth/" + id + "/" + row.provider, { ...grant(row), enabled: false, revokedAt: new Date().toISOString() });
        return Response.json({ changed: true });
      }
      if (action === "usage") {
        await ingested.get(id).promise;
        return worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + "-fixture-secret" } }), env, context);
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-([a-z_]+)-fixture-secret$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const row = cases.find(value => value.id === id);
    if (!row || active !== id) return new Response(null, { status: 401 });
    if (!["/v1/catalog", row.route].includes(path) || request.method !== "GET" || new URL(request.url).search || request.body) throw new Error("unexpected client route");
    const list = records.get(id) ?? []; records.set(id, list);
    if (list.some(value => value.path === path)) throw new Error("repeated actual catalog route");
    const record = { path, returned: deferred(), pending: [], errors: [] }; list.push(record);
    try { return await worker.fetch(request, env, { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } }); }
    catch (error) { record.errors.push(error); throw error; }
    finally { record.returned.resolve(); }
  },
  async queue(batch, env) { await worker.queue(batch, env); for (const message of batch.messages) if ("type" in message.body) ingested.get(message.body.credential_id)?.resolve(); },
};
`.replace("CASES", JSON.stringify(cases));
}

function upstreamFixture(controlOrigin) {
  return String.raw`
const cases = CASES, calls = []; let active;
export default { async fetch(request) {
  if (request.url === "https://fixture.example/state") return Response.json(calls);
  const activation = /^https:\/\/fixture.example\/activate\/([a-z_]+)$/.exec(request.url);
  if (activation && request.method === "POST" && cases.some(row => row.id === activation[1])) {
    active = activation[1]; return Response.json({ ready: true });
  }
  const row = cases.find(value => value.id === active);
  calls.push({ id: active, url: request.url, method: request.method, bodyless: request.body === null, headers: [...request.headers] });
  if (!row || !row.urls.includes(request.url) || request.method !== "GET" || request.body || JSON.stringify([...request.headers]) !== JSON.stringify([["accept", "application/json"], ["cf-worker", "router.example.com"]])) return new Response(null, { status: 400 });
  if (request.url.includes("featured-models.json")) return Response.json({ "featured-models": [] });
  if (row.scenario === "malformed") return Response.json({ data: {} });
  const rows = row.scenario === "empty" ? [] : [row.upstream, "unqualified-upstream"];
  const body = JSON.stringify({ object: "list", ...(row.provider === "venice" ? { type: "text" } : {}), data: rows.map(id => ({ id, object: "model",
    ...(row.provider === "venice" ? { type: "text", model_spec: {} } : {}),
    ...(row.provider === "cerebras" ? { limits: { max_context_length: 4096, max_completion_tokens: 512 } } : {}) })) });
  if (row.scenario !== "abort") return new Response(body, { headers: { "content-type": "application/json" } });
  let first = true;
  return new Response(new ReadableStream({ async pull(controller) {
    if (!first) return; first = false;
    controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
    const gate = await fetch(CONTROL + "/hold/" + row.id, { signal: request.signal, redirect: "manual" });
    if (!gate.ok || await gate.text() !== "released") throw new Error("producer barrier not released by witness");
    controller.enqueue(new TextEncoder().encode(body.slice(10))); controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
} };
`.replace("CASES", JSON.stringify(cases)).replaceAll("CONTROL", JSON.stringify(controlOrigin));
}
