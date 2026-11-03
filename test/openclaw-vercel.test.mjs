import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const diagnostic = process.env.CLAWROUTER_VERCEL_DIAGNOSTIC === "first";
const sourceHead = "0093b58c0d132ae1707f9553839f1cf297fb9a25";
const modelId = "vercel-ai-gateway/anthropic/claude-sonnet-4.6";
const ids = ["vercel_stream", "vercel_simple", "vercel_error", "vercel_cancel", "vercel_unpriced", "vercel_foreign", "vercel_chat_only"];

test("actual Vercel catalog, replay, Anthropic SDK and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(provider => provider.id === "vercel-ai-gateway");
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  assert.equal(endpoint.path, "/v1/messages"); assert.equal(endpoint.upstreamPath, "/messages");
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-vercel-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "vercel_foreign" ? "anthropic" : provider.id], models: [modelId], tenantId: "fixture", monthlyBudgetMicros: 100,
        requestCostMicros: ["vercel_unpriced", "vercel_chat_only"].includes(id) ? null : 7,
        ...(id === "vercel_chat_only" ? { requestCostsMicros: { "llm.chat": 7 } } : {}), budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put(`connections/${provider.id}`, JSON.stringify({ providerId: provider.id, enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    const headers = { authorization: "Bearer clawrouter-live-vercel_chat_only-fixture-secret" };
    const catalog = await (await fetch(`${origin}/v1/catalog`, { headers })).json();
    const offers = catalog.providers.find(row => row.id === provider.id).offers;
    assert.ok(offers.some(offer => offer.modelId === modelId && offer.endpoint === "chat_completions" && offer.eligible));
    assert.ok(offers.some(offer => offer.modelId === modelId && offer.endpoint === "messages" && !offer.eligible && offer.reasonCode === "pricing_required"));
    let consumerError;
    try {
      await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-vercel-contract.test.ts", import.meta.url),
        testPath: "src/agents/worker-contract.test.ts", testNamePattern: diagnostic ? "simple=false" : undefined,
        env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_VERCEL_DIAGNOSTIC: diagnostic ? "first" : "" } });
    } catch (error) { consumerError = error; }
    const upstream = await mf.getWorker("upstream");
    if (diagnostic || consumerError) {
      const observed = await (await upstream.fetch("https://fixture.example/state")).json();
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: "Bearer clawrouter-live-vercel_stream-fixture-secret" } })).json();
      t.diagnostic(JSON.stringify({ phase: "first-call-worker-evidence", upstreamHits: observed.length, spentMicros: usage.budget.spentMicros,
        events: usage.usage.events.map(event => ({ status: event.status, basis: event.cost_basis, cost: event.actual_cost_micros,
          input: event.input_tokens, output: event.output_tokens, total: event.total_tokens })) }));
    }
    if (consumerError) throw consumerError;
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("vercel_cancel"));
      if (diagnostic || cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(calls.length, diagnostic ? 1 : 4, "denied calls have zero egress; failed generation does not replay or fall back to Chat");
    const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("vercel_cancel"));
    if (!diagnostic) { assert.ok(cancelled?.cancelled || cancelled?.aborted); assert.notEqual(cancelled.fixtureExpired, true); }
    for (const call of calls) {
      assert.equal(call.url, "https://ai-gateway.vercel.sh/v1/messages");
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-vercel");
      assert.equal(call.headers["x-api-key"], undefined);
      assert.equal(call.headers["anthropic-version"], "2023-06-01");
      assert.equal(call.body.model, "anthropic/claude-sonnet-4.6"); assert.equal(call.body.stream, true); assert.equal(call.body.max_tokens, 100);
      const blocks = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      const use = blocks.find(block => block.type === "tool_use"), answer = blocks.find(block => block.type === "tool_result");
      assert.equal(use.name, "lookup"); assert.deepEqual(use.input, { index: 1 }); assert.match(use.id, /^[a-zA-Z0-9_-]+$/);
      assert.equal(answer.tool_use_id, use.id); assert.equal(answer.content, "synthetic record");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|clawrouterRoute/);
    }
    for (const id of ids.slice(0, diagnostic ? 1 : 4)) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); assert.equal(usage.budget.spentMicros, 7);
      const [event] = usage.usage.events;
      assert.equal(event.provider, provider.id); assert.equal(event.model, modelId);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "vercel_error" ? "provider_error" : id === "vercel_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["vercel_error", "vercel_cancel"].includes(id) ? [null, null, null] : [11, 3, 14]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic record|fixture-upstream|must-not-fallback/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
    export default { ...handler, fetch(request, env, context) { return handler.fetch(request, { ...env, AI_GATEWAY_API_KEY: "fixture-upstream-vercel" }, context); } };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(), call = { url: request.url, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), failed = input.includes("vercel_error"), cancel = input.includes("vercel_cancel");
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-answer" } },
      ...(failed ? [{ type: "error", error: { type: "overloaded_error", message: "synthetic-upstream-error" } }] : cancel ? [] : [
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" }]),
    ];
    const bytes = new TextEncoder().encode(events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join(""));
    let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n")); resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
