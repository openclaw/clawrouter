import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { transformRequestBody } = await import("../provider-request.ts"); const { providerById, modelRoute } = await import("../provider-catalog.ts");
const { grantSupports } = await import("../provider-auth.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { actualModelCost, estimateModelCost } = await import("../pricing.ts");
const provider = providerById("openai");
const responses = provider.endpoints.find(row => row.id === "responses");
const chat = provider.endpoints.find(row => row.id === "chat_completions");
const models = ["gpt-6.2-astra", "gpt-6.2-sol"];
const replay = { id: "reason_fixture", type: "reasoning", encrypted_content: "synthetic-encrypted-reasoning", summary: [] };
const call = { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "proof", arguments: '{"value":7}', status: "completed" };
const tool = { type: "function", name: "proof", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, strict: true };
const frame = value => "event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n";

async function fixture(t, kind) {
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { POLICY_KV: {
    async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "proof", policy: {
    enabled: true, generation: "fixture", providers: ["openai"], models: models.map(id => "openai/" + id), tenantId: "fixture",
    monthlyBudgetMicros: 100000000, requestCostMicros: null, budgetMode: "reserve", retainRequestContent: false,
    serviceTiers: { allowed: ["default", "priority", "ultrafast"], models: {} },
  } }]);
  await authorityCall(env, "/credentials/initialize-all", [{ credentialId: "proof", credential: {
    enabled: true, secretSha256: await sha256Hex("synthetic-proof-key"), policyId: "proof", policyGeneration: "fixture",
  } }]);
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "openai", enabled: true }]);
  await putGrantCredentials(env, "oauth/proof/openai", { provider: "openai", kind, enabled: true,
    credential: "synthetic-selected-" + kind, ...(kind === "subscription" ? { accountId: "synthetic-account" } : {}) });
  const f = { env, events, sent, reply: null,
    call(body, endpoint = "responses") {
      return worker.fetch(new Request("https://router.example/v1/native/openai/v1/" + endpoint, {
        method: "POST", headers: { authorization: "Bearer clawrouter-live-proof-synthetic-proof-key", "content-type": "application/json" }, body: JSON.stringify(body),
      }), env, { waitUntil: promise => pending.push(promise) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain);
  return f;
}

for (const id of models) {
  test(id + " selects a priced route and preserves endpoint-specific tool/transport constraints", () => {
    const route = modelRoute("openai/" + id, "llm.responses");
    assert.equal(route.model.upstream, id);
    assert.equal(route.model.pricing.maxInputTokens, 922000);
    assert.equal(route.model.pricing.maxRequestInputTokens, 922000);
    assert.equal(route.model.pricing.defaultMaxOutputTokens, 128000);
    assert.deepEqual(route.model.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(route.model.requestParameters.responses.toolCalling, "supported");
    assert.equal(route.model.requestParameters.chat_completions.toolCalling, "unsupported");
    assert.equal(route.model.nativeCapabilities.endpoints.responses.contextWindow, 1050000);
    assert.deepEqual(transformRequestBody(provider, chat.path, id, { model: id, max_tokens: 32 }, {}), { model: id, max_completion_tokens: 32 });
    for (const kind of ["api_key", "subscription"]) {
      assert.equal(grantSupports({ provider, endpoint: responses, mode: "http", model: route.model.id }, { kind }), true);
      assert.equal(grantSupports({ provider, endpoint: chat, mode: "http", model: route.model.id }, { kind }), kind === "api_key");
    }
    assert.equal(grantSupports({ provider, endpoint: responses, mode: "websocket" }, { kind: "subscription" }), false);
    const api = provider.products.find(row => row.id === "platform-api");
    const subscription = provider.products.find(row => row.id === "chatgpt-subscription");
    assert.ok(api.offers.find(row => row.endpoint === "responses").models.includes(route.model.id));
    assert.ok(api.offers.find(row => row.endpoint === "chat_completions").models.includes(route.model.id));
    assert.ok(subscription.offers.find(row => row.endpoint === "responses").models.includes(route.model.id));
  });

  test(id + " settles published ceilings at the long-context boundary and fails closed on incomplete usage", () => {
    const pricing = modelRoute("openai/" + id, "llm.responses").model.pricing;
    const base = id.endsWith("astra") ? 8 : 2;
    const usage = { input: 272000, output: 100, cached: 1000, cacheWrite: 2000, cacheWrite5m: null, cacheWrite1h: null, serviceTier: "default" };
    // Ordinary input + 5% cached reads + 2.5x write ceiling + 5x output.
    assert.equal(actualModelCost(pricing, usage), 274550 * base);
    assert.equal(actualModelCost(pricing, { ...usage, input: 272001 }), 548852 * base);
    assert.equal(actualModelCost(pricing, { ...usage, serviceTier: "priority" }), 549100 * base);
    assert.equal(actualModelCost(pricing, { ...usage, serviceTier: "ultrafast" }), 1647300 * base);
    assert.equal(actualModelCost(pricing, { ...usage, cacheWrite: null }), null);
    assert.equal(actualModelCost(pricing, { ...usage, serviceTier: "future" }), null);
    const estimate = estimateModelCost(pricing, { input: [{ type: "input_image", image_url: "https://example.invalid/fixture.png" }], max_output_tokens: 16, service_tier: "default" }, responses);
    assert.equal(estimate.inputTokens, 922000);
    assert.ok(estimate.reserveMicros >= actualModelCost(pricing, { ...usage, input: 922000, output: 16 }));
  });

  for (const kind of ["api_key", "subscription"]) test(id + " " + kind + " streams a tool roundtrip through the Worker with original auth provenance", async t => {
    const f = await fixture(t, kind);
    let turn = 0;
    f.reply = async request => {
      assert.equal(request.url, kind === "subscription" ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-" + kind);
      assert.equal(request.headers.get("chatgpt-account-id"), kind === "subscription" ? "synthetic-account" : null);
      const body = await request.json();
      assert.equal(body.model, id);
      assert.equal(body.reasoning.effort, "low");
      assert.deepEqual(body.tools, [tool]);
      if (turn === 1) assert.deepEqual(body.input, [{ role: "user", content: "Call proof with value 7." }, replay, call,
        { type: "function_call_output", call_id: call.call_id, output: "synthetic-result" }]);
      const output = turn++ === 0 ? [replay, call] : [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PROOF_OK", annotations: [] }] }];
      const result = { id: "resp_fixture_" + turn, object: "response", model: id, status: "completed", service_tier: "default", output,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
      return new Response(frame({ type: "response.completed", response: result }), { headers: { "content-type": "text/event-stream" } });
    };
    const body = { model: id, stream: true, store: false, max_output_tokens: 32, reasoning: { effort: "low" }, service_tier: "default", tools: [tool], input: [{ role: "user", content: "Call proof with value 7." }] };
    const first = await f.call(body);
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(first.headers.get("x-clawrouter-grant-lane"), kind);
    const wire = await first.text();
    assert.match(wire, /function_call/);
    const second = await f.call({ ...body, input: [...body.input, replay, call, { type: "function_call_output", call_id: call.call_id, output: "synthetic-result" }] });
    assert.equal(second.status, 200, await second.clone().text());
    assert.match(await second.text(), /PROOF_OK/);
    await f.drain();
    assert.equal(f.sent.length, 2);
    const usage = f.events.filter(event => event.type === "clawrouter.usage.v1");
    assert.equal(usage.length, 2);
    assert.ok(usage.every(event => event.grant_lane === kind && event.model === "openai/" + id && event.cost_basis === "manifest_rate_upper_bound"));
    assert.doesNotMatch(JSON.stringify(usage), /synthetic-selected|synthetic-encrypted|synthetic-result|PROOF_OK/);
  });
}

for (const id of models) {
  test(id + " API-key Chat sends the registered model and modern output limit", async t => {
    const f = await fixture(t, "api_key");
    let wire;
    f.reply = async request => {
      assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-api_key");
      wire = await request.json();
      return Response.json({ id: "chat_fixture", object: "chat.completion", model: id, service_tier: "default",
        choices: [{ index: 0, message: { role: "assistant", content: "CHAT_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    };
    const response = await f.call({ model: id, messages: [{ role: "user", content: "Reply CHAT_OK" }], max_tokens: 32, reasoning_effort: "low", service_tier: "default" }, "chat/completions");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).choices[0].message.content, "CHAT_OK");
    assert.equal(wire.model, id); assert.equal(wire.max_completion_tokens, 32); assert.equal(wire.max_tokens, undefined);
    await f.drain(); assert.equal(f.sent.length, 1);
  });

  for (const kind of ["api_key", "subscription"]) test(id + " " + kind + " upstream refusal does not fabricate success or change credential lanes", async t => {
    const f = await fixture(t, kind);
    f.reply = () => Response.json({ error: { code: "model_not_found", message: "Synthetic entitlement denial" } }, { status: 403 });
    const response = await f.call({ model: id, input: "Synthetic denial proof", max_output_tokens: 16, service_tier: "default" });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-clawrouter-grant-lane"), kind);
    assert.equal((await response.json()).error.code, "model_not_found");
    await f.drain(); assert.equal(f.sent.length, 1);
    const usage = f.events.filter(event => event.type === "clawrouter.usage.v1");
    assert.equal(usage.length, 1); assert.equal(usage[0].grant_lane, kind); assert.equal(usage[0].actual_cost_micros, 0);
  });
}
