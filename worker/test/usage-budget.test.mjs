import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import test from "node:test";


const { default: handler } = await import("../index.ts");
const { providerBudgetStatus, queue } = await import("../ledgers.ts");
const keyMaterial = "abcdefgh";
const keyDigest = await sha256(keyMaterial);

for (const failure of ["retention", "provider"]) {
  test(`${failure} failure accounts the fixed tariff only after dispatch and preserves request attribution`, async (t) => {
    const env = usageEnv([], { provider: "local-openai", retainContent: failure === "retention" });
    env.LOCAL_OPENAI_BASE_URL = "https://upstream.example.invalid";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.CONTENT_ARCHIVE = { put: async () => { throw new Error("synthetic retention failure"); } };
    const events = [], pending = [];
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("synthetic transport failure"); });
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json", "x-request-id": "synthetic-request", "x-clawrouter-session-id": "synthetic-session" },
      body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "synthetic input" }] }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, failure === "retention" ? 503 : 502);
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), failure === "retention" ? 0 : 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].request_id, "synthetic-request");
    assert.equal(events[0].session_id, "synthetic-session");
    assert.equal(events[0].status, "provider_error");
    assert.equal(events[0].reserved_cost_micros, 1);
    const charged = failure === "retention" ? 0 : 1;
    assert.equal(events[0].actual_cost_micros, charged);
    assert.equal(events[0].cost_basis, failure === "retention" ? "none" : "policy_fixed");
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, charged);
    assert.equal((await providerBudgetStatus(env, "local-openai", 100)).spentMicros, charged);
  });
}

test("GET /v1/usage preserves the budget response contract while selecting the caller principal", async () => {
  const objectNames = [];
  const env = usageEnv(objectNames);
  const response = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  const month = new Date().toISOString().slice(0, 7);
  assert.deepEqual(body.budget, {
    configured: true,
    ledger: "durable_object",
    windowKey: `tenant/maintainer_access/owner@example.com/${month}`,
    limitMicros: 100,
    spentMicros: 10,
    remainingMicros: 90,
  });
  assert.deepEqual(Object.keys(body.budget), ["configured", "ledger", "windowKey", "limitMicros", "spentMicros", "remainingMicros"]);
  assert.equal(objectNames[0], "tenant:maintainer_access:owner@example.com");
});

test("failed dispatch confirmation never reaches upstream and releases both real budgets", async (t) => {
  for (const failedOwner of ["tenant:maintainer_access:owner@example.com", "provider:openai"]) {
    const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    const ledger = sqlBudgetNamespace(t), events = [], pending = [];
    env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => name === failedOwner && new URL(url).pathname === "/dispatch" ? Response.json({ dispatched: false }) : ledger.get(name).fetch(url, init) }) };
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("dispatch must not reach upstream"); });
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority" }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "accounting_unavailable");
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, "none");
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, 0);
    assert.equal((await providerBudgetStatus(env, "openai", 1_000_000)).spentMicros, 0);
    upstream.mock.restore();
  }
});

function usageEnv(objectNames, { provider = "openai", limit = 100, providerLimit = limit, fixedCost = 1, retainContent = true, existingUnmetered = false } = {}) {
  const policy = { enabled: true, generation: "policy_v1", providers: [provider], tenantId: "tenant", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, budgetScope: "principal", retainRequestContent: retainContent };
  // Existing stored policies can omit the optional limits; new policies use null.
  if (existingUnmetered) { delete policy.monthlyBudgetMicros; delete policy.requestCostMicros; }
  const credential = { enabled: true, ["sec" + "retSha256"]: keyDigest, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" };
  const access = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "maintainer_key", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "maintainer_access", policy }], missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [], missingEmails: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: provider, enabled: true, monthlyBudgetMicros: providerLimit }], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      throw new Error(`unexpected authority path ${path}`);
    } }),
  };
  const budget = { idFromName: (name) => name, get: (name) => ({ fetch: async () => { objectNames.push(name); return Response.json({ spentMicros: 10, remainingMicros: 90 }); } }) };
  const emptyUsage = { ledger: "durable_object", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  const usage = { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json(emptyUsage) }) };
  return { ACCESS_CONTROL: access, BUDGET_LEDGER: budget, USAGE_LEDGER: usage, POLICY_KV: { get: async (keys) => Array.isArray(keys) ? new Map() : null } };
}

function proxyKey() { return ["clawrouter", "live", `maintainer_key-${keyMaterial}`].join("-"); }

test("Fusion settles the final body estimate while retaining both original reservation receipts", async (t) => {
  const { estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
  const { DEFAULT_FUSION_CONFIG, buildAggregatorBody, buildFusionReservationProposals } = await import("../fusion.ts");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-6-astra", maxProposalChars: 256 };
  const body = { model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  const route = modelRoute(config.aggregatorModel, "llm.chat");
  const prepared = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), {});
  const initial = estimateCost(route.model, prepared.body, null, "llm.chat", "openai.chat_completions");
  const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
  env.OPENAI_API_KEY = "fixture-openai-key";
  env.POLICY_KV.get = async (key) => key === "config/fusion" ? config : Array.isArray(key) ? new Map() : null;
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [], bodies = [];
  env.BUDGET_LEDGER = { ...ledger, get: (name) => ({ fetch: (url, init) => {
    calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) });
    return ledger.get(name).fetch(url, init);
  } }) };
  env.USAGE_QUEUE = { send: async (event) => events.push(event) };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "short fixture answer" } }] });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(response.status, 200); await response.text();
  while (pending.length) await Promise.all(pending.splice(0));
  assert.deepEqual(bodies.map(({ model }) => model), ["gpt-4.1-mini", "gpt-6-astra"]);
  const final = estimateCost(route.model, bodies[1], null, "llm.chat", "openai.chat_completions");
  assert.ok(final.reserveMicros < initial.reserveMicros);
  const event = events.find(({ compound_request_stage }) => compound_request_stage === "fusion_synthesizer");
  assert.equal(event.reserved_cost_micros, initial.reserveMicros);
  assert.equal(event.actual_cost_micros, final.reserveMicros);
  assert.equal(event.reserved_input_tokens, final.inputTokens);
  assert.equal(event.cost_basis, "manifest_reservation");
  const original = calls.filter(({ path }) => path === "/reserve").slice(0, 2);
  assert.deepEqual(original.map(({ body }) => body.costMicros), [initial.reserveMicros, initial.reserveMicros]);
  for (const { name, body: held } of original) {
    const receipt = calls.filter((call) => call.name === name && call.body.reservationId === held.reservationId);
    assert.deepEqual(receipt.map(({ path }) => path), ["/reserve", "/dispatch", "/settle"]);
    assert.equal(receipt[2].body.actualCostMicros, final.reserveMicros);
  }
});

