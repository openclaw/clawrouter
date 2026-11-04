import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const provider = snapshot.providers.find(provider => provider.id === "venice");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const models = ["zai-org-glm-5-2", "zai-org-glm-4.7", "venice-uncensored-1-2", "google-gemma-4-31b-it", "kimi-k2-6", "deepseek-v3.2", "qwen3-235b-a22b-thinking-2507", "qwen3-coder-480b-a35b-instruct-turbo", "qwen3-vl-235b-a22b", "grok-4-5", "qwen-3-7-max", "qwen-3-7-plus", "claude-fable-5", "claude-opus-5", "claude-sonnet-4-6", "openai-gpt-56-sol", "zai-org-glm-4.6", "google-gemma-3-27b-it", "kimi-k2-5"];
const charged = [...models.map((_, i) => `venice_card${i}`), "venice_observed", "venice_error", "venice_cancel", "venice_foreign_model", "venice_missing_model", "venice_groktool"];
const ids = [...charged, "venice_unpriced", "venice_foreign"];
const modelFor = id => id.startsWith("venice_card") ? models[Number(id.slice("venice_card".length))] : id === "venice_groktool" ? "grok-4-5" : models[0];

test("actual OpenClaw Venice configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(endpoint); assert.ok(models.every(id => provider.models.some(model => model.upstream === id)));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-venice-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "venice_foreign" ? "openai" : "venice"], models: models.map(id => `venice/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "venice_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/venice", JSON.stringify({ providerId: "venice", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-venice_card0-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "venice_card0");
    const visible = catalog.providers.find(row => row.id === "venice"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "venice/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "venice/" + id && offer.routeKind === "native" && offer.eligible)));

    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-venice-contract.test.ts", import.meta.url),
      testPath: "extensions/venice/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, VENICE_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("venice_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => JSON.stringify(call.body.messages).includes("venice_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    assert.equal(calls.length, charged.length, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-venice");
      const id = charged.find(id => call.body.messages.some(message => message.role === "user" && message.content === `fixture ${id}`)); assert.ok(id);
      const expected = modelFor(id);
      assert.equal(call.body.model, expected);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.equal(call.body.fallbacks, undefined, "the frozen actual client sends no vendor fallback control");
      assert.equal(call.body.stream_options, undefined, "native usage-request compatibility is preserved");
      if (id === "venice_card0") assert.ok(call.body.messages.some(message => message.reasoning_content === "synthetic-prior-thinking"));
      if (id === "venice_error") {
        assert.equal(call.errorReleased, true, "the actual client must observe the valid prefix before the fixture emits its late error");
        assert.notEqual(call.fixtureExpired, true);
      }
      if (id === "venice_groktool") assert.equal(call.body.tools[0].function.parameters.properties.value.minLength, undefined, "actual Grok compatibility removes its unsupported schema keyword");
      assert.equal(call.body.tools[0].function.name, "lookup");
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"), "the actual native serializer retains system instructions");
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of charged) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const [event] = usage.usage.events;
      assert.equal(usage.usage.events.length, 1);
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "venice"); assert.equal(event.model, `venice/${modelFor(id)}`);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, ["venice_error", "venice_foreign_model", "venice_missing_model"].includes(id) ? "provider_error" : id === "venice_cancel" ? "client_error" : "success", id);
      if (["venice_foreign_model", "venice_missing_model"].includes(id)) assert.equal(event.status_code, 502);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["venice_observed", "venice_groktool"].includes(id) ? [4, 3, 7] : [null, null, null]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of ["venice_foreign", "venice_unpriced"]) {
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      assert.equal(usage.budget.spentMicros, 0);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/release-error" && request.method === "POST")
    return fetch("https://fixture.example/release-error", { method: "POST" });
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/venice", { provider: "venice", kind: "api_key", enabled: true, credential: "fixture-upstream-venice" });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, VENICE_API_KEY: "must-not-fallback" }, context);
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    if (request.url === "https://fixture.example/release-error" && request.method === "POST") {
      const call = calls.find(call => call.body.messages.some(message => message.content === "fixture venice_error"));
      if (!call || call.errorReleased) return new Response(null, { status: 409 });
      call.errorReleased = true; return new Response(null, { status: 204 });
    }
    const body = await request.json(); const call = { url: request.url, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("venice_error"), cancel = input.includes("venice_cancel");
    const responseModel = input.includes("venice_foreign_model") ? "zai-org-glm-4.7" : input.includes("venice_missing_model") ? undefined : body.model;
    const tool = input.includes("venice_groktool"), observed = input.includes("venice_observed") || tool;
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: responseModel,
      choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: "callnext", type: "function", function: { name: "lookup", arguments: JSON.stringify({ value: "A &amp; B" }) } }] } : { content: "synthetic-answer" }) }, finish_reason: null }] });
    const wire = first + (failed ? frame({ model: body.model, error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], ...(observed ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : {}) }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire), firstBytes = new TextEncoder().encode(first).byteLength;
    let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (failed && offset === firstBytes && !call.errorReleased) {
        // Gate on actual client receipt, not packet coalescing or a fixed delay.
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.error(new Error("fixture prefix was not observed")); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
          resolve();
        }, 50); });
      }
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
      const end = Math.min(offset + 7, bytes.length, failed && offset < firstBytes ? firstBytes : bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
