import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import worker from "../index.ts";
import { authorityCall } from "../authority.ts";
import { snapshot } from "../providers.ts";
import { sha256Hex } from "../utils.ts";

// Compile this source manifest independently of the serialized shared snapshot.
const { providers: [meta] } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/meta.provider.yaml"], { encoding: "utf8" }));
const model = "muse-spark-1.3";
const input = [
  { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "synthetic-encrypted-replay" },
  { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "synthetic-preamble" }] },
  { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}" },
  { type: "function_call_output", call_id: "call_fixture", output: "synthetic-tool-result" },
];
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 8 } };
const result = { id: "resp_meta_fixture", object: "response", model, status: "completed", store: false,
  output: [{ type: "message", id: "msg_fixture", status: "completed", role: "assistant", content: [{ type: "output_text", text: "synthetic-answer" }] }], usage };
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

async function fixture(t, models = null) {
  const row = snapshot.providers.find(p => p.id === "meta"), original = structuredClone(row);
  Object.assign(row, structuredClone(meta));
  t.after(() => Object.assign(row, original));
  const values = new Map(), events = [], pending = [], sent = [];
  const env = { MODEL_API_KEY: "synthetic-meta-key", OPENAI_API_KEY: "synthetic-foreign-key",
    POLICY_KV: {
      async get(key) { return Array.isArray(key) ? new Map(key.map(k => [k, values.get(k) ?? null])) : values.get(key) ?? null; },
      async put(key, value) { values.set(key, JSON.parse(value)); },
      async list() { return { keys: [], list_complete: true }; },
    }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(event) { events.push(event); } },
  };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  const policy = { enabled: true, generation: "fixture", providers: ["meta"], models, tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [
    { policyId: "paid", policy }, { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } },
    { policyId: "foreign", policy: { ...policy, providers: ["synthetic"] } },
  ]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async id => ({
    credentialId: id, credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${id}`), policyId: id, policyGeneration: "fixture" },
  }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "meta", enabled: true }]);
  const f = { env, events, sent, reply: () => Response.json(result),
    call(path, body, key = "paid", method = body == null ? "GET" : "POST") {
      return worker.fetch(new Request(`https://router.example${path}`, { method,
        headers: { authorization: `Bearer clawrouter-live-${key}-fixture-${key}`, "content-type": "application/json" },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
      }), env, { waitUntil: promise => pending.push(promise) });
    },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain);
  return f;
}

test("Meta retains exactly the six frozen cards, explicit Contributor identities and unknown prices", () => {
  assert.deepEqual(meta.models.map(m => m.upstream).sort(), ["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.3-contributor",
    "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.1"].sort());
  for (const m of meta.models) {
    assert.equal(m.id, `meta/${m.upstream}`);
    assert.equal(m.pricing, null);
    assert.deepEqual(m.capabilities, ["llm.chat", "llm.responses"]);
    assert.equal(m.nativeCapabilities.endpoints.responses.contextWindow, 1048576);
    assert.equal(m.nativeCapabilities.endpoints.responses.maxOutputTokens, undefined);
  }
  assert.deepEqual(meta.endpoints.find(e => e.id === "responses").responsesLifecycle,
    { retrieve: "responses_retrieve", cancel: "responses_cancel" });
  assert.equal(meta.endpoints.find(e => e.id === "chat_completions").path, "/chat/completions");
});

for (const dispatch of ["native", "manifest"]) for (const stream of [false, true]) {
  test(`Meta ${dispatch} Responses ${stream ? "SSE" : "JSON"} preserves replay and settles once`, async t => {
    const f = await fixture(t);
    const body = { model: dispatch === "manifest" ? `meta/${model}` : model, input, tools,
      store: false, stream, include: ["reasoning.encrypted_content"], reasoning: { effort: "high" } };
    const wire = frame({ type: "response.created", response: { ...result, status: "in_progress", usage: null, output: [] } })
      + frame({ type: "response.output_text.delta", delta: "synthetic-answer", output_index: 0, content_index: 0, item_id: "msg_fixture" })
      + frame({ type: "response.completed", response: result });
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, "https://api.meta.ai/v1/responses");
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-meta-key");
        assert.deepEqual(await request.json(), { ...body, model });
        assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(result);
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) {
          if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; }
        } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const response = await f.call(dispatch === "native" ? "/v1/native/meta/responses" : "/v1/proxy/meta/responses",
      dispatch === "native" ? body : { body });
    assert.ifError(upstreamError);
    assert.equal(response.status, 200, await response.clone().text());
    if (stream) assert.equal(await response.text(), wire); else assert.deepEqual(await response.json(), result);
    await f.drain();
    assert.equal(f.sent.length, 1);
    const rows = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "success");
    assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens], [100, 20, 120]);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:encrypted|tool|answer|meta-key|preamble)/);
    const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
    assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1); assert.equal(reservations[0].reserved_micros, 7);
  });
}

