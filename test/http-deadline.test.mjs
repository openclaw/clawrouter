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
    const read = async path => {
      const response = await fetch(new URL(path, origin), { headers, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const ledgerFacts = () => Promise.all([["default:fixture", "default/fixture"], ["provider:openai", "provider/openai"]].map(async ([name, policyId]) => {
      const stub = budgets.get(budgets.idFromName(name)), month = new Date().toISOString().slice(0, 7);
      const status = await (await stub.fetch(`https://budget/status?policy_id=${policyId}&window_key=${policyId}/${month}&limit_micros=${limit}`)).json();
      const rows = await (await stub.fetch("https://budget/fixture-reservations")).json();
      return { spent: status.spentMicros, rows };
    }));
    let count = 0;
    for (const scenario of ["json", "sse", "headers", "first-event", "cancel-json", "cancel-sse"]) await t.test(scenario, async () => {
      const caller = new AbortController(), started = Date.now();
      const streaming = scenario.includes("sse") || scenario === "first-event";
      const canceled = scenario.startsWith("cancel-");
      const timedOut = scenario === "headers" || scenario === "first-event";
      const response = await fetch(new URL("/v1/responses", origin), {
        method: "POST", headers, signal: AbortSignal.any([caller.signal, AbortSignal.timeout(15_000)]),
        body: JSON.stringify({ model: "openai/gpt-6-astra", input: scenario, stream: streaming }),
      });
      assert.equal(response.status, timedOut ? 502 : 200);
      let text = "", reads = 0;
      if (timedOut) assert.equal((await response.json()).error.code, "provider_unavailable");
      else {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            text += decoder.decode(part.value, { stream: true }); reads++;
            if (canceled && Date.now() - started > endpointMs * 2) {
              caller.abort(new Error("fixture caller after endpoint deadline retirement"));
              await assert.rejects(reader.read());
              break;
            }
          }
        } finally { reader.releaseLock(); }
        assert.ok(reads > 2, "body must make progress across the declared deadline");
        assert.ok(Date.now() - started > endpointMs * 2);
        if (!canceled) assert.ok(streaming ? text.includes('"type":"response.completed"') : JSON.parse(text).status === "completed");
      }
      count++;
      let usage, state, ledgers;
      await until(async () => {
        usage = await read("/v1/usage"); state = (await read("/fixture-state"))[scenario];
        ledgers = await ledgerFacts();
        return usage.usage.events.length === count && ledgers.every(({ rows }) => rows.length === count && rows.every(row => row.settled === 1)) && (timedOut || canceled ? state.aborted || state.canceled : state.complete);
      });
      const receipt = usage.usage.events.find(event => event.request_id === response.headers.get("x-request-id"));
      assert.ok(receipt);
      assert.equal(receipt.status, timedOut ? "timeout" : canceled ? "client_error" : "success");
      assert.equal(receipt.status_code, timedOut ? 502 : 200);
      assert.equal(receipt.actual_cost_micros, 7); assert.equal(receipt.cost_basis, "policy_fixed");
      assert.equal(receipt.total_tokens, timedOut || canceled ? null : 2);
      assert.equal(new Set(usage.usage.events.map(event => event.request_id)).size, count);
      assert.equal(usage.usage.summary.actualCostMicros, count * 7);
      if (!timedOut) assert.ok(state.lastProgressAt - state.startedAt > endpointMs);
      if (!timedOut && !canceled) assert.equal(state.aborted || state.canceled, false);
      for (const { spent, rows } of ledgers) {
        assert.equal(spent, count * 7); assert.equal(rows.length, count);
        assert.ok(rows.every(row => row.settled === 1 && row.dispatch_started === 1 && row.reserved_micros === 7));
      }
    });
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("HTTP deadline fixture did not settle");
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
    if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.fixtureSql.exec("SELECT settled, dispatch_started, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture-state") return fetch("https://upstream.fixture/state");
  return handler.fetch(request, env, context);
} };
`; }

function upstreamFixture() { return `
const state = {}, encoder = new TextEncoder();
export default { async fetch(request) {
  if (new URL(request.url).pathname === "/state") return Response.json(state);
  const body = await request.json(), scenario = body.input;
  const entry = state[scenario] = { startedAt: Date.now(), lastProgressAt: null, complete: false, aborted: false, canceled: false };
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
  let chunks = 0;
  return new Response(new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      if (scenario === "first-event") { await wait(${endpointMs * 4}); return; }
      if (chunks > 0) await wait(50);
      if (stopped) return;
      entry.lastProgressAt = Date.now();
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