test("reservation reuse reassesses a final pricing gap before admission and unmetered settlement", async (t) => {
  const { reserveBudget, validateBudgetReservation } = await import("../accounting.ts");
  const { createProxyAccounting, estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("openai/gpt-6-astra", "llm.chat");
  const endpoint = route.provider.endpoints.find(({ id }) => id === "chat_completions");
  const originalBody = { messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  for (const [policyLimit, providerLimit] of [[1_000_000, null], [null, 1_000_000], [null, null]]) {
    const events = [], pending = [], env = { BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { send: async (event) => events.push(event) } };
    const auth = { policyId: "fixture", policy: { tenantId: "default", monthlyBudgetMicros: policyLimit }, credentialId: "fixture", authType: "proxy_key" };
    const connection = { providerId: "openai", monthlyBudgetMicros: providerLimit };
    const initial = estimateCost(route.model, originalBody, null, "llm.chat", endpoint.request_format);
    const reservation = await reserveBudget(env, auth, "llm.chat", initial, connection);
    const originalReceipt = structuredClone(reservation);
    // Exercise the shared reuse boundary: monetary coverage cannot certify a
    // later request's completeness. Fusion's current builder preserves tools.
    const body = { ...originalBody, web_search_options: {} };
    const final = estimateCost(route.model, body, null, "llm.chat", endpoint.request_format);
    assert.equal(final.basis, "unpriced_request");
    assert.equal(final.pricingGap, "hosted_tool_fee");
    assert.ok(final.reserveMicros <= initial.reserveMicros);
    const owner = createProxyAccounting({ env, context: { waitUntil: (promise) => pending.push(promise) }, auth, selection: { ...route, endpoint, body, capability: "llm.chat" }, cost: final, request: correlateIngressRequest(new Request("https://router.example/v1/chat/completions")).request });
    const budgeted = policyLimit != null || providerLimit != null;
    if (budgeted) {
      assert.throws(() => validateBudgetReservation("llm.chat", final, policyLimit, connection), (error) => error.code === "pricing_required");
      owner.fail(400, "client_error", reservation);
    } else {
      assert.equal(validateBudgetReservation("llm.chat", final, policyLimit, connection), false);
      await owner.settle(200, "success", true, { input: 100, output: 10, total: 110, serviceTier: "default" }, reservation, null);
    }
    await Promise.all(pending);
    assert.deepEqual(reservation, originalReceipt);
    assert.equal(events[0].reserved_cost_micros, budgeted ? initial.reserveMicros : 0);
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, budgeted ? "none" : "unpriced_usage");
    for (const { objectName, reservationId } of reservation.reservations) {
      const [row] = env.BUDGET_LEDGER.get(objectName).reservations();
      assert.equal(row.reservation_id, reservationId);
      assert.equal(row.reserved_micros, 0); assert.equal(row.settled, 1);
    }
  }
});

test("HTTP still delivers the upstream response when accounting publication fails", async (t) => {
  const env = usageEnv([], { provider: "local-openai", limit: null, retainContent: false });
  env.LOCAL_OPENAI_BASE_URL = "https://upstream.example.invalid";
  env.USAGE_QUEUE = { send: async () => { throw new Error("fixture queue outage"); } };
  env.USAGE_LEDGER.get = () => ({ fetch: async () => new Response("fixture ingest outage", { status: 503 }) });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({ fixture: "complete" }));
  const pending = [];
  const response = await handler.fetch(new Request("https://clawrouter.example/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "fixture" }] }),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fixture: "complete" });
  await Promise.all(pending);
});

for (const contentType of ["application/vnd.amazon.eventstream", "application/json", "text/event-stream"]) {
test(`${contentType} accounting preserves backpressure and settles on completion, error, or cancellation`, async (t) => {
  for (const outcome of ["complete", "error", "cancel"]) {
    const env = usageEnv([], { provider: "local-openai", limit: null, retainContent: false });
    env.LOCAL_OPENAI_BASE_URL = "https://upstream.example.invalid";
    const events = []; env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    let pulls = 0, canceled = false;
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const source = new ReadableStream({
      pull(controller) {
        if (outcome === "error" && pulls === 1) controller.error(new Error("synthetic upstream failure"));
        else if (pulls < bytes.length) controller.enqueue(bytes.slice(pulls, ++pulls));
        else controller.close();
      },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "content-type": contentType } }));
    const pending = [];
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "local/default", messages: [{ role: "user", content: "synthetic input" }] }),
    }), env, { waitUntil: promise => pending.push(promise) });
    try {
      assert.equal(response.status, 200);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pulls, 0, "accounting must not drain a stalled client's stream");
      assert.equal(events.length, 0);
      if (outcome === "cancel") await response.body.cancel();
      else if (outcome === "error") await assert.rejects(response.arrayBuffer(), /synthetic upstream failure/);
      else assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      await Promise.all(pending);
      assert.equal(canceled, outcome === "cancel"); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 1);
    } finally {
      if (!response.body.locked) await response.body.cancel().catch(() => {});
      t.mock.restoreAll();
    }
  }
});
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const messageUsage = { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 }, output_tokens: 20 };
const messageStart = { type: "message_start", message: { type: "message", usage: { ...messageUsage, output_tokens: 1 } } };
const messageDelta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } };
const messageStop = { type: "message_stop" };
const sse = (...events) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const earlyRefusal = { type: "message", content: [], stop_reason: "refusal", usage: { ...messageUsage, output_tokens: 0 } };

