import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { types } from "node:util";


// BEGIN search observation diagnostics (pure; no native runner or fixture execution).
export const searchObservationContract = Object.freeze({
  file: "test/search-semantics-observe.test.mjs",
  name: "observations include rejected fixture variants without changing diagnostic/matrix behavior",
  prefix: "SEARCH_OBSERVATION_V1 ",
});
const observationOperations = new Set(["runtime", "matrix_create", "diagnostic_create", "observation_ready", "observation_create", "initial_snapshot", "initial_equality", "twenty_gets", "first_text", "marker", "head", "post", "query", "trailing", "unregistered", "matrix_get", "snapshot", "counters", "expiry", "privacy_marker", "privacy_id", "diagnostic_gets", "diagnostic_heads", "matrix_gets", "observation_close", "post_diagnostic", "post_matrix", "diagnostic_close", "matrix_close", "complete"]);
const observationStages = new Set(["begin", "complete", "temporary", "observer_bundle", "main_bundle", "old_bundle", "options", "miniflare", "cleanup_registration", "ready", "worker", "namespace", "observer", "registry", "token", "path", "dispatch", "response_ok", "worker_header", "handler_header", "body", "byte_bound", "json", "ready_schema", "identity", "expiry", "page_identity", "marker", "counters", "timestamps", "schema", "deleted", "status", "assertion"]);
const observationCleanupStates = new Set(["unregistered", "pending", "fulfilled", "rejected"]);
function diagnosticData(value) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw new Error("invalid observation diagnostic");
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("invalid observation diagnostic");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("invalid observation diagnostic");
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}
export function observationDiagnosticText(value) {
  const row = diagnosticData(value), keys = Object.keys(row).sort().join(",");
  if (row.v !== 1 || row.case !== "variants") throw new Error("invalid observation diagnostic");
  if (row.kind === "boundary") {
    if (keys !== "case,failurePresent,kind,operation,reasonDefined,stage,state,v" || !observationOperations.has(row.operation) || !observationStages.has(row.stage)
      || !["fulfilled", "rejected"].includes(row.state) || typeof row.failurePresent !== "boolean"
      || row.failurePresent !== (row.state === "rejected") || (row.failurePresent ? typeof row.reasonDefined !== "boolean" : row.reasonDefined !== null)) throw new Error("invalid observation diagnostic");
  } else if (row.kind === "cleanup") {
    if (keys !== "case,dispose,disposeDefined,kind,recorderFailures,recorderFirstDefined,registered,remove,removeDefined,v" || typeof row.registered !== "boolean"
      || !observationCleanupStates.has(row.dispose) || !observationCleanupStates.has(row.remove)
      || !Number.isSafeInteger(row.recorderFailures) || row.recorderFailures < 0 || row.recorderFailures > 1000000
      || (row.recorderFailures ? typeof row.recorderFirstDefined !== "boolean" : row.recorderFirstDefined !== null)) throw new Error("invalid observation diagnostic");
    for (const key of ["dispose", "remove"]) if ((row[key] === "rejected" ? typeof row[key + "Defined"] !== "boolean" : row[key + "Defined"] !== null)
      || (!row.registered && row[key] !== "unregistered") || (row.registered && row[key] === "unregistered")) throw new Error("invalid observation diagnostic");
  } else throw new Error("invalid observation diagnostic");
  const text = searchObservationContract.prefix + JSON.stringify(row);
  if (Buffer.byteLength(text) > 640 || /[^\x20-\x7e]/.test(text)) throw new Error("invalid observation diagnostic");
  return text;
}
export function parseObservationDiagnostic(text) {
  if (typeof text !== "string" || text.length > 640 || /[^\x20-\x7e]/.test(text) || !text.startsWith(searchObservationContract.prefix)) throw new Error("invalid observation diagnostic");
  const json = text.slice(searchObservationContract.prefix.length), row = JSON.parse(json);
  // Only the exact canonical emitter encoding is admitted; duplicates/escapes/preambles fail.
  if (observationDiagnosticText(row) !== text) throw new Error("invalid observation diagnostic");
  return row;
}
export function createObservationLedger(deliver) {
  let operation = "runtime", stage = "begin", boundary, registered = false, flushed = false;
  const recorderFailures = [], cleanupFailures = [];
  const cleanup = { dispose: "unregistered", disposeDefined: null, remove: "unregistered", removeDefined: null };
  const capture = error => { recorderFailures.push(error); };
  const ledger = {
    select(value) { if (observationOperations.has(value)) { operation = value; stage = "begin"; } else capture(undefined); },
    mark(value, owner) { if (owner !== undefined) ledger.select(owner); if (observationStages.has(value)) stage = value; else capture(undefined); },
    registered() { registered = true; cleanup.dispose = cleanup.remove = "pending"; },
    body(failed, reason) { boundary = { v: 1, kind: "boundary", case: "variants", operation, stage, state: failed ? "rejected" : "fulfilled", failurePresent: failed, reasonDefined: failed ? reason !== undefined : null }; },
    flush() {
      if (flushed) return; flushed = true;
      if (boundary) try { deliver(observationDiagnosticText(boundary)); } catch (error) { capture(error); }
      try { deliver(observationDiagnosticText({ v: 1, kind: "cleanup", case: "variants", registered, ...cleanup,
        recorderFailures: Math.min(1000000, recorderFailures.length), recorderFirstDefined: recorderFailures.length ? recorderFailures[0] !== undefined : null })); } catch (error) { capture(error); }
    },
    async cleanup(dispose, remove) {
      for (const [key, original] of [["dispose", dispose], ["remove", remove]]) {
        try { await original(); cleanup[key] = "fulfilled"; }
        catch (error) { cleanup[key] = "rejected"; cleanup[key + "Defined"] = error !== undefined; cleanupFailures.push(error); }
      }
      ledger.flush();
      const errors = [...cleanupFailures, ...recorderFailures];
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "observation cleanup and reporting failed");
    },
    isRegistered: () => registered,
    failures: () => ({ cleanup: [...cleanupFailures], reporting: [...recorderFailures] }),
  };
  return ledger;
}
// END search observation diagnostics.

