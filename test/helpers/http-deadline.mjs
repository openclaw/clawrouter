import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "./workerd.mjs";

const endpointMs = 500;
const limit = 1_000_000;
const secret = "http-deadline-fixture-secret";
const headers = { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" };

export async function runHttpDeadlineCases(t, scenarios, reportFailure) {
  const attribution = httpDeadlineAttribution();
  const shared = attribution.branch(null);
  let temporary, mf;
  const primary = { failed: false, error: undefined };
  try {
    shared.at("directory");
    temporary = await mkdtemp(join(tmpdir(), "clawrouter-http-deadline-"));
    shared.at("runtime_start");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true });
    shared.at("policy_namespace");
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    shared.at("policy_setup");
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: 7, retainRequestContent: false }));
    shared.at("credential_setup");
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    shared.at("connection_setup");
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    shared.at("direct_url");
    const direct = await mf.unsafeGetDirectURL("router");
    const origin = shared.sync("direct_origin", () => direct.origin);
    shared.at("budget_namespace");
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    const read = async (path, signal, readBranch) => {
      const response = await fetch(new URL(path, origin), { headers, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
      readBranch.assertion("check_01", () => assert.equal, () => [response.status, 200]);
      return response.json();
    };
    const ledgerFacts = () => Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
      const stub = budgets.get(budgets.idFromName(name)), month = new Date().toISOString().slice(0, 7);
      const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
      const rows = await (await stub.fetch("https://budget/fixture-reservations")).json();
      return { spent: status.spentMicros, rows };
    }));
    for (const scenario of scenarios) {
      let cleanupError, cleanupFailed = false;
      const caseBranch = attribution.branch(scenario);
      shared.at("case_registration");
      await t.test(scenario === "cancel-json" ? "cancel-json (unresolved whitespace cancellation)" : scenario, async () => {
        caseBranch.at("case_setup");
        try {
          const caller = new AbortController(), watchStop = new AbortController();
          const requestId = `deadline-${scenario}`, cancellation = new Error("fixture caller after endpoint deadline retirement");
          const streaming = scenario.includes("sse") || scenario === "first-event";
          const canceled = scenario.startsWith("cancel-");
          const preBodyProgress = scenario === "cancel-json-pre-body-progress";
          const requireDeliveredBytes = canceled && scenario !== "cancel-json" && !preBodyProgress;
          const timedOut = scenario === "headers" || scenario === "first-event";
          caseBranch.at("baseline_usage");
          const beforeUsage = await read("/v1/usage", undefined, caseBranch);
          caseBranch.at("baseline_ledgers");
          const beforeLedgers = await ledgerFacts();
          caseBranch.at("baseline_selection");
          const previousReceipts = new Set(beforeUsage.usage.events.map(event => event.request_id));
          const previousReservations = beforeLedgers.map(({ rows }) => new Set(rows.map(row => row.reservation_id)));
          const addedRows = (ledgers, index) => ledgers[index].rows.filter(row => !previousReservations[index].has(row.reservation_id));
          const safety = AbortSignal.timeout(15_000);
          const client = { startedAt: null, headersAt: null, status: null, contentEncoding: null, firstBodyAt: null, lastBodyAt: null, bodyBytes: 0, completedAt: null, failedAt: null, errorName: null, abortRequestedAt: null, bytesAtAbort: null };
          let usage, state, ingress, ledgers;
          const diagnostics = () => JSON.stringify({ requestId, client, ingress, state, receipts: usage?.usage.events.filter(event => event.request_id === requestId), reservations: ledgers?.map((_, index) => addedRows(ledgers, index)) });
          const facts = async () => {
            usage = await read("/v1/usage", undefined, caseBranch); state = (await read("/fixture-state", undefined, caseBranch))[scenario];
            ingress = (await read("/fixture-ingress", undefined, caseBranch))[requestId];
            ledgers = await ledgerFacts();
            return usage.usage.events.some(event => event.request_id === requestId) && ledgers.every((_, index) => addedRows(ledgers, index).length > 0 && addedRows(ledgers, index).every(row => row.settled === 1)) && (state?.complete || state?.aborted || state?.canceled);
          };
          // Observe both sides without assuming that transport preserves write chunks.
          // The original whitespace case deliberately retains its upstream-only trigger.
          const watchBranch = attribution.branch(scenario);
          const watcher = canceled ? (async () => {
            try {
              watchBranch.at("watch_progress");
              await until(async () => {
                const progress = (await read("/fixture-state", watchStop.signal, watchBranch))[scenario];
                return progress?.progressCount > 2 && progress.lastProgressAt - progress.startedAt > endpointMs * 2 && (!requireDeliveredBytes || client.bodyBytes > 0);
              }, watchStop.signal, diagnostics);
              watchBranch.at("watch_stop_check");
              watchStop.signal.throwIfAborted();
              watchBranch.at("watch_bookkeeping");
              client.abortRequestedAt = Date.now(); client.bytesAtAbort = client.bodyBytes;
              watchBranch.at("watch_caller_abort");
              caller.abort(cancellation);
            } catch (error) { watchBranch.failed(error); throw error; }
          })() : Promise.resolve();
          const requestBranch = attribution.branch(scenario);
          const requestCleanupFailures = [];
          const request = (async () => {
            client.startedAt = Date.now();
            try {
              requestBranch.at("request_fetch");
              const response = await fetch(new URL("/v1/responses", origin), {
                method: "POST", headers: { ...headers, "x-request-id": requestId }, signal: AbortSignal.any([caller.signal, safety]),
                body: JSON.stringify({ model: "openai/gpt-6-astra", input: scenario, stream: streaming }),
              });
              requestBranch.sync("response_bookkeeping", () => {
                client.headersAt = Date.now(); client.status = response.status; client.contentEncoding = response.headers.get("content-encoding");
              });
              requestBranch.assertion("check_02", () => assert.equal, () => [response.status, timedOut ? 502 : 200]);
              requestBranch.assertion("check_03", () => assert.equal, () => [response.headers.get("x-request-id"), requestId]);
              const reader = requestBranch.sync("reader_acquire", () => response.body.getReader());
              const readerFailure = { failed: false, error: undefined };
              let text = "";
              try {
                requestBranch.at("reader_decoder");
                const decoder = new TextDecoder();
                while (true) {
                  requestBranch.at("reader_read");
                  const part = await reader.read();
                  requestBranch.at("reader_result");
                  if (part.done) { client.completedAt = Date.now(); return text + decoder.decode(); }
                  if (part.value.byteLength) { client.firstBodyAt ??= Date.now(); client.lastBodyAt = Date.now(); client.bodyBytes += part.value.byteLength; }
                  text += decoder.decode(part.value, { stream: true });
                }
              } catch (error) {
                readerFailure.failed = true; readerFailure.error = error;
                if (!canceled) requestBranch.failed(error);
                throw error;
              } finally {
                try { requestBranch.sync("reader_release", () => reader.releaseLock()); }
                catch (error) {
                  requestCleanupFailures.push({ reason: error, represented: false });
                  httpDeadlineThrow(readerFailure.failed ? [readerFailure.error, error] : [error]);
                }
              }
            } catch (error) {
              // The original canceled-request rejection is expected until its
              // existing expectation validates it. Do not witness every catch.
              if (!canceled) requestBranch.failed(error);
              try {
                requestBranch.sync("request_failure_bookkeeping", () => {
                  client.failedAt = Date.now(); client.errorName = error.name;
                });
              } catch (bookkeepingError) {
                requestCleanupFailures.push({ reason: bookkeepingError, represented: false });
                httpDeadlineThrow([error, bookkeepingError]);
              }
              throw error;
            }
          })();
          const bodyFailures = [];
          try {
            caseBranch.at(canceled ? "cancellation_join" : "request_join");
            if (canceled) await Promise.all([watcher, caseBranch.assertion("check_04", () => assert.rejects, () => [request, error => {
              caseBranch.assertion("check_05", () => assert.equal, () => [caller.signal.reason, cancellation]);
              caseBranch.assertion("check_06", () => assert.equal, () => [safety.aborted, false, "the safety timeout is not the intended caller cancellation"]);
              return caseBranch.sync("cancellation_match_operand", () => error === cancellation || error.name === "AbortError");
            }])]);
            else {
              let text;
              try { text = await request; }
              catch (error) {
                // This direct await propagates the request's complete failure
                // graph. Mark its occurrences by this path, never by reason.
                for (const occurrence of requestCleanupFailures) occurrence.represented = true;
                throw error;
              }
              if (timedOut) caseBranch.assertion("check_07", () => assert.equal, () => [JSON.parse(text).error.code, "provider_unavailable"]);
              else caseBranch.assertion("check_08", () => assert.ok, () => [streaming ? text.includes('"type":"response.completed"') : JSON.parse(text).status === "completed"]);
            }
            caseBranch.at("settlement");
            await until(facts, undefined, diagnostics);
            caseBranch.at("receipt_selection");
            const receipts = usage.usage.events.filter(event => !previousReceipts.has(event.request_id));
            caseBranch.assertion("check_09", () => assert.equal, () => [receipts.length, 1]); caseBranch.assertion("check_10", () => assert.equal, () => [receipts[0].request_id, requestId]);
            const receipt = receipts[0];
            caseBranch.assertion("check_11", () => assert.equal, () => [usage.usage.events.filter(event => event.request_id === requestId).length, 1]);
            caseBranch.assertion("check_12", () => assert.equal, () => [receipt.status, timedOut ? "timeout" : canceled ? "client_error" : "success"]);
            caseBranch.assertion("check_13", () => assert.equal, () => [receipt.status_code, timedOut ? 502 : 200]);
            caseBranch.assertion("check_14", () => assert.equal, () => [receipt.actual_cost_micros, 7]); caseBranch.assertion("check_15", () => assert.equal, () => [receipt.cost_basis, "policy_fixed"]);
            caseBranch.assertion("check_16", () => assert.equal, () => [receipt.total_tokens, timedOut || canceled ? null : 2]);
            caseBranch.assertion("check_17", () => assert.equal, () => [usage.usage.summary.actualCostMicros, beforeUsage.usage.summary.actualCostMicros + 7]);
            if (timedOut || canceled) caseBranch.assertion("check_18", () => assert.ok, () => [state.aborted || state.canceled]);
            else { caseBranch.assertion("check_19", () => assert.equal, () => [state.complete, true]); caseBranch.assertion("check_20", () => assert.equal, () => [state.aborted || state.canceled, false]); }
            if (!timedOut) {
              caseBranch.assertion("check_21", () => assert.ok, () => [state.progressCount > 2, "upstream must make progress across the declared deadline"]);
              caseBranch.assertion("check_22", () => assert.ok, () => [state.lastProgressAt - state.startedAt > endpointMs * 2]);
            }
            if (requireDeliveredBytes) {
              caseBranch.assertion("check_23", () => assert.ok, () => [client.bytesAtAbort > 0, "the active-delivery case must observe body bytes before cancellation"]);
              caseBranch.assertion("check_24", () => assert.ok, () => [client.firstBodyAt <= client.abortRequestedAt]);
            }
            if (preBodyProgress) {
              caseBranch.assertion("check_25", () => assert.equal, () => [client.status, 200]); caseBranch.assertion("check_26", () => assert.equal, () => [client.contentEncoding, "gzip"]);
              caseBranch.assertion("check_27", () => assert.equal, () => [client.bytesAtAbort, 0]); caseBranch.assertion("check_28", () => assert.equal, () => [client.firstBodyAt, null]);
              caseBranch.assertion("check_29", () => assert.ok, () => [client.headersAt <= client.abortRequestedAt]);
              caseBranch.assertion("check_30", () => assert.notEqual, () => [ingress.abortedAt, null]); caseBranch.assertion("check_31", () => assert.ok, () => [ingress.abortedAt >= client.abortRequestedAt]);
              caseBranch.assertion("check_32", () => assert.equal, () => [state.aborted, true]); caseBranch.assertion("check_33", () => assert.equal, () => [state.complete, false]);
              if (state.firstPayloadAt !== null) {
                caseBranch.assertion("check_34", () => assert.ok, () => [client.abortRequestedAt < state.firstPayloadAt]);
                caseBranch.assertion("check_35", () => assert.ok, () => [state.firstPayloadAt - state.startedAt >= 2_000]);
              }
            }
            caseBranch.at("ledger_selection");
            for (const [index, { spent, rows }] of ledgers.entries()) {
              caseBranch.assertion("check_36", () => assert.equal, () => [spent, beforeLedgers[index].spent + 7]); caseBranch.assertion("check_37", () => assert.equal, () => [rows.length, beforeLedgers[index].rows.length + 1]);
              const added = addedRows(ledgers, index);
              caseBranch.assertion("check_38", () => assert.equal, () => [added.length, 1]);
              caseBranch.assertion("check_39", () => assert.deepEqual, () => [added[0], { reservation_id: added[0].reservation_id, settled: 1, dispatch_started: 1, reserved_micros: 7 }]);
            }
          } catch (error) {
            bodyFailures.push(error); caseBranch.failed(error);
          } finally {
            try { caseBranch.sync("cleanup_watch_abort", () => watchStop.abort()); }
            catch (error) { bodyFailures.push(error); }
            try { caseBranch.sync("cleanup_caller_abort", () => caller.abort()); }
            catch (error) { bodyFailures.push(error); }
            caseBranch.at("cleanup_join");
            try { await Promise.allSettled([request, watcher]); }
            catch (error) { bodyFailures.push(error); caseBranch.failed(error); }
            // Promise.all may have failed on the watcher first. Preserve each
            // independent request-cleanup occurrence after the original join.
            for (const occurrence of requestCleanupFailures) {
              if (!occurrence.represented) {
                bodyFailures.push(occurrence.reason);
                occurrence.represented = true;
              }
            }
            // Keep the original drain and diagnostic, even after independent
            // failures. An undefined drain reason still stops the outer sequence.
            caseBranch.at("cleanup_settlement");
            try { await until(facts, undefined, diagnostics); }
            catch (error) {
              cleanupFailed = true; cleanupError = error;
              bodyFailures.push(error); caseBranch.failed(error);
            }
            try {
              caseBranch.sync("cleanup_diagnostic", () => t.diagnostic(diagnostics()));
            } catch (error) { bodyFailures.push(error); }
          }
          httpDeadlineThrow(bodyFailures);
        } catch (error) { caseBranch.failed(error); throw error; }
      });
      if (cleanupFailed) throw cleanupError;
    }
  } catch (error) {
    primary.error = error; primary.failed = true; shared.failed(error);
  } finally {
    try {
      await cleanupHttpDeadlineFixture([
        ["runtime_dispose", () => mf?.dispose()],
        ["directory_remove", () => temporary === undefined ? undefined : rm(temporary, { recursive: true, force: true })],
      ], primary, shared);
    } catch (error) { primary.error = error; primary.failed = true; }
  }
  const failures = primary.failed ? [primary.error] : [];
  const witness = attribution.first();
  if (witness !== undefined && reportFailure !== undefined) {
    try { await reportFailure(witness); }
    catch (error) { failures.push(error); }
  }
  httpDeadlineThrow(failures);
}

