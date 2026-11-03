import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { authorityCall } = await import("../authority.ts");
const { snapshot, configuredUpstream, upstreamPath, modelSupportsEndpoint } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");

// Compile the owned source, not the separately serialized provider snapshot.
const { providers } = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs",
  "providers/opencode.provider.yaml", "providers/opencode-go.provider.yaml"], { encoding: "utf8" }));
const active = {
  opencode: { "glm-5.3": "chat_completions", "claude-opus-5": "messages", "gpt-5.6-sol": "responses", "minimax-m3": "chat_completions", "kimi-k3": "chat_completions" },
  "opencode-go": { "glm-5.3": "chat_completions", "deepseek-v4-pro": "chat_completions", "deepseek-v4.1-flash": "chat_completions", "kimi-k3": "chat_completions",
    "kimi-k2.7-code": "chat_completions", "gpt-5.6-luna": "responses", "qwen3.8-max": "messages", hy3: "chat_completions" },
};
const closed = { opencode: ["gemini-3.6-flash", "big-pickle"], "opencode-go": ["deepseek-v4-flash", "kimi-k2.6"] };
const capabilities = { chat_completions: "llm.chat", messages: "llm.messages", responses: "llm.responses" };
const paths = { chat_completions: "/chat/completions", messages: "/v1/messages", responses: "/v1/responses" };
const formats = { chat_completions: "openai.chat_completions", messages: "anthropic.messages", responses: "openai.responses" };
const bindings = { opencode: "OPENCODE_API_KEY", "opencode-go": "OPENCODE_GO_API_KEY" };
const productPrefix = id => id === "opencode" ? "/inference" : "/inference/go";
const destination = (id, endpoint) => `https://opencode.ai${productPrefix(id)}${endpoint === "messages" ? "/anthropic/v1/messages" : endpoint === "responses" ? "/openai/v1/responses" : "/openai/v1/chat/completions"}`;
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 8 } };