export const fixtureOrigin = "https://clawrouter-fakeco.openclaw.ai";
const prefix = "/search-semantics/";
export function observationResponseDiagnostics(response) {
  let captures = null;
  try {
    const text = response.headers.get("x-clawrouter-observation-captures");
    const value = text && text.length <= 128 && JSON.parse(text);
    if (value && Object.keys(value).sort().join(",") === "inactive,recorded,rejected,transport" && Object.values(value).every(n => Number.isInteger(n) && n >= 0 && n <= 1_000_000)) captures = value;
  } catch { /* report fixed metadata only */ }
  return { workerMatched: response.headers.get("x-clawrouter-observation-worker") === "observations-worker-v2",
    handlerMatched: response.headers.get("x-clawrouter-observation-handler") === "observations-v2", captures };
}

async function boundedJson(response, limit = 16_384, diagnostic) {
  diagnostic?.("body");
  let text = "", bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length; diagnostic?.("byte_bound"); assert.ok(bytes <= limit, "fixture response is bounded"); text += Buffer.from(chunk).toString("utf8"); diagnostic?.("body");
  }
  diagnostic?.("json");
  try { return JSON.parse(text); } catch { throw new Error("fixture response is invalid JSON"); }
}

// A sampled stability gate, not proof of global Worker/object propagation.
// No session creation, retry of mutations, or public calibration requests.
export async function waitForRequestObservationReadiness({ token, fetcher = fetch, onCheck = async () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.match(token ?? "", /^[a-zA-Z0-9_-]{40,128}$/, "inject SEARCH_SEMANTICS_CONTROL_TOKEN");
  const deadline = now() + 120_000;
  let consecutive = 0;
  for (let attempt = 1; attempt <= 25 && now() < deadline; attempt++) {
    const response = await fetcher(`${fixtureOrigin}${prefix}_control/observations/ready`, { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now()))) });
    const diagnostics = observationResponseDiagnostics(response);
    if (response.status === 200) {
      assert.ok(diagnostics.workerMatched && diagnostics.handlerMatched && diagnostics.captures, "observation handler identities and diagnostics match");
      const ready = await boundedJson(response, 512);
      assert.ok(ready?.ready === true && ready.protocol === "observations-v2" && Object.keys(ready).sort().join(",") === "protocol,ready", "exact observation readiness contract");
      consecutive++;
    } else {
      assert.ok(response.status === 404 && !diagnostics.handlerMatched, "unexpected observation readiness response");
      consecutive = 0; await response.body?.cancel();
    }
    const check = { attempt, status: response.status, ...diagnostics, consecutive };
    await onCheck(check);
    if (consecutive === 3) return check;
    const delay = Math.min(5_000, Math.max(0, deadline - now()));
    if (attempt < 25 && delay) await sleep(delay);
  }
  throw new Error("observation_handler_readiness_deadline");
}
export function fixtureControlToken(adminToken) {
  assert.ok(typeof adminToken === "string" && adminToken.length >= 40, "inject the FakeCo admin token");
  return createHmac("sha256", adminToken).update("clawrouter/fakeco/search-semantics/control/v1").digest("hex");
}