// Private identities never enter reporter messages or source sentinels.
function httpDeadlineAttribution() {
  let first;
  const cases = new Set(["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json-pre-body-progress"]);
  const capture = (scenario, site, reason) => {
    first ??= Object.freeze({ scenario: cases.has(scenario) ? scenario : null, site, reasonPresent: true, reasonDefined: reason !== undefined, reason });
  };
  return {
    first: () => first,
    branch(scenario) {
      let current = "unknown";
      return {
        at(site) { current = site; },
        failed(reason) { capture(scenario, current, reason); },
        sync(site, operation) {
          try { return operation(); }
          catch (reason) { capture(scenario, site, reason); throw reason; }
        },
        assertion(site, callee, argumentsList) {
          let boundary = `${site}_operands`;
          try {
            const method = callee(), args = argumentsList();
            boundary = `${site}_assertion`;
            return Reflect.apply(method, assert, args);
          } catch (reason) { capture(scenario, boundary, reason); throw reason; }
        },
      };
    },
  };
}

function httpDeadlineThrow(failures) {
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "HTTP deadline fixture independent failures");
}

// Same awaited cleanup order as cleanupFixture, with owner-local catch sites.
async function cleanupHttpDeadlineFixture(steps, primary, branch) {
  const failures = [];
  for (const [site, step] of steps) {
    branch.at(site);
    try { await step(); }
    catch (error) { failures.push(error); branch.failed(error); }
  }
  if (failures.length && primary.failed) failures.unshift(primary.error);
  httpDeadlineThrow(failures);
}

