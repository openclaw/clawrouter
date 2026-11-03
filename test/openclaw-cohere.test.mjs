import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "b566e9a6b22a863bf0f1f869f106a2a91b062f16";
const provider = snapshot.providers.find(provider => provider.id === "cohere");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const model = provider.models.find(model => model.upstream === "command-a-plus-05-2026");
const ids = ["cohere_stream", "cohere_simple", "cohere_error", "cohere_cancel", "cohere_unpriced", "cohere_foreign"];

test("actual OpenClaw Cohere compatibility hooks through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(endpoint && model);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-cohere-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "cohere_foreign" ? "openai" : "cohere"], models: [model.id], tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "cohere_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/cohere", JSON.stringify({ providerId: "cohere", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-cohere-contract.test.ts", import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, COHERE_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("cohere_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("cohere_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    assert.equal(calls.length, 4, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-cohere");
      assert.equal(call.body.model, model.upstream);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens, 128);
      for (const field of ["tool_choice", "store", "stream_options", "max_completion_tokens"]) assert.ok(!(field in call.body), field);
      assert.equal(call.body.tools[0].function.name, "lookup");
      assert.ok(call.body.messages.some(message => message.role === "developer" && message.content === "Synthetic instructions"), "the native client owns the system/developer mapping");
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "call_fixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of ids.slice(0, 4)) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const [event] = usage.usage.events;
      assert.equal(usage.usage.events.length, 1);
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "cohere"); assert.equal(event.model, model.id);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "cohere_error" ? "provider_error" : id === "cohere_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "cohere_error" || id === "cohere_cancel" ? [null, null, null] : [4, 3, 7]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
export default { ...handler, fetch(request, env, context) { return handler.fetch(request, { ...env, COHERE_API_KEY: "fixture-upstream-cohere" }, context); } };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(); const call = { url: request.url, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("cohere_error"), cancel = input.includes("cohere_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        // Heartbeats keep the synthetic request live and make downstream
        // disconnection observable. The bound never substitutes for an abort.
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
          resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
