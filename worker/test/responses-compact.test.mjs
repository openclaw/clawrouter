import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { default: handler } = await import("../index.ts");
const { modelRoute } = await import("../providers.ts");
const { estimateModelCost } = await import("../pricing.ts");
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";

const routes = ["/v1/responses/compact", "/v1/native/openai/v1/responses/compact", "/v1/proxy/openai/responses_compact"];
const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
const model = modelRoute("openai/gpt-6-astra").model;
const compactEndpoint = { request_format: "openai.responses_compact" };
const opaque = { type: "compaction", encrypted_content: "fixture-ciphertext" };
const output = [{ type: "message", role: "user", content: [{ type: "input_text", text: "retained user" }], extra: { keep: true } }, opaque, { type: "message", role: "assistant", content: "retained tail", vendor_field: [1, 2] }];
const result = { id: "cmp_fixture", object: "response.compaction", output, extra: { preserved: true }, service_tier: "default",
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } };
const wire = JSON.stringify(result, null, 2) + String.fromCharCode(10);

function fixture(t, { mode = "reserve", limit = 100_000_000, fixedCost = null } = {}) {
  const events = [], pending = [], operations = [];
  const env = usageEnv([], { limit: mode === "unmetered" ? null : limit, providerLimit: mode === "unmetered" ? null : 100_000_000, fixedCost, retainContent: false });
  env.OPENAI_API_KEY = "fixture-environment-key";
  const ledger = sqlBudgetNamespace(t);
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => {
    operations.push({ name, path: new URL(url).pathname });
    return ledger.get(name).fetch(url, init);
  } }) };
  const original = env.ACCESS_CONTROL.get;
  env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
    if (new URL(url).pathname === "/grant-pools/attachment") return Response.json({ attached: false, pending: false });
    const response = await original(name).fetch(url, init), body = await response.json();
    if (body.policy) Object.assign(body.policy.policy, { budgetMode: mode === "soft" ? "soft" : "reserve" });
    return Response.json(body);
  } });
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  return { env, ledger, events, pending, operations, context: { waitUntil: promise => pending.push(promise) } };
}
function request(route, body = {}, { signal, headers = {} } = {}) {
  const native = route.includes("/native/");
  const payload = { model: native ? "gpt-6-astra" : "openai/gpt-6-astra", input: [{ role: "user", content: "history" }], service_tier: "default", ...body };
  return new Request("https://router.example" + route, { method: "POST", headers: { authorization: "Bearer " + proxyKey(), "content-type": "application/json", ...headers }, signal,
    body: JSON.stringify(route === routes[2] ? { body: payload } : payload) });
}
async function consume(f, response) { const text = await response.text(); await Promise.all(f.pending); return text; }
function settledOnce(f, amount) {
  assert.equal(f.events.length, 1);
  for (const owner of owners) {
    const rows = f.ledger.get(owner).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, amount);
    for (const path of ["/reserve", "/dispatch", "/settle"]) assert.equal(f.operations.filter(op => op.name === owner && op.path === path).length, 1);
  }
}
for (const route of routes) test("unary compact forwards canonical whole window and settles SQL once: " + route, async t => {
  const f = fixture(t), input = [{ role: "user", content: "history" }, { type: "additional_tools", tools: [{ type: "function", name: "local" }] }];
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses/compact");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-environment-key");
    assert.deepEqual(JSON.parse(init.body), { model: "gpt-6-astra", input, service_tier: "default", instructions: "keep state", max_output_tokens: 1 });
    for (const owner of owners) { const rows = f.ledger.get(owner).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].dispatch_started, 1); assert.equal(rows[0].settled, 0); assert.ok(rows[0].reserved_micros >= 6_400_000); }
    return new Response(wire, { headers: { "content-type": "application/json" } });
  });
  const response = await handler.fetch(request(route, { input, instructions: "keep state", max_output_tokens: 1 }), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), wire);
  assert.equal(upstream.mock.callCount(), 1);
  const [event] = f.events;
  assert.equal(event.capability, "llm.responses.compact"); assert.equal(event.model, "openai/gpt-6-astra"); assert.equal(event.credential_id, "maintainer_key");
  assert.equal(event.reserved_output_tokens, 128_000); assert.equal(event.actual_cost_micros, 1665); assert.equal(event.cost_basis, "manifest_pricing");
  assert.equal(event.input_tokens, 100); assert.equal(event.output_tokens, 20); assert.equal(event.cached_input_tokens, 40); assert.equal(event.cache_write_input_tokens, 10);
  assert.ok(!JSON.stringify(event).includes(opaque.encrypted_content)); settledOnce(f, 1665);
});