async function until(predicate, signal, diagnostics = () => "") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP deadline fixture did not settle: ${diagnostics()}`);
}

function routerFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
import { providerById } from "./worker/providers.ts";
export * from "./worker/index.ts";
// Only this isolated fixture declares a short endpoint timeout.
providerById("openai").endpoints.find(endpoint => endpoint.id === "responses").timeout_ms = ${endpointMs};
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.fixtureSql.exec("SELECT reservation_id, settled, dispatch_started, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
const ingress = {};
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture-state") return fetch("https://upstream.fixture/state");
  if (path === "/fixture-ingress") return Response.json(ingress);
  if (path !== "/v1/responses") return handler.fetch(request, env, context);
  const requestId = request.headers.get("x-request-id");
  const entry = ingress[requestId] = { receivedAt: Date.now(), abortedAt: request.signal.aborted ? Date.now() : null, returnedAt: null, status: null, failedAt: null };
  request.signal.addEventListener("abort", () => { entry.abortedAt = Date.now(); }, { once: true });
  try {
    const response = await handler.fetch(request, env, context);
    entry.returnedAt = Date.now(); entry.status = response.status;
    if (requestId === "deadline-cancel-json-pre-body-progress") {
      // The direct socket needs the fixture's downstream compression contract.
      const headers = new Headers(response.headers);
      headers.set("content-encoding", "gzip"); headers.delete("content-length");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers, encodeBody: "automatic" });
    }
    return response;
  } catch (error) { entry.failedAt = Date.now(); throw error; }
} };
`; }

