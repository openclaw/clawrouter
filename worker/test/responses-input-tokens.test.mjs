import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKeys } from "./http-continuation-fixture.mjs";
import { putGrantCredentials } from "../grant-credentials.ts";
import { assertInputTokensRequest } from "../responses-input-tokens.ts";
const { default: worker } = await import("../index.ts");

const routes = ["/v1/responses/input_tokens", "/v1/native/openai/v1/responses/input_tokens", "/v1/proxy/openai/responses_input_tokens"];
const wire = '{ "object": "response.input_tokens", "input_tokens": 37, "extra": true }\n';
const tool = { type: "function", name: "local", strict: true, parameters: { type: "object", properties: { id: { type: "string" }, file_id: { type: "string" } }, additionalProperties: false } };
async function setup(t, { pooled = false, mode = "reserve", fixedCost = null } = {}) {
  const f = await fixture(t, false, { limit: mode === "unmetered" ? null : 100, fixedCost });
  if (mode === "soft") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, budgetMode: "soft" } });
  if (pooled) await putGrantCredentials(f.env, grantKeys[0], { provider: "openai", kind: "api_key", credential: "synthetic-count-key", enabled: true });
  f.response = () => new Response(wire, { headers: { "content-type": "application/json" } });
  f.send = (route = routes[0], body = {}, headers = {}, signal) => {
    const payload = { model: route.includes("/native/") ? "gpt-6-astra" : "openai/gpt-6-astra", input: "synthetic text", ...body };
    return worker.fetch(new Request("https://router.example" + route, { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...headers }, signal, body: JSON.stringify(route.includes("/proxy/") ? { body: payload } : payload) }), f.env, { waitUntil: promise => f.pending.push(promise) });
  };
  // Own the context used by send, without changing the production authority/SQL.
  f.pending = [];
  const drain = f.drain;
  f.drain = async () => { while (f.pending.length) await Promise.all(f.pending.splice(0)); await drain(); };
  return f;
}
function nativeRefusal(response, body, code) {
  assert.equal(response.headers.get("x-clawrouter-error-code"), code);
  assert.equal(typeof body.error.message, "string");
  assert.deepEqual(body, { error: { message: body.error.message, type: response.status >= 500 ? "server_error" : response.status === 429 ? "rate_limit_error" : "invalid_request_error", param: null, code } });
}
function noMoney(f) {
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
  assert.ok(f.events.every(e => e.actual_cost_micros === 0 && e.reserved_cost_micros === 0 && e.cost_basis === "none"));
  assert.equal(f.bindings().length, 0, "counts must not claim response/object custody");
}
for (const route of routes) for (const pooled of [false, true]) test("input count forwards exact stateless native payload and settles free once: " + route + ": " + pooled, async t => {
  const f = await setup(t, { pooled, fixedCost: 7 });
  const body = { input: [{ role: "user", content: [{ type: "input_text", text: "synthetic" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" }, { type: "input_file", filename: "fixture.txt", file_data: "data:text/plain;base64,AAAA" }] }], instructions: "count only", tools: [tool], tool_choice: "auto", parallel_tool_calls: false, personality: "pragmatic", reasoning: { effort: "low" }, text: { format: { type: "json_schema", name: "result", schema: tool.parameters } }, truncation: "disabled" };
  const response = await f.send(route, body, { "OpenAI-Project": "synthetic-project", "OpenAI-Organization": "synthetic-org" });
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1); const sent = f.sent[0];
  assert.equal(sent.url, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(sent.headers.get("authorization"), "Bearer " + (pooled ? "synthetic-count-key" : "synthetic-environment-key"));
  assert.equal(sent.headers.get("openai-project"), "synthetic-project"); assert.equal(sent.headers.get("openai-organization"), "synthetic-org");
  assert.deepEqual(sent.body, { model: "gpt-6-astra", ...body });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].capability, "llm.count_tokens"); assert.equal(f.events[0].model, "openai/gpt-6-astra");
  assert.equal(f.events[0].input_tokens, null, "an estimate is not generated/billable model usage"); assert.equal(f.events[0].pricing_ref, null);
  assert.equal(f.events[0].grant_key, pooled ? grantKeys[0] : null); assert.equal(f.events[0].status, "success");
  noMoney(f);
});
for (const route of routes) for (const [context, mode] of [["auto", "standard"], ["current_turn", "pro"], ["all_turns", "custom-mode"]]) test("input count forwards stateless reasoning context and mode: " + route + ": " + context + "/" + mode, async t => {
  const f = await setup(t), reasoning = { effort: "low", context, mode };
  const response = await f.send(route, { reasoning });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].body, { model: "gpt-6-astra", input: "synthetic text", reasoning });
  assert.equal(f.events.length, 1); noMoney(f);
});
for (const route of routes) test("Luna input count uses count endpoint and zero receipt: " + route, async t => {
  const f = await setup(t, { fixedCost: 99 });
  const model = route.includes("/native/") ? "gpt-6-luna" : "openai/gpt-6-luna";
  const result = { object: "response.input_tokens", input_tokens: 500000 };
  f.response = () => Response.json(result);
  const response = await f.send(route, { model });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(JSON.parse(await f.consume(response)), result);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(f.sent[0].body.model, "gpt-6-luna");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].model, "openai/gpt-6-luna");
  assert.equal(f.events[0].capability, "llm.count_tokens");
  assert.equal(f.events[0].pricing_ref, null);
  assert.equal(f.events[0].input_tokens, null);
  noMoney(f);
});
for (const mode of ["reserve", "soft", "unmetered"]) test("input count does not charge fixed policy tariff or fake generation usage in " + mode, async t => {
  const f = await setup(t, { mode, fixedCost: 99 });
  const body = { object: "response.input_tokens", input_tokens: 500000, usage: { input_tokens: 500000, output_tokens: 10, total_tokens: 500010 } };
  f.response = () => Response.json(body);
  const response = await f.send(); assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(JSON.parse(await f.consume(response)), body);
  assert.equal(f.events.length, 1); noMoney(f);
});
for (const route of routes) test("input count preserves self-contained tool transcript and null parents: " + route, async t => {
  const f = await setup(t);
  const body = { previous_response_id: null, conversation: null,
    input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "inline", annotations: [] }] },
      { type: "function_call", name: "local", arguments: '{"file_id":"literal-user-data"}', call_id: "call_inline" },
      { type: "function_call_output", call_id: "call_inline", output: [{ type: "input_file", file_url: "https://example.com/inline.txt" }] },
      { type: "custom_tool_call", name: "grammar", input: "file_id is literal text", call_id: "call_custom" },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "inline result" }],
    tools: [{ type: "namespace", name: "local", description: "inline tools", tools: [tool, { type: "custom", name: "grammar", format: { type: "grammar", syntax: "regex", definition: "[a-z]+" } }] }],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "local", namespace: "local" }] },
  };
  const response = await f.send(route, body); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await f.consume(response), wire); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].body, { model: "gpt-6-astra", ...body }); assert.equal(f.events.length, 1); noMoney(f);
});
const stateful = {
  parent: { previous_response_id: "resp_foreign" }, conversation: { conversation: "conv_foreign" }, conversation_object: { conversation: { id: "conv_foreign" } },
  prompt: { prompt: { id: "pmpt_foreign" } }, item_reference: { input: [{ type: "item_reference", id: "msg_foreign" }] },
  item_id: { input: [{ type: "message", id: "msg_foreign", role: "user", content: "text" }] },
  image_file: { input: [{ role: "user", content: [{ type: "input_image", file_id: "file_foreign" }] }] },
  input_file: { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_foreign" }] }] },
  opaque: { input: [{ type: "compaction", encrypted_content: "synthetic-foreign-window" }] },
  reasoning: { input: [{ type: "reasoning", encrypted_content: "synthetic-reasoning" }] },
  tool_file: { tools: [{ type: "file_search", vector_store_ids: ["vs_foreign"] }] },
  tool_container: { tools: [{ type: "code_interpreter", container: "cntr_foreign" }] },
  hosted_search: { tools: [{ type: "web_search" }] }, reasoning_selector: { reasoning: { context: "auto", previous_response_id: "resp_foreign" } },
  tool_output: { input: [{ type: "function_call_output", call_id: "local", output: [{ type: "input_file", file_id: "file_foreign" }] }] },
  tool_choice: { tool_choice: { type: "file_search" } }, future_selector: { future_account_object: "obj_foreign" },
  future_input: { input: [{ type: "future_reference", id: "obj_foreign" }] },
};
for (const route of routes) for (const [name, body] of Object.entries(stateful)) test("stateless count rejects " + name + " before egress: " + route, async t => {
  const f = await setup(t), response = await f.send(route, body);
  assert.equal(response.status, 400); nativeRefusal(response, JSON.parse(await f.consume(response)), "input_tokens_stateless_required");
  assert.equal(f.sent.length, 0); noMoney(f);
});
for (const route of routes) for (const [name, body, headers] of [
  ["stream", { stream: true }, {}], ["background", { background: true }, {}], ["bad input", { input: {} }, {}],
  ["null model", { model: null }, {}], ["missing model", { model: undefined }, {}], ["turn state", {}, { "x-codex-turn-state": "foreign-turn" }],
]) test("input count rejects " + name + ": " + route, async t => {
  const f = await setup(t), response = await f.send(route, body, headers);
  assert.equal(response.status, 400);
  nativeRefusal(response, JSON.parse(await f.consume(response)), ["null model", "missing model"].includes(name) ? "model_required" : "input_tokens_stateless_required");
  assert.equal(f.sent.length, 0); noMoney(f);
});
for (const route of routes) for (const query of ["previous_response_id=resp_foreign", "trace=a&trace=b&empty=", "=blank-name"]) test("input count query is refused before egress: " + route + "?" + query, async t => {
  const f = await setup(t), response = await f.send(route + "?" + query);
  assert.equal(response.status, 400);
  nativeRefusal(response, JSON.parse(await f.consume(response)), "input_tokens_stateless_required");
  assert.equal(f.sent.length, 0); noMoney(f);
});
for (const query of ["trace=a&trace=b", "empty=", "=blank-name"]) test("count guard refuses ordered query independently of request URL: " + query, () => {
  const request = new Request("https://router.example/v1/responses/input_tokens");
  assert.throws(() => assertInputTokensRequest(request, new URLSearchParams(query)), error => error.status === 400 && error.code === "input_tokens_stateless_required");
  assert.doesNotThrow(() => assertInputTokensRequest(request, new URLSearchParams()));
});
for (const denial of ["missing", "invalid", "revoked", "model", "provider", "disabled"]) test("free count retains " + denial + " enforcement", async t => {
  const f = await setup(t), headers = {};
  if (denial === "missing") headers.authorization = "";
  if (denial === "invalid") headers.authorization = "Bearer clawrouter-live-fixture-wrong";
  if (denial === "revoked") await f.mutateCredential({ operation: "revoke", credentialId: "fixture" });
  if (denial === "model" || denial === "provider") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, ...(denial === "model" ? { models: ["openai/gpt-6.1-sol"] } : { providers: ["anthropic"] }) } });
  if (denial === "disabled") await f.authority("/connections/put", { providerId: "openai", enabled: false });
  const response = await f.send(routes[0], {}, headers);
  assert.equal(response.status, ["missing", "invalid"].includes(denial) ? 401 : denial === "disabled" ? 503 : 403, await response.clone().text());
  const codes = { missing: "invalid_proxy_key", invalid: "invalid_proxy_key", revoked: "proxy_key_revoked", model: "model_not_allowed", provider: "provider_not_allowed", disabled: "provider_disabled" };
  nativeRefusal(response, JSON.parse(await f.consume(response)), codes[denial]); assert.equal(f.sent.length, 0); noMoney(f);
});
for (const kind of ["subscription", "oauth"]) test("input count refuses " + kind + " grants and catalog offers", async t => {
  const f = await setup(t);
  await putGrantCredentials(f.env, grantKeys[0], { provider: "openai", kind, accessToken: "synthetic-non-api", accountId: "synthetic-account", enabled: true });
  const response = await f.send(); assert.equal(response.status, 503); await f.consume(response); assert.equal(f.sent.length, 0); noMoney(f);
  const catalog = await worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil: p => f.pending.push(p) });
  assert.equal(catalog.status, 200); const provider = (await catalog.json()).providers.find(p => p.id === "openai");
  assert.ok(!provider?.offers.some(o => o.endpoint === "responses_input_tokens" && o.eligible));
});
test("same-key catalog advertises free unary count only for supported API-key models", async t => {
  const f = await setup(t);
  const response = await worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret" } }), f.env, { waitUntil: p => f.pending.push(p) });
  assert.equal(response.status, 200, await response.clone().text());
  const provider = (await response.json()).providers.find(p => p.id === "openai");
  const offers = provider.offers.filter(o => o.endpoint === "responses_input_tokens" && o.modelId === "openai/gpt-6-astra");
  assert.deepEqual(offers.map(o => o.route).sort(), routes.slice(0, 2).sort());
  assert.ok(offers.every(o => o.eligible && o.transport === "http" && o.affordability === "exact-covered"));
  assert.ok(provider.models.find(m => m.id === "openai/gpt-6-astra").capabilities.includes("llm.count_tokens"));
  assert.ok(!provider.models.find(m => m.id === "openai/tts-1")?.capabilities.includes("llm.count_tokens"));
  assert.equal(f.sent.length, 0);
});
for (const status of [400, 429, 500]) test("count preserves upstream rejection " + status + " and zero settlement", async t => {
  const f = await setup(t, { fixedCost: 7 }); const body = '{"error":{"message":"synthetic rejection"}}';
  f.response = () => new Response(body, { status, headers: { "content-type": "application/json", "retry-after": "9" } });
  const response = await f.send(); assert.equal(response.status, status); assert.equal(response.headers.get("retry-after"), "9"); assert.equal(await f.consume(response), body);
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1); noMoney(f);
});
for (const cause of ["fetch", "abort", "timeout", "cancel", "malformed"]) test("count " + cause + " owns one zero receipt", async t => {
  const f = await setup(t, { fixedCost: 7 }), caller = new AbortController();
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  if (cause === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
  f.response = () => { enter(); if (cause === "fetch") throw new Error("synthetic fetch failure");
    if (["abort", "timeout"].includes(cause)) return new Promise(() => {});
    if (cause === "cancel") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } });
    return new Response("{ truncated", { headers: { "content-type": "application/json" } }); };
  const pending = f.send(routes[0], {}, {}, caller.signal); await entered;
  if (cause === "abort") caller.abort(); if (cause === "timeout") t.mock.timers.tick(120000);
  const response = await pending;
  if (cause === "cancel") await response.body.cancel(); else await f.consume(response);
  await f.drain(); assert.equal(response.status, ["cancel", "malformed"].includes(cause) ? 200 : 502);
  assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1); noMoney(f);
});

test("free count respects API grant rate-limit cooldown with Retry-After", async t => {
  const f = await setup(t, { pooled: true }), now = Date.now();
  const revision = f.values.get(grantKeys[0]).updatedAt;
  await f.authority("/grant-pools/feedback", { key: grantKeys[0], state: { status: "cooldown", observedAt: new Date(now).toISOString(), source: "provider_response", cooldownUntil: new Date(now + 60000).toISOString(), lastSignal: "rate_limited", grantRevision: revision, windows: [] } });
  const response = await f.send(); assert.equal(response.status, 429, await response.clone().text());
  assert.ok(Number(response.headers.get("retry-after")) > 0); nativeRefusal(response, JSON.parse(await f.consume(response)), "upstream_grant_pool_unavailable");
  assert.equal(f.sent.length, 0); noMoney(f);
});
