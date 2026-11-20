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
const stop = (n, index = 0) => ({ candidates: [{ index, finishReason: "STOP" }], usageMetadata: usage(n) });
for (const c of [
  { name: "final Carbon receipt supersedes a checkpoint without counters", model: "carbon", frames: [{ candidates: checkpoint(0).candidates }, stop(40000)], eof: true, cost: 800040, basis: "manifest_rate_upper_bound", status: "success" },
  { name: "delivered Neon terminal receipt does not need transport EOF", frames: [stop(31)], cancel: true, cost: 495, basis: "manifest_pricing", status: "client_error" },
  { name: "one finished candidate cannot complete a two-candidate request", count: "2", frames: [stop(31)], cancel: true, cost: 0, basis: "none", status: "client_error" },
  { name: "last of two separately finished candidates commits cumulative receipt", count: "2", frames: [stop(5, 1), stop(31)], cancel: true, cost: 495, basis: "manifest_pricing", status: "client_error" },
  { name: "terminal without usage cannot borrow earlier progress", frames: [progress, { candidates: stop(31).candidates }], eof: true, basis: "manifest_reservation", status: "success" },
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
    else if (c.eof) ctrl.close(); else if (!c.cancel) ctrl.error(new Error("fixture: provider connection closed"));
  } }), { headers: { "content-type": c.json ? "application/json" : "text/event-stream" } }));
  const model = c.upstream ?? ("gemini-4-" + (c.model ?? "neon"));
  const path = "/v1/native/google-gemini/v1beta/models/" + model + (c.json ? ":generateContent" : ":streamGenerateContent?alt=sse");
  const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { candidate_count: c.count, maxOutputTokens: c.model === "carbon" ? 65536 : 100 } };
  const reply = await handler.fetch(new Request("https://router.example" + path, { method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: work => pending.push(work) });
  assert.equal(reply.status, 200);
  if (c.cancel) {
    const reader = reply.body.getReader(), frame = await reader.read();
    assert.equal(new TextDecoder().decode(frame.value), sse(...c.frames));
    await reader.cancel();
  } else if (c.eof) await reply.text(); else await assert.rejects(reply.text());
  await Promise.all(pending); assert.equal(transport.mock.callCount(), 1); assert.equal(events.length, 1);
  assert.ok(events[0].reserved_cost_micros > 0); assert.equal(events[0].actual_cost_micros, c.cost ?? events[0].reserved_cost_micros);
  assert.equal(events[0].cost_basis, c.basis); assert.equal(events[0].status, c.status ?? "provider_error");
});