function upstreamFixture() { return `
const state = {}, encoder = new TextEncoder();
export default { async fetch(request) {
  if (new URL(request.url).pathname === "/state") return Response.json(state);
  const body = await request.json(), scenario = body.input;
  const preBodyProgress = scenario === "cancel-json-pre-body-progress";
  const entry = state[scenario] = { startedAt: Date.now(), lastProgressAt: null, progressCount: 0, complete: false, aborted: false, canceled: false };
  if (preBodyProgress) entry.firstPayloadAt = null;
  let timer, controller, release, stopped = false;
  const finish = () => { stopped = true; clearTimeout(timer); release?.(); };
  const wait = ms => new Promise(resolve => { release = resolve; timer = setTimeout(resolve, ms); });
  request.signal.addEventListener("abort", () => { entry.aborted = true; finish(); controller?.error(request.signal.reason); }, { once: true });
  if (scenario === "headers") {
    await new Promise((resolve, reject) => {
      timer = setTimeout(resolve, ${endpointMs * 4});
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    return Response.json({ unexpected: "headers arrived after deadline" });
  }
  const result = { object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  let activeJson = null;
  if (scenario === "cancel-json-active" || preBodyProgress) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let seed = 1, text = "";
    for (let index = 0; index < 64 * 1024; index++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      text += alphabet[(seed >>> 0) % alphabet.length];
    }
    activeJson = JSON.stringify({ ...result, output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }
  let chunks = 0;
  return new Response(new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      if (scenario === "first-event") { await wait(${endpointMs * 4}); return; }
      if (chunks > 0) await wait(50);
      if (stopped) return;
      entry.lastProgressAt = Date.now(); entry.progressCount++;
      // This probe's payload starts on the upstream clock, independently of caller abort.
      if (activeJson !== null && (!preBodyProgress || entry.lastProgressAt - entry.startedAt >= 2_000)) {
        if (preBodyProgress && entry.firstPayloadAt === null) { entry.firstPayloadAt = entry.lastProgressAt; chunks = 0; }
        const offset = chunks++ * 2048;
        value.enqueue(encoder.encode(activeJson.slice(offset, offset + 2048)));
        if (offset + 2048 >= activeJson.length) { entry.complete = true; finish(); value.close(); }
        return;
      }
      if (chunks++ === 30 && !scenario.startsWith("cancel-")) {
        value.enqueue(encoder.encode(body.stream ? 'data: ' + JSON.stringify({ type: "response.completed", response: result }) + '\\n\\n' : JSON.stringify(result)));
        entry.complete = true; finish(); value.close(); return;
      }
      value.enqueue(encoder.encode(body.stream ? 'data: ' + JSON.stringify(chunks === 1 ? { type: "response.created", response: { status: "in_progress" } } : { type: "response.output_text.delta", delta: "fixture" }) + '\\n\\n' : ' '));
    },
    cancel() { entry.canceled = true; finish(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } });
} };
`; }
