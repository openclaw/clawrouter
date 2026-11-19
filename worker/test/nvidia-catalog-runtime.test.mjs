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
const { snapshot } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const { providers: [provider] } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/nvidia.provider.yaml"], { encoding: "utf8" }));
const models = ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b", "moonshotai/kimi-k2.6"];
const excluded = ["meta/llama-3.1-8b-instruct", "synthetic/embedding", "synthetic/unknown"];
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const result = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }], usage });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

async function fixture(t, { ownGrant = true } = {}) {
  const index = snapshot.providers.findIndex(p => p.id === "nvidia"), previous = snapshot.providers[index];
  assert.ok(index >= 0); snapshot.providers[index] = structuredClone(provider);
  t.after(() => { snapshot.providers[index] = previous; });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { CEREBRAS_API_KEY: "synthetic-foreign", NGC_API_KEY: "synthetic-container-key", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: ["nvidia"], models: [...models, ...excluded].map(m => `nvidia/${m}`),
    tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["cerebras"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", [{ providerId: "nvidia", enabled: true }]);
  await putGrantCredentials(env, "oauth/paid/cerebras", { provider: "cerebras", kind: "api_key", enabled: true, credential: "synthetic-other-grant" });
  for (const p of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${p}/nvidia`, {
    provider: "nvidia", kind: "api_key", enabled: true, credential: "synthetic-selected" });
  const f = { env, events, sent, reply: () => Response.json(result(models[0])),
    call(body, { manifest = false, policyId = "paid" } = {}) {
      return worker.fetch(new Request(`https://router.example${manifest ? "/v1/proxy/nvidia/chat_completions" : "/v1/native/nvidia/chat/completions"}`, {
        method: "POST", headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

test("NVIDIA manifest exposes exactly four frozen identities with unknown prices and no passthrough", () => {
  assert.deepEqual(provider.models.map(m => m.upstream), models);
  for (const m of provider.models) { assert.equal(m.id, `nvidia/${m.upstream}`); assert.equal(m.pricing, null); }
  assert.equal(provider.endpoints.find(e => e.id === "chat_completions").modelPassthrough, undefined);
});

for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
  test(`NVIDIA ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves native parameters and one ledger charge`, async t => {
    const f = await fixture(t), body = { model, stream, max_tokens: 256, messages: [{ role: "user", content: "synthetic-input" }] };
    if (model === models[0]) Object.assign(body, { reasoning_effort: "medium", chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true } });
    if (model === models[1]) Object.assign(body, { reasoning_budget: 128, chat_template_kwargs: { enable_thinking: true } });
    if (model === models[2] || model === models[3]) {
      Object.assign(body, { stream_options: { include_usage: true },
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] });
      body.messages = [{ role: "assistant", content: null, reasoning_content: "synthetic-reasoning",
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" },
      { role: "user", content: [{ type: "text", text: "synthetic-input" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=" } }] }];
      Object.assign(body, model === models[2] ? { reasoning_effort: "low" } : { chat_template_kwargs: { thinking: true } });
    }
    const toolWire = model === models[2] || model === models[3]
      ? frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] })
        + frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] }) : "";
    const wire = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning", content: "synthetic-answer" }, finish_reason: null }] })
      + toolWire + frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [], usage }) + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async r => {
      try {
        assert.equal(r.url, "https://integrate.api.nvidia.com/v1/chat/completions");
        assert.equal(r.headers.get("authorization"), "Bearer synthetic-selected"); assert.equal(r.headers.get("x-api-key"), null);
        assert.deepEqual(await r.json(), body); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(result(model));
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) {
          if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; }
        } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `nvidia/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), result(model));
    await f.drain(); assert.equal(f.sent.length, 1);
    const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
    assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens, events[0].cached_input_tokens, events[0].actual_cost_micros], [100, 20, 120, 40, 7]);
    assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].settled, 1);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-(?:selected|reasoning|tool-result|answer)/);
  });
}

test("NVIDIA excludes deprecated and unclassified IDs even when policy permits them", async t => {
  const f = await fixture(t);
  for (const model of excluded) for (const manifest of [false, true]) {
    const r = await f.call({ model: manifest ? `nvidia/${model}` : model, messages: [] }, { manifest });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, "model_capability_unsupported");
  }
  assert.equal(f.sent.length, 0);
});

test("NVIDIA foreign policy and unknown price fail before egress", async t => {
  const f = await fixture(t), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
  assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
});

test("NVIDIA absent or revoked original grant cannot borrow a container key or foreign provider grant", async t => {
  const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
  assert.equal((await f.call(body)).status, 503);
  await putGrantCredentials(f.env, "oauth/paid/nvidia", { provider: "nvidia", kind: "api_key", enabled: true, credential: "synthetic-revoked" });
  await revokeGrantCredentials(f.env, "oauth/paid/nvidia"); assert.equal((await f.call(body)).status, 503); assert.equal(f.sent.length, 0);
});

for (const status of [401, 403, 429]) test(`NVIDIA ${status} cannot trigger another model, credential or endpoint`, async t => {
  const f = await fixture(t); f.reply = () => Response.json({ error: { code: "synthetic_rejection", message: "synthetic-error" } }, { status });
  const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status); await r.text(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.events.find(e => e.type === "clawrouter.usage.v1").actual_cost_micros, 0);
});

for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) {
  test(`NVIDIA ${manifest ? "manifest" : "native"} ${outcome} preserves unknown usage and cancels the selected stream`, async t => {
    const f = await fixture(t), model = models[3]; let canceled = false;
    const chunk = frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] });
    const wire = outcome === "embedded-error" ? frame({ error: { code: "synthetic_error", message: "synthetic-error" } })
      : chunk + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
    f.reply = () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call({ model: manifest ? `nvidia/${model}` : model, messages: [], stream: true }, { manifest });
    assert.equal(r.status, 200);
    if (outcome === "disconnect") {
      const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true);
    } else assert.equal(await r.text(), wire);
    await f.drain(); assert.equal(f.sent.length, 1);
    const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
    assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], [null, null, null]);
    assert.equal(events[0].status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(events[0].actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
    assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 1);
  });
}