for (const route of routes.slice(0, 2)) for (const mode of ["soft", "unmetered", "fixed"]) test(mode + " compact uses existing charge semantics: " + route, async t => {
  const f = fixture(t, { mode, fixedCost: mode === "fixed" ? 7 : null });
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": "application/json" } }));
  const response = await handler.fetch(request(route), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), wire);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].actual_cost_micros, mode === "fixed" ? 7 : 1665);
  assert.equal(f.events[0].cost_basis, mode === "fixed" ? "policy_fixed" : "manifest_pricing");
  for (const owner of owners) {
    const rows = f.ledger.get(owner).reservations();
    if (mode === "unmetered") { assert.equal(rows.length, 0); continue; }
    assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].dispatch_started, 1);
    assert.equal(rows[0].reserved_micros, mode === "fixed" ? 7 : 1665);
    if (mode === "soft") {
      assert.equal(f.operations.filter(op => op.name === owner && op.path === "/charge").length, 1);
      assert.equal(f.operations.filter(op => op.name === owner && ["/reserve", "/dispatch", "/settle"].includes(op.path)).length, 0);
    }
  }
});

const corruptions = {
  missing: value => { delete value.usage; },
  fractional: value => { value.usage.input_tokens = 1.5; },
  negative: value => { value.usage.output_tokens = -1; },
  overflow: value => { value.usage.total_tokens = 2 ** 53; },
  string: value => { value.usage.input_tokens = "100"; },
  inconsistent: value => { value.usage.total_tokens++; },
  cache_over_input: value => { value.usage.input_tokens_details.cached_tokens = 100; },
  missing_write: value => { delete value.usage.input_tokens_details.cache_write_tokens; },
  missing_reasoning: value => { delete value.usage.output_tokens_details; },
  excess_reasoning: value => { value.usage.output_tokens_details.reasoning_tokens = 21; },
  wrong_object: value => { value.object = "response"; },
  missing_tier: value => { delete value.service_tier; },
};
for (const [name, corrupt] of Object.entries(corruptions)) test("compact " + name + " usage cannot discount a dispatched reservation", async t => {
  const f = fixture(t), value = structuredClone(result); corrupt(value);
  const body = JSON.stringify(value);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "application/json" } }));
  const response = await handler.fetch(request(routes[0]), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), body);
  assert.equal(f.events[0].cost_basis, "manifest_reservation");
  assert.ok(f.events[0].reserved_cost_micros >= 6_400_000);
  assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
  settledOnce(f, f.events[0].reserved_cost_micros);
});

for (const [name, body] of Object.entries({
  stream: { stream: true }, background: { background: true }, malformed_stream: { stream: "false" },
  missing_input: { input: null }, malformed_input: { input: {} }, bad_parent: { previous_response_id: "" },
  unknown_model: { model: "openai/not-registered" }, incompatible_model: { model: "openai/gpt-4.1-mini" },
})) test("compact rejects " + name + " before reservation or egress", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const response = await handler.fetch(request(routes[0], body), f.env, f.context);
  assert.ok([400, 404].includes(response.status)); const error = JSON.parse(await consume(f, response));
  if (name.includes("stream")) assert.equal(error.error.code, "unsupported_compact_stream");
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.operations.filter(op => op.path === "/reserve").length, 0);
});

