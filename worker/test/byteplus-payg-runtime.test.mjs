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
const { snapshot, configuredUpstream } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const contracts = [["byteplus", "BYTEPLUS_API_KEY", "https://ark.ap-southeast.bytepluses.com/api/v3"]];
const inventory = { byteplus: ["dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328", "glm-5-2-260617", "deepseek-v4-pro-260425", "deepseek-v4-flash-260425"] };
const unqualified = { byteplus: ["glm-4-7-251222"] };
const imageModels = new Set(["dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328"]);
const { providers } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));
const model = "dola-seed-2-1-turbo-260628", frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const result = { id: "chatcmpl_fixture", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }], usage };

async function fixture(t, id, { ownGrant = true } = {}) {
  const previous = snapshot.providers.filter(p => p.id === id);
  for (const row of previous) snapshot.providers.splice(snapshot.providers.indexOf(row), 1);
  const rows = structuredClone(providers); snapshot.providers.push(...rows);
  t.after(() => { for (const row of rows) snapshot.providers.splice(snapshot.providers.indexOf(row), 1); snapshot.providers.push(...previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { VOLCANO_ENGINE_API_KEY: "synthetic-foreign-region", VOLCENGINE_PLAN_API_KEY: "synthetic-coding-plan", BYTEPLUS_PLAN_API_KEY: "synthetic-foreign-plan", ARK_API_KEY: "synthetic-unscoped", POLICY_KV: {
      async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
      async put(k, v) { values.set(k, JSON.parse(v)); },
    }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: [...inventory[id], ...unqualified[id]].map(m => `${id}/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["volcengine"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", contracts.map(([providerId]) => ({ providerId, enabled: true })));
  for (const foreignId of ["volcengine", "volcengine-plan", "byteplus-plan"]) {
    await putGrantCredentials(env, `oauth/paid/${foreignId}`, { provider: foreignId, kind: "api_key", enabled: true, credential: "synthetic-foreign-product" });
  }
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/${id}`, {
    provider: id, kind: "api_key", enabled: true, credential: "synthetic-selected-credential" });
  const f = { env, events, sent, grantKey: `oauth/paid/${id}`, reply: () => Response.json(result),
    call(body, { manifest = false, policyId = "paid", routeId = id } = {}) {
      return worker.fetch(new Request(`https://router.example${manifest ? `/v1/proxy/${routeId}/chat_completions` : `/v1/native/${routeId}/chat/completions`}`, {
        method: "POST", headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

for (const [id, binding, base] of contracts) {
  const frozen = inventory[id];
  test(`${id} preserves the qualified frozen identities without pricing or cross-product credential fallback`, () => {
    const provider = providers.find(p => p.id === id);
    assert.deepEqual(provider.models.map(m => m.upstream), [...frozen, ...unqualified[id]]);
    for (const m of provider.models) { assert.equal(m.id, `${id}/${m.upstream}`); assert.equal(m.pricing, null); assert.equal(m.supportedReasoningEfforts, undefined); assert.equal(m.requestParameters, undefined);
      if (frozen.includes(m.upstream)) { const facts = m.nativeCapabilities.endpoints.chat_completions;
        assert.deepEqual(facts.input, imageModels.has(m.upstream) ? ["text", "image"] : ["text"]);
        assert.equal(facts.contextWindow, undefined); assert.equal(facts.maxOutputTokens, undefined);
      } else { assert.deepEqual(m.capabilities, []); assert.equal(m.availability, undefined); assert.equal(m.nativeCapabilities, undefined); } }
    const foreign = { VOLCANO_ENGINE_API_KEY: "synthetic-foreign-region", VOLCENGINE_PLAN_API_KEY: "synthetic-coding-plan", BYTEPLUS_PLAN_API_KEY: "synthetic-foreign-plan", ARK_API_KEY: "synthetic-unscoped" };
    assert.throws(() => configuredUpstream(provider, null, foreign), e => e.code === "provider_not_configured");
    const selected = configuredUpstream(provider, null, { ...foreign, [binding]: "synthetic-explicit-credential" });
    assert.equal(selected.baseUrl, base); assert.equal(selected.headers.get("authorization"), "Bearer synthetic-explicit-credential");
    assert.deepEqual(provider.auth.grantTransports, {});
  });

  for (const model of frozen) for (const manifest of [false, true]) for (const stream of [false, true]) test(`${id} ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} pins region, grant, replay and one reservation`, async t => {
    const f = await fixture(t, id), body = { model, stream, max_tokens: 256, thinking: { type: "enabled" },
      messages: [{ role: "assistant", content: null, reasoning_content: "synthetic-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
    const wire = frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning", content: "synthetic-answer" }, finish_reason: null }] })
      + frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] })
      + frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }], usage }) + "data: [DONE]\n\n";
    let upstreamError;
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-credential"); assert.equal(request.headers.get("x-api-key"), null);
        assert.deepEqual(await request.json(), body); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json({ ...result, model });
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamError = e; throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
    assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
    if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), { ...result, model });
    await f.drain(); assert.equal(f.sent.length, 1);
    const rows = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(rows.length, 1); assert.equal(rows[0].status, "success");
    assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens, rows[0].cached_input_tokens, rows[0].actual_cost_micros], [100, 20, 120, 40, 7]);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
    const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations(); assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1);
  });

  test(`${id} rejects Volcengine policy, foreign model and unknown pricing before egress`, async t => {
    const f = await fixture(t, id), body = { model, messages: [], max_tokens: 16 };
    assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
    assert.equal((await f.call({ ...body, model: "unpermitted-model" })).status, 403);
    assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400);
    assert.equal(f.sent.length, 0);
  });

  test(`${id} missing or revoked credential never borrows a different region, plan or legacy global key`, async t => {
    const f = await fixture(t, id, { ownGrant: false }), body = { model, messages: [] };
    assert.equal((await f.call(body)).status, 503);
    await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-revoked" });
    await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503); assert.equal(f.sent.length, 0);
  });

  for (const status of [401, 403, 429]) test(`${id} upstream ${status} never retries another region or billing product`, async t => {
    const f = await fixture(t, id);
    f.reply = () => Response.json({ error: { code: "plan_unavailable", message: "synthetic-plan-rejection" } }, { status });
    const r = await f.call({ model, messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.actual_cost_micros, 0);
  });
  test(`${id} routes every frozen model without changing its native identity`, async t => {
    const f = await fixture(t, id);
    for (const selected of frozen) {
      const body = { model: selected, messages: [{ role: "user", content: "synthetic-input" }], thinking: { type: "enabled" } };
      f.reply = () => Response.json({ ...result, model: selected });
      const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).model, selected);
      assert.deepEqual(await f.sent.at(-1).json(), body);
    }
    await f.drain(); assert.equal(f.sent.length, frozen.length);
  });

  for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`${id} ${manifest ? "manifest" : "native"} ${outcome} preserves unknown usage and product isolation`, async t => {
    const f = await fixture(t, id);
    const chunk = frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] });
    const wire = outcome === "embedded-error" ? frame({ error: { code: "plan_exhausted", message: "synthetic-plan-error" } }) : chunk + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
    let canceled = false;
    f.reply = () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [], stream: true }, { manifest });
    assert.equal(r.status, 200);
    if (outcome === "disconnect") {
      const reader = r.body.getReader(); assert.equal((await reader.read()).done, false);
      await reader.cancel("synthetic disconnect"); assert.equal(canceled, true);
    } else assert.equal(await r.text(), wire);
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
    assert.equal(event.cost_basis, outcome === "embedded-error" ? "none" : "policy_fixed");
    assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 1);
  });

  test(`${id} rejects aliased, deprecated or unqualified frozen cards even when the policy permits their names`, async t => {
    const provider = providers.find(p => p.id === id), f = await fixture(t, id);
    assert.ok(provider.endpoints.find(e => e.id === "chat_completions").modelPassthrough);
    for (const blocked of unqualified[id]) for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `${id}/${blocked}` : blocked, messages: [] }, { manifest });
      assert.equal(r.status, 400); assert.equal((await r.json()).error.code, "model_capability_unsupported");
    }
    assert.equal(f.sent.length, 0);
  });

  test(`${id} preserves the requested and observed serving identities separately`, async t => {
    const f = await fixture(t, id), observed = { ...result, model: "synthetic-serving-model" };
    f.reply = () => Response.json(observed);
    const r = await f.call({ model, messages: [] }); assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), observed); assert.equal((await f.sent[0].json()).model, model);
    await f.drain();
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
  });

}