function bodyFor(endpoint, model, stream = false) {
  if (endpoint === "responses") return { model, stream, store: false,
    input: [{ type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "synthetic-encrypted" },
      { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fixture", output: "synthetic-result" }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }], include: ["reasoning.encrypted_content"] };
  if (endpoint === "messages") return { model, stream, max_tokens: 256,
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "synthetic-thinking", signature: "synthetic-signature" },
      { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_fixture", content: "synthetic-result" }] }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }] };
  return { model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [{ role: "assistant", content: null,
      tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_fixture", content: "synthetic-result" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
}
function resultFor(endpoint, model) {
  if (endpoint === "responses") return { id: "resp_fixture", object: "response", model, status: "completed", store: false,
    output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic-answer" }] }], usage };
  if (endpoint === "messages") return { id: "msg_fixture", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "synthetic-answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
  return { id: "chat_fixture", object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 8 } } };
}
function streamFor(endpoint, model) {
  const result = resultFor(endpoint, model);
  if (endpoint === "responses") return frame({ type: "response.created", response: { ...result, status: "in_progress", output: [], usage: null } })
    + frame({ type: "response.output_text.delta", delta: "synthetic-answer", output_index: 0, content_index: 0, item_id: "msg_fixture" })
    + frame({ type: "response.completed", response: result });
  if (endpoint === "messages") return frame({ type: "message_start", message: { ...result, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-answer" } })
    + frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) + frame({ type: "message_stop" });
  return `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: result.usage })}\n\ndata: [DONE]\n\n`;
}
function fragmented(wire) {
  const bytes = new TextEncoder().encode(wire); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else { const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end; }
  } }), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(t, id, models = null) {
  const previous = snapshot.providers.find(p => p.id === id), row = structuredClone(providers.find(p => p.id === id));
  assert.ok(previous); snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row);
  t.after(() => snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous));
  const values = new Map(), sent = [], events = [], pending = [], responses = [];
  const other = id === "opencode" ? "opencode-go" : "opencode";
  const env = { OPENCODE_API_KEY: "synthetic-console-environment", OPENCODE_GO_API_KEY: "synthetic-go-environment", OPENAI_API_KEY: "synthetic-lab-key",
    POLICY_KV: { async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
      async put(key, value) { values.set(key, JSON.parse(value)); }, async list() { return { keys: [], list_complete: true }; } },
    BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models, tenantId: "fixture", monthlyBudgetMicros: 100,
    requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy }, { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } },
    { policyId: "foreign", policy: { ...policy, providers: [other] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async key => ({ credentialId: key,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${key}`), policyId: key, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
  await putGrantCredentials(env, `oauth/paid/${id}`, { provider: id, kind: "api_key", enabled: true, credential: `synthetic-selected-${id}` });
  const f = { env, row, sent, events, reply: () => Response.json(resultFor("chat_completions", "glm-5.3")),
    async call(path, body, key = "paid", signal) {
      const response = await worker.fetch(new Request(`https://router.example${path}`, { method: body == null ? "GET" : "POST", signal,
        headers: { authorization: `Bearer clawrouter-live-${key}-fixture-${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01",
          "x-api-key": "synthetic-caller-key", "x-goog-api-key": "synthetic-caller-google-key", "user-agent": "synthetic-caller/1", "x-opencode-session": "synthetic-unbound-session" },
        ...(body == null ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: promise => pending.push(promise) });
      responses.push(response); return response;
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(async () => { for (const response of responses) if (!response.bodyUsed && !response.body?.locked) await response.body?.cancel(); await f.drain(); });
  return f;
}

for (const provider of providers) {
  const id = provider.id, known = active[id];
  test(`${id}: exact frozen roster, native-only bindings, preserved seed and unknown tariffs`, () => {
    assert.deepEqual(provider.models.map(m => m.upstream).sort(), [...Object.keys(known), ...closed[id]].sort());
    assert.equal(provider.base_urls.default, "https://opencode.ai");
    assert.deepEqual(provider.auth.grantTransports, {});
    assert.deepEqual(provider.adapter.injectHeaders, {}); assert.deepEqual(provider.adapter.passthroughHeaders, []);
    for (const model of provider.models) {
      assert.equal(model.id, `${id}/${model.upstream}`); assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
      assert.equal(model.endpointPricing, undefined); assert.equal(model.supportedReasoningEfforts, undefined); assert.equal(model.requestParameters, undefined);
      const endpoint = known[model.upstream];
      assert.deepEqual(model.capabilities, endpoint ? [capabilities[endpoint]] : []);
      for (const route of provider.endpoints) assert.equal(modelSupportsEndpoint(provider, model, route), route.id === endpoint);
      if (endpoint && model.upstream !== "glm-5.3") {
        assert.deepEqual(Object.keys(model.nativeCapabilities.endpoints), [endpoint]);
        const facts = model.nativeCapabilities.endpoints[endpoint];
        assert.equal(facts.inference.chat, true); assert.ok(facts.input.includes("text"));
        for (const field of ["contextWindow", "contextTokens", "maxOutputTokens"]) assert.equal(facts[field], undefined);
      } else assert.equal(model.nativeCapabilities, undefined);
      if (id === "opencode-go" && !endpoint) {
        assert.equal(model.availability.status, "deprecated"); assert.equal(model.availability.servingModel, undefined);
      } else assert.equal(model.availability, undefined);
    }
    for (const [endpoint, format] of Object.entries(formats)) {
      const route = provider.endpoints.find(e => e.id === endpoint);
      assert.equal(route.path, paths[endpoint]); assert.equal(route.request_format, format); assert.equal(route.response_format, format);
      assert.equal(`https://opencode.ai${route.upstreamPath}`, destination(id, endpoint));
      assert.equal(route.responsesLifecycle, undefined); assert.equal(route.websocket, undefined);
      assert.ok(!route.request_headers.includes("x-opencode-session")); assert.ok(!route.request_headers.includes("user-agent"));
    }
  });

  test(`${id}: foreign product credentials cannot configure this product or replace the selected grant`, () => {
    const other = id === "opencode" ? "opencode-go" : "opencode";
    const foreign = { [bindings[other]]: "synthetic-other-product", OPENAI_API_KEY: "synthetic-lab", OPENCODE_ZEN_API_KEY: "synthetic-alias" };
    assert.throws(() => configuredUpstream(provider, null, foreign), e => e.code === "provider_not_configured");
    const auth = configuredUpstream(provider, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-original-grant" },
      { ...foreign, [bindings[id]]: "synthetic-env" });
    assert.equal(auth.headers.get("authorization"), "Bearer synthetic-original-grant");
    assert.equal(auth.baseUrl, "https://opencode.ai");
  });

  for (const [model, endpoint] of Object.entries(known)) for (const mode of ["native", "manifest"]) for (const stream of [false, true]) {
    test(`${id}/${model}: ${mode} ${endpoint} ${stream ? "SSE" : "JSON"} preserves native replay, grant and one settlement`, async t => {
      const f = await fixture(t, id), body = bodyFor(endpoint, model, stream), wire = streamFor(endpoint, model), result = resultFor(endpoint, model);
      let upstreamError;
      f.reply = async request => {
        try {
          assert.equal(request.url, destination(id, endpoint));
          assert.equal(request.headers.get("authorization"), `Bearer synthetic-selected-${id}`);
          for (const header of ["x-api-key", "x-goog-api-key", "x-opencode-session", "user-agent"]) assert.equal(request.headers.get(header), null);
          if (endpoint === "messages") assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
          assert.deepEqual(await request.json(), body);
          assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
          return stream ? fragmented(wire) : Response.json(result);
        } catch (error) { upstreamError = error; throw error; }
      };
      const response = await f.call(mode === "native" ? `/v1/native/${id}${paths[endpoint]}` : `/v1/proxy/${id}/${endpoint}`,
        mode === "native" ? body : { body: { ...body, model: `${id}/${model}` } });
      assert.ifError(upstreamError); assert.equal(response.status, 200, await response.clone().text());
      if (stream) assert.equal(await response.text(), wire); else assert.deepEqual(await response.json(), result);
      await f.drain(); assert.equal(f.sent.length, 1);
      const rows = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "success"); assert.equal(rows[0].actual_cost_micros, 7);
      assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens], [100, 20, 120]);
      assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:encrypted|thinking|signature|result|answer|selected|unbound|caller)/);
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations(); assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1);
    });
  }

  for (const [model, endpoint] of Object.entries(known)) if (endpoint !== "chat_completions") {
    test(`${id}/${model}: known native ${endpoint} cannot revive through Chat or model passthrough`, async t => {
      const f = await fixture(t, id);
      for (const name of [model, `${id}/${model}`]) {
        const body = bodyFor("chat_completions", name);
        for (const [path, request] of [[`/v1/native/${id}/chat/completions`, body], [`/v1/proxy/${id}/chat_completions`, { body }]]) {
          const response = await f.call(path, request); assert.equal(response.status, 400, await response.clone().text()); await response.text();
        }
      }
      const unified = await f.call("/v1/chat/completions", bodyFor("chat_completions", `${id}/${model}`));
      assert.equal(unified.status, 400, await unified.clone().text()); await unified.text(); await f.drain(); assert.equal(f.sent.length, 0);
    });
  }

  for (const model of closed[id]) test(`${id}/${model}: known closed row cannot execute through any declared API`, async t => {
    const f = await fixture(t, id);
    for (const endpoint of Object.keys(paths)) for (const name of [model, `${id}/${model}`]) {
      const body = bodyFor(endpoint, name);
      const response = await f.call(`/v1/proxy/${id}/${endpoint}`, { body });
      assert.equal(response.status, 400, await response.clone().text()); await response.text();
    }
    const r = await f.call(`/v1/native/${id}/chat/completions`, bodyFor("chat_completions", model));
    assert.equal(r.status, 400, await r.clone().text()); await r.text(); await f.drain(); assert.equal(f.sent.length, 0);
  });

  for (const endpoint of Object.keys(paths)) {
    const model = Object.keys(known).find(m => known[m] === endpoint);
    test(`${id}: ${endpoint} rejects foreign policy and unknown price before egress`, async t => {
      const f = await fixture(t, id), body = bodyFor(endpoint, model);
      assert.equal((await f.call(`/v1/native/${id}${paths[endpoint]}`, body, "foreign")).status, 403);
      assert.equal((await f.call(`/v1/native/${id}${paths[endpoint]}`, body, "unpriced")).status, 400);
      assert.equal(f.sent.length, 0);
    });
    test(`${id}: ${endpoint} HTTP rejection preserves failure without fabricated usage`, async t => {
      const f = await fixture(t, id);
      f.reply = () => Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "synthetic-upstream-error" } }, { status: 429 });
      const r = await f.call(`/v1/native/${id}${paths[endpoint]}`, bodyFor(endpoint, model)); assert.equal(r.status, 429); await r.text(); await f.drain();
      assert.equal(f.sent.length, 1); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
      assert.equal(event.status, "provider_error"); assert.equal(event.total_tokens, null);
    });
    test(`${id}: ${endpoint} SSE cancellation cancels the transport and preserves unknown usage`, async t => {
      const f = await fixture(t, id); let cancelled = false;
      f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": fixture\n\n")); }, cancel() { cancelled = true; } },
        { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      const r = await f.call(`/v1/native/${id}${paths[endpoint]}`, bodyFor(endpoint, model, true)); assert.equal(r.status, 200);
      const reader = r.body.getReader(); await reader.read(); await reader.cancel(); await f.drain(); assert.equal(cancelled, true);
      const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.status, "client_error"); assert.equal(event.total_tokens, null);
    });
  }

  test(`${id}: catalog binds only the selected native API and omits closed offers`, async t => {
    const f = await fixture(t, id), r = await f.call("/v1/catalog"); assert.equal(r.status, 200, await r.clone().text());
    const catalog = await r.json(), visible = catalog.providers.find(p => p.id === id);
    for (const [model, endpoint] of Object.entries(known)) {
      const offers = visible.offers.filter(o => o.modelId === `${id}/${model}`);
      assert.ok(offers.length); assert.ok(offers.every(o => o.endpoint === endpoint && o.policyId === "paid"));
      assert.ok(offers.some(o => o.routeKind === "native" && o.route === `/v1/native/${id}${paths[endpoint]}`));
    }
    for (const model of closed[id]) assert.ok(!visible.offers.some(o => o.modelId === `${id}/${model}`));
    assert.equal(f.sent.length, 0);
  });
}

