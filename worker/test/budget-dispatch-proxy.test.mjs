import { perRequestAuthority } from "./typescript-setup.mjs"; perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerBudgetStatus } = await import("../ledgers.ts");

test("failed dispatch confirmation never reaches upstream and releases both real budgets", async (t) => {
  for (const failedOwner of ["tenant:maintainer_access:owner@example.com", "provider:openai"]) {
    const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    const ledger = sqlBudgetNamespace(t), events = [], pending = [];
    env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => {
      if (name === failedOwner) {
        if (new URL(url).pathname === "/dispatch") return Response.json({ dispatched: false });
        if (new URL(url).pathname === "/reserve") {
          const body = JSON.parse(init.body); delete body.dispatched;
          return ledger.get(name).fetch(url, { ...init, body: JSON.stringify(body) });
        }
      }
      return ledger.get(name).fetch(url, init);
    } }) };
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

test("cancellation before fetch stays zero after preflight or dispatch confirmation", async (t) => {
  for (const route of ["/v1/responses", "/v1/native/openai/v1/responses"]) for (const phase of ["initial", "reserve", "dispatch"]) for (const fixedCost of [null, 0, 7]) {
    const events = [], pending = [], abort = new AbortController();
    const env = usageEnv([], { limit: 1_000_000, fixedCost, retainContent: false });
    env.OPENAI_API_KEY = "fixture-openai-key";
    const ledger = sqlBudgetNamespace(t);
    env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: async (url, init) => {
      if (phase === "dispatch" && new URL(url).pathname === "/reserve") {
        const body = JSON.parse(init.body); delete body.dispatched;
        init = { ...init, body: JSON.stringify(body) };
      }
      const response = await ledger.get(name).fetch(url, init);
      if (name === "provider:openai" && new URL(url).pathname === "/" + phase) abort.abort();
      return response;
    } }) };
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
