import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

const endpointMs = 500;
const limit = 1_000_000;
const secret = "http-deadline-fixture-secret";
const headers = { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" };

test("workerd HTTP endpoint deadline retires before delivery with caller and both ledgers still owned", { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-http-deadline-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: limit, requestCostMicros: 7, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: limit }));
    const origin = await mf.ready;
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    const read = async (path, signal) => {
      const response = await fetch(new URL(path, origin), { headers, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const ledgerFacts = () => Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
      const stub = budgets.get(budgets.idFromName(name)), month = new Date().toISOString().slice(0, 7);
      const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
      const rows = await (await stub.fetch("https://budget/fixture-reservations")).json();
      return { spent: status.spentMicros, rows };
    }));
    // The original whitespace cancellation remains an unresolved diagnostic.
    // Run independent delivered-body cases first; never turn its failure into a skip.
    for (const scenario of ["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json"]) {
      let cleanupError;
      await t.test(scenario === "cancel-json" ? "cancel-json (unresolved whitespace cancellation)" : scenario, async () => {
        const caller = new AbortController(), watchStop = new AbortController();
        const requestId = `deadline-${scenario}`, cancellation = new Error("fixture caller after endpoint deadline retirement");
        const streaming = scenario.includes("sse") || scenario === "first-event";
        const canceled = scenario.startsWith("cancel-");
        const requireDeliveredBytes = canceled && scenario !== "cancel-json";
        const timedOut = scenario === "headers" || scenario === "first-event";
        const beforeUsage = await read("/v1/usage"), beforeLedgers = await ledgerFacts();
        const previousReceipts = new Set(beforeUsage.usage.events.map(event => event.request_id));
        const previousReservations = beforeLedgers.map(({ rows }) => new Set(rows.map(row => row.reservation_id)));
        const addedRows = (ledgers, index) => ledgers[index].rows.filter(row => !previousReservations[index].has(row.reservation_id));
        const safety = AbortSignal.timeout(15_000);
        const client = { startedAt: null, headersAt: null, status: null, contentEncoding: null, firstBodyAt: null, lastBodyAt: null, bodyBytes: 0, completedAt: null, failedAt: null, errorName: null, abortRequestedAt: null, bytesAtAbort: null };
        let usage, state, ingress, ledgers;
        const diagnostics = () => JSON.stringify({ requestId, client, ingress, state, receipts: usage?.usage.events.filter(event => event.request_id === requestId), reservations: ledgers?.map((_, index) => addedRows(ledgers, index)) });
        const facts = async () => {
          usage = await read("/v1/usage"); state = (await read("/fixture-state"))[scenario];
          ingress = (await read("/fixture-ingress"))[requestId];
          ledgers = await ledgerFacts();
          return usage.usage.events.some(event => event.request_id === requestId) && ledgers.every((_, index) => addedRows(ledgers, index).length > 0 && addedRows(ledgers, index).every(row => row.settled === 1)) && (state?.complete || state?.aborted || state?.canceled);
        };
        // Observe both sides without assuming that transport preserves write chunks.
        // The original whitespace case deliberately retains its upstream-only trigger.
        const watcher = canceled ? (async () => {
          await until(async () => {
            const progress = (await read("/fixture-state", watchStop.signal))[scenario];
            return progress?.progressCount > 2 && progress.lastProgressAt - progress.startedAt > endpointMs * 2 && (!requireDeliveredBytes || client.bodyBytes > 0);
          }, watchStop.signal, diagnostics);
          watchStop.signal.throwIfAborted();
          client.abortRequestedAt = Date.now(); client.bytesAtAbort = client.bodyBytes;
          caller.abort(cancellation);
        })() : Promise.resolve();
        const request = (async () => {
          client.startedAt = Date.now();
          try {
            const response = await fetch(new URL("/v1/responses", origin), {
              method: "POST", headers: { ...headers, "x-request-id": requestId }, signal: AbortSignal.any([caller.signal, safety]),
              body: JSON.stringify({ model: "openai/gpt-6-astra", input: scenario, stream: streaming }),
            });
            client.headersAt = Date.now(); client.status = response.status; client.contentEncoding = response.headers.get("content-encoding");
            assert.equal(response.status, timedOut ? 502 : 200);
            assert.equal(response.headers.get("x-request-id"), requestId);
            const reader = response.body.getReader(), decoder = new TextDecoder();
            let text = "";
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) { client.completedAt = Date.now(); return text + decoder.decode(); }
                if (part.value.byteLength) { client.firstBodyAt ??= Date.now(); client.lastBodyAt = Date.now(); client.bodyBytes += part.value.byteLength; }
                text += decoder.decode(part.value, { stream: true });
              }
            } finally { reader.releaseLock(); }
          } catch (error) { client.failedAt = Date.now(); client.errorName = error.name; throw error; }
        })();
        try {
          if (canceled) await Promise.all([watcher, assert.rejects(request, error => {
            assert.equal(caller.signal.reason, cancellation);
            assert.equal(safety.aborted, false, "the safety timeout is not the intended caller cancellation");
            return error === cancellation || error.name === "AbortError";
          })]);
          else {
            const text = await request;
            if (timedOut) assert.equal(JSON.parse(text).error.code, "provider_unavailable");
            else assert.ok(streaming ? text.includes('"type":"response.completed"') : JSON.parse(text).status === "completed");
          }
          await until(facts, undefined, diagnostics);
          const receipts = usage.usage.events.filter(event => !previousReceipts.has(event.request_id));
          assert.equal(receipts.length, 1); assert.equal(receipts[0].request_id, requestId);
          const receipt = receipts[0];
          assert.equal(usage.usage.events.filter(event => event.request_id === requestId).length, 1);
          assert.equal(receipt.status, timedOut ? "timeout" : canceled ? "client_error" : "success");
          assert.equal(receipt.status_code, timedOut ? 502 : 200);
          assert.equal(receipt.actual_cost_micros, 7); assert.equal(receipt.cost_basis, "policy_fixed");
          assert.equal(receipt.total_tokens, timedOut || canceled ? null : 2);
          assert.equal(usage.usage.summary.actualCostMicros, beforeUsage.usage.summary.actualCostMicros + 7);
          if (timedOut || canceled) assert.ok(state.aborted || state.canceled);
          else { assert.equal(state.complete, true); assert.equal(state.aborted || state.canceled, false); }
          if (!timedOut) {
            assert.ok(state.progressCount > 2, "upstream must make progress across the declared deadline");
            assert.ok(state.lastProgressAt - state.startedAt > endpointMs * 2);
          }
          if (requireDeliveredBytes) {
            assert.ok(client.bytesAtAbort > 0, "the active-delivery case must observe body bytes before cancellation");
            assert.ok(client.firstBodyAt <= client.abortRequestedAt);
          }
          for (const [index, { spent, rows }] of ledgers.entries()) {
            assert.equal(spent, beforeLedgers[index].spent + 7); assert.equal(rows.length, beforeLedgers[index].rows.length + 1);
            const added = addedRows(ledgers, index);
            assert.equal(added.length, 1);
            assert.deepEqual(added[0], { reservation_id: added[0].reservation_id, settled: 1, dispatch_started: 1, reserved_micros: 7 });
          }
        } finally {
          watchStop.abort(); caller.abort();
          await Promise.allSettled([request, watcher]);
          // Drain this request's upstream and accounting before taking another
          // baseline, even when a case assertion fails.
          try { await until(facts, undefined, diagnostics); }
          catch (error) { cleanupError = error; throw error; }
          finally { t.diagnostic(diagnostics()); }
        }
      });
      if (cleanupError) throw cleanupError;
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

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
  const entry = ingress[request.headers.get("x-request-id")] = { receivedAt: Date.now(), abortedAt: request.signal.aborted ? Date.now() : null, returnedAt: null, status: null, failedAt: null };
  request.signal.addEventListener("abort", () => { entry.abortedAt = Date.now(); }, { once: true });
  try {
    const response = await handler.fetch(request, env, context);
    entry.returnedAt = Date.now(); entry.status = response.status;
    return response;
  } catch (error) { entry.failedAt = Date.now(); throw error; }
} };
`; }

function upstreamFixture() { return `
const state = {}, encoder = new TextEncoder();
export default { async fetch(request) {
  if (new URL(request.url).pathname === "/state") return Response.json(state);
  const body = await request.json(), scenario = body.input;
  const entry = state[scenario] = { startedAt: Date.now(), lastProgressAt: null, progressCount: 0, complete: false, aborted: false, canceled: false };
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
  if (scenario === "cancel-json-active") {
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
      if (activeJson !== null) {
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
