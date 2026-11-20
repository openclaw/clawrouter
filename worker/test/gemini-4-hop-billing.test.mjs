import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");

// Ordinary provider disconnects. Only a complete checkpoint frame can commit
// usage in an interrupted stream; later progress is not another billable hop.
const usage = n => ({ promptTokenCount: 10, candidatesTokenCount: n, totalTokenCount: n + 10 });
const checkpoint = n => ({ candidates: [{ continuationToken: "Y3A=" }], usageMetadata: usage(n) });
const progress = { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: usage(1) };
for (const c of [
  { name: "SSE before first checkpoint", frames: [progress], cost: 0, basis: "none" },
  { name: "SSE last checkpoint only", model: "carbon", frames: [checkpoint(32768), checkpoint(37768), { ...progress, usageMetadata: usage(39000) }], cost: 40 + 20 * 37768, basis: "manifest_rate_upper_bound" },
  { name: "unterminated SSE without finish reason", frames: [progress], eof: true, cost: 0, basis: "none" },
  { name: "empty SSE never reaches a checkpoint", frames: [], eof: true, cost: 0, basis: "none" },
  { name: "provider error after checkpoint keeps only checkpoint usage", model: "carbon", frames: [checkpoint(32768), { error: { message: "fixture" } }], eof: true, cost: 40 + 20 * 32768, basis: "manifest_rate_upper_bound" },
  { name: "unary response interrupted mid-body", json: true, cost: 0, basis: "none" },
  { name: "truncated unary JSON at EOF", json: true, eof: true, cost: 0, basis: "none" },
  { name: "missing checkpoint counters remain an estimate, not zero", frames: [{ candidates: [{ continuationToken: "Y3A=" }] }], model: "carbon", basis: "manifest_reservation" },
  { name: "older priced Google model retains its previous contract", upstream: "gemini-3.8-flash", frames: [progress], basis: "manifest_reservation" },
  { name: "explicit fixed price remains separate", frames: [progress], fixed: 73, cost: 73, basis: "policy_fixed" },
]) test(c.name, async t => {
  const env = usageEnv([], { provider: "google-gemini", fixedCost: c.fixed ?? null, limit: 10000000, budgetMode: "reserve", retainContent: false });
  const events = [], pending = [];
  env.BUDGET_LEDGER = sqlBudgetNamespace(t); env.GOOGLE_API_KEY = "fixture-google";
  env.USAGE_QUEUE = { async send(event) { events.push(event); } };
  let sent = false;
  const transport = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(ctrl) {
    if (!sent) { sent = true; ctrl.enqueue(new TextEncoder().encode(c.json ? '{"candidates":[' : sse(...c.frames))); }
    else if (c.eof) ctrl.close(); else ctrl.error(new Error("fixture: provider connection closed"));
  } }), { headers: { "content-type": c.json ? "application/json" : "text/event-stream" } }));
  const model = c.upstream ?? ("gemini-4-" + (c.model ?? "neon"));
  const path = "/v1/native/google-gemini/v1beta/models/" + model + (c.json ? ":generateContent" : ":streamGenerateContent?alt=sse");
  const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: c.model === "carbon" ? 65536 : 100 } };
  const reply = await handler.fetch(new Request("https://router.example" + path, { method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: work => pending.push(work) });
  assert.equal(reply.status, 200); if (c.eof) await reply.text(); else await assert.rejects(reply.text());
  await Promise.all(pending); assert.equal(transport.mock.callCount(), 1); assert.equal(events.length, 1);
  assert.ok(events[0].reserved_cost_micros > 0); assert.equal(events[0].actual_cost_micros, c.cost ?? events[0].reserved_cost_micros);
  assert.equal(events[0].cost_basis, c.basis); assert.equal(events[0].status, "provider_error");
});