const unknownHistories = {
  opaque: { input: [opaque] }, reasoning: { input: [{ type: "reasoning", encrypted_content: "fixture-reasoning" }] },
  reference: { input: [{ type: "item_reference", id: "rs_fixture" }] }, future_item: { input: [{ type: "future_tool_declarations", tools: [] }] },
  tagged_hosted: { input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] },
  search_result_hosted: { input: [{ type: "tool_search_output", tools: [{ type: "mcp" }] }] },
  tagged_future: { input: [{ type: "additional_tools", tools: [{ type: "future_tool" }] }] },
  top_future: { tools: [{ type: "future_tool" }] }, prompt: { prompt: { id: "pmpt_fixture" } },
};
for (const [name, body] of Object.entries(unknownHistories)) test("compact reserve refuses unknown or hosted ancestry: " + name, async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const response = await handler.fetch(request(routes[0], body), f.env, f.context);
  assert.equal(response.status, 400); assert.equal(JSON.parse(await consume(f, response)).error.code, "pricing_required");
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.operations.filter(op => op.path === "/reserve").length, 0);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
});

for (const mode of ["soft", "unmetered", "fixed"]) test("compact " + mode + " opaque history does not invent token-only ancestry", async t => {
  const f = fixture(t, { mode, fixedCost: mode === "fixed" ? 7 : null });
  t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": "application/json" } }));
  const response = await handler.fetch(request(routes[0], { input: [opaque] }), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), wire);
  assert.equal(f.events[0].actual_cost_micros, mode === "fixed" ? 7 : mode === "soft" ? 1665 : 0);
  assert.equal(f.events[0].cost_basis, mode === "fixed" ? "policy_fixed" : "unpriced_usage");
});

test("compact reserves authoritative full opaque input and model maximum, not caller aliases", () => {
  for (const input of [[opaque], [{ type: "reasoning", encrypted_content: "fixture" }]]) {
    const estimate = estimateModelCost(model.pricing, { input, max_output_tokens: 1, max_tokens: 1, max_completion_tokens: 1, n: 99, service_tier: "default" }, compactEndpoint);
    assert.equal(estimate.inputTokens, model.pricing.maxRequestInputTokens ?? model.pricing.maxInputTokens); assert.equal(estimate.outputTokens, 128_000);
  }
});

for (const route of routes.slice(0, 2)) test("compact budget exhaustion precedes egress: " + route, async t => {
  const f = fixture(t, { limit: 1 }), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const response = await handler.fetch(request(route), f.env, f.context);
  assert.equal(response.status, 402); assert.equal(JSON.parse(await consume(f, response)).error.code, "budget_exhausted");
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.ledger.get(owners[0]).reservations().length, 0);
});

for (const [name, headers] of Object.entries({ missing: { authorization: "" }, invalid: { authorization: "Bearer clawrouter-live-maintainer_key-incorrect" } })) test("compact " + name + " authorization is denied before egress", async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const response = await handler.fetch(request(routes[0], {}, { headers }), f.env, f.context);
  assert.equal(response.status, 401); await consume(f, response); assert.equal(upstream.mock.callCount(), 0); assert.equal(f.operations.length, 0);
});