for (const [name, body, contentType, measured, measuredCost = 4_710, outputTokens = 20] of [
  ["JSON", JSON.stringify({ type: "message", usage: messageUsage }), "application/json", true],
  ["SSE", sse(messageStart, { type: "message_delta", usage: { output_tokens: 5 } }, messageDelta, messageStop), "text/event-stream", true],
  ["JSON early refusal", JSON.stringify(earlyRefusal), "application/json", true, 0, 0],
  ["SSE early refusal", sse({ type: "message_start", message: { ...earlyRefusal, stop_reason: null } }, { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }, messageStop), "text/event-stream", true, 0, 0],
  ["SSE mid-output refusal", sse(messageStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial output" } }, { ...messageDelta, delta: { stop_reason: "refusal" } }, messageStop), "text/event-stream", true],
  ["SSE without message_stop", sse(messageStart, messageDelta), "text/event-stream", false],
  ["SSE without final usage", sse(messageStart, messageStop), "text/event-stream", false],
  ["SSE with malformed final usage", sse(messageStart, "{broken", messageStop), "text/event-stream", false],
]) {
  test(`Anthropic ${name} settles policy and provider budgets from complete cache usage`, async (t) => {
    const limit = 13_500;
    const env = usageEnv([], { provider: "anthropic", limit, fixedCost: null, retainContent: false });
    env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    const events = [];
    env.USAGE_QUEUE = { send: async (event) => { events.push(event); } };
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(JSON.parse(init.body).service_tier, "standard_only");
      return new Response(body, { headers: { "content-type": contentType } });
    });
    const pending = [];
    const context = { waitUntil: (promise) => { pending.push(promise); } };
    const request = new Request("https://clawrouter.example/v1/messages", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5", service_tier: "standard_only", max_tokens: 20, stream: contentType === "text/event-stream", messages: [{ role: "user", content: [{ type: "text", text: "a".repeat(4_000), cache_control: { type: "ephemeral", ttl: "1h" } }] }] }),
    });
    const response = await handler.fetch(request.clone(), env, context);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
    await Promise.all(pending);
    const [event] = events;
    assert.equal(events.length, 1);
    const expectedCost = measured ? measuredCost : event.reserved_cost_micros;
    assert.ok(event.reserved_cost_micros > 4_710);
    assert.equal(event.actual_cost_micros, expectedCost);
    assert.equal(event.cost_basis, !measured ? "manifest_reservation" : measuredCost === 0 ? "none" : "manifest_pricing");
    if (measured) {
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens, event.cache_write_input_tokens], [4_010, outputTokens, 4_010 + outputTokens, 1_000, 3_000]);
    }
    const usageResponse = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usageResponse.json()).budget.spentMicros, expectedCost);
    assert.equal((await providerBudgetStatus(env, "anthropic", limit)).spentMicros, expectedCost);
    const next = await handler.fetch(request, env, context);
    assert.equal(next.status, expectedCost === 0 ? 200 : 402);
    if (expectedCost !== 0) assert.equal((await next.json()).error.code, "budget_exhausted");
    else await next.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), expectedCost === 0 ? 2 : 1);
  });
}

const astraUsage = { input_tokens: 14, output_tokens: 8, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
const largeResponsesOutput = [{ type: "message", content: [{ type: "output_text", text: "x".repeat(2 * 1024 * 1024 + 1024) }] }];
test("live HTTP and native streams keep both reservations past 15 minutes until completion", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) {
    const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    const events = [], pending = [];
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    let source;
    const first = sse({ type: "response.created" });
    const last = sse({ type: "response.completed", response: { service_tier: "priority", usage: astraUsage } });
    const upstream = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
      source = controller; controller.enqueue(new TextEncoder().encode(first));
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", stream: true }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), first);
    const policySpent = async () => (await (await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {})).json()).budget.spentMicros;
    const reserved = await policySpent();
    assert.ok(reserved > 1_080);
    now += 20 * 60_000;
    assert.equal(await policySpent(), reserved);
    assert.equal((await providerBudgetStatus(env, "openai", 1_000_000)).spentMicros, reserved);
    assert.deepEqual(events, []);
    source.enqueue(new TextEncoder().encode(last)); source.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), last);
    assert.equal((await reader.read()).done, true);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].actual_cost_micros, 1_080);
    assert.equal(await policySpent(), 1_080);
    assert.equal((await providerBudgetStatus(env, "openai", 1_000_000)).spentMicros, 1_080);
    upstream.mock.restore();
  }
});

