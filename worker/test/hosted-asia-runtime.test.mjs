import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { sha256Hex } = await import("../utils.ts");

// Real Worker and SQL budget boundaries, synthetic upstream responses. A fixed
// router tariff proves policy settlement, not the provider's actual dollar cost.
const providers = [
  ["moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions"],
  ["qwen", "QWEN_API_KEY", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"],
  ["zai", "ZAI_API_KEY", "https://api.z.ai/api/paas/v4/chat/completions"],
];

for (const [id, binding, url] of providers) test(`${id}: scoped catalog routes SSE and settles one fixed-price request`, async t => {
  const pending = [], events = [], records = new Map();
  const env = {
    [binding]: "synthetic-upstream-key",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, records.get(k) ?? null])) : records.get(key) ?? null; },
      async put(key, value) { records.set(key, JSON.parse(value)); },
      async list() { return { keys: [], list_complete: true }; },
    },
    BUDGET_LEDGER: sqlBudgetNamespace(t),
    USAGE_QUEUE: { async send(event) { events.push(event); } },
  };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => authority };
  const policy = { enabled: true, generation: "fixture", providers: [id], models: null, tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [
    { policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } },
    { policyId: "foreign", policy: { ...policy, providers: ["openai"] } },
  ]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async credentialId => ({ credentialId, credential: { enabled: true, secretSha256: await sha256Hex("fixture-secret"), policyId: credentialId, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  const request = (key, path, body) => worker.fetch(new Request(`https://router.example${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer clawrouter-live-${key}-fixture-secret`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil: promise => pending.push(promise) });
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected provider I/O"); });
  const catalogResponse = await request("paid", "/v1/catalog");
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.scope.credentialId, "paid");
  const provider = catalog.providers.find(row => row.id === id);
  const model = provider.models[0], route = provider.routes.find(row => row.endpoint === "chat_completions");
  assert.equal(route.requestFormat, "openai.chat_completions");
  assert.ok(provider.offers.some(offer => offer.modelId === model.id && offer.eligible));
  const path = provider.nativeBaseUrl + route.path;
  const body = { model: model.upstream, stream: true, stream_options: { include_usage: true },
    messages: [
      { role: "assistant", content: null, reasoning_content: "synthetic-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" },
    ] };
  for (const [key, status, code] of [["unpriced", 400, "pricing_required"], ["foreign", 403, "provider_not_allowed"]]) {
    const denied = await request(key, path, body);
    assert.equal(denied.status, status);
    assert.equal((await denied.json()).error.code, code);
  }
  assert.equal(upstream.mock.callCount(), 0, "discovery and denied requests never reach the provider");
  const wire = [
    { id: "chat_fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "synthetic-output" }, finish_reason: null }] },
    { id: "chat_fixture", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  upstream.mock.mockImplementation(async (target, init) => {
    assert.equal(String(target), url);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-upstream-key");
    assert.deepEqual(JSON.parse(init.body), body);
    let offset = 0;
    const bytes = new TextEncoder().encode(wire);
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const response = await request("paid", path, body);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(upstream.mock.callCount(), 1);
  const usage = events.filter(event => event.type === "clawrouter.usage.v1" && event.status === "success");
  assert.equal(usage.length, 1);
  const [event] = usage;
  assert.equal(event.credential_id, "paid");
  assert.equal(event.policy_id, "paid");
  assert.equal(event.provider, id);
  assert.equal(event.model, model.id);
  assert.equal(event.request_id, response.headers.get("x-clawrouter-request-id"));
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [100, 20, 120]);
  assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.actual_cost_micros, 7);
  const reservations = env.BUDGET_LEDGER.get("fixture:paid").reservations();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].settled, 1);
  assert.equal(reservations[0].reserved_micros, 7);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-reasoning|synthetic-tool-result|synthetic-output|synthetic-upstream-key/);
});
