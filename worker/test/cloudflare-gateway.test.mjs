import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildProviderSmokePlan } from "../../scripts/provider-smoke-plan.mjs";

const { default: worker } = await import("../index.ts");
const { snapshot } = await import("../providers.ts");
const { BudgetLedgerObject } = await import("../ledgers.ts");
const { sha256Hex } = await import("../utils.ts");
const providerId = "cloudflare-ai-gateway";
const manifestPath = `/v1/proxy/${providerId}/universal`;
const nativePath = `/v1/native/${providerId}/`;
const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

test("generated gateway smoke reaches the Worker upstream unchanged and settles once", async (t) => {
  const fixture = await gatewayFixture(t);
  const { target } = buildProviderSmokePlan(snapshot, {
    ...fixture.env,
    CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY: "synthetic-inline-key",
  }).providers.find(({ id }) => id === providerId);
  const wire = JSON.stringify({ choices: [{ message: { content: "ok" } }], usage });
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("cf-aig-authorization"), "Bearer synthetic-gateway-token");
    assert.equal(init.headers.has("authorization"), false);
    assert.equal(init.body, JSON.stringify(target.envelope.body));
    assert.equal(JSON.parse(init.body)[0].headers.Authorization, "Bearer synthetic-inline-key");
    return new Response(wire, { headers: { "content-type": "application/json" } });
  });
  const response = await fixture.call(target.route, target.envelope);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawrouter-upstream-provider"), providerId);
  assert.equal(response.headers.get("x-clawrouter-content-retention"), "on; retention-days=30");
  assert.equal(await response.text(), wire);
  await fixture.drain();
  assert.equal(upstream.mock.callCount(), 1);
  assert.deepEqual(fixture.budgetCalls.map(({ path }) => path), ["/reserve", "/dispatch", "/settle"]);
  assert.equal(fixture.budgetCalls[0].body.costMicros, 25);
  assert.equal(fixture.budgetCalls[2].body.actualCostMicros, 25);
  assert.equal(fixture.budgetCalls[2].body.reservationId, fixture.budgetCalls[0].body.reservationId);
  assert.equal(fixture.events.length, 1);
  const [event] = fixture.events;
  assert.equal(event.provider, providerId);
  assert.equal(event.model, null);
  assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.actual_cost_micros, 25);
  assert.equal(event.reserved_cost_micros, 25);
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [3, 2, 5]);
  assert.equal(event.content_retained, true);
  assert.equal(fixture.archives.length, 1);
  const record = JSON.parse(fixture.archives[0]);
  assert.equal(record.contentRef, event.content_ref);
  assert.equal(record.expiresAtMs - record.occurredAtMs, 30 * 86_400_000);
  assert.deepEqual(record.body, target.envelope.body.map(({ headers, ...entry }) => entry));
  assert.equal(fixture.archives[0].includes("synthetic-inline-key"), false);
});

test("native gateway fallbacks preserve array order and omit only documented transport fields from retention", async (t) => {
  const fixture = await gatewayFixture(t);
  const body = [
    { provider: "openai", endpoint: "chat/completions", authorization: "Bearer synthetic-legacy-key", headers: { "X-Api-Key": "synthetic-header-key" }, query: { model: "upstream/first", messages: [{ role: "user", content: "fixture" }] }, config: { maxAttempts: 2 } },
    { provider: "workers-ai", endpoint: "@cf/fixture/model", headers: { Authorization: "Bearer synthetic-fallback-key" }, query: { prompt: "fixture fallback" } },
  ];
  const before = JSON.stringify(body);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.body, before);
    return Response.json({ usage }, { headers: { "cf-aig-step": "1" } });
  });
  const response = await fixture.call(nativePath, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cf-aig-step"), "1");
  await response.text(); await fixture.drain();
  assert.equal(JSON.stringify(body), before);
  assert.deepEqual(JSON.parse(fixture.archives[0]).body, [
    { provider: body[0].provider, endpoint: body[0].endpoint, query: body[0].query, config: body[0].config },
    { provider: body[1].provider, endpoint: body[1].endpoint, query: body[1].query },
  ]);
  assert.doesNotMatch(fixture.archives[0], /synthetic-(?:legacy|header|fallback)-key/);
});

test("array streaming keeps SSE bytes, terminal usage and effective retention opt-out", async (t) => {
  const fixture = await gatewayFixture(t);
  fixture.policy.retainRequestContent = false;
  const body = [{ provider: "openai", endpoint: "chat/completions", query: { model: "fixture", stream: true } }];
  const wire = `data: ${JSON.stringify({ object: "chat.completion.chunk", usage })}\n\ndata: [DONE]\n\n`;
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
  const response = await fixture.call(nativePath, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clawrouter-content-retention"), "off");
  assert.equal(await response.text(), wire);
  await fixture.drain();
  assert.equal(fixture.archives.length, 0);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].total_tokens, 5);
  assert.equal(fixture.events[0].status, "success");
  assert.equal(fixture.events[0].content_retained, false);
  assert.equal(fixture.events[0].actual_cost_micros, 25);
});

test("nested stream requests preserve pre-stream error mapping and zero settlement", async (t) => {
  const fixture = await gatewayFixture(t);
  const body = [{ provider: "openai", endpoint: "chat/completions", query: { stream: true } }];
  t.mock.method(globalThis, "fetch", async () => new Response('data: {"error":{"message":"fixture exhausted","code":429}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const response = await fixture.call(nativePath, body);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.message, "fixture exhausted");
  await fixture.drain();
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].actual_cost_micros, 0);
  assert.equal(fixture.budgetCalls.at(-1).body.actualCostMicros, 0);
});