for (const [name, route, requestedTier, payload, contentType, expected, servedTier, outcome = "success", fixedCost = null] of [
  ["JSON priority", "/v1/responses", "priority", { service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
  ["large JSON late usage", "/v1/responses", "priority", { output: largeResponsesOutput, object: "response", status: "completed", service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
  ["large native SSE terminal", "/v1/native/openai/v1/responses", "priority", sse({ type: "response.created" }, { type: "response.completed", response: { output: largeResponsesOutput, service_tier: "priority", usage: astraUsage } }), "text/event-stream", 1_080, "priority"],
  ["large JSON fixed tariff 7", "/v1/responses", "priority", { output: largeResponsesOutput, object: "response", status: "completed", service_tier: "priority", usage: astraUsage }, "application/json", 7, "priority", "success", 7],
  ["large JSON fixed tariff 0", "/v1/responses", "priority", { output: largeResponsesOutput, object: "response", status: "completed", service_tier: "priority", usage: astraUsage }, "application/json", 0, "priority", "success", 0],
  ["inspection cap remains estimated", "/v1/responses", "priority", { object: "response", status: "completed", service_tier: "x".repeat(65), usage: astraUsage }, "application/json", null, null],
  ["syntax after late usage remains estimated", "/v1/responses", "priority", JSON.stringify({ output: largeResponsesOutput, service_tier: "priority", usage: astraUsage }) + "!", "application/json", null, null, "provider_error"],
  ["native fast alias", "/v1/native/openai/v1/responses", "fast", { service_tier: "fast", usage: astraUsage }, "application/json", 1_080, "fast"],
  ["JSON Flex", "/v1/responses", "flex", { service_tier: "flex", usage: astraUsage }, "application/json", 270, "flex"],
  ["omitted inherits Fast", "/v1/responses", undefined, { service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
  ["auto inherits Fast", "/v1/responses", "auto", { service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
  ["Responses SSE downgrade", "/v1/responses", "priority", sse({ type: "response.created", response: { service_tier: "priority" } }, { type: "response.completed", response: { service_tier: "default", usage: astraUsage } }), "text/event-stream", 540, "default"],
  ["Responses SSE max-output incomplete", "/v1/responses", "priority", sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, service_tier: "priority", usage: astraUsage } }), "text/event-stream", 1_080, "priority"],
  ["Responses SSE failed with usage", "/v1/responses", "priority", sse({ type: "response.failed", response: { status: "failed", service_tier: "priority", usage: astraUsage } }), "text/event-stream", 1_080, "priority", "provider_error"],
  ["Responses JSON failed with usage", "/v1/responses", "priority", { object: "response", status: "failed", service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority", "provider_error"],
  ["Responses JSON incomplete", "/v1/responses", "priority", { object: "response", status: "incomplete", service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
  ["Chat SSE usage-only terminal", "/v1/chat/completions", "priority", sse({ object: "chat.completion.chunk", service_tier: "priority" }, { object: "chat.completion.chunk", usage: astraUsage }, "[DONE]"), "text/event-stream", 1_080, "priority"],
  ["unknown served tier", "/v1/responses", "priority", { service_tier: "future", usage: astraUsage }, "application/json", null, "future"],
  ["missing served tier", "/v1/responses", "priority", { usage: astraUsage }, "application/json", null, null],
  ["incomplete cache counters", "/v1/responses", "priority", { service_tier: "priority", usage: { input_tokens: 14, output_tokens: 8 } }, "application/json", null, "priority"],
  ["incomplete Responses stream", "/v1/responses", "priority", sse({ type: "response.created", response: { service_tier: "priority", usage: astraUsage } }), "text/event-stream", null, null, "provider_error"],
]) {
  test(`Astra ${name} settles both real SQL ledgers and records its price basis`, async (t) => {
    const limit = 1_000_000, events = [], pending = [];
    const env = usageEnv([], { limit, fixedCost, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async (event) => { events.push(event); } };
    const upstreamBody = typeof payload === "string" ? payload : JSON.stringify(payload);
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(JSON.parse(init.body).service_tier, requestedTier);
      return new Response(upstreamBody, { headers: { "content-type": contentType } });
    });
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", messages: [{ role: "user", content: "fixture" }], max_output_tokens: 32, service_tier: requestedTier, stream: contentType === "text/event-stream" }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamBody);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    const [event] = events;
    const charged = expected ?? event.reserved_cost_micros;
    if (fixedCost == null) assert.ok(event.reserved_cost_micros > 1_080);
    else assert.equal(event.reserved_cost_micros, fixedCost);
    assert.equal(event.actual_cost_micros, charged);
    assert.equal(event.status, outcome);
    assert.equal(event.status_code, 200);
    assert.equal(event.requested_service_tier, requestedTier ?? null);
    assert.equal(event.served_service_tier, servedTier);
    assert.equal(event.cost_basis, fixedCost != null ? "policy_fixed" : expected == null ? "manifest_reservation" : "manifest_pricing");
    assert.equal(event.content_retained, false);
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, charged);
    assert.equal((await providerBudgetStatus(env, "openai", limit)).spentMicros, charged);
  });
}

test("HTTP and native streaming outcomes settle each ledger once without rewriting delivery", async (t) => {
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) for (const scenario of ["failed", "failed_without_usage", "error", "eof", "cancel", "cancel_after_terminal", "abort", "abort_after_terminal", "broken_after_terminal"]) {
    const events = [], pending = [], limit = 1_000_000;
    const env = usageEnv([], { limit, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    const measured = scenario === "failed" || scenario.endsWith("after_terminal");
    const terminal = scenario.startsWith("failed") ? { type: "response.failed", response: { status: "failed", service_tier: "priority", ...(measured ? { usage: astraUsage } : {}) } }
      : scenario === "error" ? { type: "error", error: { message: "fixture" } }
      : measured ? { type: "response.completed", response: { service_tier: "priority", usage: astraUsage } } : null;
    const body = sse({ type: "response.created" }, ...(terminal ? [terminal] : []));
    const abort = new AbortController(), callerCanceled = scenario.startsWith("cancel") || scenario.startsWith("abort");
    let pulls = 0, canceled = false;
    const upstream = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(body));
      else if (scenario === "broken_after_terminal") controller.error(new Error("fixture broken stream"));
      else if (!callerCanceled) controller.close();
    }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", signal: abort.signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", stream: true }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), body);
    if (scenario.startsWith("abort")) {
      const read = reader.read(), rejected = assert.rejects(read, /fixture caller abort/);
      abort.abort(new Error("fixture caller abort"));
      await rejected;
      assert.equal(canceled, true);
    } else if (scenario.startsWith("cancel")) { await reader.cancel(); assert.equal(canceled, true); }
    else if (scenario === "broken_after_terminal") await assert.rejects(reader.read(), /fixture broken stream/);
    else assert.equal((await reader.read()).done, true);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    const [event] = events, cost = measured ? 1_080 : event.reserved_cost_micros;
    assert.equal(event.status, callerCanceled ? "client_error" : "provider_error");
    assert.equal(event.status_code, 200);
    assert.equal(event.actual_cost_micros, cost);
    assert.equal(event.cost_basis, measured ? "manifest_pricing" : "manifest_reservation");
    assert.equal((await (await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {})).json()).budget.spentMicros, cost);
    assert.equal((await providerBudgetStatus(env, "openai", limit)).spentMicros, cost);
    upstream.mock.restore();
  }
});

test("dispatched pre-header HTTP and native failures retain estimates through independent ledger recovery", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { modelRoute } = await import("../providers.ts");
  const endpointTimeout = modelRoute("openai/gpt-6-astra").provider.endpoints.find(endpoint => endpoint.id === "responses").timeout_ms;
  const setTimer = globalThis.setTimeout;
  let deadline;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === endpointTimeout) deadline = callback;
    return setTimer(callback, delay, ...args);
  });
  const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) for (const scenario of ["transport", "upstream_abort", "first_event", "timeout", "caller_abort"]) for (const failedOwner of [null, ...owners]) {
    const messages = [], pending = [], abort = new AbortController(), limit = 1_000_000;
    const env = usageEnv([], { limit, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    const ledger = sqlBudgetNamespace(t);
    let unavailable = failedOwner;
    env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => {
      if (name === unavailable && new URL(url).pathname === "/settle") throw new Error("fixture ledger unavailable");
      return ledger.get(name).fetch(url, init);
    } }) };
    env.USAGE_QUEUE = { send: async message => messages.push(message) };
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      for (const owner of owners) assert.equal(ledger.get(owner).reservations()[0].dispatch_started, 1);
      if (scenario === "caller_abort") abort.abort();
      if (scenario === "timeout") { assert.equal(typeof deadline, "function"); deadline(); }
      if (scenario === "transport") throw new Error("fixture connection lost before headers");
      if (scenario === "first_event") return new Response(new ReadableStream({
        pull() { throw new Error("fixture HTTP 200 first-event failure"); },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      throw new DOMException("fixture upstream abort", "AbortError");
    });
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", signal: abort.signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", stream: true }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "provider_unavailable");
    await Promise.all(pending);
    const events = messages.filter(message => message.type === "clawrouter.usage.v1");
    assert.equal(events.length, 1);
    assert.equal(events[0].status, scenario === "caller_abort" ? "client_error" : scenario === "timeout" ? "timeout" : "provider_error");
    const reserved = events[0].reserved_cost_micros;
    assert.ok(reserved > 0);
    assert.equal(events[0].actual_cost_micros, reserved);
    assert.equal(events[0].cost_basis, "manifest_reservation");
    assert.equal(events[0].total_tokens, null);
    for (const owner of owners) assert.equal(ledger.get(owner).reservations()[0].settled, owner === failedOwner ? 0 : 1);
    now += 20 * 60_000;
    assert.equal((await (await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {})).json()).budget.spentMicros, reserved);
    assert.equal((await providerBudgetStatus(env, "openai", limit)).spentMicros, reserved);
    const jobs = messages.filter(message => message.kind === "budget_settlement");
    assert.equal(jobs.length, failedOwner ? 1 : 0);
    if (failedOwner) {
      assert.equal(ledger.get(failedOwner).reservations()[0].settled, 2);
      const delivery = { body: jobs[0], acks: 0, retries: 0, ack() { this.acks++; }, retry() { this.retries++; } };
      await queue({ messages: [delivery] }, env);
      assert.equal(delivery.acks, 0); assert.equal(delivery.retries, 1);
      unavailable = null;
      await queue({ messages: [delivery] }, env);
      await queue({ messages: [delivery] }, env);
      assert.equal(delivery.acks, 2); assert.equal(delivery.retries, 1);
    }
    for (const owner of owners) {
      assert.equal(ledger.get(owner).reservations()[0].settled, 1);
      assert.equal(ledger.get(owner).reservations()[0].reserved_micros, reserved);
    }
    assert.equal(upstream.mock.callCount(), 1);
    upstream.mock.restore();
  }
});