for (const cause of ["fetch_rejection", "caller_abort", "deadline", "consumer_cancel"]) test("compact " + cause + " finalizes dispatched SQL exactly once", async t => {
  const f = fixture(t), caller = new AbortController();
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  if (cause === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    enter();
    if (cause === "fetch_rejection") throw new Error("fixture upstream failure");
    if (cause === "consumer_cancel") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(wire.slice(0, 30))); } }), { headers: { "content-type": "application/json" } });
    return new Promise(() => {});
  });
  const pendingResponse = handler.fetch(request(routes[0], {}, { signal: caller.signal }), f.env, f.context);
  await entered;
  if (cause === "caller_abort") caller.abort(new Error("fixture caller cancellation"));
  if (cause === "deadline") t.mock.timers.tick(600_000);
  const response = await pendingResponse;
  if (cause === "consumer_cancel") { assert.equal(response.status, 200); await response.body.cancel("fixture downstream cancellation"); }
  else { assert.equal(response.status, 502); await response.text(); }
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, cause === "deadline" ? "timeout" : cause.includes("cancel") || cause === "caller_abort" ? "client_error" : "provider_error");
  assert.equal(f.events[0].actual_cost_micros, f.events[0].reserved_cost_micros);
  settledOnce(f, f.events[0].reserved_cost_micros);
});

const { fixture: continuationFixture } = await import("./http-continuation-fixture.mjs");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { sha256Hex } = await import("../utils.ts");
const grantKey = "oauth/fixture/account-a";
async function ownedFixture(t, { fixedCost = null, pooled = false } = {}) {
  const f = await continuationFixture(t, false, { limit: 100_000_000, fixedCost });
  if (pooled) await putGrantCredentials(f.env, grantKey, { provider: "openai", kind: "api_key", credential: "fixture-account-key", enabled: true });
  f.response = (upstream, index) => upstream.url.endsWith("/compact") ? new Response(wire, { headers: { "content-type": "application/json" } })
    : Response.json({ id: "resp_parent_" + index, object: "response", status: "completed", output: [], service_tier: "default", usage: result.usage });
  return f;
}
async function parentRequest(f, body = {}, headers = {}) {
  const response = await f.request({ service_tier: "default", max_output_tokens: 1, ...body }, headers);
  assert.equal(response.status, 200, await response.clone().text()); return JSON.parse(await f.consume(response)).id;
}
for (const pooled of [false, true]) for (const route of routes.slice(0, 2)) test("compact pins " + (pooled ? "single API grant" : "environment") + " previous response: " + route, async t => {
  const f = await ownedFixture(t, { pooled });
  const parentId = await parentRequest(f);
  const response = await f.request({ previous_response_id: parentId, model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: "default", max_output_tokens: 1 }, {}, route);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].url, "https://api.openai.com/v1/responses/compact");
  assert.equal(f.sent[1].headers.get("authorization"), "Bearer " + (pooled ? "fixture-account-key" : "synthetic-environment-key"));
  assert.equal(f.events[1].grant_key, pooled ? grantKey : null); assert.equal(f.events[1].actual_cost_micros, 1665);
  assert.equal(f.events[1].reserved_input_tokens, 922_000); assert.equal(f.events[1].reserved_output_tokens, 128_000);
  const claims = f.bindings().flatMap(([, state]) => state.db.prepare("SELECT * FROM http_continuations").all());
  assert.equal(claims.length, 1, "a compaction result is not a new ordinary response or ancestry proof");
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations(); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.settled === 1)); assert.equal(rows[1].reserved_micros, 1665);
  }
});

for (const mutation of ["unknown_id", "credential_rotation", "project_change", "foreign_scope", "expired_owner"]) test("compact " + mutation + " cannot borrow a continuation account", async t => {
  const f = await ownedFixture(t, { pooled: true }), id = await parentRequest(f);
  const headers = {}, body = { previous_response_id: id, service_tier: "default" };
  if (mutation === "unknown_id") body.previous_response_id = "resp_unregistered";
  if (mutation === "credential_rotation") await putGrantCredentials(f.env, grantKey, { ...f.values.get(grantKey), credential: "fixture-rotated-key" }, true);
  if (mutation === "project_change") headers["OpenAI-Project"] = "fixture-other-project";
  if (mutation === "foreign_scope") {
    await f.mutateCredential({ operation: "create", credentialId: "foreign", credential: { ...f.credential, secretSha256: await sha256Hex("foreign-fixture") } });
    headers.authorization = "Bearer clawrouter-live-foreign-foreign-fixture";
  }
  if (mutation === "expired_owner") for (const [, state] of f.bindings()) state.db.prepare("UPDATE http_continuations SET expires_at_ms = 0").run();
  const response = await f.request(body, headers, routes[0]);
  assert.equal(response.status, 409, await response.clone().text()); assert.equal(JSON.parse(await f.consume(response)).error.code, "continuation_restart_required");
  assert.equal(f.sent.length, 1);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 1);
});

