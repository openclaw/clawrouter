import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const manifests = readdirSync("providers").filter(path => path.endsWith(".provider.yaml")).sort().map(path => parse(readFileSync(`providers/${path}`, "utf8")));
assert.deepEqual(snapshot.providers.map(provider => provider.id).sort(), manifests.map(manifest => manifest.id).sort(), "compiled snapshot must contain every bundled provider manifest exactly once");
assert.deepEqual(compileProviderSnapshot(manifests), snapshot);
const provider = snapshot.providers.find(row => row.id === "featherless");
const endpoint = provider.endpoints.find(row => row.id === "catalog");
assert.equal(endpoint.request_format, "featherless.catalog");
assert.equal(endpoint.response_format, "featherless.catalog");
assert.equal(endpoint.native_proxy, false);
assert.deepEqual(endpoint.methods, ["GET"]);
const models = provider.models.map(row => ({ id: row.id, upstream: row.upstream }));
assert.equal(models.length, 2);
const specifications = [
  ["table", 3, 200], ["empty", 1, 200], ["maximum", 50, 200], ["policy", 3, 200],
  ["duplicate", 2, 502], ["totals", 2, 502], ["malformed", 2, 502], ["redirect", 2, 502],
  ["limit", 1, 502], ["revoked", 0, 403], ["rotated_old", 0, 401],
  ["rotated_new", 3, 200], ["grant_revoke", 1, 503], ["grant_rotate", 1, 503], ["abort", 3, 200],
];
const cases = specifications.map(([scenario, count, status]) => ({ id: `featherless_${scenario}`, provider: "featherless", scenario, status,
  endpoint: "catalog", format: "featherless.catalog", native: false, path: endpoint.path, route: "/v1/proxy/featherless/catalog", models,
  expected: ["empty"].includes(scenario) ? [] : scenario === "policy" ? [models[0].upstream] : models.map(row => row.upstream),
  urls: Array.from({ length: count }, (_, i) => `https://api.featherless.ai/v1/models?capabilities=chat&page=${i + 1}&per_page=100`) }));