test("cancellation before fetch stays zero after preflight, retention, or dispatch confirmation", async (t) => {
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) for (const phase of ["initial", "retention", "dispatch"]) for (const fixedCost of [null, 0, 7]) {
    const events = [], pending = [], abort = new AbortController();
    const env = usageEnv([], { limit: 1_000_000, fixedCost, retainContent: phase === "retention" });
    env.OPENAI_API_KEY = "fixture-openai-key";
    const ledger = sqlBudgetNamespace(t);
    env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: async (url, init) => {
      const response = await ledger.get(name).fetch(url, init);
      if (phase === "dispatch" && name === "provider:openai" && new URL(url).pathname === "/dispatch") abort.abort();
      return response;
    } }) };
    env.CONTENT_ARCHIVE = { put: async () => { abort.abort(); } };
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      init.signal.throwIfAborted();
      throw new Error("canceled work must never reach upstream");
    });
    if (phase === "initial") abort.abort();
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", signal: abort.signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority" }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "provider_unavailable");
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "client_error");
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, "none");
    assert.equal(upstream.mock.callCount(), 0);
    for (const name of ["tenant:maintainer_access:owner@example.com", "provider:openai"]) {
      const [row] = ledger.get(name).reservations();
      assert.equal(row.reserved_micros, 0); assert.equal(row.settled, 1);
    }
    upstream.mock.restore();
  }
});

test("known nonbillable responses stay readable and zero across tariffs and broken JSON or SSE details", async (t) => {
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) for (const status of [400, 429, 503]) for (const fixedCost of [null, 0, 7]) for (const brokenType of [null, "application/json", "text/event-stream"]) {
    const env = usageEnv([], { limit: 1_000_000, fixedCost, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    const events = [], pending = [];
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async () => brokenType ? new Response(new ReadableStream({
      pull(controller) { controller.error(new Error("fixture broken error details")); },
    }, { highWaterMark: 0 }), { status, headers: { "content-type": brokenType } }) : Response.json({ error: { message: "fixture rejection" }, usage: astraUsage }, { status }));
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", stream: true }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, status);
    if (brokenType) assert.deepEqual(await response.json(), { error: { message: "upstream request failed", type: "upstream_error", code: status } });
    else await response.text();
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].status_code, status);
    assert.equal(events[0].status, status < 500 ? "client_error" : "provider_error");
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, "none");
    assert.equal(upstream.mock.callCount(), 1);
    for (const name of ["tenant:maintainer_access:owner@example.com", "provider:openai"]) {
      const rows = env.BUDGET_LEDGER.get(name).reservations();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].settled, 1); assert.equal(rows[0].dispatch_started, 1); assert.equal(rows[0].reserved_micros, 0);
    }
    upstream.mock.restore();
  }
});

test("settlement bases distinguish nonbillable work from tariffs, fallback charges, and free rates", async () => {
  const { createProxyAccounting } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { extractUsageTokens } = await import("../token-usage.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("anthropic/claude-haiku-4-5");
  const unbilled = extractUsageTokens(earlyRefusal);
  const normal = extractUsageTokens({ usage: messageUsage });
  const freeModel = { ...route.model, pricing: { ...route.model.pricing, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, cacheWriteInputMicrosPerMillion: 0, cacheWrite5mInputMicrosPerMillion: 0, cacheWrite1hInputMicrosPerMillion: 0, longContext: null, serviceTiers: [] } };
  for (const [name, model, fixed, tokens, actual, basis] of [
    ["measured refusal", route.model, null, unbilled, 0, "none"],
    ["zero tariff", route.model, 0, unbilled, 0, "policy_fixed"],
    ["positive tariff", route.model, 7, unbilled, 7, "policy_fixed"],
    ["unpriced fallback", { ...route.model, pricing: null }, null, unbilled, 1, "flat_fallback"],
    ["free manifest rate", freeModel, null, normal, 0, "manifest_pricing"],
  ]) {
    const events = [];
    const owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: {},
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { ...route, model, endpoint: route.provider.endpoints.find(endpoint => endpoint.id === "messages"), body: {}, capability: "llm.messages" },
      request: correlateIngressRequest(new Request("https://router.example/v1/messages")).request,
    });
    const reservation = { reservations: [], reservedMicros: owner.cost.reserveMicros };
    assert.equal(await owner.settle(200, "success", true, tokens, reservation, null), true);
    assert.equal(events.length, 1, name);
    assert.equal(events[0].actual_cost_micros, actual, name);
    assert.equal(events[0].cost_basis, basis, name);
    assert.equal(events[0].reserved_cost_micros, reservation.reservedMicros, name);
    assert.equal(events[0].input_tokens, tokens.input, name);
  }
});