// Preparation only: caller keeps `key` in memory and uploads only the digest.
// A fresh ID is mandatory if this candidate ID already exists remotely.
export function prepareSemanticsCredential(adminToken, id = "codex_search_semantics_20261022", now = Date.now()) {
  assert.match(id, /^codex_search_semantics_[a-zA-Z0-9_]{8,64}$/);
  assert.ok(typeof adminToken === "string" && adminToken.length >= 40, "inject the FakeCo admin token");
  const secret = createHmac("sha256", adminToken).update(`clawrouter/fakeco/search-semantics/credential/v1/${id}`).digest("hex");
  return { id, key: `clawrouter-live-${id}-${secret}`, registration: {
    enabled: true, policyId: id, secretSha256: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(now + 2 * 60 * 60_000).toISOString(),
  } };
}

function fixtureControl(token, fetcher, diagnostic) {
  diagnostic?.("token");
  assert.match(token ?? "", /^[a-zA-Z0-9_-]{40,128}$/, "inject SEARCH_SEMANTICS_CONTROL_TOKEN");
  return async function control(path, method = "GET", body) {
    diagnostic?.("path");
    assert.match(path, /^(?:runs(?:\/[a-f0-9-]{36}(?:\/pages\/warm)?)?|diagnostic(?:\/[a-f0-9-]{36})?|observations(?:\/(?:ready|[a-f0-9-]{36}))?)$/);
    diagnostic?.("dispatch");
    const response = await fetcher(`${fixtureOrigin}${prefix}_control/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    diagnostic?.("response_ok");
    assert.ok(response.ok, `fixture control request succeeds (HTTP ${response.status})`);
    if (path.startsWith("observations")) {
      diagnostic?.("worker_header");
      assert.ok(response.headers.get("x-clawrouter-observation-worker") === "observations-worker-v2", "observation handler Worker identity matches");
      diagnostic?.("handler_header");
      assert.ok(response.headers.get("x-clawrouter-observation-handler") === "observations-v2", "observation handler object identity matches");
    }
    return boundedJson(response, 16_384, diagnostic);
  };
}

export async function createSemanticsFixture({ token, fetcher = fetch, ttlSeconds = 3600, diagnostic }) {
  const control = fixtureControl(token, fetcher, diagnostic);
  const initial = await control("runs", "POST", { ttlSeconds });
  const id = initial.id;
  diagnostic?.("identity");
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "fixture run ID is valid");
  const valid = run => {
    diagnostic?.("identity");
    assert.equal(run.id, id, "fixture run identity preserved");
    diagnostic?.("expiry");
    assert.ok(Number.isSafeInteger(run.expiresAt) && run.expiresAt > Date.now() + 30_000, "fixture has at least 30 seconds remaining");
    for (const name of ["cached", "live", "warm", "child"]) {
      const page = run.pages?.[name];
      diagnostic?.("identity");
      assert.match(page?.id ?? "", /^[a-f0-9-]{36}$/, "fixture page ID valid");
      diagnostic?.("marker");
      assert.match(page?.marker ?? "", /^ClawRouterProbe[a-f0-9]{32}$/, "fixture marker valid");
      diagnostic?.("counters");
      assert.ok([page.revision, page.gets, page.heads, page.revisionGets].every(Number.isSafeInteger), "fixture counters valid");
    }
    return run;
  };
  valid(initial);
  return {
    initial,
    url: name => `${fixtureOrigin}${prefix}${id}/${initial.pages[name].id}`,
    snapshot: async () => valid(await control(`runs/${id}`)),
    rotate: async () => valid(await control(`runs/${id}/pages/warm`, "POST")),
    close: async () => { let closed; assert.equal((closed = await control(`runs/${id}`, "DELETE"), diagnostic?.("deleted"), closed).deleted, true, "fixture run cleanup confirmed"); },
  };
}

// Stable public URL; one bounded generation, created only by authenticated control.
// Keep initial/snapshot markers in memory. Public requests alone never create it.
export async function createDiagnosticFixture({ token, fetcher = fetch, ttlSeconds = 300, diagnostic }) {
  const control = fixtureControl(token, fetcher, diagnostic);
  const initial = await control("diagnostic", "POST", { ttlSeconds });
  const id = initial.id;
  diagnostic?.("identity");
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "diagnostic generation ID valid");
  const valid = value => {
    diagnostic?.("identity");
    assert.equal(value.id, id, "diagnostic generation identity preserved");
    diagnostic?.("marker");
    assert.match(value.marker ?? "", /^ClawRouterProbe[a-f0-9]{32}$/, "diagnostic marker valid");
    diagnostic?.("expiry");
    assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() + 30_000, "diagnostic has at least 30 seconds remaining");
    diagnostic?.("counters");
    assert.ok([value.gets, value.heads].every(count => Number.isSafeInteger(count) && count >= 0), "diagnostic counters valid");
    for (const [count, time] of [[value.gets, value.lastGetAt], [value.heads, value.lastHeadAt]]) {
      diagnostic?.("timestamps");
      assert.ok(count === 0 ? time === null : Number.isSafeInteger(time) && time > 0, "diagnostic request timestamp valid");
    }
    return value;
  };
  valid(initial);
  return {
    initial,
    url: `${fixtureOrigin}${prefix}diagnostic`,
    snapshot: async () => valid(await control(`diagnostic/${id}`)),
    close: async () => { let closed; assert.equal((closed = await control(`diagnostic/${id}`, "DELETE"), diagnostic?.("deleted"), closed).deleted, true, "diagnostic cleanup confirmed"); },
  };
}

// Temporary observation entrypoint only; no public request or diagnostic creation.
export async function createRequestObservation({ token, fetcher = fetch, diagnostic }) {
  const control = fixtureControl(token, fetcher, diagnostic);
  diagnostic?.("begin", "observation_ready");
  const ready = await control("observations/ready");
  diagnostic?.("ready_schema");
  assert.ok(ready?.ready === true && ready.protocol === "observations-v2" && Object.keys(ready).sort().join(",") === "protocol,ready", "observation handler ready before creation");
  diagnostic?.("begin", "observation_create");
  const initial = await control("observations", "POST", { ttlSeconds: 300 });
  const id = initial.id;
  diagnostic?.("identity");
  assert.match(id ?? "", /^[a-f0-9-]{36}$/, "observation ID valid");
  const valid = value => {
    diagnostic?.("identity");
    assert.equal(value.id, id, "observation identity preserved");
    diagnostic?.("expiry");
    assert.ok(Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now() + 30_000, "observation has at least 30 seconds remaining");
    diagnostic?.("counters");
    assert.ok(Array.isArray(value.counters) && value.counters.length <= 128, "observation counters bounded");
    diagnostic?.("schema");
    assert.ok(Number.isSafeInteger(value.overflow) && value.overflow >= 0 && value.overflow <= 1_000_000 && typeof value.saturated === "boolean", "observation limits valid");
    return value;
  };
  valid(initial);
  return { initial, snapshot: async () => valid(await control(`observations/${id}`)),
    close: async () => { let closed; assert.equal((closed = await control(`observations/${id}`, "DELETE"), diagnostic?.("deleted"), closed).deleted, true, "observation cleanup confirmed"); } };
}

// Adapter for the native harness. No request primes the unique public page.
export async function startHostedSearchOrigin(mode, options) {
  const fixture = await createSemanticsFixture(options);
  const page = fixture.initial.pages[mode];
  return { url: fixture.url(mode), marker: page.marker, count: async () => (await fixture.snapshot()).pages[mode].gets,
    observations: async () => { const pages = Object.values((await fixture.snapshot()).pages); return { requests: pages.reduce((sum, item) => sum + item.gets + item.heads, 0), gets: pages.reduce((sum, item) => sum + item.gets, 0) }; },
    robots: () => null, close: fixture.close };
}