const key = row => `clawrouter-live-${row.id}-${row.scenario === "rotated_new" ? "rotated-secret" : "fixture-secret"}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// BEGIN catalog diagnostic protocol
const diagnosticIds = ["inventory", "maximum", "policy", "rotated_new", "duplicate", "totals", "malformed", "redirect", "limit", "revoked", "rotated_old", "grant_revoke", "grant_rotate", "abort"];
const diagnosticTestIds = new Set(["none", ...diagnosticIds]);
const diagnosticCaseIds = new Set(["none", "featherless_table", "featherless_empty", ...diagnosticIds.filter(id => id !== "inventory").map(id => "featherless_" + id)]);
const diagnosticPhases = new Set(["setup", "facade_load", "registration", "body", "native_fetch", "offer_observation", "offer_json", "provider_lookup", "routes_lookup", "offer_assert", "route_assert", "stale_revocation", "transport_join", "worker_join", "restoration", "state_cleanup", "worker_acquisition", "sdk_process", "case_verify", "worker_retirement", "sql_receipt", "upstream_contract", "producer_release", "control_close", "worker_dispose", "scratch_cleanup", "relay"]);
const diagnosticCategories = new Set(["error", "assertion", "aggregate", "undefined", "null", "unknown", "child_process", "limit"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "AssertionError", "AggregateError", "AbortError", "TimeoutError", "undefined", "null", "unknown"]);
const diagnosticFields = new Set(["none", "assertion", "count", "presence", "endpoint", "methods", "path", "formats", "exit_code", "killed", "sdk_records", "suppressed", "status", "retirement", "receipt", "upstream", "close"]);
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
  ? ["featherless_table", "featherless_empty"].includes(caseId) ? "inventory" : caseId.slice("featherless_".length) : "none";
function createDiagnostics(write = line => process.stdout.write(line)) {
  let emitted = 0, suppressed = 0, sdkRecords = 0, finished = false;
  const emit = (value, summary = false) => {
    try {
      const record = safeDiagnosticRecord(value); if (!record) return false;
      if (record.layer === "sdk") sdkRecords = Math.min(65_535, sdkRecords + 1);
      if (finished || emitted >= (summary ? 64 : 63)) { suppressed = Math.min(65_535, suppressed + 1); return true; }
      const json = JSON.stringify(record); if (Buffer.byteLength(json) > 2_048) return false;
      emitted++; write("::error title=Catalog contract diagnostic::" + annotationEscape(json) + "\n");
      return true;
    } catch { return false; } // Reporting cannot replace the original outcome.
  };
  const failure = (phase, error, caseId = "none", field = "none") => emit(failureDiagnostic("outer", diagnosticTestFor(caseId), caseId, phase, error, field));
  return { emit, failure, child(error) {
    // Do not inspect message, stdout or stderr from the buffered child.
    const base = { v: 1, layer: "outer", testId: "none", caseId: "none", phase: "sdk_process", category: "child_process", name: "unknown" };
    const code = diagnosticData(error, "code"), killed = diagnosticData(error, "killed"), signal = diagnosticData(error, "signal");
    if (typeof code === "number" && diagnosticPrimitive(code)) emit({ ...base, field: "exit_code", actual: code });
    if (typeof killed === "boolean") emit({ ...base, field: "killed", actual: killed });
    emit({ ...base, field: "sdk_records", actual: sdkRecords, ...(["SIGTERM", "SIGKILL"].includes(signal) ? { code: signal } : {}) });
    // Zero reports establishes only that no structured record arrived.
  }, finish() {
    if (finished) return;
    if (suppressed) emit({ v: 1, layer: "outer", testId: "none", caseId: "none", phase: "relay", category: "limit", name: "unknown", field: "suppressed", actual: suppressed }, true);
    finished = true;
  } };
}
async function receiveDiagnostic(request, response, diagnostics) {
  try {
    if (request.method !== "POST" || request.headers.authorization || request.headers["content-type"] !== "application/json") {
      request.resume(); response.writeHead(400); response.end(); return;
    }
    const chunks = []; let bytes = 0;
    request.setTimeout(2_000, () => request.destroy());
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 2_048) { request.resume(); response.writeHead(413); response.end(); return; }
      chunks.push(chunk);
    }
    request.setTimeout(0);
    const record = safeDiagnosticRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!record || record.layer !== "sdk" || !diagnostics.emit(record)) { response.writeHead(400); response.end(); return; }
    response.writeHead(204); response.end();
  } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  finally { request.setTimeout(0); }
}
async function barriers(diagnostics = createDiagnostics()) {
  const states = new Map(cases.filter(row => row.scenario === "abort").map(row => [row.id, { seen: deferred(), response: undefined, released: false }]));
  const server = createServer(async (request, response) => {
    if (request.url === "/diagnostic") { await receiveDiagnostic(request, response, diagnostics); return; }
    const match = /^\/(hold|seen|release)\/([a-z_]+)$/.exec(request.url ?? "");
    const state = match && states.get(match[2]);
    if (!state || request.headers.authorization || request.method !== (match[1] === "release" ? "POST" : "GET")) {
      response.writeHead(400); response.end(); return;
    }
    if (match[1] === "hold") {
      if (state.response) { response.writeHead(409); response.end(); return; }
      state.response = response; state.seen.resolve();
      if (state.released) response.end("released");
    } else if (match[1] === "seen") {
      await state.seen.promise; response.end("seen");
    } else {
      state.released = true; state.response?.end("released"); response.end("released");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, releaseAll() {
    for (const state of states.values()) { state.released = true; state.response?.end("released"); }
  }, async close() {
    for (const state of states.values()) { state.released = true; state.response?.end("teardown"); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

async function withWorker(run) {
  const failures = [], diagnostics = createDiagnostics(); let gates, temporary, mf, retire, phase = "worker_acquisition";
  try {
    gates = await barriers(diagnostics);
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-featherless-catalog-"));
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(gates.origin), { directRouter: true, preventEviction: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    const command = async (path, method = "GET") => {
      const response = await fetch(origin + path, { method });
      const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
    };
    await command("/__catalog/init", "POST");
    retire = () => command("/__catalog/retire", "POST");
    phase = "body";
    await run({ origin, control: gates.origin, command, mf, diagnostics });
  } catch (error) { diagnostics.failure(phase, error); failures.push(error); }
  finally {
    // Even a failed assertion releases the real producer and joins original
    // Worker waitUntil/read/cancel promises before disposal. Cleanup is not proof.
    try { gates?.releaseAll(); } catch (error) { diagnostics.failure("producer_release", error); failures.push(error); }
    try { await retire?.(); } catch (error) { diagnostics.failure("worker_retirement", error); failures.push(error); }
    try { await gates?.close(); } catch (error) { diagnostics.failure("control_close", error); failures.push(error); }
    try { await mf?.dispose(); } catch (error) { diagnostics.failure("worker_dispose", error); failures.push(error); }
    if (temporary !== undefined) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { diagnostics.failure("scratch_cleanup", error); failures.push(error); }
  }
  diagnostics.finish();
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "catalog contract or owned cleanup failed");
}

async function verifyCase(f, row) {
  const joined = await f.command(`/__catalog/join/${row.id}`);
  assert.equal(joined.retired, true, row.id);
  assert.equal(joined.charged, 0, row.id);
  assert.equal(joined.calls, row.urls.length, row.id);
  for (const input of joined.inputs) {
    assert.equal(input.onlyExpectedHeaders, true, row.id);
    assert.equal(input.activeReads, 0, row.id);
    assert.equal(input.unlocked, true, row.id);
    assert.equal(input.sourceLocked, false, row.id);
    assert.equal(input.physicalLocked, false, row.id);
    assert.equal(input.pendingSettled, true, "join original read/cancel promises, not only an unlock flag");
    assert.ok(input.eof || input.canceled || input.readRejected, row.id);
    if (row.status === 200) {
      assert.equal(input.eof, true, row.id); assert.equal(input.canceled, false, row.id); assert.equal(input.readRejected, false, row.id);
    }
  }
  if (row.urls.length > 0) {
    const receipt = await f.command(`/__catalog/usage/${row.id}`);
    assert.equal(receipt.usage.events.length, 1, row.id);
    const [event] = receipt.usage.events;
    assert.equal(event.provider, row.provider); assert.equal(event.credential_id, row.id); assert.equal(event.policy_id, row.id);
    assert.equal(event.capability, "models.list"); assert.equal(event.model, null);
    assert.equal(event.cost_basis, "none"); assert.equal(event.actual_cost_micros, 0);
    assert.equal(receipt.budget.spentMicros, 0);
    assert.doesNotMatch(JSON.stringify(event), /fixture-secret|catalog-owner-|must-not-fallback/);
  }
  return joined;
}

test("Featherless diagnostic schema rejects control text, extra data and hostile getters", () => {
  const base = failureDiagnostic("sdk", "inventory", "featherless_table", "body", undefined);
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
  assert.equal(getters, 0);
  const assertion = new assert.AssertionError({ expected: 1, actual: 1, operator: "strictEqual", message: "not relayed" });
  assert.deepEqual(failureDiagnostic("sdk", "inventory", "featherless_table", "offer_assert", assertion, "count"), {
    v: 1, layer: "sdk", testId: "inventory", caseId: "featherless_table", phase: "offer_assert", category: "assertion", name: "AssertionError", field: "count", code: "ERR_ASSERTION", expected: 1, actual: 1,
  });
  assert.equal(annotationEscape("%\r\n::error::"), "%25%0D%0A::error::");
});

test("Featherless diagnostic relay accepts only new typed SDK records and rejects oversized input", async () => {
  const lines = [], diagnostics = createDiagnostics(line => lines.push(line)), gates = await barriers(diagnostics);
  const post = async body => {
    const response = await fetch(gates.origin + "/diagnostic", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer(); return response.status;
  };
  try {
    const record = failureDiagnostic("sdk", "revoked", "featherless_revoked", "native_fetch", null);
    assert.equal(await post(JSON.stringify(record)), 204);
    assert.equal(await post(JSON.stringify({ ...record, layer: "outer" })), 400);
    assert.equal(await post(JSON.stringify({ ...record, caseId: "unknown" })), 400);
    assert.equal(await post(JSON.stringify({ ...record, message: "not allowed" })), 400);
    assert.equal(await post("{"), 400);
    assert.equal(await post(" ".repeat(2_049)), 413);
    assert.deepEqual(lines, ["::error title=Catalog contract diagnostic::" + JSON.stringify(record) + "\n"]);
  } finally { await gates.close(); diagnostics.finish(); }
});

test("Featherless diagnostic relay caps annotations and reports only safe child metadata", () => {
  const lines = [], diagnostics = createDiagnostics(line => lines.push(line));
  let getters = 0;
  const child = Object.defineProperties({ code: 1, killed: false, signal: "SIGTERM" }, Object.fromEntries(["message", "stdout", "stderr"].map(key => [key, { get() { getters++; throw new Error("must not read child output"); } }])));
  diagnostics.child(child);
  for (let index = 0; index < 100; index++) diagnostics.emit(failureDiagnostic("sdk", "abort", "featherless_abort", "transport_join", undefined));
  diagnostics.finish(); diagnostics.finish();
  assert.equal(getters, 0); assert.equal(lines.length, 64);
  const records = lines.map(line => JSON.parse(line.slice("::error title=Catalog contract diagnostic::".length)));
  assert.deepEqual(records.slice(0, 3).map(row => [row.field, row.actual]), [["exit_code", 1], ["killed", false], ["sdk_records", 0]]);
  assert.equal(records[2].code, "SIGTERM");
  assert.equal(records.at(-1).field, "suppressed"); assert.equal(records.at(-1).actual, 40);
  assert.ok(lines.every(line => !line.includes("\r") && line.split("\n").length === 2));
});


const sdkFixtureSource = readFileSync(new URL("./fixtures/openclaw-featherless-catalog-contract.test.ts", import.meta.url), "utf8");
function sdkSection(start, end) {
  const first = sdkFixtureSource.indexOf(start), last = sdkFixtureSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return stripTypeScriptTypes(sdkFixtureSource.slice(first, last));
}
const nodeExpect = actual => ({
  toBe: expected => assert.equal(actual, expected), toEqual: expected => assert.deepEqual(actual, expected),
  toHaveLength: expected => assert.equal(actual.length, expected), toBeTypeOf: expected => assert.equal(typeof actual, expected),
});
const rawCatalogAssertion = new Function("expect", sdkSection("type RawCatalog =", "function observeBody(") + "; return assertRawCatalog;")(nodeExpect);

// Exercise the same SDK-side raw schema assertion against real Worker responses.
const rawCatalogForTest = row => ({ providers: [{ id: row.provider,
  offers: [{ endpoint: row.endpoint, routeKind: "manifest", route: row.route, eligible: true }],
  routes: [{ endpoint: row.endpoint, methods: ["GET"], path: row.path, requestFormat: row.format, responseFormat: row.format }] }] });
test("SDK raw catalog assertion joins formats from the exact declared route, not the offer", () => {
  const row = cases[0], body = rawCatalogForTest(row), markers = [];
  rawCatalogAssertion(body, row, (...args) => markers.push(args));
  assert.equal(Object.hasOwn(body.providers[0].offers[0], "requestFormat"), false);
  assert.deepEqual(markers.at(-1), ["route_assert", "formats", true, true]);
  for (const mutate of [value => value.providers[0].offers.push(value.providers[0].offers[0]),
    value => { value.providers[0].offers[0].eligible = false; },
    value => { value.providers[0].routes[0].path = "/wrong"; },
    value => { value.providers[0].routes[0].methods = ["POST"]; },
    value => { value.providers[0].routes[0].responseFormat = "wrong"; },
    value => { value.providers[0].routes[0].endpoint = "wrong"; }]) {
    const changed = structuredClone(body); mutate(changed);
    assert.throws(() => rawCatalogAssertion(changed, row, (...args) => markers.push(args)));
    assert.ok(markers.at(-1).slice(2).every(value => typeof value === "number" || typeof value === "boolean"));
  }
});

function sdkDiagnosticFunctions(originalFetch, withOpenClawTestState = async (_options, body) => body({})) {
  const protocol = sdkSection("// BEGIN catalog diagnostic protocol", "beforeEach(async context");
  const failures = sdkSection("function throwFailures(", "function refuse(");
  const restore = sdkSection("async function restoreTestState(", "afterEach(");
  const fixture = sdkSection("async function fixture(", "describe(");
  return new Function("originalFetch", "control", "withOpenClawTestState", "loadBundledPluginFacade", "registerSingleProviderPlugin", "expect", "origin", "unexpected", "joined",
    protocol + failures + restore + fixture + "; return { restoreTestState, fixture, reportDiagnostic, safeDiagnosticRecord, failureDiagnostic };")(
      originalFetch, "http://127.0.0.1:1", withOpenClawTestState, async () => ({ default: {} }),
      async () => ({ catalog: { run() {} } }), nodeExpect, "http://127.0.0.1:1", [], async () => {});
}

test("SDK diagnostic packet shares the outer allowlists and never invokes hostile error getters", async () => {
  const packets = [], sdk = sdkDiagnosticFunctions(async (_url, init) => { packets.push(JSON.parse(init.body)); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal); return new Response(null, { status: 204 }); });
  let getters = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["name", "message", "stack", "code", "actual", "expected"].map(key => [key, { get() { getters++; throw new Error("must not inspect"); } }])));
  await sdk.reportDiagnostic("route_assert", hostile, "featherless_table", "formats", { expected: true, actual: false });
  assert.equal(getters, 0); assert.equal(packets.length, 1);
  assert.deepEqual(safeDiagnosticRecord(packets[0]), packets[0]);
  assert.deepEqual(packets[0], { v: 1, layer: "sdk", testId: "none", caseId: "featherless_table", phase: "route_assert", category: "unknown", name: "unknown", field: "formats", expected: true, actual: false });
  for (const id of diagnosticTestIds) assert.ok(sdk.safeDiagnosticRecord({ ...packets[0], testId: id }));
  assert.equal(diagnosticTestIds.size, 15); assert.equal(diagnosticCaseIds.size, 16);
  await sdk.reportDiagnostic("body", undefined);
  assert.equal(packets.at(-1).category, "undefined");
});

test("SDK restoration attempts every owner and retains undefined despite reporting failure", async () => {
  const reportFailure = new Error("report failed"), restoreFailure = new Error("restore failed"), reached = [];
  const sdk = sdkDiagnosticFunctions(async () => { throw reportFailure; });
  await assert.rejects(sdk.restoreTestState([
    () => { reached.push(1); throw undefined; }, () => { reached.push(2); throw restoreFailure; }, () => { reached.push(3); },
  ]), error => { assert.deepEqual(error.errors, [undefined, restoreFailure]); return true; });
  assert.deepEqual(reached, [1, 2, 3]);
});

test("SDK fixture preserves body and state cleanup failures outside the callback with identity protection", async t => {
  for (const body of [new Error("body failed"), undefined]) for (const cleanup of [new Error("state cleanup failed"), undefined]) {
    await t.test(`${body === undefined ? "undefined" : "Error"} body plus ${cleanup === undefined ? "undefined" : "Error"} cleanup`, async () => {
      const sdk = sdkDiagnosticFunctions(async () => { throw new Error("report failed"); }, async (_options, run) => {
        try { await run({}); } finally { throw cleanup; }
      });
      await assert.rejects(sdk.fixture(async () => { throw body; }), error => { assert.deepEqual(error.errors, [body, cleanup]); return true; });
    });
  }
  const body = new Error("original body"), sdk = sdkDiagnosticFunctions(async () => { throw new Error("report failed"); });
  const result = await sdk.fixture(async () => { throw body; }).then(() => ({ ok: true }), error => ({ error }));
  assert.equal(result.error, body, "the callback aggregate is an identity guard, not a duplicate failure");
});

// Real Worker/SQLite preparation, separate from execution of the pinned SDK.
test("compiled Featherless complete scans preserve policy, original credentials and physical joins", { timeout: 120_000 }, async () => {
  await withWorker(async f => {
    const selected = cases.filter(row => row.scenario !== "abort");
    for (const row of selected) {
      await f.command(`/__catalog/activate/${row.id}`, "POST");
      const headers = { authorization: `Bearer ${key(row)}` };
      const catalog = await (await fetch(`${f.origin}/v1/catalog`, { headers })).json();
      rawCatalogAssertion(catalog, row, () => {});
      const advertised = catalog.providers.find(value => value.id === row.provider);
      const offers = advertised.offers.filter(value => value.endpoint === row.endpoint);
      assert.equal(offers.length, 1); assert.equal(offers[0].eligible, true);
      assert.equal(offers[0].routeKind, "manifest"); assert.equal(offers[0].route, row.route);
      assert.equal(Object.hasOwn(offers[0], "requestFormat"), false);
      assert.equal(Object.hasOwn(offers[0], "responseFormat"), false);
      const routes = advertised.routes.filter(value => value.endpoint === row.endpoint);
      assert.equal(routes.length, 1); assert.deepEqual(routes[0].methods, ["GET"]);
      assert.equal(routes[0].path, row.path);
      assert.equal(routes[0].requestFormat, row.format); assert.equal(routes[0].responseFormat, row.format);
      const response = await fetch(f.origin + row.route, { headers });
      const body = await response.json();
      assert.equal(response.status, row.status, `${row.id}: ${JSON.stringify(body)}`);
      if (row.status === 200) {
        assert.deepEqual(body.catalog.map(value => value.id), row.expected);
        assert.equal(body.providerId, "featherless");
        assert.equal(JSON.stringify(body).includes("unlisted/"), false);
      } else {
        assert.equal("catalog" in body, false);
        assert.equal(body.error.code, row.status === 403 ? "proxy_key_revoked" : row.status === 401 ? "invalid_proxy_key" : row.status === 503 ? "model_discovery_owner_unavailable" : "invalid_model_discovery_response");
      }
      await verifyCase(f, row);
    }
    await verifyCalls(f, selected);
  });
});

test("a held later page keeps the original response pending until real producer release and joins", { timeout: 120_000 }, async () => {
  await withWorker(async f => {
    const row = cases.find(value => value.scenario === "abort");
    await f.command(`/__catalog/activate/${row.id}`, "POST");
    let settled = false;
    const original = fetch(f.origin + row.route, { headers: { authorization: `Bearer ${key(row)}` } }).then(async response => {
      const body = await response.json(); assert.equal(response.status, 200); return body;
    }).finally(() => { settled = true; });
    try {
      const seen = await fetch(`${f.control}/seen/${row.id}`); assert.equal(await seen.text(), "seen");
      const before = await f.command(`/__catalog/state/${row.id}`);
      assert.equal(settled, false); assert.equal(before.calls, 2); assert.equal(before.inputs[1].eof, false);
    } finally {
      const released = await fetch(`${f.control}/release/${row.id}`, { method: "POST" }); assert.equal(await released.text(), "released");
      assert.deepEqual((await original).catalog.map(value => value.id), row.expected);
    }
    await verifyCase(f, row); await verifyCalls(f, [row]);
  });
});

test("actual registered Featherless catalog through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  await withWorker(async f => {
    try { await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL("./fixtures/openclaw-featherless-catalog-contract.test.ts", import.meta.url),
      testPath: "extensions/clawrouter/worker-featherless-catalog-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: f.origin, CLAWROUTER_CONTRACT_CONTROL: f.control,
        CLAWROUTER_CONTRACT_SOURCE_HEAD: sourceHead, CLAWROUTER_CONTRACT_CATALOG_CASES: JSON.stringify(cases) } });
    } catch (error) { f.diagnostics.child(error); throw error; }
    for (const row of cases) await verifyCase(f, row);
    await verifyCalls(f, cases);
  });
});

async function verifyCalls(f, selected) {
  const upstream = await f.mf.getWorker("upstream");
  const calls = await (await upstream.fetch("https://fixture.example/state")).json();
  assert.equal(calls.length, selected.reduce((sum, row) => sum + row.urls.length, 0));
  for (const row of selected) assert.deepEqual(calls.filter(call => call.id === row.id), row.urls.map(url => ({
    id: row.id, url, method: "GET", bodyless: true,
    headers: [["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id], ["cf-worker", "router.example.com"]],
  })), row.id);
}

function observeReaderOperation(operations, kind, pending, signal) {
  const operation = { kind, pending, expectedAbort: false, rejected: false, reason: undefined }; operations.push(operation);
  void pending.then(() => {}, reason => {
    operation.rejected = true; operation.reason = reason;
    // Capture the original transport signal at rejection, never the caller's
    // separate waiter signal, an error name, or a signal aborted only later.
    operation.expectedAbort = kind === "read" && reason !== undefined && signal?.aborted === true && signal.reason === reason;
  });
  return pending;
}
async function joinReaderOperations(operations) {
  const results = await Promise.allSettled(operations.map(operation => operation.pending));
  const failures = results.flatMap((result, index) => result.status === "rejected" && !operations[index].expectedAbort ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "original catalog reader operations failed");
}

// Execute the actual join emitted into the Worker, not a second implementation.
function workerJoinForTest(proofs, original = [{ returned: { promise: Promise.resolve() }, pending: [] }]) {
  const text = routerFixture(), start = text.indexOf("async function join(id) {"), end = text.indexOf("\nexport default {", start);
  assert.ok(start >= 0 && end > start);
  return new Function("records", "inputs", "view", observeReaderOperation.toString() + "\n" + joinReaderOperations.toString()
    + "\n" + text.slice(start, end) + "; return join;")(
    new Map([["observer", original]]), new Map([["observer", proofs]]), () => ({ retired: true }));
}
function failingReader(kind, signal) {
  const terminal = deferred(), proof = { terminal, pending: [], errors: [], pendingSettled: false };
  let reject;
  const stream = kind === "read" ? new ReadableStream({ start(controller) { reject = reason => controller.error(reason); } })
    : new ReadableStream({ cancel() { return new Promise((_, fail) => { reject = fail; }); } });
  const reader = stream.getReader(), pending = kind === "read" ? reader.read() : reader.cancel();
  assert.equal(observeReaderOperation(proof.pending, kind, pending, signal), pending);
  void pending.then(() => { reader.releaseLock(); terminal.resolve(); }, () => { reader.releaseLock(); terminal.resolve(); });
  return { proof, pending, reject };
}
const originalFailures = error => error instanceof AggregateError ? error.errors.flatMap(originalFailures) : [error];

test("original Worker join rejects cancellation even with the exact transport abort reason", async () => {
  const controller = new AbortController(), reason = new Error("transport cancellation failed"); controller.abort(reason);
  const row = failingReader("cancel", controller.signal); row.reject(reason);
  await assert.rejects(workerJoinForTest([row.proof])("observer"), error => originalFailures(error).includes(reason));
  assert.equal(row.proof.pendingSettled, false);
});
test("original Worker join rejects unrelated reads despite a matching error name", async () => {
  const controller = new AbortController(), owned = new Error("owned"), foreign = new Error("unrelated");
  owned.name = foreign.name = "AbortError"; controller.abort(owned);
  const row = failingReader("read", controller.signal); row.reject(foreign);
  await assert.rejects(workerJoinForTest([row.proof])("observer"), error => originalFailures(error).includes(foreign));
  assert.equal(row.proof.pendingSettled, false);
});
test("original Worker join accepts only an already-signaled exact transport-owned read reason", async () => {
  const controller = new AbortController(), reason = new Error("owned read abort");
  const row = failingReader("read", controller.signal); controller.abort(reason); row.reject(reason);
  assert.deepEqual(await workerJoinForTest([row.proof])("observer"), { retired: true });
  assert.equal(row.proof.pendingSettled, true);
});
test("original Worker join cannot excuse a read failure with a later abort", async () => {
  const controller = new AbortController(), reason = new Error("earlier read failure");
  const row = failingReader("read", controller.signal); row.reject(reason); await row.pending.catch(() => {}); controller.abort(reason);
  await assert.rejects(workerJoinForTest([row.proof])("observer"), error => originalFailures(error).includes(reason));
  assert.equal(row.proof.pendingSettled, false);
});
test("original Worker join retains primary and every cleanup failure while joining later operations", async () => {
  const primary = new Error("original Worker failure"), waitUntil = new Error("original waitUntil failure");
  const read = new Error("original read failure"), cancel = new Error("original cancel failure");
  const first = failingReader("read"), later = failingReader("cancel"); first.reject(read);
  const pending = Promise.reject(waitUntil); void pending.catch(() => {});
  const joined = workerJoinForTest([first.proof, later.proof], [{ returned: { promise: Promise.resolve() }, pending: [pending], failure: primary }])("observer");
  let finished = false; void joined.then(() => { finished = true; }, () => { finished = true; });
  try {
    await first.pending.catch(() => {}); await Promise.resolve(); assert.equal(finished, false);
    later.reject(cancel);
    await assert.rejects(joined, error => {
      const failures = originalFailures(error);
      assert.deepEqual(failures, [primary, waitUntil, read, cancel]); return true;
    });
    assert.equal(first.proof.pendingSettled, false); assert.equal(later.proof.pendingSettled, false);
  } finally { later.reject(cancel); await Promise.allSettled([first.pending, later.pending, joined]); }
});
test("original Worker join preserves undefined cancellation and primary failures", async () => {
  const row = failingReader("cancel"); row.reject(undefined);
  const original = [{ returned: { promise: Promise.resolve() }, pending: [], failure: undefined }];
  await assert.rejects(workerJoinForTest([row.proof], original)("observer"), error => {
    assert.deepEqual(originalFailures(error), [undefined, undefined]); return true;
  });
  assert.equal(row.proof.pendingSettled, false);
});

function routerFixture() {
  return String.raw`