test("either enforced budget rejects unsupported tiers while fixed policy tariffs remain explicit", async (t) => {
  for (const [limit, providerLimit, fixedCost] of [[1_000_000, null, null], [null, 1_000_000, null], [1_000_000, 1_000_000, null], [1_000_000, 1_000_000, 7]]) {
    const events = [], pending = [];
    const env = usageEnv([], { limit, providerLimit, fixedCost, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => { events.push(event); } };
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ service_tier: "future", usage: astraUsage }));
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "future" }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, fixedCost == null ? 400 : 200);
    const body = await response.json();
    if (fixedCost == null) assert.equal(body.error.code, "pricing_required");
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), fixedCost == null ? 0 : 1);
    assert.equal(events[0].actual_cost_micros, fixedCost ?? 0);
    assert.equal(events[0].cost_basis, fixedCost == null ? "none" : "policy_fixed");
    assert.equal((await providerBudgetStatus(env, "openai", 1_000_000)).spentMicros, fixedCost ?? 0);
    upstream.mock.restore();
  }
});

for (const existingUnmetered of [false, true]) {
  test(`${existingUnmetered ? "existing stored" : "fresh"} unmetered policies forward unknown tiers and distinguish unavailable prices`, async (t) => {
    for (const [servedTier, status, expected, basis] of [["future", 200, 0, "unpriced_usage"], [undefined, 200, 0, "unpriced_usage"], ["priority", 200, 1_080, "manifest_pricing"], ["default", 200, 540, "manifest_pricing"], ["future", 400, 0, "none"], ["transport_failure", 502, 0, "unpriced_usage"], ["timeout", 502, 0, "unpriced_usage"], ["retention_failure", 503, 0, "none"]]) {
      const events = [], pending = [], ledgerCalls = [];
      const env = usageEnv(ledgerCalls, { limit: null, providerLimit: null, fixedCost: null, retainContent: servedTier === "retention_failure", existingUnmetered });
      env.OPENAI_API_KEY = "fixture-openai-key";
      env.USAGE_QUEUE = { send: async event => events.push(event) };
      env.CONTENT_ARCHIVE = { put: async () => { throw new Error("synthetic retention failure"); } };
      const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
        assert.equal(JSON.parse(init.body).service_tier, "future");
        if (servedTier === "timeout") throw new DOMException("synthetic timeout", "AbortError");
        if (servedTier === "transport_failure") throw new Error("synthetic transport failure");
        return Response.json({ service_tier: servedTier, usage: astraUsage }, { status });
      });
      const response = await handler.fetch(new Request("https://clawrouter.example/v1/responses", {
        method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "future" }),
      }), env, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, status);
      await response.text(); await Promise.all(pending);
      assert.equal(upstream.mock.callCount(), servedTier === "retention_failure" ? 0 : 1);
      assert.equal(events.length, 1);
      assert.equal(events[0].actual_cost_micros, expected);
      assert.equal(events[0].reserved_cost_micros, 0);
      assert.equal(events[0].cost_basis, basis);
      assert.equal(events[0].requested_service_tier, "future");
      assert.deepEqual(ledgerCalls, []);
      upstream.mock.restore();
    }
  });
}

test("incomplete pricing admission and unavailable settlement share the HTTP, native, JSON and SSE owner", async (t) => {
  for (const [provider, route, model, tool] of [
    ["openai", "/v1/responses", "openai/gpt-6-astra", { tools: [{ type: "web_search" }] }],
    ["openai", "/v1/native/openai/v1/responses", "gpt-6-astra", { tools: [{ type: "web_search_preview_2025_03_11" }] }],
    ...["file_search", "code_interpreter", "image_generation"].map(type => ["openai", "/v1/responses", "openai/gpt-6-astra", { tools: [{ type }] }]),
    ...["mcp", "programmatic_tool_calling", "tool_search"].map(type => ["openai", "/v1/responses", "openai/gpt-6-astra", { tools: [{ type }] }]),
    ["openai", "/v1/native/openai/v1/responses", "gpt-6-astra", { multi_agent: { enabled: true } }],
    ["openai", "/v1/native/openai/v1/responses", "gpt-6-astra", { tools: [{ type: "shell", environment: { type: "container_auto" } }] }],
    ...["/v1/responses", "/v1/native/openai/v1/responses", "/v1/proxy/openai/responses"].flatMap(route => [
      ["openai", route, "openai/gpt-6-astra", { prompt: { id: "pmpt_fixture", version: "1" } }],
      ...["additional_tools", "tool_search_output"].map(type => ["openai", route, "openai/gpt-6-astra", { tools: [], input: [{ type, ...(type === "additional_tools" ? { role: "developer" } : { call_id: "call_fixture", execution: "client" }), tools: [{ type: "file_search" }] }] }]),
    ]),
    ["openai", "/v1/chat/completions", "openai/gpt-6-astra", { web_search_options: {} }],
    ["anthropic", "/v1/native/anthropic/v1/messages", "claude-haiku-4-5", { tools: [{ type: "web_search_20260318", name: "web_search" }] }],
    ["anthropic", "/v1/native/anthropic/v1/messages", "claude-haiku-4-5", { tools: [{ type: "code_execution_20250825", name: "code_execution" }] }],
    ["anthropic", "/v1/proxy/anthropic/messages", "claude-haiku-4-5", { tools: [{ type: "code_execution_20260521", name: "code_execution" }] }],
    ...["advisor_20260301", "web_fetch_20260318", "tool_search_tool_regex_20251119", "tool_search_tool_bm25"].map(type => ["anthropic", "/v1/native/anthropic/v1/messages", "claude-haiku-4-5", { tools: [{ type }] }]),
    ["anthropic", "/v1/proxy/anthropic/messages", "claude-haiku-4-5", { tools: [{ type: "code_execution_20260521", name: "code_execution" }, { type: "web_fetch_20260318", name: "web_fetch" }] }],
    ...[[], [{ type: "mcp_toolset", mcp_server_name: "fixture" }]].map(tools => ["anthropic", "/v1/native/anthropic/v1/messages", "claude-sonnet-4-6", { tools, mcp_servers: [{ type: "url", name: "fixture", url: "https://example.com/mcp" }] }]),
    ["anthropic", "/v1/native/anthropic/v1/messages", "claude-sonnet-4-6", { context_management: { edits: [{ type: "compact_20260112" }] } }],
    ["anthropic", "/v1/proxy/anthropic/messages", "claude-sonnet-4-6", { compaction: { type: "summarize" } }],
  ]) for (const stream of [false, true]) for (const [limit, providerLimit, fixedCost, servedTier] of [
    [1_000_000, null, null, "priority"], [null, 1_000_000, null, "priority"],
    [null, null, null, "priority"], [null, null, null, "future"], [1_000_000, 1_000_000, 7, "priority"], [1_000_000, 1_000_000, 0, "priority"],
  ]) {
    const events = [], pending = [];
    const env = usageEnv([], { provider, limit, providerLimit, fixedCost, retainContent: false });
    Object.assign(env, { OPENAI_API_KEY: "fixture-openai-key", ANTHROPIC_API_KEY: "fixture-anthropic-key" });
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const denied = fixedCost == null && (limit != null || providerLimit != null);
    const usage = tool.compaction ? { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }] } : messageUsage;
    const stop_reason = tool.compaction ? "compaction" : "end_turn";
    const result = provider === "anthropic" ? { type: "message", stop_reason, usage } : { status: "completed", service_tier: servedTier, usage: astraUsage };
    const wire = !stream ? JSON.stringify(result) : provider === "anthropic" ? sse({ type: "message_start", message: result }, { type: "message_delta", delta: { stop_reason }, usage }, messageStop) : route.endsWith("chat/completions") ? sse({ object: "chat.completion.chunk", ...result }, "[DONE]") : sse({ type: "response.completed", response: result });
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      const sent = JSON.parse(init.body);
      for (const [key, value] of Object.entries(tool)) assert.deepEqual(sent[key], value);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const requestBody = { model, input: "fixture", messages: [{ role: "user", content: "fixture" }], max_tokens: 32, stream, service_tier: "priority", ...tool };
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(route.startsWith("/v1/proxy/") ? { body: requestBody } : requestBody),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, denied ? 400 : 200);
    if (denied) { const body = await response.json(); assert.equal(body.error.code, "pricing_required"); assert.match(body.error.message, /fixed policy request price/); }
    else assert.equal(await response.text(), wire);
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), denied ? 0 : 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, denied ? "none" : fixedCost != null ? "policy_fixed" : "unpriced_usage");
    assert.equal(events[0].actual_cost_micros, denied ? 0 : fixedCost ?? 0);
    if (!denied) assert.ok(tool.compaction ? events[0].input_tokens === 0 : events[0].input_tokens > 0, "top-level token usage must not imply a complete request price");
    assert.equal((await providerBudgetStatus(env, provider, 1_000_000)).spentMicros, denied ? 0 : fixedCost ?? 0);
    const report = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await report.json()).budget.spentMicros, limit == null ? null : denied ? 0 : fixedCost ?? 0);
    upstream.mock.restore();
  }
});