for (const ancestry of ["hosted", "pending", "corrupt", "unknown"]) test("compact parent " + ancestry + " tools cannot become a token-only reservation", async t => {
  const f = await ownedFixture(t, { fixedCost: 0 });
  const id = await parentRequest(f, ancestry === "hosted" ? { input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] } : {});
  if (ancestry !== "hosted") for (const [, state] of f.bindings()) {
    const rows = state.db.prepare("SELECT binding_key, pricing_evidence_json FROM http_continuations").all();
    for (const row of rows) {
      const evidence = JSON.parse(row.pricing_evidence_json);
      const value = ancestry === "corrupt" ? "{" : JSON.stringify(ancestry === "pending" ? { version: 1, producerId: evidence.producerId, state: "pending" } : { ...evidence, knowledge: "unknown" });
      state.db.prepare("UPDATE http_continuations SET pricing_evidence_json = ? WHERE binding_key = ?").run(value, row.binding_key);
    }
  }
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, requestCostMicros: null } });
  const response = await f.request({ previous_response_id: id, service_tier: "default" }, {}, routes[0]);
  assert.equal(response.status, 400); assert.equal(JSON.parse(await f.consume(response)).error.code, "pricing_required");
  assert.equal(f.sent.length, 1); assert.equal(f.events[1].actual_cost_micros, 0);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 1);
});

for (const account of ["subscription", "multi_account", "environment_fallback"]) test("compact rejects unqualified " + account + " before egress", async t => {
  const f = await ownedFixture(t, { pooled: account !== "subscription" });
  if (account === "subscription") await putGrantCredentials(f.env, grantKey, { provider: "openai", kind: "subscription", accessToken: "fixture-subscription", accountId: "fixture-account", enabled: true });
  if (account === "multi_account") await putGrantCredentials(f.env, "oauth/fixture/account-b", { provider: "openai", kind: "api_key", credential: "fixture-second-key", enabled: true });
  if (account === "environment_fallback") await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, grantRouting: { ...f.policy.grantRouting, environmentFallback: true } } });
  const response = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.ok([409, 503].includes(response.status)); const value = JSON.parse(await f.consume(response));
  assert.equal(value.error.code, account === "subscription" ? "upstream_grant_pool_unavailable" : "compact_account_unqualified");
  assert.equal(f.sent.length, 0);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
});

test("activating a detached second account makes compact fail closed", async t => {
  const f = await ownedFixture(t, { pooled: true }), second = "oauth/fixture/account-b";
  await putGrantCredentials(f.env, second, { provider: "openai", kind: "api_key", credential: "fixture-secondary", enabled: false });
  const response = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.equal(response.status, 200); await f.consume(response); assert.equal(f.sent.length, 1);
  await putGrantCredentials(f.env, second, { ...f.values.get(second), enabled: true }, true);
  const denied = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.equal(denied.status, 409); assert.equal(JSON.parse(await f.consume(denied)).error.code, "compact_account_unqualified"); assert.equal(f.sent.length, 1);
});

for (const status of [400, 429, 500]) test("compact upstream " + status + " remains readable and releases reservations once", async t => {
  const f = fixture(t), body = JSON.stringify({ error: { code: "fixture_rejection", message: "fixture provider rejection" } });
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(body, { status, headers: { "content-type": "application/json", "retry-after": "4" } }));
  const response = await handler.fetch(request(routes[0]), f.env, f.context);
  assert.equal(response.status, status); assert.equal(response.headers.get("retry-after"), "4"); assert.equal(await consume(f, response), body);
  assert.equal(upstream.mock.callCount(), 1); assert.equal(f.events[0].actual_cost_micros, 0); settledOnce(f, 0);
});

