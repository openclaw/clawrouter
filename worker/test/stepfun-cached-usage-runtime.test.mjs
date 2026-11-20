import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { observeUsage } = await import("../proxy-response.ts");
const usage = { prompt_tokens: 591, completion_tokens: 120, total_tokens: 711, cached_tokens: 512 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const output = (model, value = usage) => ({ id: "synthetic-chat", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", content: "Synthetic output" }, finish_reason: "stop" }], usage: value });
const streamText = (model, value, terminal = true) => frame({ ...output(model, { ...usage, completion_tokens: 1, total_tokens: 592 }), object: "chat.completion.chunk" })
  + frame({ ...output(model, value), object: "chat.completion.chunk" }) + frame({ ...output(model, value), object: "chat.completion.chunk" }) + (terminal ? "data: [DONE]\n\n" : "");

async function setup(t, options = {}) {
  const id = options.providerId ?? "stepfun", original = snapshot.providers;
  const source = structuredClone(original.find(provider => provider.id === "stepfun")); assert.ok(source);
  // Exact regional binding published in source-owned PR697 at 9d528b3c.
  // This fixture qualifies shared accounting, not provider/snapshot activation.
  if (id === "stepfun-cn") {
    source.id = id; source.config_keys = ["STEPFUN_CN_API_KEY"]; source.base_urls.default = "https://api.stepfun.com/v1";
    source.models = source.models.map(model => ({ ...model, id: `${id}/${model.upstream}` }));
  }
  snapshot.providers = original.filter(provider => provider.id !== id); t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { ...options, providerId: id, configure(provider) { Object.assign(provider, source); } });
  f.model = f.provider.models.find(model => model.capabilities.includes("llm.chat")); assert.ok(f.model);
  f.env[source.config_keys[0]] = "synthetic-stepfun-environment";
  f.upstream = () => {
    const value = options.usage ?? usage; f.wire = options.stream ? streamText(f.model.upstream, value, options.terminal !== false) : JSON.stringify(output(f.model.upstream, value));
    const bytes = new TextEncoder().encode(f.wire); let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(offset + 7, bytes.length); }
    } }), { headers: { "content-type": options.stream ? "text/event-stream" : "application/json" } });
  };
  f.request = () => {
    const body = { model: options.manifest ? f.model.id : f.model.upstream, messages: [{ role: "user", content: "Synthetic fixture" }], max_tokens: 256, stream: !!options.stream };
    return f.call(options.manifest ? `/v1/proxy/${id}/chat_completions` : `/v1/native/${id}/chat/completions`, options.manifest ? { body } : body);
  };
  t.after(f.drain); return f;
}

for (const providerId of ["stepfun", "stepfun-cn"]) for (const manifest of [false, true]) for (const pooled of [false, true]) for (const stream of [false, true]) {
  test(`StepFun ${providerId}/${manifest ? "manifest" : "native"}/${pooled ? "grant" : "environment"}/${stream ? "SSE" : "JSON"} settles gross and cached counts once`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { providerId, manifest, pooled, stream }), response = await f.request();
    assert.equal(response.status, 200, response.ok ? undefined : await response.text()); assert.equal(await response.text(), f.wire); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${f.provider.base_urls.default}/chat/completions`);
    assert.equal(f.sent[0].headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-stepfun-environment");
    const rows = await f.events(); assert.equal(rows.length, 1); const event = rows[0];
    assert.equal(event.input_tokens, 591); assert.equal(event.output_tokens, 120); assert.equal(event.total_tokens, 711); assert.equal(event.cached_input_tokens, 512);
    assert.equal(event.actual_cost_micros, 700); assert.equal(event.cost_basis, "policy_fixed");
    assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
    for (const name of new Set(f.budgetCalls.map(call => call.name))) { const reservations = f.budgets.get(name).reservations(); assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1); }
  });
}

for (const stream of [false, true]) test(`StepFun invalid final cache count cannot discount real ${stream ? "SSE" : "JSON"} accounting`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream, usage: { ...usage, cached_tokens: 592 } }), response = await f.request();
  assert.equal(response.status, 200); await response.text(); await f.drain();
  const [event] = await f.events(); assert.equal(event.input_tokens, 591); assert.equal(event.total_tokens, 711); assert.equal(event.cached_input_tokens, null);
  assert.equal(event.actual_cost_micros, 700); assert.equal(f.sent.length, 1);
});

test("StepFun unfinished SSE cannot certify a cache discount or turn delivery loss into free inference", { timeout: 10_000 }, async t => {
  const f = await setup(t, { stream: true, terminal: false }), response = await f.request(); await response.text(); await f.drain();
  const [event] = await f.events(); assert.equal(event.cached_input_tokens, null); assert.equal(event.total_tokens, null);
  assert.equal(event.actual_cost_micros, 700); assert.equal(f.sent.length, 1);
});

test("StepFun complete-JSON publication observes the same scoped cached usage", async () => {
  let published;
  const context = { providerId: "stepfun", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions" };
  const observed = observeUsage(Response.json(output("step-3.7-flash")), undefined, {
    async push() {}, async end() {}, acceptJson(value) { published = value; },
  }, "openai.chat_completions", undefined, undefined, context);
  await observed.response.json(); assert.deepEqual(published.usage, usage);
  const result = await observed.result; assert.equal(result.tokens.cached, 512); assert.equal(result.tokens.input, 591);
});
