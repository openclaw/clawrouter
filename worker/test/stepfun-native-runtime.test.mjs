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
const { snapshot, configuredUpstream, providerModel } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const providers = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", "providers/stepfun.provider.yaml", "providers/stepfun-cn.provider.yaml"], { encoding: "utf8" })).providers;
const contracts = [["stepfun", "STEPFUN_API_KEY", "https://api.stepfun.ai/v1"],
  ["stepfun-cn", "STEPFUN_CN_API_KEY", "https://api.stepfun.com/v1"]];
for (const [id, binding, base] of contracts) {
  const provider = providers.find(p => p.id === id);
  const models = ["step-3.7-flash", "step-3.5-flash"];
  const thinking = models[0];
  const vision = new Set([models[0]]);
  const toolFacts = new Set(models);
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const usage = { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, cached_tokens: 256 };
  const reasoning = () => ({ reasoning_content: "synthetic-reasoning" });
  const response = model => ({ id: "chatcmpl_fixture", object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", ...reasoning(model), content: "synthetic-answer" }, finish_reason: "stop" }], usage });

  async function fixture(t, { ownGrant = true } = {}) {
    const replacements = providers.map(provider => ({ previous: snapshot.providers.find(p => p.id === provider.id), row: structuredClone(provider) }));
    for (const { previous, row } of replacements) {
      if (previous) snapshot.providers.splice(snapshot.providers.indexOf(previous), 1, row); else snapshot.providers.push(row);
    }
    t.after(() => { for (const { previous, row } of replacements) {
      if (previous) snapshot.providers.splice(snapshot.providers.indexOf(row), 1, previous); else snapshot.providers.splice(snapshot.providers.indexOf(row), 1);
    } });
    const values = new Map(), pending = [], events = [], sent = [];
    const env = { OPENAI_API_KEY: "synthetic-foreign-environment", ANTHROPIC_API_KEY: "synthetic-foreign-anthropic", OPENROUTER_API_KEY: "synthetic-foreign-router",
      [contracts.find(([other]) => other !== id)[1]]: "synthetic-foreign-region", STEPFUN_PLAN_API_KEY: "synthetic-foreign-plan", STEPFUN_PLAN_CN_API_KEY: "synthetic-foreign-cn-plan", POLICY_KV: {
      async get(k) { return Array.isArray(k) ? new Map(k.map(k => [k, values.get(k) ?? null])) : values.get(k) ?? null; },
      async put(k, v) { values.set(k, JSON.parse(v)); },
    }, BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
    env.ACCESS_CONTROL = continuationAuthority(t, env);
    attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
    const policy = { enabled: true, generation: "fixture", providers: [id], models: models.map(m => `${id}/${m}`), tenantId: "fixture",
      monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false };
    await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
      { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["openrouter"] } }]);
    await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
      credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
    await authorityCall(env, "/connections/initialize-all", [{ providerId: id, enabled: true }]);
    await putGrantCredentials(env, "oauth/paid/openrouter", { provider: "openrouter", kind: "api_key", enabled: true, credential: "synthetic-foreign-grant" });
    for (const other of [contracts.find(([other]) => other !== id)[0], "stepfun-plan", "stepfun-plan-cn"])
      await putGrantCredentials(env, `oauth/paid/${other}`, { provider: other, kind: "api_key", enabled: true, credential: "synthetic-foreign-product-or-region" });
    for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/${id}`, {
      provider: id, kind: "api_key", enabled: true, credential: "synthetic-selected-stepfun" });
    const f = { env, events, sent, grantKey: `oauth/paid/${id}`, reply: async r => Response.json(response((await r.clone().json()).model)),
      call(body, { manifest = false, policyId = "paid", discovery = false, query = "", routeId = id, nativePrefix = routeId } = {}) {
        const path = discovery ? (manifest ? `/v1/proxy/${routeId}/models_list` : `/v1/native/${nativePrefix}/models`)
          : (manifest ? `/v1/proxy/${routeId}/chat_completions` : `/v1/native/${nativePrefix}/chat/completions`);
        return worker.fetch(new Request(`https://router.example${path}${query}`, { method: discovery ? "GET" : "POST",
          headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key", "x-organization-id": "synthetic-unbound-org" },
          ...(!discovery && { body: JSON.stringify(manifest ? { body } : body) }),
        }), env, { waitUntil: p => pending.push(p) });
      },
      catalog() { return worker.fetch(new Request("https://router.example/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-paid-fixture-paid" } }), env, { waitUntil: p => pending.push(p) }); },
      async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
    t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
    t.after(f.drain); return f;
  }

  test(`${id} declaration keeps two frozen identities with separate standard region credentials`, () => {
    assert.deepEqual(provider.models.map(m => m.upstream), models);
    for (const m of provider.models.filter(m => models.includes(m.upstream))) {
      assert.equal(m.id, `${id}/${m.upstream}`); assert.equal(m.pricing, null); assert.equal(m.availability, undefined);
      assert.deepEqual(m.supportedReasoningEfforts, m.upstream === thinking ? ["low", "medium", "high"] : undefined);
      assert.equal(m.requestParameters?.chat_completions.toolCalling, toolFacts.has(m.upstream) ? "supported" : undefined);
      assert.equal(m.requestParameters?.chat_completions.defaultReasoningEffort, m.upstream === thinking ? "medium" : undefined);
      const native = m.nativeCapabilities?.endpoints.chat_completions;
      assert.deepEqual(native?.input, vision.has(m.upstream) ? ["text", "image"] : ["text"]);
      assert.equal(native?.contextWindow, undefined); assert.equal(native?.maxOutputTokens, undefined);
    }
    assert.deepEqual(provider.endpoints.map(e => e.id), ["models_list", "chat_completions"]);
    const opaque = providerModel(provider, `${id}/synthetic-tenant-model`, provider.endpoints.find(e => e.id === "chat_completions"));
    assert.equal(opaque.nativeCapabilities, undefined); assert.equal(opaque.requestParameters, undefined); assert.equal(opaque.pricing, null);
    const foreign = { [contracts.find(([other]) => other !== id)[1]]: "synthetic-foreign-region", STEPFUN_PLAN_API_KEY: "synthetic-plan", STEPFUN_PLAN_CN_API_KEY: "synthetic-cn-plan" };
    assert.throws(() => configuredUpstream(provider, null, foreign), e => e.code === "provider_not_configured");
    const upstream = configuredUpstream(provider, null, { ...foreign, [binding]: "synthetic-explicit" });
    assert.equal(upstream.baseUrl, base); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-explicit");
    assert.equal(upstream.headers.get("x-organization-id"), null); assert.deepEqual(provider.auth.grantTransports, {});
  });

  test(`${id} actual catalog exposes only the original direct grant's eligible finite Chat offers`, async t => {
    const f = await fixture(t), r = await f.catalog();
    assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("cache-control"), "no-store");
    const view = (await r.json()).providers.find(p => p.id === id);
    assert.deepEqual(view.models.map(m => m.id).sort(), models.map(m => `${id}/${m}`).sort());
    for (const m of view.models) {
      assert.equal(m.requestParameters?.chat_completions.toolCalling, toolFacts.has(m.id.slice(id.length + 1)) ? "supported" : undefined);
      const offers = view.offers.filter(o => o.modelId === m.id);
      assert.ok(offers.length > 0); assert.ok(offers.every(o => o.endpoint === "chat_completions" && o.eligible));
    }
    await f.drain(); assert.equal(f.sent.length, 0);
  });

  for (const model of models) for (const manifest of [false, true]) for (const stream of [false, true]) {
    test(`${id} native ${model} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves selected identity, opaque reasoning/tool replay and native usage`, async t => {
      const f = await fixture(t), tools = toolFacts.has(model);
      const body = { model, stream, max_tokens: 256,
        reasoning_format: "deepseek-style",
        messages: tools ? [{ role: "assistant", content: "", ...reasoning(model),
          tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }]
          : [{ role: "user", content: "synthetic-input" }],
        ...(tools && { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "auto" }) };
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", ...reasoning(model) }, finish_reason: null }] },
        ...(tools ? [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
        ] : [{ choices: [{ index: 0, delta: { content: "synthetic-answer" }, finish_reason: "stop" }] }]),
      ];
      chunks[0].usage = { prompt_tokens: 300, completion_tokens: 6, total_tokens: 306, cached_tokens: 256 };
      chunks.at(-1).usage = usage;
      const wire = chunks.map(chunk => frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, ...chunk })).join("") + "data: [DONE]\n\n";
      let upstreamError;
      f.reply = async request => {
        try {
          assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-stepfun");
          assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.headers.get("x-organization-id"), null); assert.deepEqual(await request.json(), body);
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
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [300, 20, 320, 256]);
      assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
      assert.doesNotMatch(JSON.stringify(event), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)/);
    });
  }

  test(`${id} original grant does not rewrite model case, substitute products or allow ungranted models`, async t => {
    const f = await fixture(t);
    for (const model of ["Step-3.7-Flash", "step-3.5-flash-2603", "synthetic-tenant-model"]) {
      for (const manifest of [false, true]) {
        const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
        assert.equal(r.status, 403, await r.clone().text()); assert.equal((await r.json()).error.code, "model_not_allowed");
      }
    }
    await f.drain(); assert.equal(f.sent.length, 0);
  });

  test(`${id} direct rejects foreign policy, missing/revoked credentials and unknown cost before egress`, async t => {
    const f = await fixture(t, { ownGrant: false }), body = { model: models[0], messages: [] };
    assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
    assert.equal((await f.call(body)).status, 503);
    await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-revoked" });
    await revokeGrantCredentials(f.env, f.grantKey); assert.equal((await f.call(body)).status, 503);
    await putGrantCredentials(f.env, `oauth/unpriced/${id}`, { provider: id, kind: "api_key", enabled: true, credential: "synthetic-unpriced" });
    assert.equal((await f.call(body, { policyId: "unpriced" })).status, 400); assert.equal(f.sent.length, 0);
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} cannot spend the original grant on another region or Step Plan`, async t => {
    const f = await fixture(t);
    for (const routeId of [contracts.find(([other]) => other !== id)[0], "stepfun-plan", "stepfun-plan-cn"]) {
      const body = { model: manifest ? `${routeId}/${models[0]}` : models[0], messages: [] };
      const r = await f.call(body, { manifest, routeId }); assert.equal(r.status, 403, await r.clone().text());
    }
    await f.drain(); assert.equal(f.sent.length, 0);
  });

  for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) test(`${id} native ${status} never retries a product, model or credential`, async t => {
    const f = await fixture(t);
    f.reply = () => Response.json({ error: { type: "invalid_request_error", message: "synthetic-upstream-rejection" } }, { status });
    const r = await f.call({ model: models[0], messages: [] }); assert.equal(r.status, status, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal((await f.sent[0].json()).model, models[0]);
  });

  for (const manifest of [false, true]) for (const outcome of ["usage-absent", "disconnect", "embedded-error", "late-error"]) test(`${id} native ${manifest ? "manifest" : "native"} ${outcome} preserves conservative settlement`, async t => {
    const f = await fixture(t), model = thinking;
    const wire = outcome === "embedded-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
      : frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "synthetic-partial-reasoning" }, finish_reason: null }] })
        + (outcome === "late-error" ? frame({ error: { type: "server_error", message: "synthetic-stream-error" } })
          : outcome === "disconnect" ? "" : "data: [DONE]\n\n");
    let canceled = false;
    f.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); if (outcome !== "disconnect") c.close(); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [], stream: true }, { manifest }); assert.equal(r.status, 200);
    if (outcome === "disconnect") { const reader = r.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel("synthetic disconnect"); assert.equal(canceled, true); }
    else assert.equal(await r.text(), wire);
    await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome.endsWith("error") ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7); assert.equal(f.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(event), /synthetic-partial-reasoning/);
  });


  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} keeps canonical effort controls and default fields untouched`, async t => {
    const f = await fixture(t), model = models[0];
    for (const controls of [{}, ...["low", "medium", "high"].map(reasoning_effort => ({ reasoning_effort }))]) {
      const body = { model, ...controls, messages: [{ role: "user", content: "synthetic-input" }] };
      const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
      assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain(); assert.deepEqual(await f.sent.at(-1).json(), body);
    }
  });

  for (const manifest of [false, true]) for (const format of ["general", "deepseek-style"]) test(`${id} ${manifest ? "manifest" : "native"} preserves native ${format} reasoning without field conversion`, async t => {
    const f = await fixture(t), model = models[0], field = format === "general" ? "reasoning" : "reasoning_content";
    const body = { model, reasoning_format: format, messages: [{ role: "assistant", content: "synthetic-prior-answer", [field]: "synthetic-prior-reasoning" }, { role: "user", content: "synthetic-input" }] };
    const value = response(model); delete value.choices[0].message.reasoning_content; value.choices[0].message[field] = "synthetic-native-reasoning";
    f.reply = () => Response.json(value);
    const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), value); await f.drain(); assert.deepEqual(await f.sent[0].json(), body);
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} requires native top-level cached usage without inventing missing evidence`, async t => {
    const f = await fixture(t), model = thinking;
    for (const cached of [undefined, 0, 256]) {
      f.reply = () => { const value = response(model); value.usage = { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320,
        ...(cached === undefined ? {} : { cached_tokens: cached }) }; return Response.json(value); };
      const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
      const event = f.events.filter(e => e.type === "clawrouter.usage.v1").at(-1);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [300, 20, 320]);
      assert.equal(event.cached_input_tokens, cached ?? null); assert.equal(event.actual_cost_micros, 7); assert.equal(event.cost_basis, "policy_fixed");
    }
  });

  for (const model of vision) for (const manifest of [false, true]) test(`${id} ${model} ${manifest ? "manifest" : "native"} preserves qualified inline image input`, async t => {
    const f = await fixture(t), body = { model, messages: [{ role: "user", content: [{ type: "text", text: "synthetic-input" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=" } }] }] };
    const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
    assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} keyed discovery filters the original grant without inference pricing`, async t => {
    const f = await fixture(t), row = { id: models[0], object: "model", created: 1713196800, owned_by: "stepai" };
    f.reply = () => Response.json({ object: "list", data: [row, { id: "unpermitted", object: "model" }] });
    const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { object: "list", data: [row] }); assert.match(r.headers.get("cache-control"), /private, no-store/);
    assert.equal(f.sent[0].url, `${base}/models`); assert.equal(f.sent[0].method, "GET"); assert.equal(f.sent[0].body, null);
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-stepfun");
    assert.equal(f.sent[0].headers.get("x-organization-id"), null); assert.equal(f.sent[0].headers.get("x-api-key"), null);
    await f.drain(); const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0);
    f.reply = () => Response.json({ object: "list", data: [] });
    const empty = await f.call(null, { discovery: true, manifest }); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { object: "list", data: [] });
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} discovery rejects malformed envelopes and caller query remapping`, async t => {
    const f = await fixture(t);
    for (const payload of [{ data: [] }, { object: "wrong", data: [] }, { object: "list", data: [{}] }, { object: "list", data: [{ id: "bad\u0000id" }] }]) {
      f.reply = () => Response.json(payload); const r = await f.call(null, { discovery: true, manifest });
      assert.equal(r.status, 502, await r.clone().text()); assert.equal((await r.json()).error.code, "invalid_model_discovery_response");
    }
    const count = f.sent.length;
    for (const query of ["?limit=1", "?after_id=unpermitted", "?url=https://other.example", "?api_key=synthetic-private"]) {
      const r = await f.call(null, { discovery: true, manifest, query }); assert.equal(r.status, 400, await r.clone().text());
    }
    assert.equal(f.sent.length, count);
  });

  for (const manifest of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} discovery cannot replace denied or revoked credentials with public inventory`, async t => {
    const f = await fixture(t);
    f.reply = () => Response.json({ error: "synthetic-private-rejection" }, { status: 403 });
    const r = await f.call(null, { discovery: true, manifest }); assert.equal(r.status, 403);
    assert.doesNotMatch(await r.text(), /synthetic-private-rejection/); assert.equal(f.sent.length, 1);
    await revokeGrantCredentials(f.env, f.grantKey);
    const denied = await f.call(null, { discovery: true, manifest }); assert.equal(denied.status, 503, await denied.clone().text());
    assert.equal(f.sent.length, 1);
  });

  for (const nativePrefix of id === "stepfun" ? ["clawrouter-stepfun", "stepfun-ai"] : ["clawrouter-stepfun-cn"]) test(`${id} routing alias ${nativePrefix} retains the canonical provider grant and native model`, async t => {
    const f = await fixture(t), body = { model: models[0], messages: [{ role: "user", content: "synthetic-input" }] };
    const r = await f.call(body, { nativePrefix }); assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
    assert.equal(f.sent[0].headers.get("authorization"), "Bearer synthetic-selected-stepfun"); assert.equal(f.sent[0].url, `${base}/chat/completions`);
  });

  if (id === "stepfun") test("StepFun frozen stepfun-ai model prefix retains the canonical global identity", async t => {
    const f = await fixture(t), body = { model: models[0], messages: [{ role: "user", content: "synthetic-input" }] };
    const r = await f.call({ ...body, model: `stepfun-ai/${models[0]}` }, { manifest: true });
    assert.equal(r.status, 200, await r.clone().text()); await r.text(); await f.drain();
    assert.equal(f.sent.length, 1); assert.deepEqual(await f.sent[0].json(), body);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.equal(event.provider, "stepfun"); assert.equal(event.model, `stepfun/${models[0]}`);
  });

}