test("compact fragmented large canonical window is passed byte-for-byte without usage inspection limit loss", async t => {
  const f = fixture(t), value = structuredClone(result);
  value.output[0].content[0].text = "preserved \ud83e\udd80".repeat(400_000);
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let offset = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 4093); controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }), { headers: { "content-type": "application/json" } }));
  const response = await handler.fetch(request(routes[0]), f.env, f.context);
  assert.equal(response.status, 200); const delivered = new Uint8Array(await response.arrayBuffer()); await Promise.all(f.pending);
  assert.deepEqual(delivered, bytes); assert.equal(f.events[0].actual_cost_micros, 1665); settledOnce(f, 1665);
});

for (const mime of ["text/event-stream", "text/plain"]) test("compact wrong upstream MIME " + mime + " cannot fabricate usage or streaming", async t => {
  const f = fixture(t), body = mime.includes("event-stream") ? "data: " + JSON.stringify(result) + "\n\n" : wire;
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": mime } }));
  const response = await handler.fetch(request(routes[0]), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), body);
  assert.equal(f.events[0].input_tokens, null); assert.equal(f.events[0].cost_basis, "manifest_reservation"); settledOnce(f, f.events[0].reserved_cost_micros);
});

for (const route of routes) test("compact query options cannot bypass JSON admission: " + route, async t => {
  const f = fixture(t), upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const original = request(route), response = await handler.fetch(new Request(original.url + "?stream=true", original), f.env, f.context);
  assert.equal(response.status, 400); assert.equal(JSON.parse(await consume(f, response)).error.code, "invalid_compact_query");
  assert.equal(upstream.mock.callCount(), 0); assert.equal(f.operations.filter(op => op.path === "/reserve").length, 0);
});

for (const route of routes.slice(0, 2)) test("compact Sol uses registered canonical model through " + route, async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, "gpt-6.1-sol");
    return new Response(wire, { headers: { "content-type": "application/json" } });
  });
  const response = await handler.fetch(request(route, { model: route.includes("native") ? "gpt-6.1-sol" : "openai/gpt-6.1-sol" }), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), wire);
  assert.equal(f.events[0].model, "openai/gpt-6.1-sol"); assert.equal(f.events[0].reserved_output_tokens, 128_000);
  assert.equal(f.events[0].cost_basis, "manifest_pricing"); settledOnce(f, f.events[0].actual_cost_micros);
});

for (const second of ["oauth/fixture/account-b", "oauth/tenants/default/openai"]) test("missing projection cannot erase compact account " + second, async t => {
  const f = await ownedFixture(t, { pooled: true });
  await putGrantCredentials(f.env, second, { provider: "openai", kind: "api_key", credential: "fixture-second-key", enabled: true });
  const get = f.env.POLICY_KV.get;
  f.env.POLICY_KV.get = async (key, type) => {
    const value = await get(key, type);
    if (Array.isArray(key)) value.set(second, null);
    return key === second ? null : value;
  };
  const response = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.equal(response.status, 409); assert.equal(JSON.parse(await f.consume(response)).error.code, "compact_account_unqualified"); assert.equal(f.sent.length, 0);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
});

for (const body of [wire.slice(0, -20), "{ malformed fixture"]) test("compact malformed or truncated JSON retains dispatched reservation: " + body.length, async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "application/json" } }));
  const response = await handler.fetch(request(routes[0]), f.env, f.context);
  assert.equal(response.status, 200); assert.equal(await consume(f, response), body);
  assert.equal(f.events[0].cost_basis, "manifest_reservation"); settledOnce(f, f.events[0].reserved_cost_micros);
});