test("Anthropic client-owned tools settle both ledgers from token usage", async (t) => {
  for (const stream of [false, true]) {
    const events = [], pending = [], limit = 1_000_000;
    const env = usageEnv([], { provider: "anthropic", limit, fixedCost: null, retainContent: false });
    env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const tools = [{ type: "bash_20250124", name: "bash" }, { name: "advisor_20260301", input_schema: { type: "object" } }];
    const wire = stream ? sse(messageStart, messageDelta, messageStop) : JSON.stringify({ type: "message", usage: messageUsage });
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).tools, tools);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/native/anthropic/v1/messages", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", tools, max_tokens: 20, stream, messages: [{ role: "user", content: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral", ttl: "1h" } }] }] }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, "manifest_pricing");
    assert.equal(events[0].actual_cost_micros, 4_710);
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, 4_710);
    assert.equal((await providerBudgetStatus(env, "anthropic", limit)).spentMicros, 4_710);
    upstream.mock.restore();
  }
});

test("incomplete pricing preserves fixed tariffs, free counting, and known nonbillable outcomes", async () => {
  const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("openai/gpt-6-astra"), body = { tools: [{ type: "web_search" }] };
  assert.equal(estimateCost(route.model, body, 7, "llm.responses", "openai.responses").basis, "policy_fixed");
  assert.equal(estimateCost(route.model, body, 0, "llm.responses", "openai.responses").basis, "policy_fixed");
  assert.equal(estimateCost(route.model, body, null, "llm.count_tokens", "openai.responses").basis, "none");
  for (const [format, request] of [["openai.responses", { multi_agent: { enabled: true } }], ["anthropic.messages", { compaction: { type: "summarize" } }], ["anthropic.messages", { context_management: { edits: [{ type: "compact_20260112" }] } }], ["google.generate_content", { tools: [{ mcpServers: [{}] }] }]]) {
    assert.equal(estimateCost(route.model, request, 0, "llm.chat", format).basis, "policy_fixed");
    assert.equal(estimateCost(route.model, request, 7, "llm.count_tokens", format).basis, "none");
  }
  assert.equal(estimateCost(route.model, { tools: [{ type: "tool_search", execution: "client" }] }, null, "llm.responses", "openai.responses").basis, "manifest_pricing");
  for (const [billable, tokens, dispatched, expected] of [[true, { billable: false }, null, "none"], [false, null, null, "none"], [true, null, null, "unpriced_usage"], [null, null, false, "none"], [null, null, true, "unpriced_usage"]]) {
    const events = [], pending = [];
    const owner = createProxyAccounting({ env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) }, auth: { policyId: "fixture", policy: {} }, selection: { ...route, endpoint: route.provider.endpoints.find(endpoint => endpoint.id === "responses"), body, capability: "llm.responses" }, request: correlateIngressRequest(new Request("https://router.example/v1/responses")).request });
    if (dispatched == null) await owner.settle(200, "provider_error", billable, tokens, { reservations: [], reservedMicros: 0 }, null);
    else owner.fail(502, "provider_error", undefined, null, dispatched);
    await Promise.all(pending);
    assert.equal(events.length, 1); assert.equal(events[0].cost_basis, expected); assert.equal(events[0].actual_cost_micros, 0);
  }
});

