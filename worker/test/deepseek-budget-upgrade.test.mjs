import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";

const { markBudgetDispatched, reserveBudget, settleBudget } = await import("../accounting.ts");
const { resolveConnection } = await import("../authority.ts");
const { budgetStatus, providerBudgetStatus } = await import("../ledgers.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { modelRoute } = await import("../providers.ts");
const { default: handler } = await import("../index.ts");

// Frozen providers/deepseek.provider.yaml at a28a8df335642ec609e85397dfb73c452980ee42.
// This compares the historical card/endpoint estimate, not an old binary or invoice.
const historicalPricing = {
  inputMicrosPerMillion: 140_000, outputMicrosPerMillion: 280_000, cachedInputMicrosPerMillion: 2_800,
  cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null,
  maxInputTokens: 1_000_000, maxRequestInputTokens: null, defaultMaxOutputTokens: 384_000,
  inputTokenOverhead: 1_024, longContext: null,
};
const historicalEndpoint = { request_format: "openai.chat_completions" };

for (const [limit, providerLimit] of [[200_000, 1_000_000], [1_000_000, 200_000]]) {
  test(`DeepSeek upgrade preserves existing debt when the ${limit < providerLimit ? "policy" : "provider"} budget rejects and recovers`, async (t) => {
    const env = usageEnv([], { provider: "deepseek", limit, providerLimit, fixedCost: null, retainContent: false });
    env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
    env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    const events = [], pending = [], headers = new Headers({ authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" });
    env.USAGE_QUEUE = { send: async event => events.push(event) };
    const auth = await authenticateProxyKey(headers, env), connection = await resolveConnection(env, "deepseek");
    assert.equal(auth instanceof Response, false);
    assert.equal(auth.policy.generation, "policy_v1");
    assert.equal(auth.policy.monthlyBudgetMicros, limit);
    assert.equal(connection.monthlyBudgetMicros, providerLimit);
    const authority = structuredClone({ auth, connection });
    const seed = amount => reserveBudget(env, auth, "llm.chat", { reserveMicros: amount, basis: "manifest_pricing", inputTokens: null, outputTokens: null }, connection);
    const settled = await seed(80_000);
    await markBudgetDispatched(env, settled);
    await settleBudget(env, settled, 80_000);
    const held = await seed(11_000);
    await markBudgetDispatched(env, held);
    assert.equal(held.reservations.length, 2);
    const stores = held.reservations.map(({ objectName }) => env.BUDGET_LEDGER.get(objectName));
    const originalRows = stores.map(store => store.reservations());
    assert.ok(originalRows.every(rows => rows.length === 2 && rows.some(row => row.settled === 0 && row.dispatch_started === 1)));
    // Reconstruct each DO over its original SQLite DB before new admission.
    for (const store of stores) store.restart();
    const totals = async () => (await Promise.all([
      budgetStatus(env, auth.policyId, auth.policy, auth.principalId),
      providerBudgetStatus(env, "deepseek", providerLimit),
    ])).map(status => status.spentMicros);
    assert.deepEqual(await totals(), [91_000, 91_000]);
    const unchangedRows = () => stores.forEach((store, index) => {
      const rows = store.reservations(), before = originalRows[index];
      assert.deepEqual(rows.filter(row => before.some(old => old.reservation_id === row.reservation_id)), before);
      assert.ok(rows.filter(row => !before.some(old => old.reservation_id === row.reservation_id)).every(row => row.reserved_micros === 0 && row.settled === 1 && row.dispatch_started === 0), "provider denial only adds final-zero policy rollback receipts");
    });
    unchangedRows();

    const body = { model: "deepseek-v4-flash", messages: [] };
    const selected = modelRoute("deepseek/deepseek-v4-flash", "llm.chat");
    const endpoint = selected.provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
    const oldDefault = estimateCost({ pricing: historicalPricing }, body, null, "llm.chat", historicalEndpoint);
    const newDefault = estimateCost(selected.model, body, null, "llm.chat", endpoint);
    assert.equal(oldDefault.outputTokens, 384_000);
    assert.equal(newDefault.outputTokens, 393_216);
    assert.ok(oldDefault.reserveMicros <= 109_000 && newDefault.reserveMicros > 109_000, "unchanged near-limit balance admits the historical default but rejects the corrected bound");

    const recoveryBody = { ...body, max_tokens: 32 };
    const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(new URL(url).pathname, "/chat/completions");
      assert.deepEqual(JSON.parse(init.body), recoveryBody);
      return Response.json({ usage: { prompt_tokens: 1_000, completion_tokens: 20, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } });
    });
    const request = value => handler.fetch(new Request("https://clawrouter.example/v1/native/deepseek/chat/completions", {
      method: "POST", headers, body: JSON.stringify(value),
    }), env, { waitUntil: promise => pending.push(promise) });
    for (const output of [{ max_tokens: 0 }, { max_output_tokens: 1 }, {}]) {
      const rejectedBody = { ...body, ...output };
      const cost = estimateCost(selected.model, rejectedBody, null, "llm.chat", endpoint);
      assert.ok(cost.reserveMicros <= Math.max(limit, providerLimit) - 91_000, "the nonlimiting sibling must admit the bound so each denial reaches its intended owner");
      const response = await request(rejectedBody);
      assert.equal(response.status, 402);
      assert.equal((await response.json()).error.code, limit < providerLimit ? "budget_exhausted" : "provider_budget_exhausted");
      await Promise.all(pending);
      assert.equal(upstream.mock.callCount(), 0);
      assert.equal(events.at(-1).actual_cost_micros, 0);
      assert.deepEqual(await totals(), [91_000, 91_000]);
      unchangedRows();
    }

    const response = await request(recoveryBody);
    assert.equal(response.status, 200);
    await response.text();
    await Promise.all(pending);
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(events.at(-1).actual_cost_micros, 89);
    assert.equal(events.at(-1).cost_basis, "manifest_rate_upper_bound");
    assert.deepEqual([events.at(-1).input_tokens, events.at(-1).output_tokens, events.at(-1).cached_input_tokens], [1_000, 20, 800]);
    assert.equal(events.at(-1).reserved_output_tokens, 32);
    assert.deepEqual(await totals(), [91_089, 91_089]);
    for (const [index, store] of stores.entries()) {
      assert.deepEqual(store.reservations().filter(row => originalRows[index].some(old => old.reservation_id === row.reservation_id)), originalRows[index]);
    }
    await settleBudget(env, held, 7_000);
    assert.deepEqual(await totals(), [87_089, 87_089], "the original outstanding receipt still owns its later settlement");
    for (const [index, store] of stores.entries()) {
      const original = originalRows[index], heldId = held.reservations[index].reservationId;
      assert.deepEqual(store.reservations().filter(row => original.some(old => old.reservation_id === row.reservation_id)), original.map(row => row.reservation_id === heldId ? Object.assign(Object.create(Object.getPrototypeOf(row)), row, { reserved_micros: 7_000, settled: 1 }) : row));
    }
    assert.deepEqual({ auth: await authenticateProxyKey(headers, env), connection: await resolveConnection(env, "deepseek") }, authority);
  });
}