test("Meta rejects foreign policy and unknown tariffs before upstream egress", async t => {
  const f = await fixture(t), body = { model, input: "fixture", store: false };
  assert.equal((await f.call("/v1/native/meta/responses", body, "foreign")).status, 403);
  assert.equal((await f.call("/v1/native/meta/responses", body, "unpriced")).status, 400);
  assert.equal(f.sent.length, 0);
});

test("Meta HTTP-200 terminal failures are provider errors without fabricated token usage", async t => {
  const f = await fixture(t);
  f.reply = () => new Response(frame({ type: "response.failed", response: { ...result, status: "failed", usage: null,
    output: [], error: { code: "server_error", message: "synthetic-error" } } }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call("/v1/native/meta/responses", { model, input: "fixture", stream: true, store: false });
  await r.text(); await f.drain();
  const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.equal(event.status, "provider_error"); assert.equal(event.input_tokens, null); assert.equal(event.output_tokens, null);
});

test("Meta streaming disconnect cancels transport without claiming upstream execution stopped", async t => {
  const f = await fixture(t); let cancelled = false;
  f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: "fixture" }))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const r = await f.call("/v1/native/meta/responses", { model, input: "fixture", stream: true, store: false });
  assert.equal(r.status, 200);
  const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel(); await f.drain();
  assert.equal(cancelled, true);
  const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
  assert.equal(event.status, "client_error"); assert.equal(event.total_tokens, null);
});

test("Meta model discovery preserves the OpenAI envelope and filters the caller's model scope", async t => {
  const f = await fixture(t, [`meta/${model}`]);
  f.reply = request => {
    assert.equal(request.url, "https://api.meta.ai/v1/models");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-meta-key");
    return Response.json({ object: "list", data: [{ id: model, object: "model" }, { id: "muse-spark-1.3-contributor", object: "model" }] });
  };
  const r = await f.call("/v1/native/meta/models"); assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { object: "list", data: [{ id: model, object: "model" }] });
  await f.drain(); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 0);
});

test("Meta response controls require an owned create and preserve the original endpoint and key", async t => {
  const f = await fixture(t);
  const missing = await f.call("/v1/native/meta/responses/resp_unknown");
  assert.notEqual(missing.status, 200); assert.equal(f.sent.length, 0);
  f.reply = () => Response.json({ ...result, status: "queued", background: true, store: true, output: [], usage: null });
  const create = await f.call("/v1/native/meta/responses", { model, input: "fixture", background: true, store: true });
  assert.equal(create.status, 200, await create.clone().text()); await create.json(); await f.drain();
  f.reply = request => {
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-meta-key");
    assert.ok(["https://api.meta.ai/v1/responses/resp_meta_fixture", "https://api.meta.ai/v1/responses/resp_meta_fixture/cancel"].includes(request.url));
    assert.equal(request.body, null);
    return Response.json({ ...result, background: true, store: true });
  };
  const retrieve = await f.call("/v1/native/meta/responses/resp_meta_fixture");
  assert.equal(retrieve.status, 200, await retrieve.clone().text()); await retrieve.json(); await f.drain();
  const cancel = await f.call("/v1/native/meta/responses/resp_meta_fixture/cancel", undefined, "paid", "POST");
  assert.equal(cancel.status, 200, await cancel.clone().text());
  assert.equal((await cancel.json()).status, "completed", "a cancel race may return completed, never infer a refund");
  await f.drain(); assert.equal(f.sent.length, 3);
  const ledger = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
  assert.equal(ledger.length, 1); assert.equal(ledger[0].settled, 1); assert.equal(ledger[0].reserved_micros, 7);
});