test("gateway array admission keeps authentication, provider policy and connection authority", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not dispatch"); });
  for (const [change, status, code] of [
    [(f) => { f.credential.enabled = false; }, 403, "proxy_key_revoked"],
    [(f) => { f.policy.providers = ["openai"]; }, 403, "provider_not_allowed"],
    [(f) => { f.connection.enabled = false; }, 503, "provider_disabled"],
  ]) {
    const fixture = await gatewayFixture(t); change(fixture);
    const response = await fixture.call(manifestPath, { body: [{ provider: "openai", query: {} }] });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    await fixture.drain();
    assert.equal(fixture.budgetCalls.length, 0);
    assert.equal(fixture.archives.length, 0);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("gateway arrays cannot bypass a policy or provider budget without a fixed price", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not dispatch"); });
  for (const [policyLimit, providerLimit] of [[1000, null], [null, 1000]]) {
    const fixture = await gatewayFixture(t);
    fixture.policy.requestCostMicros = null;
    fixture.policy.monthlyBudgetMicros = policyLimit;
    fixture.connection.monthlyBudgetMicros = providerLimit;
    const response = await fixture.call(nativePath, [{ provider: "openai", query: { model: "gpt-6-astra" } }]);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "pricing_required");
    await fixture.drain();
    assert.equal(fixture.budgetCalls.length, 0);
    assert.equal(fixture.archives.length, 0);
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].actual_cost_micros, 0);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("retention failure prevents gateway dispatch and releases the existing reservation", async (t) => {
  const fixture = await gatewayFixture(t);
  fixture.env.CONTENT_ARCHIVE.put = async () => { throw new Error("synthetic archive outage"); };
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not dispatch"); });
  const response = await fixture.call(nativePath, [{ provider: "openai", query: {} }]);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "content_retention_unavailable");
  await fixture.drain();
  assert.equal(upstream.mock.callCount(), 0);
  assert.deepEqual(fixture.budgetCalls.map(({ path }) => path), ["/reserve", "/settle"]);
  assert.equal(fixture.budgetCalls[1].body.actualCostMicros, 0);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].content_retained, false);
});

test("only the declared universal format accepts arrays and manifest metadata stays object-only", async (t) => {
  const fixture = await gatewayFixture(t);
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not dispatch"); });
  for (const [path, body] of [
    [nativePath, {}], [nativePath, null], [nativePath, [null]], [nativePath, [[]]],
    [manifestPath, { body: {} }], [manifestPath, []],
    [manifestPath, { body: [], pathParams: [] }], [manifestPath, { body: [], query: [] }],
    ["/v1/proxy/openai/chat_completions", { body: [] }],
    ["/v1/native/openai/v1/chat/completions", []], ["/v1/chat/completions", []],
  ]) {
    const response = await fixture.call(path, body);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, "invalid_request_body");
  }
  await fixture.drain();
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(fixture.budgetCalls.length, 0);
  assert.equal(fixture.archives.length, 0);
});

async function gatewayFixture(t) {
  const pending = [], archives = [], events = [], budgetCalls = [];
  const secret = "synthetic-proxy-secret";
  const policy = { enabled: true, generation: "g1", providers: [providerId], tenantId: "default", monthlyBudgetMicros: 1000, requestCostMicros: 25, retainRequestContent: true };
  const credential = { enabled: true, secretSha256: await sha256Hex(secret), policyId: "fixture", policyGeneration: "g1" };
  const connection = { providerId, enabled: true, monthlyBudgetMicros: null };
  const budgets = new Map();
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_AI_GATEWAY_ID: "fixture-gateway", CLOUDFLARE_API_TOKEN: "synthetic-gateway-token",
    POLICY_KV: { get: async (key) => Array.isArray(key) ? new Map(key.map((item) => [item, null])) : null },
    CONTENT_ARCHIVE: { put: async (_key, body) => archives.push(body) },
    USAGE_QUEUE: { send: async (event) => events.push(event) },
    BUDGET_LEDGER: { idFromName: (name) => name, get(name) {
      if (!budgets.has(name)) {
        const db = new DatabaseSync(":memory:");
        t.after(() => db.close());
        const sql = { exec(query, ...bindings) {
          const statement = db.prepare(query);
          if (statement.columns().length) return statement.all(...bindings);
          statement.run(...bindings);
          return [];
        } };
        const ledger = new BudgetLedgerObject({ storage: { sql, getAlarm: async () => 1 } });
        budgets.set(name, { fetch: async (url, init) => {
          budgetCalls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
          return ledger.fetch(new Request(url, init));
        } });
      }
      return budgets.get(name);
    } },
    ACCESS_CONTROL: { idFromName: (name) => name, get: () => ({ fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {}, ready: true });
      throw new Error(`unexpected authority call ${path}`);
    } }) },
  };
  return {
    env, policy, credential, connection, archives, events, budgetCalls,
    call(path, body) {
      return worker.fetch(new Request(`https://router.example${path}`, {
        method: "POST", headers: { authorization: `Bearer clawrouter-live-fixture-${secret}`, "content-type": "application/json" }, body: JSON.stringify(body),
      }), env, { waitUntil: (promise) => pending.push(promise) });
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}