import worker from "./worker/index.ts";
export * from "./worker/index.ts";
import { authorityCall } from "./worker/authority.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { sha256Hex } from "./worker/utils.ts";
import { bodyBudgetCharged } from "./worker/body-budget.ts";
const cases = CASES, rawFetch = globalThis.fetch.bind(globalThis);
${observeReaderOperation.toString()}
${joinReaderOperations.toString()}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const records = new Map(), inputs = new Map(), ingested = new Map(cases.map(row => [row.id, deferred()]));
let active, fixtureEnv;
const policy = row => ({ enabled: true, generation: "fixture", providers: [row.provider], models: row.models.filter((_, i) => row.scenario !== "policy" || i === 0).map(model => model.id), tenantId: "fixture",
  monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { environmentFallback: false } });
const grant = row => ({ provider: row.provider, kind: "api_key", enabled: true, credential: "catalog-owner-" + row.id });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), row = cases.find(value => value.id === active);
  if (!row || !row.urls.includes(request.url)) throw new Error("unexpected provider egress");
  const list = inputs.get(row.id) ?? []; inputs.set(row.id, list);
  if (list.some(value => value.url === request.url)) throw new Error("repeated provider egress");
  const proof = { url: request.url, onlyExpectedHeaders: JSON.stringify([...request.headers]) === JSON.stringify([["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id]]),
    activeReads: 0, eof: false, canceled: false, unlocked: false, readRejected: false, aborted: false, terminal: deferred(), pending: [], errors: [] };
  list.push(proof);
  request.signal.addEventListener("abort", () => { proof.aborted = true; }, { once: true });
  let response;
  try {
    response = await rawFetch(request);
    if (list.length === 1 && ["grant_revoke", "grant_rotate"].includes(row.scenario)) {
      await putGrantCredentials(fixtureEnv, "oauth/" + row.id + "/featherless", { ...grant(row),
        ...(row.scenario === "grant_revoke" ? { enabled: false, revokedAt: new Date().toISOString() } : { credential: "changed-owner-" + row.id }) });
    }
  }
  catch (error) { proof.errors.push(error); proof.readRejected = true; proof.terminal.resolve(); throw error; }
  const physical = response.body;
  if (!physical) { const error = new Error("missing real public catalog body"); proof.errors.push(error); proof.readRejected = true; proof.terminal.resolve(); throw error; }
  proof.status = response.status; proof.headers = [...response.headers]; proof.physical = physical;
  const reader = physical.getReader();
  const unlock = () => { if (!proof.unlocked) { reader.releaseLock(); proof.unlocked = true; proof.terminal.resolve(); } };
  const source = new ReadableStream({
    async pull(controller) {
      proof.activeReads++; let pending, operation;
      try {
        pending = reader.read(); observeReaderOperation(proof.pending, "read", pending, request.signal); operation = proof.pending.at(-1);
        const next = await pending;
        if (next.done) { proof.eof = true; controller.close(); } else controller.enqueue(next.value);
      } catch (error) { if (!operation?.rejected || operation.reason !== error) proof.errors.push(error); proof.readRejected = true; controller.error(error); }
      finally { proof.activeReads--; if (proof.eof || proof.readRejected) unlock(); }
    },
    async cancel(reason) {
      proof.canceled = true; let pending;
      try { pending = reader.cancel(reason); observeReaderOperation(proof.pending, "cancel", pending, request.signal); await pending; }
      catch (error) { if (!pending) proof.errors.push(error); throw error; }
      finally { unlock(); }
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
  const requests = await Promise.allSettled(original.map(async record => {
    await record.returned.promise;
    const failures = Object.hasOwn(record, "failure") ? [record.failure] : [];
    for (let cursor = 0; cursor < record.pending.length;) {
      const batch = record.pending.slice(cursor); cursor += batch.length;
      const settled = await Promise.allSettled(batch);
      failures.push(...settled.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    }
    return failures;
  }));
  const failures = requests.flatMap(result => result.status === "rejected" ? [result.reason] : result.value);
  const readers = await Promise.allSettled((inputs.get(id) ?? []).map(async proof => {
    await proof.terminal.promise;
    const joined = await Promise.allSettled([joinReaderOperations(proof.pending)]);
    const failures = [...proof.errors, ...joined.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
    if (failures.length) throw new AggregateError(failures, "original upstream catalog operations failed");
    proof.pendingSettled = true;
  }));
  failures.push(...readers.flatMap(result => result.status === "rejected" ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, "original catalog request or retirement failed");
  return view(id, true);
}
export default {
  async fetch(request, env, context) {
    fixtureEnv = env;
    env = { ...env, CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex("fixture-admin") };
    const admin = async (path, body) => {
      const response = await worker.fetch(new Request("https://fixture.example/v1/admin/" + path, { method: "POST",
        headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, context);
      const result = await response.text(); if (!response.ok) throw new Error("fixture authority mutation failed: " + response.status);
      return result;
    };
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
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "catalog retirements failed");
      return Response.json({ retired: results.length });
    }
    const control = /^\/__catalog\/(activate|state|join|revoke|usage)\/([a-z_]+)$/.exec(path);
    if (control) {
      const [, action, id] = control, row = cases.find(value => value.id === id);
      if (!row) return new Response(null, { status: 404 });
      if (action === "activate" && request.method === "POST") {
        active = id;
        if (row.scenario === "rotated_new") await admin("credentials/" + id + "/rotate", { secretSha256: await sha256Hex("rotated-secret") });
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
        return worker.fetch(new Request(new URL("/v1/usage", request.url), { headers: { authorization: "Bearer clawrouter-live-" + id + (row.scenario === "rotated_new" ? "-rotated-secret" : "-fixture-secret") } }), env, context);
      }
      return new Response(null, { status: 405 });
    }
    const id = /^Bearer clawrouter-live-([a-z_]+)-(?:fixture-secret|rotated-secret)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const row = cases.find(value => value.id === id);
    if (!row || active !== id) return new Response(null, { status: 401 });
    if (!["/v1/catalog", row.route].includes(path) || request.method !== "GET" || new URL(request.url).search || request.body) throw new Error("unexpected client route");
    const list = records.get(id) ?? []; records.set(id, list);
    if (list.some(value => value.path === path)) throw new Error("repeated actual catalog route");
    const record = { path, returned: deferred(), pending: [] }; list.push(record);
    try {
      const response = await worker.fetch(request, env, { waitUntil(promise) { record.pending.push(promise); context.waitUntil(promise); } });
      if (path === "/v1/catalog" && response.ok && row.scenario === "revoked") await admin("credentials/" + id + "/revoke");
      if (path === "/v1/catalog" && response.ok && row.scenario === "rotated_old") await admin("credentials/" + id + "/rotate", { secretSha256: await sha256Hex("rotated-secret") });
      return response;
    }
    catch (error) { record.failure = error; throw error; }
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
  const row = cases.find(value => value.id === active), url = new URL(request.url);
  calls.push({ id: active, url: request.url, method: request.method, bodyless: request.body === null, headers: [...request.headers] });
  if (!row || !row.urls.includes(request.url) || request.method !== "GET" || request.body || JSON.stringify([...request.headers]) !== JSON.stringify([
    ["accept", "application/json"], ["authorization", "Bearer catalog-owner-" + row.id], ["cf-worker", "router.example.com"]])) return new Response(null, { status: 400 });
  const page = Number(url.searchParams.get("page"));
  if (row.scenario === "redirect" && page === 2) return new Response("no follow", { status: 302, headers: { location: "https://api.featherless.ai/v1/elsewhere" } });
  if (row.scenario === "malformed" && page === 2) return Response.json({ data: {} });
  const total = row.scenario === "empty" ? 0 : row.scenario === "maximum" ? 5000 : row.scenario === "limit" ? 5001 : row.scenario === "totals" && page === 2 ? 202 : 201;
  const pages = Math.ceil(total / 100), last = page === pages;
  let data = row.scenario === "empty" ? [] : Array.from({ length: 100 }, (_, i) => ({ id: "unlisted/" + page + "_" + i, object: "model" }));
  if (page === 2 && row.scenario !== "maximum") data = [];
  if (last) data = [...row.models.map(model => ({ id: model.upstream, object: "model", available_on_current_plan: true })), ...(row.scenario === "maximum" ? data.slice(2) : [])];
  if (row.scenario === "duplicate" && page === 2) data = [{ id: "unlisted/1_0", object: "model" }];
  const body = JSON.stringify({ data, pagination: { current_page: page, per_page: 100, total_items: total, total_pages: pages }, total });
  if (row.scenario !== "abort" || page !== 2) return new Response(body, { headers: { "content-type": "application/json" } });
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
