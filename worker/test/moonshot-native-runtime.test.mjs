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
const contracts = [
  ["moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1"],
  ["moonshot-cn", "MOONSHOT_CN_API_KEY", "https://api.moonshot.cn/v1"],
];
const models = ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"];
const { providers } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
  choices: [{ index: 0, message: { role: "assistant", reasoning_content: "synthetic-reasoning", content: "synthetic-answer" }, finish_reason: "stop" }], usage });

async function fixture(t, id, { ownGrant = true } = {}) {
  const previous = snapshot.providers.filter(p => contracts.some(([name]) => p.id === name));
  for (const row of previous) snapshot.providers.splice(snapshot.providers.indexOf(row), 1);
  const rows = structuredClone(providers); snapshot.providers.push(...rows);
  t.after(() => { for (const row of rows) snapshot.providers.splice(snapshot.providers.indexOf(row), 1); snapshot.providers.push(...previous); });
  const values = new Map(), pending = [], events = [], sent = [];
  const env = { KIMI_API_KEY: "synthetic-code-key", POLICY_KV: {
    async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
    async put(k, v) { values.set(k, JSON.parse(v)); },
  }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: models.map(m => `${id}/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["kimi"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", contracts.map(([providerId]) => ({ providerId, enabled: true })));
  const [otherId, otherBinding] = contracts.find(([other]) => other !== id);
  env[otherBinding] = "synthetic-foreign-environment";
  await putGrantCredentials(env, `oauth/paid/${otherId}`, { provider: otherId, kind: "api_key", enabled: true, credential: "synthetic-foreign-region" });
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/${id}`, {
    provider: id, kind: "api_key", enabled: true, credential: "synthetic-selected-region" });
  const f = { env, events, sent, grantKey: `oauth/paid/${id}`, reply: async r => Response.json(response((await r.clone().json()).model)),
    call(body, { manifest = false, policyId = "paid", discovery = false, query = "" } = {}) {
      const path = discovery ? (manifest ? `/v1/proxy/${id}/models_list` : `/v1/native/${id}/models`)
        : (manifest ? `/v1/proxy/${id}/chat_completions` : `/v1/native/${id}/chat/completions`);
      return worker.fetch(new Request(`https://router.example${path}${query}`, { method: discovery ? "GET" : "POST",
        headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
        ...(!discovery && { body: JSON.stringify(manifest ? { body } : body) }),
      }), env, { waitUntil: p => pending.push(p) });
    }, async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  t.after(f.drain); return f;
}

for (const [id, binding, base] of contracts) {
  test(`${id} keeps every frozen identity, primary facts and account-dependent disposition`, () => {
    const p = providers.find(p => p.id === id);
    assert.deepEqual(p.models.map(m => m.upstream), models);
    for (const m of p.models) {
      const k3 = m.upstream.startsWith("kimi-k3"), facts = m.nativeCapabilities.endpoints.chat_completions;
      assert.equal(m.id, `${id}/${m.upstream}`); assert.equal(m.pricing, null);
      assert.deepEqual(facts.input, k3 ? ["text", "image", "video"] : ["text", "image"]);
      assert.equal(facts.contextWindow, k3 ? 1048576 : 262144); assert.equal(facts.maxOutputTokens, k3 ? 1048576 : undefined);
      assert.deepEqual(m.supportedReasoningEfforts, k3 ? ["max"] : undefined);
      assert.equal(m.requestParameters?.chat_completions.defaultReasoningEffort, k3 ? "max" : undefined);
      assert.equal(m.availability?.status, k3 ? undefined : "deprecated");
      if (!k3) { assert.equal(m.availability.effectiveAt, "2026-10-31"); assert.equal(m.availability.servingModel, undefined); }
    }
    const foreign = { KIMI_API_KEY: "synthetic-code", [contracts.find(([other]) => other !== id)[1]]: "synthetic-foreign" };
    assert.throws(() => configuredUpstream(p, null, foreign), e => e.code === "provider_not_configured");
    const auth = configuredUpstream(p, null, { ...foreign, [binding]: "synthetic-explicit-region" });
    assert.equal(auth.baseUrl, base); assert.equal(auth.headers.get("authorization"), "Bearer synthetic-explicit-region");
    assert.deepEqual(p.auth.grantTransports, {});
  });

  for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
    test(`${id} ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves native replay and original grant`, async t => {
      const f = await fixture(t, id), k3 = model.startsWith("kimi-k3"), body = { model, stream, stream_options: { include_usage: true },
        ...(k3 ? { max_completion_tokens: 256, reasoning_effort: "max" } : { max_tokens: 256, thinking: { type: "enabled" } }),
        messages: [{ role: "assistant", content: null, reasoning_content: "synthetic-prior-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
        tools: [{ type: "function", function: { name: "lookup", description: "Read the synthetic fixture.", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" };
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage },
      ];
      const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
      let upstreamError;
      f.reply = async request => {
        try {
          assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-region");
          assert.equal(request.headers.get("x-api-key"), null); assert.deepEqual(await request.json(), body);
          assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
          if (!stream) return Response.json(response(model));
          const bytes = new TextEncoder().encode(wire); let offset = 0;
          return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
        } catch (e) { upstreamError = e; throw e; }
      };
      const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
      assert.ifError(upstreamError); assert.equal(r.status, 200, await r.clone().text());
      if (stream) assert.equal(await r.text(), wire); else assert.deepEqual(await r.json(), response(model));
      await f.drain(); assert.equal(f.sent.length, 1);
      const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [100, 20, 120, 40]);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|prior-reasoning|tool-result|answer)/);
    });
  }

  test(`${id} preserves inline image input for all five frozen models without a credential-bearing file fetch`, async t => {
    const f = await fixture(t, id);
    for (const model of models) {
      const body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
      const r = await f.call(body); assert.equal(r.status, 200, await r.clone().text()); await r.text();
      assert.deepEqual(await f.sent.at(-1).json(), body);
    }
    await f.drain(); assert.equal(f.sent.length, models.length);
    assert.ok(f.sent.every(r => r.url === `${base}/chat/completions`));
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} discovery uses the original account and strict OpenAI envelope`, async t => {
    const f = await fixture(t, id), row = { id: models[0], object: "model", created: 123, owned_by: "moonshot", context_length: 1048576, supports_image_in: true, supports_video_in: true, supports_reasoning: true };
    f.reply = () => Response.json({ object: "list", data: [row, { id: "unpermitted", object: "model" }] });
    const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { object: "list", data: [row] }); assert.match(r.headers.get("cache-control"), /private, no-store/);
    assert.equal(f.sent[0].url, `${base}/models`); assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-region");
    assert.equal(f.sent[0].method, "GET"); assert.equal(f.sent[0].body, null);
    await f.drain(); assert.ok(f.events.filter(e => e.type === "clawrouter.usage.v1").every(e => e.actual_cost_micros === 0));
    const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
    assert.equal(reservations.length, 1); assert.equal(reservations[0].reserved_micros, 0); assert.equal(reservations[0].settled, 1);
    f.reply = () => Response.json({ data: [row] });
    assert.equal((await f.call(null, { discovery: true, manifest })).status, 502);
    const count = f.sent.length;
    assert.equal((await f.call(null, { discovery: true, manifest, query: "?after_id=hidden" })).status, 400); assert.equal(f.sent.length, count);
  });

  test(`${id} rejects foreign policy, unpriced inference and missing or revoked credentials without borrowing`, async t => {
    const f = await fixture(t, id, { ownGrant: false }), body = { model: models[0], messages: [] };
    assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
    assert.equal((await f.call(body)).status, 503);
    assert.equal((await f.call(null, { discovery: true })).status, 503);
    await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-revoked" });
    await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
    await putGrantCredentials(f.env, `oauth/unpriced/${id}`, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
    assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
  });

  for (const status of [400, 401, 403, 404, 429]) test(`${id} native ${status} never retries another model, region or Kimi product`, async t => {
    const f = await fixture(t, id);
    f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
    const r = await f.call({ model: models[0], messages: [], thinking: { type: "disabled" } });
    assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    assert.equal((await f.sent[0].json()).model, models[0]);
  });

  for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error"]) test(`${id} ${manifest ? "manifest" : "native"} ${outcome} retains conservative accounting`, async t => {
    const f = await fixture(t, id), model = models[0];
    const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
      : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "synthetic-partial" }, finish_reason: null }] }) + (outcome === "disconnect" ? "" : "data: [DONE]\n\n");
    let cancelled = false;
    f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
    if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(cancelled, true); }
    else assert.equal(await r.text(), wire);
    await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
  });
}