for (const route of routes.slice(0, 2)) test("compact model scope cannot borrow provider access: " + route, async t => {
  const f = await ownedFixture(t);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, models: ["openai/gpt-6.1-sol"] } });
  const response = await f.request({ model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: "default" }, {}, route);
  assert.equal(response.status, 403); assert.equal(JSON.parse(await f.consume(response)).error.code, "model_not_allowed"); assert.equal(f.sent.length, 0);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
});

for (const route of routes.slice(0, 2)) for (const tier of [undefined, "auto"]) test("compact default-only grant pins " + tier + " tier: " + route, async t => {
  const f = await ownedFixture(t);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, serviceTiers: { allowed: ["default"] } } });
  const response = await f.request({ model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: tier }, {}, route);
  assert.equal(response.status, 200); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.service_tier, "default"); assert.equal(f.events[0].actual_cost_micros, 1665);
});
for (const route of routes.slice(0, 2)) for (const tier of ["priority", "fast"]) test("compact denies ungranted " + tier + " tier: " + route, async t => {
  const f = await ownedFixture(t);
  await f.authority("/policies/put", { policyId: "fixture", policy: { ...f.policy, serviceTiers: { allowed: ["default"] } } });
  const response = await f.request({ model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: tier }, {}, route);
  assert.equal(response.status, 400); assert.equal(JSON.parse(await f.consume(response)).error.code, "service_tier_not_allowed"); assert.equal(f.sent.length, 0);
  for (const name of ["default:fixture", "provider:openai"]) assert.equal(f.env.BUDGET_LEDGER.get(name).reservations().length, 0);
});

// Regression probes exercise actual authority and SQL; only timing is controlled.
for (const pooled of [false, true]) test("detached disabled default metadata does not add a compact account: " + pooled, async t => {
  const f = await ownedFixture(t, { pooled });
  f.values.set("oauth/tenants/default/openai", { provider: "openai", kind: "api_key", credential: "fixture-inactive-legacy", enabled: false });
  const response = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer " + (pooled ? "fixture-account-key" : "synthetic-environment-key"));
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 1665);
});

for (const phase of ["default_attachment_read", "budget_dispatch"]) test("compact requalifies membership after " + phase, async t => {
  const f = await ownedFixture(t, { pooled: true });
  const second = phase === "default_attachment_read" ? "oauth/tenants/default/openai" : "oauth/fixture/account-b";
  let activated = false;
  const operations = [], budgetGet = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => ({ ...budgetGet(name), fetch: async (url, init) => {
    const path = new URL(url).pathname; operations.push({ name, path });
    const response = await budgetGet(name).fetch(url, init);
    if (phase === "budget_dispatch" && path === "/dispatch") await activate();
    return response;
  } });
  async function activate() {
    if (activated) return; activated = true;
    await putGrantCredentials(f.env, second, { provider: "openai", kind: "api_key", credential: "fixture-racing-second-key", enabled: true });
  }
  if (phase === "default_attachment_read") {
    const get = f.env.ACCESS_CONTROL.get;
    f.env.ACCESS_CONTROL.get = name => ({ fetch: async (url, init) => {
      const response = await get(name).fetch(url, init);
      if (new URL(url).pathname === "/grant-pools/attachment" && JSON.parse(init.body).key === second) await activate();
      return response;
    } });
  }
  const response = await f.request({ service_tier: "default" }, {}, routes[0]);
  assert.equal(activated, true); assert.equal(response.status, 409, await response.clone().text());
  assert.equal(JSON.parse(await f.consume(response)).error.code, "compact_account_unqualified"); assert.equal(f.sent.length, 0);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations();
    assert.equal(rows.length, phase === "budget_dispatch" ? 1 : 0);
    if (rows.length) {
      assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 0);
      for (const path of ["/reserve", "/dispatch", "/settle"]) assert.equal(operations.filter(op => op.name === name && op.path === path).length, 1);
    }
  }
});

