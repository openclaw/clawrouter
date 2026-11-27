import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startWorkerdFixture } from "./workerd.mjs";

// Real Worker, authority, queue and SQLite ledgers. Only the vendor is synthetic.
export async function startDecisionsFixture() {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-decisions-"));
  const key = "clawrouter-live-fixture-decisions-fixture-secret";
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture().replaceAll("./worker/index.ts", fileURLToPath(new URL("../../worker/index.ts", import.meta.url))), upstreamFixture(), { preventEviction: true });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const policy = { enabled: true, generation: "g1", providers: ["openai"], tenantId: "default", monthlyBudgetMicros: 1_000_000, retainRequestContent: false };
    await kv.put("policies/fixture", JSON.stringify(policy));
    await kv.put("policies/denied", JSON.stringify({ ...policy, models: ["openai/gpt-6.1-sol"] }));
    const credential = { enabled: true, secretSha256: createHash("sha256").update("decisions-fixture-secret").digest("hex"), policyId: "fixture", policyGeneration: "g1" };
    await kv.put("credentials/fixture", JSON.stringify(credential));
    await kv.put("credentials/denied", JSON.stringify({ ...credential, policyId: "denied" }));
    await kv.put("connections/openai", JSON.stringify({ providerId: "openai", enabled: true, monthlyBudgetMicros: 1_000_000 }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const read = async path => {
      const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    const ledgerFacts = () => Promise.all(["default:fixture", "provider:openai"].map(async owner => {
      const stub = budgets.get(budgets.idFromName(owner));
      const rows = await (await stub.fetch("https://budget/fixture-reservations")).json();
      return { owner, rows };
    }));
    return { mf, origin, key, headers, read, ledgerFacts,
      deniedKey: key.replace("live-fixture-", "live-denied-"),
      async close() { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); },
    };
  } catch (error) {
    await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); throw error;
  }
}

export async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Decisions fixture did not reach its observed terminal state");
}

function routerFixture() { return `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.fixtureSql = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.fixtureSql.exec("SELECT reservation_id, settled, dispatch_started, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
const ingress = [];
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture-state") return fetch("https://upstream.fixture/state");
  if (path === "/fixture-ingress") return Response.json(ingress);
  if (path === "/v1/catalog" || path.includes("decisions")) {
    const entry = { path, routerAuth: request.headers.get("authorization") === "Bearer clawrouter-live-fixture-decisions-fixture-secret", aborted: request.signal.aborted };
    ingress.push(entry);
    request.signal.addEventListener("abort", () => { entry.aborted = true; }, { once: true });
  }
  return handler.fetch(request, env, context);
} };
`; }

function upstreamFixture() { return `
const state = { requests: [] }, encoder = new TextEncoder();
export default { async fetch(request) {
  if (new URL(request.url).pathname === "/state") return Response.json(state);
  const body = await request.json();
  const entry = { path: new URL(request.url).pathname, upstreamAuth: request.headers.get("authorization") === "Bearer fixture-upstream-key", body, aborted: false, canceled: false };
  state.requests.push(entry);
  if (entry.path !== "/v1/decisions" || !entry.upstreamAuth) return Response.json({ error: "wrong upstream route/auth" }, { status: 500 });
  if (body.input === "reject") return Response.json({ error: { type: "invalid_request_error", code: "fixture_rejection", message: "Synthetic invalid input" } }, { status: 422 });
  if (body.input === "cancel") {
    let timer, controller;
    // Non-compressible JSON string content makes physical delivery observable;
    // whitespace alone can remain buffered by the local HTTP compression pump.
    let seed = 1;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const noise = Array.from({ length: 8192 }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return alphabet[(seed >>> 0) % alphabet.length]; }).join("");
    const stop = () => { clearInterval(timer); };
    request.signal.addEventListener("abort", () => { entry.aborted = true; stop(); controller?.error(request.signal.reason); }, { once: true });
    return new Response(new ReadableStream({
      start(c) { controller = c; c.enqueue(encoder.encode('{"padding":"')); timer = setInterval(() => c.enqueue(encoder.encode(noise)), 25); },
      cancel() { entry.canceled = true; stop(); },
    }), { headers: { "content-type": "application/json" } });
  }
  const answers = body.questions.map(q => q.name === "withheld" ? { name: q.name, type: "refusal" }
    : q.type === "predicate" ? { name: q.name ?? null, type: q.type, probability: 0.9 }
    : q.type === "choice" ? { name: q.name ?? null, type: q.type, choice: q.choices[0].value, confidence: 0.8, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.8 : 0.2 / (q.choices.length - 1) })) }
    : { name: q.name ?? null, type: q.type, score: 0.75, confidence: 0.7, probabilities: q.levels.map((l, i) => ({ label: l.label, value: i, probability: i === 0 ? 0.25 : 0.75 })) });
  return Response.json({ model: "gpt-6-luna", answers, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1000 } });
} };
`; }
