import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { default: handler } = await import("../index.ts");
const { modelRoute } = await import("../providers.ts");
const { estimateModelCost, requestPricingGap } = await import("../pricing.ts");
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";

const routes = ["/v1/responses", "/v1/native/openai/v1/responses"];
const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
const opaque = { type: "compaction", encrypted_content: "synthetic-opaque" };
const model = modelRoute("openai/gpt-6-astra").model;
const endpoint = { request_format: "openai.responses" };
// Published default long-context card: 922k input at max(input, cache-write)
// $25/M, plus one output token at $75/M. Not a ciphertext token estimate.
const fullReserve = 23_050_075;
const result = { object: "response", status: "completed", service_tier: "default", output: [],
  usage: { input_tokens: 500_000, output_tokens: 1, total_tokens: 500_001,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };

function fixture(t, options = {}) {
  const events = [], pending = [], operations = [];
  const env = usageEnv([], { limit: 100_000_000, fixedCost: null, retainContent: false, ...options });
  env.OPENAI_API_KEY = "fixture-openai-key";
  const ledger = sqlBudgetNamespace(t);
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => {
    operations.push({ name, path: new URL(url).pathname });
    return ledger.get(name).fetch(url, init);
  } }) };
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  return { env, ledger, events, operations, pending, context: { waitUntil: promise => pending.push(promise) } };
}
function request(route, body, headers = {}) {
  return new Request("https://clawrouter.example" + route, { method: "POST",
    headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: route === routes[0] ? "openai/gpt-6-astra" : "gpt-6-astra",
      max_output_tokens: 1, service_tier: "default", store: false, ...body }) });
}
function settled(f, amount) {
  for (const owner of owners) {
    const rows = f.ledger.get(owner).reservations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].settled, 1);
    assert.equal(rows[0].dispatch_started, 1);
    assert.equal(rows[0].reserved_micros, amount);
    for (const path of ["/reserve", "/dispatch", "/settle"]) {
      assert.equal(f.operations.filter(op => op.name === owner && op.path === path).length, 1);
    }
  }
}

for (const route of routes) for (const stream of [false, true]) {
  test("deficient opaque budget fails before upstream: " + route + " stream=" + stream, async t => {
    for (const [limit, providerLimit, code] of [[1_000_000, 100_000_000, "budget_exhausted"], [100_000_000, 1_000_000, "provider_budget_exhausted"]]) {
      const f = fixture(t, { limit, providerLimit });
      const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(result));
      const response = await handler.fetch(request(route, { input: [opaque], stream }), f.env, f.context);
      const text = await response.text();
      await Promise.all(f.pending);
      assert.equal(response.status, 402);
      assert.equal(JSON.parse(text).error.code, code);
      assert.ok(!text.includes(opaque.encrypted_content));
      assert.equal(upstream.mock.callCount(), 0);
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].reserved_input_tokens, 922_000);
      assert.equal(f.events[0].actual_cost_micros, 0);
      assert.equal(f.ledger.get(owners[1]).reservations().length, 0);
      const policyRows = f.ledger.get(owners[0]).reservations();
      assert.equal(policyRows.length, code === "provider_budget_exhausted" ? 1 : 0);
      if (policyRows.length) { assert.equal(policyRows[0].reserved_micros, 0); assert.equal(policyRows[0].settled, 1); }
      upstream.mock.restore();
    }
  });

  test("opaque state reserves full context and settles once: " + route + " stream=" + stream, async t => {
    const f = fixture(t);
    const input = [{ role: "user", content: "retained visible text" }, opaque];
    const wire = stream ? sse({ type: "response.completed", response: result }) : JSON.stringify(result);
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-openai-key");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "gpt-6-astra"); assert.equal(body.store, false);
      assert.deepEqual(body.input, input);
      for (const owner of owners) {
        const rows = f.ledger.get(owner).reservations();
        assert.equal(rows.length, 1); assert.equal(rows[0].reserved_micros, fullReserve);
        assert.equal(rows[0].settled, 0); assert.equal(rows[0].dispatch_started, 1);
      }
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const response = await handler.fetch(request(route, { input, stream }), f.env, f.context);
    assert.equal(response.status, 200); assert.equal(await response.text(), wire);
    await Promise.all(f.pending);
    assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
    const [event] = f.events;
    assert.equal(event.reserved_input_tokens, 922_000); assert.equal(event.reserved_cost_micros, fullReserve);
    assert.equal(event.actual_cost_micros, 10_000_075); assert.equal(event.cost_basis, "manifest_pricing");
    assert.equal(event.credential_id, "maintainer_key"); assert.equal(event.provider, "openai");
    assert.equal(event.grant_lane, "environment");
    assert.ok(!JSON.stringify(event).includes(opaque.encrypted_content));
    settled(f, 10_000_075);
  });
}