for (const route of routes.slice(0, 2)) test("compact authority failure after reserve stays unsent: " + route, async t => {
  const f = await ownedFixture(t, { pooled: true });
  let dispatchStarted = false;
  const operations = [], get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => ({ ...get(name), fetch: async (url, init) => {
    const path = new URL(url).pathname; operations.push({ name, path });
    const response = await get(name).fetch(url, init);
    if (path === "/dispatch") dispatchStarted = true;
    return response;
  } });
  f.env.ACCESS_CONTROL.beforeFetch = (_name, request) => {
    if (dispatchStarted && new URL(request.url).pathname === "/grant-pools/resolve") throw new Error("fixture authority unavailable");
  };
  const response = await f.request({ model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: "default" }, {}, route);
  assert.equal(response.status, 503); assert.equal(JSON.parse(await f.consume(response)).error.code, "provider_unavailable");
  assert.equal(f.sent.length, 0); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
  for (const name of ["default:fixture", "provider:openai"]) {
    const rows = f.env.BUDGET_LEDGER.get(name).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 0);
    for (const path of ["/reserve", "/dispatch", "/settle"]) assert.equal(operations.filter(op => op.name === name && op.path === path).length, 1);
  }
});

for (const route of routes.slice(0, 2)) for (const source of ["kv", "authority"]) for (const cause of ["caller_abort", "deadline"]) test("compact stalled post-dispatch " + source + " honors " + cause + ": " + route, async t => {
  const f = await ownedFixture(t, { pooled: true }), caller = new AbortController();
  let dispatchStarted = false, entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const operations = [], get = f.env.BUDGET_LEDGER.get;
  f.env.BUDGET_LEDGER.get = name => ({ ...get(name), fetch: async (url, init) => {
    const path = new URL(url).pathname; operations.push({ name, path });
    const response = await get(name).fetch(url, init);
    if (path === "/dispatch") dispatchStarted = true;
    return response;
  } });
  if (source === "kv") {
    const read = f.env.POLICY_KV.get;
    f.env.POLICY_KV.get = async (key, type) => {
      const value = await read(key, type);
      if (dispatchStarted && Array.isArray(key)) { entered(); await held; }
      return value;
    };
  } else f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
    if (dispatchStarted && new URL(request.url).pathname === "/grant-pools/resolve") { entered(); await held; }
  };
  if (cause === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.request({ model: route.includes("native") ? "gpt-6-astra" : "openai/gpt-6-astra", service_tier: "default" }, {}, route, caller.signal);
  await reached;
  if (cause === "caller_abort") caller.abort(new Error("fixture qualification canceled"));
  else t.mock.timers.tick(600_000);
  const outcome = await Promise.race([pending.then(response => ({ response })), new Promise(resolve => setImmediate(() => resolve({ stalled: true })))]);
  if (outcome.stalled) {
    // Release the fixture and collect its HTTP/SQL owner before failing the probe.
    release(); await f.consume(await pending);
    assert.fail("post-dispatch qualification ignored " + cause + " while " + source + " was stalled");
  }
  assert.equal(outcome.response.status, 502); assert.equal(JSON.parse(await f.consume(outcome.response)).error.code, "provider_unavailable");
  const assertUnsentOnce = () => {
    assert.equal(f.sent.length, 0); assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
    assert.equal(f.events[0].status, cause === "deadline" ? "timeout" : "client_error");
    for (const name of ["default:fixture", "provider:openai"]) {
      const rows = f.env.BUDGET_LEDGER.get(name).reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].settled, 1); assert.equal(rows[0].reserved_micros, 0);
      for (const path of ["/reserve", "/dispatch", "/settle"]) assert.equal(operations.filter(op => op.name === name && op.path === path).length, 1);
    }
  };
  assertUnsentOnce();
  // A late successful authority result cannot dispatch or settle a second time.
  release(); await new Promise(resolve => setImmediate(resolve)); await f.drain(); assertUnsentOnce();
});
