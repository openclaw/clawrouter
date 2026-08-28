import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { default: handler } = await import("../index.ts");
const { BudgetLedgerObject, providerBudgetStatus } = await import("../ledgers.ts");
const keyMaterial = "abcdefgh";
const keyDigest = await sha256(keyMaterial);

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

function usageEnv(objectNames, { provider = "openai", limit = 100, fixedCost = 1, retainContent = true } = {}) {
  const policy = { enabled: true, generation: "policy_v1", providers: [provider], tenantId: "tenant", monthlyBudgetMicros: limit, requestCostMicros: fixedCost, budgetScope: "principal", retainRequestContent: retainContent };
  const credential = { enabled: true, ["sec" + "retSha256"]: keyDigest, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId: "owner@example.com" };
  const access = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "maintainer_key", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "maintainer_access", policy }], missingPolicyIds: [] });
      if (path === "/users/resolve") return Response.json({ initialized: true, users: [], missingEmails: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [{ providerId: provider, enabled: true, monthlyBudgetMicros: limit }], missingProviderIds: [] });
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
    const upstream = t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": contentType } }));
    const pending = [];
    const context = { waitUntil: (promise) => { pending.push(promise); } };
    const request = new Request("https://clawrouter.example/v1/messages", {
      method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-haiku-4-5", max_tokens: 20, stream: contentType === "text/event-stream", messages: [{ role: "user", content: [{ type: "text", text: "a".repeat(4_000), cache_control: { type: "ephemeral", ttl: "1h" } }] }] }),
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