test("Console Gemini templates retain exact frozen path/query facts without activating a model or a mapped template", async t => {
  const f = await fixture(t, "opencode"), auth = configuredUpstream(f.row, null, { OPENCODE_API_KEY: "synthetic-template-key" });
  for (const [endpointId, suffix] of [["generate_content", "generateContent"], ["stream_generate_content", "streamGenerateContent"]]) {
    const endpoint = f.row.endpoints.find(e => e.id === endpointId);
    assert.equal(endpoint.upstreamPath, undefined); assert.deepEqual(endpoint.path_params, ["model"]);
    const path = `/inference/google/v1beta/models/gemini-3.6-flash:${suffix}`;
    assert.equal(upstreamPath(f.row, endpoint, { model: "gemini-3.6-flash" }, {}, auth), path);
    assert.deepEqual(endpoint.query, suffix === "generateContent" ? {} : { alt: "sse" });
    const body = { contents: [{ role: "user", parts: [{ text: "synthetic-input" }] }] };
    const native = await f.call(`/v1/native/opencode${path}${suffix === "generateContent" ? "" : "?alt=sse"}`, body);
    assert.equal(native.status, 400, await native.clone().text()); await native.text();
    const manifest = await f.call(`/v1/proxy/opencode/${endpointId}`, { pathParams: { model: "opencode/gemini-3.6-flash" }, body });
    assert.equal(manifest.status, 400, await manifest.clone().text()); await manifest.text();
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});