test("Sonar mandatory fees and Gemini hosted work never settle at token-only prices", async (t) => {
  for (const [provider, model, gapBody, counts] of [
    ...["googleSearch", "google_search", "googleSearchRetrieval", "googleMaps", "urlContext", "url_context", "fileSearch", "codeExecution"].map(key => ["google-gemini", "gemini-3.5-flash", { tools: [{ [key]: {} }] }, [27, 76, 10_412]]),
    ...["mcpServers", "mcp_servers"].map(key => ["google-gemini", "gemini-3.5-flash", { tools: [{ [key]: [{ name: "fixture", streamableHttpTransport: { url: "https://example.com/mcp" } }] }] }, [27, 76, 10_412]]),
    ["google-gemini", "gemini-3.5-flash", { cached_content: "cachedContents/fixture" }, [27, 76, 10_412]],
    ["perplexity", "sonar-pro", {}, [26, 832, 858]],
  ]) for (const manifest of [false, true]) for (const stream of [false, true]) for (const [limit, providerLimit, fixedCost] of [
    [100_000, null, null], [null, 100_000, null], [100_000, 100_000, null],
    [null, null, null], [100_000, 100_000, 7], [100_000, 100_000, 0],
  ]) {
    const events = [], pending = [], google = provider === "google-gemini";
    const env = usageEnv([], { provider, limit, providerLimit, fixedCost, retainContent: false });
    Object.assign(env, { GOOGLE_API_KEY: "fixture-google-key", PERPLEXITY_API_KEY: "fixture-perplexity-key" });
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const denied = fixedCost == null && (limit != null || providerLimit != null);
    const result = google ? { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 27, toolUsePromptTokenCount: 10_309, candidatesTokenCount: 45, thoughtsTokenCount: 31, totalTokenCount: 10_412 } }
      : { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 26, completion_tokens: 832, total_tokens: 858, cost: { total_cost: 0.019 } } };
    const wire = stream ? google ? sse(result) : sse(result, "[DONE]") : JSON.stringify(result);
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      for (const [key, value] of Object.entries(gapBody)) assert.deepEqual(JSON.parse(init.body)[key], value);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const endpoint = google ? stream ? "stream_generate_content" : "generate_content" : "chat_completions";
    const route = manifest ? `/v1/proxy/${provider}/${endpoint}` : google ? `/v1/native/google-gemini/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}` : "/v1/chat/completions";
    const body = google ? { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 100 }, ...gapBody }
      : { model: manifest ? model : `${provider}/${model}`, messages: [{ role: "user", content: "fixture" }], max_tokens: 1_000, stream };
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model }, query: google && stream ? { alt: "sse" } : {} } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, denied ? 400 : 200, `${provider}/${endpoint}`);
    if (denied) assert.equal((await response.json()).error.code, "pricing_required");
    else assert.equal(await response.text(), wire);
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), denied ? 0 : 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, denied ? "none" : fixedCost == null ? "unpriced_usage" : "policy_fixed");
    assert.equal(events[0].actual_cost_micros, denied ? 0 : fixedCost ?? 0);
    if (!denied) assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], counts);
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, limit == null ? null : denied ? 0 : fixedCost ?? 0);
    assert.equal((await providerBudgetStatus(env, provider, 100_000)).spentMicros, denied ? 0 : fixedCost ?? 0);
    upstream.mock.restore();
  }
});

for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`Gemini ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} reserves native bounds and settles both budgets`, async (t) => {
    const limit = 20_000, events = [], pending = [];
    const env = usageEnv([], { provider: "google-gemini", limit, fixedCost: null, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 1_100 } };
    const usageMetadata = { promptTokenCount: 1_000, cachedContentTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 1_000, totalTokenCount: 2_100 };
    const final = { candidates: [{ finishReason: "STOP" }], usageMetadata };
    const wire = stream ? sse({ usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 5, totalTokenCount: 1_005 } }, final) : JSON.stringify(final);
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(new URL(url).searchParams.get("alt"), stream ? "sse" : null);
      assert.deepEqual(JSON.parse(init.body), body);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const route = manifest ? `/v1/proxy/google-gemini/${stream ? "stream_generate_content" : "generate_content"}`
      : `/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const request = new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" }, query: stream ? { alt: "sse" } : {} } : body),
    });
    const context = { waitUntil: promise => pending.push(promise) };
    const response = await handler.fetch(request.clone(), env, context);
    assert.equal(response.status, 200, "the native ceiling fits the budget, unlike the model-wide default");
    assert.equal(await response.text(), wire);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.reserved_input_tokens, new TextEncoder().encode(JSON.stringify(body)).byteLength + 1_024);
    assert.equal(event.reserved_output_tokens, 1_100);
    assert.equal(event.actual_cost_micros, 10_185);
    assert.equal(event.cost_basis, "manifest_pricing");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [1_000, 1_100, 2_100, 900]);
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, 10_185);
    assert.equal((await providerBudgetStatus(env, "google-gemini", limit)).spentMicros, 10_185);
    const denied = await handler.fetch(request, env, context);
    assert.equal(denied.status, 402);
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 1);
  });
}

test("Gemini final malformed SSE usage retains reservation instead of settling a partial count", async (t) => {
  const limit = 20_000, events = [], pending = [];
  const env = usageEnv([], { provider: "google-gemini", limit, fixedCost: null, retainContent: false });
  env.GOOGLE_API_KEY = "fixture-google-key";
  env.BUDGET_LEDGER = sqlBudgetNamespace(t);
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const wire = sse({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } }, { usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: "invalid" } });
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
  const response = await handler.fetch(new Request("https://clawrouter.example/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 16 } }),
  }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
  await Promise.all(pending);
  assert.equal(events.length, 1);
  assert.equal(events[0].input_tokens, null);
  assert.equal(events[0].cost_basis, "manifest_reservation");
  assert.equal(events[0].actual_cost_micros, events[0].reserved_cost_micros);
  const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
  assert.equal((await usage.json()).budget.spentMicros, events[0].reserved_cost_micros);
  assert.equal((await providerBudgetStatus(env, "google-gemini", limit)).spentMicros, events[0].reserved_cost_micros);
});

test("either budget rejects Gemini remote input before dispatch", async (t) => {
  for (const manifest of [false, true]) for (const [limit, providerLimit] of [[20_000, null], [null, 20_000]]) for (const remote of [
    { contents: [{ parts: [{ fileData: { mimeType: "application/pdf", fileUri: "https://example.com/file.pdf" } }] }] },
  ]) {
    const pending = [], env = usageEnv([], { provider: "google-gemini", limit, providerLimit, fixedCost: null, retainContent: false });
    env.GOOGLE_API_KEY = "fixture-google-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async () => {} };
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}));
    const body = { contents: [{ parts: [{ text: "fixture" }] }], generationConfig: { maxOutputTokens: 16 }, ...remote };
    const route = manifest ? "/v1/proxy/google-gemini/generate_content" : "/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:generateContent";
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify(manifest ? { body, pathParams: { model: "gemini-3.5-flash" } } : body),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 402);
    assert.equal((await response.json()).error.code, limit == null ? "provider_budget_exhausted" : "budget_exhausted");
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 0);
    upstream.mock.restore();
  }
});
