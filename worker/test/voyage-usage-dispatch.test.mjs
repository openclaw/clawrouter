import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { observeUsage } = await import("../proxy-response.ts");
const { snapshot } = await import("../providers.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/voyage/embeddings.json", import.meta.url)));
const output = { ...wire.response, usage: { total_tokens: 7 } };
const text = JSON.stringify(output), encoder = new TextEncoder();

for (const fragmented of [false, true]) test(`Voyage ${fragmented ? "fragmented" : "unary"} observer preserves bytes and derives input usage only after EOF`, async () => {
  const bytes = encoder.encode(text), stream = new ReadableStream({ start(controller) {
    if (fragmented) for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
    else controller.enqueue(bytes); controller.close();
  } });
  const observed = observeUsage(new Response(stream, { headers: { "content-type": "application/json" } }), undefined, undefined, "voyage.embeddings");
  assert.equal(await observed.response.text(), text);
  const usage = await observed.result; assert.equal(usage.delivery, "complete");
  assert.deepEqual(usage.tokens, { input: 7, output: 0, total: 7, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null });
});

for (const scenario of ["generic", "http-error", "native-error", "missing", "malformed", "wrong-mime", "oversized", "truncated", "interrupted", "canceled"]) {
  test(`Voyage ${scenario} evidence cannot invent an embedding input/output split`, async () => {
    let bytes = encoder.encode(scenario === "missing" ? JSON.stringify({ ...output, usage: undefined })
      : scenario === "malformed" ? JSON.stringify({ ...output, usage: { total_tokens: "7" } })
      : scenario === "native-error" ? JSON.stringify({ ...output, error: { message: "synthetic" } })
      : scenario === "oversized" ? JSON.stringify({ ...output, padding: "x".repeat(2 * 1024 * 1024) })
      : scenario === "truncated" ? text.slice(0, -1) : text);
    let canceled = false, sent = false;
    const stream = new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes); }
      else if (scenario === "interrupted") controller.error(new Error("synthetic interruption"));
      else if (scenario !== "canceled") controller.close();
    }, cancel() { canceled = true; } });
    const observed = observeUsage(new Response(stream, { status: scenario === "http-error" ? 429 : 200,
      headers: { "content-type": scenario === "wrong-mime" ? "application/problem+json" : "application/json" } }),
      undefined, undefined, scenario === "generic" ? "openai.embeddings" : "voyage.embeddings");
    if (scenario === "canceled") { const reader = observed.response.body.getReader(); await reader.read(); await reader.cancel(); assert.equal(canceled, true); }
    else if (scenario === "interrupted") await assert.rejects(observed.response.text());
    else await observed.response.text();
    const usage = await observed.result;
    assert.equal(usage.tokens?.input ?? null, null); assert.equal(usage.tokens?.output ?? null, null);
    if (scenario === "generic") assert.equal(usage.tokens.total, 7, "generic totals keep their original unknown split");
  });
}

for (const manifest of [false, true]) for (const pooled of [false, true]) test(`Voyage actual ${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"} dispatch settles observed 7/0 without changing policy-fixed cost`, { timeout: 10_000 }, async t => {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === "voyage"));
  snapshot.providers = original.filter(provider => provider.id !== "voyage"); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { providerId: "voyage", pooled, configure(provider) { Object.assign(provider, source); } });
  f.env.VOYAGE_API_KEY = "synthetic-voyage-environment"; f.upstream = () => Response.json(output); t.after(f.drain);
  const body = { ...wire.request, model: manifest ? "voyage/voyage-4-lite" : "voyage-4-lite" };
  const response = await f.call(manifest ? "/v1/proxy/voyage/embeddings" : "/v1/native/voyage/v1/embeddings", manifest ? { body } : body);
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), output); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-voyage-environment");
  assert.deepEqual(await f.sent[0].clone().json(), { ...wire.request, model: "voyage-4-lite" });
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].input_tokens, 7); assert.equal(events[0].output_tokens, 0); assert.equal(events[0].total_tokens, 7);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
  for (const name of new Set(f.budgetCalls.map(call => call.name))) {
    const rows = f.budgets.get(name).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1);
  }
});