test("opaque protocol slots ignore ciphertext size or malformed contents, not text/schema/function names or controls", () => {
  for (const item of [opaque, { type: "compaction" }, { type: "compaction", encrypted_content: null },
    { type: "reasoning", encrypted_content: "x" }, { type: "reasoning", encrypted_content: "x".repeat(10_000) },
    { type: "reasoning", encrypted_content: {} }]) {
    const body = { input: [item], max_output_tokens: 1, service_tier: "default" };
    const before = structuredClone(body);
    assert.equal(estimateModelCost(model.pricing, body, endpoint).inputTokens, 922_000);
    assert.equal(estimateModelCost(model.pricing, body).inputTokens, 922_000);
    assert.deepEqual(body, before);
  }
  for (const body of [
    { input: JSON.stringify(opaque) },
    { input: [{ role: "user", content: JSON.stringify(opaque) }] },
    { input: [{ type: "function_call_output", output: JSON.stringify(opaque) }] },
    { input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "visible summary" }] }] },
    { input: "hi", include: ["reasoning.encrypted_content"], context_management: [{ type: "compaction", compact_threshold: 100_000 }] },
    { input: "hi", tools: [{ type: "function", name: "compaction", parameters: { type: "object", properties: { encrypted_content: { type: "string" } } } }] },
  ]) assert.ok(estimateModelCost(model.pricing, body, endpoint).inputTokens < 10_000);
  assert.equal(estimateModelCost(model.pricing, { input: [opaque] }, { request_format: "openai.chat_completions" }).inputTokens < 10_000, true);
  for (const body of [{ input: [{ type: "item_reference", id: "fixture" }] }, { previous_response_id: "fixture" }]) {
    assert.equal(estimateModelCost(model.pricing, body, endpoint).inputTokens, 922_000);
  }
});

test("unknown or invalid authoritative opaque bounds fail safe at HTTP admission", async t => {
  const original = model.pricing;
  try {
    for (const pricing of [null, { ...original, maxInputTokens: undefined }, { ...original, maxInputTokens: 0 },
      { ...original, maxInputTokens: -1 }, { ...original, maxInputTokens: 1.5 },
      { ...original, maxRequestInputTokens: 0 }, { ...original, maxRequestInputTokens: NaN }, { ...original, maxRequestInputTokens: Infinity },
      { ...original, maxRequestInputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, maxRequestInputTokens: "100" }]) {
      model.pricing = pricing;
      const f = fixture(t);
      const upstream = t.mock.method(globalThis, "fetch", async () => Response.json(result));
      const response = await handler.fetch(request(routes[0], { input: [opaque] }), f.env, f.context);
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "pricing_required");
      await Promise.all(f.pending);
      assert.equal(upstream.mock.callCount(), 0);
      assert.equal(f.operations.filter(op => op.path === "/reserve").length, 0);
      upstream.mock.restore();
    }
    model.pricing = { ...original, maxRequestInputTokens: 1_000_000 };
    assert.equal(estimateModelCost(model.pricing, { input: [opaque] }, endpoint).inputTokens, 1_000_000);
  } finally { model.pricing = original; }
});

test("opaque accounting preserves hosted-tool and retained-tool pricing refusals and plaintext admission", async t => {
  for (const [input, tools, expected] of [[[opaque], [{ type: "web_search" }], 400],
    ["ordinary compaction encrypted_content", [{ type: "function", name: "compaction", parameters: { type: "object" } }], 200]]) {
    const f = fixture(t, { limit: 1_000_000 });
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ ...result, usage: { ...result.usage, input_tokens: 10, total_tokens: 11 } }));
    const response = await handler.fetch(request(routes[0], { input, tools }), f.env, f.context);
    assert.equal(response.status, expected);
    if (expected === 400) assert.equal((await response.json()).error.code, "pricing_required");
    else await response.text();
    await Promise.all(f.pending);
    assert.equal(upstream.mock.callCount(), expected === 200 ? 1 : 0);
    upstream.mock.restore();
  }
  assert.equal(requestPricingGap(model.pricing, { previous_response_id: "fixture", input: [opaque] }, "openai.responses", "unknown"), "retained_tool_unknown");
});

for (const route of routes) test("canceled opaque SSE keeps the bound once without terminal usage: " + route, async t => {
  const f = fixture(t);
  let canceled = 0;
  let sent = false;
  const first = sse({ type: "response.created" });
  const source = new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(first)); }
  }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "content-type": "text/event-stream" } }));
  const response = await handler.fetch(request(route, { input: [opaque], stream: true }), f.env, f.context);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), first);
  await reader.cancel(); await Promise.all(f.pending);
  assert.equal(canceled, 1); assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].reserved_input_tokens, 922_000);
  assert.equal(f.events[0].actual_cost_micros, fullReserve);
  assert.equal(f.events[0].cost_basis, "manifest_reservation");
  settled(f, fullReserve);
});

for (const route of routes) test('opaque replay keeps missing-usage cost and rejects unauthenticated egress: ' + route, async t => {
  const f = fixture(t);
  const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...result, usage: undefined }));
  // Identical opaque bytes do not become a smaller or token-only witness on reuse.
  for (let replay = 0; replay < 2; replay++) {
    const response = await handler.fetch(request(route, { input: [opaque] }), f.env, f.context);
    assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
    assert.equal(f.events.length, replay + 1);
    assert.equal(f.events[replay].reserved_input_tokens, 922_000);
    assert.equal(f.events[replay].actual_cost_micros, fullReserve);
    assert.equal(f.events[replay].cost_basis, 'manifest_reservation');
    for (const owner of owners) {
      const rows = f.ledger.get(owner).reservations();
      assert.equal(rows.length, replay + 1);
      assert.ok(rows.every(row => row.reserved_micros === fullReserve && row.settled === 1));
    }
  }
  const before = f.operations.length;
  const unauthenticated = await handler.fetch(request(route, { input: [opaque] }, { authorization: 'Bearer invalid-fixture' }), f.env, f.context);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.text(); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 2); assert.equal(f.operations.length, before);
});

for (const route of routes) test('opaque upstream rejection releases reservation once: ' + route, async t => {
  const f = fixture(t);
  const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'synthetic invalid compaction' } }, { status: 400 }));
  const response = await handler.fetch(request(route, { input: [opaque] }), f.env, f.context);
  assert.equal(response.status, 400); await response.text(); await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].reserved_cost_micros, fullReserve);
  assert.equal(f.events[0].actual_cost_micros, 0); assert.equal(f.events[0].cost_basis, 'none');
  settled(f, 0);
});
