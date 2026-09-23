import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";


const { default: handler } = await import("../index.ts");
const { BudgetLedgerObject, providerBudgetStatus } = await import("../ledgers.ts");
const keyMaterial = "abcdefgh";
const keyDigest = await sha256(keyMaterial);

for (const failure of ["retention", "provider"]) {
  test(`${failure} failure releases both budgets and preserves request attribution in one audit event`, async (t) => {
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
    assert.equal(events[0].actual_cost_micros, 0);
    const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
    assert.equal((await usage.json()).budget.spentMicros, 0);
    assert.equal((await providerBudgetStatus(env, "local-openai", 100)).spentMicros, 0);
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

for (const [name, route, requestedTier, payload, contentType, expected, servedTier, outcome = "success"] of [
  ["JSON priority", "/v1/responses", "priority", { service_tier: "priority", usage: astraUsage }, "application/json", 1_080, "priority"],
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
    const env = usageEnv([], { limit, fixedCost: null, retainContent: false });
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
    assert.ok(event.reserved_cost_micros > 1_080);
    assert.equal(event.actual_cost_micros, charged);
    assert.equal(event.status, outcome);
    assert.equal(event.status_code, 200);
    assert.equal(event.requested_service_tier, requestedTier ?? null);
    assert.equal(event.served_service_tier, servedTier);
    assert.equal(event.cost_basis, expected == null ? "manifest_reservation" : "manifest_pricing");
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

test("pre-header caller abort stays distinct from upstream timeout and preserves zero settlement", async (t) => {
  for (const callerAbort of [false, true]) {
    const events = [], pending = [], abort = new AbortController(), limit = 1_000_000;
    const env = usageEnv([], { limit, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      if (callerAbort) abort.abort();
      throw new DOMException("fixture upstream abort", "AbortError");
    });
    const response = await handler.fetch(new Request("https://clawrouter.example/v1/responses", {
      method: "POST", signal: abort.signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-6-astra", input: "fixture", max_output_tokens: 32, service_tier: "priority", stream: true }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 502);
    await Promise.all(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, callerAbort ? "client_error" : "timeout");
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal((await (await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {})).json()).budget.spentMicros, 0);
    assert.equal((await providerBudgetStatus(env, "openai", limit)).spentMicros, 0);
    upstream.mock.restore();
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

function sqlBudgetNamespace(t) {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        const db = new DatabaseSync(":memory:");
        t.after(() => db.close());
        const sql = { exec(query, ...bindings) {
          const statement = db.prepare(query);
          if (statement.columns().length) return statement.all(...bindings);
          statement.run(...bindings);
          return [];
        } };
        const ledger = new BudgetLedgerObject({ storage: { sql, getAlarm: async () => 1 } });
        objects.set(name, { fetch: (url, init) => ledger.fetch(new Request(url, init)) });
      }
      return objects.get(name);
    },
  };
}

test("hosted search admission and unavailable settlement share the HTTP, native, JSON and SSE owner", async (t) => {
  for (const [provider, route, model, tool] of [
    ["openai", "/v1/responses", "openai/gpt-6-astra", { tools: [{ type: "web_search" }] }],
    ["openai", "/v1/native/openai/v1/responses", "gpt-6-astra", { tools: [{ type: "web_search_preview_2025_03_11" }] }],
    ["openai", "/v1/chat/completions", "openai/gpt-6-astra", { web_search_options: {} }],
    ["anthropic", "/v1/native/anthropic/v1/messages", "claude-haiku-4-5", { tools: [{ type: "web_search_20260318", name: "web_search" }] }],
  ]) for (const stream of [false, true]) for (const [limit, providerLimit, fixedCost, servedTier] of [
    [1_000_000, null, null, "priority"], [null, 1_000_000, null, "priority"],
    [null, null, null, "priority"], [null, null, null, "future"], [1_000_000, 1_000_000, 7, "priority"],
  ]) {
    const events = [], pending = [];
    const env = usageEnv([], { provider, limit, providerLimit, fixedCost, retainContent: false });
    Object.assign(env, { OPENAI_API_KEY: "fixture-openai-key", ANTHROPIC_API_KEY: "fixture-anthropic-key" });
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const denied = fixedCost == null && (limit != null || providerLimit != null);
    const result = provider === "anthropic" ? { type: "message", stop_reason: "end_turn", usage: messageUsage } : { status: "completed", service_tier: servedTier, usage: astraUsage };
    const wire = !stream ? JSON.stringify(result) : provider === "anthropic" ? sse(messageStart, messageDelta, messageStop) : route.endsWith("chat/completions") ? sse({ object: "chat.completion.chunk", ...result }, "[DONE]") : sse({ type: "response.completed", response: result });
    const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
      const sent = JSON.parse(init.body);
      for (const [key, value] of Object.entries(tool)) assert.deepEqual(sent[key], value);
      return new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
    });
    const response = await handler.fetch(new Request(`https://clawrouter.example${route}`, {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "fixture", messages: [{ role: "user", content: "fixture" }], max_tokens: 32, stream, service_tier: "priority", ...tool }),
    }), env, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, denied ? 400 : 200);
    if (denied) { const body = await response.json(); assert.equal(body.error.code, "pricing_required"); assert.match(body.error.message, /disable hosted search/); }
    else assert.equal(await response.text(), wire);
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), denied ? 0 : 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, denied ? "none" : fixedCost != null ? "policy_fixed" : "unpriced_usage");
    assert.equal(events[0].actual_cost_micros, denied ? 0 : fixedCost ?? 0);
    if (!denied) assert.ok(events[0].input_tokens > 0, "complete token usage must not imply a complete hosted-search price");
    assert.equal((await providerBudgetStatus(env, provider, 1_000_000)).spentMicros, denied ? 0 : fixedCost ?? 0);
    upstream.mock.restore();
  }
});

test("hosted search preserves fixed tariffs, free counting, and known nonbillable outcomes", async () => {
  const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("openai/gpt-6-astra"), body = { tools: [{ type: "web_search" }] };
  assert.equal(estimateCost(route.model, body, 7, "llm.responses").basis, "policy_fixed");
  assert.equal(estimateCost(route.model, body, null, "llm.count_tokens").basis, "none");
  for (const [billable, tokens, dispatched, expected] of [[true, { billable: false }, null, "none"], [false, null, null, "none"], [true, null, null, "unpriced_usage"], [null, null, false, "none"], [null, null, true, "unpriced_usage"]]) {
    const events = [], pending = [];
    const owner = createProxyAccounting({ env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) }, auth: { policyId: "fixture", policy: {} }, selection: { ...route, body, capability: "llm.responses" }, request: correlateIngressRequest(new Request("https://router.example/v1/responses")).request });
    if (dispatched == null) await owner.settle(200, "provider_error", billable, tokens, { reservations: [], reservedMicros: 0 }, null);
    else owner.fail(502, "provider_error", undefined, null, dispatched);
    await Promise.all(pending);
    assert.equal(events.length, 1); assert.equal(events[0].cost_basis, expected); assert.equal(events[0].actual_cost_micros, 0);
  }
});
