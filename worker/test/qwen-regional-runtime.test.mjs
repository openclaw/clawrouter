import { perRequestAuthority } from "./typescript-setup.mjs";
perRequestAuthority();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { continuationAuthority } from "./continuation-authority.mjs";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { accessBytesResponse } from "./access-byte-fixture.mjs";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
const { default: worker } = await import("../index.ts");
const { applyProviderCredential } = await import("../provider-auth.ts");
const { SelectedGrantCredentialFailure } = await import("../grant-credential-failure.ts");
const { authorityCall } = await import("../authority.ts");
const { configuredUpstream } = await import("../providers.ts"); const { snapshot } = await import("../provider-catalog.ts");
const { sha256Hex } = await import("../utils.ts");
const { putGrantCredentials, revokeGrantCredentials } = await import("../grant-credentials.ts");
const contracts = [
  ["qwen-cn", "QWEN_CN_API_KEY", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["qwen-coding-global", "QWEN_CODING_GLOBAL_API_KEY", "https://coding-intl.dashscope.aliyuncs.com/v1"],
  ["qwen-coding-cn", "QWEN_CODING_CN_API_KEY", "https://coding.dashscope.aliyuncs.com/v1"],
];
const inventory = {
  "qwen-cn": ["qwen3.5-plus", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash", "MiniMax-M2.5", "glm-5", "kimi-k2.5"],
  "qwen-coding-global": ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus"],
  "qwen-coding-cn": ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus"],
};
const retired = ["qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"];
const unqualified = {
  "qwen-cn": retired,
  "qwen-coding-global": [...retired, "qwen3.6-flash", "qwen3.7-max", "qwen3.8-max", "qwen3.8-flash"],
  "qwen-coding-cn": [...retired, "qwen3.6-flash", "qwen3.7-max", "qwen3.8-max", "qwen3.8-flash"],
};
const { providers } = JSON.parse(execFileSync(process.execPath,
  ["scripts/compile-providers.mjs", ...contracts.map(([id]) => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));
const model = "qwen3.7-plus", frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } };
const result = { id: "chatcmpl_fixture", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }], usage };

function fixtureKV(values) {
  return {
    async get(key, type) {
      if (Array.isArray(key)) return new Map(key.map(name => [name, values.get(name) ?? null]));
      const value = values.get(key) ?? null;
      return value !== null && type === "stream" ? accessBytesResponse(JSON.stringify(value), "").body : value;
    },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  };
}

async function readResponse(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder(), errors = [];
  let text = "", eof = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { eof = true; text += decoder.decode(); break; }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) { errors.push(error); }
  if (!eof) {
    try { await reader.cancel(); } catch (error) { errors.push(error); }
  }
  try { reader.releaseLock(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Qwen response consumption failed");
  return text;
}

async function drainOwned(responses, pending) {
  const errors = [];
  for (const response of responses) {
    try {
      assert.equal(response.body?.locked ?? false, false, "owned response reader must release its lock");
      if (response.body && !response.bodyUsed) await response.body.cancel();
    } catch (error) { errors.push(error); }
  }
  responses.clear();
  while (pending.length) {
    const settled = await Promise.allSettled(pending.splice(0));
    for (const outcome of settled) if (outcome.status === "rejected") errors.push(outcome.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Qwen fixture retirement failed");
}

async function fixture(t, id, { ownGrant = true, grantRouting } = {}) {
  const rows = structuredClone(providers); snapshot.providers.push(...rows);
  const values = new Map(), pending = [], events = [], sent = [], responses = new Set();
  const drain = () => drainOwned(responses, pending);
  // Register before SQLite owners so original response/task retirement precedes disposal.
  t.after(async () => {
    try { await drain(); }
    finally { for (const row of rows) snapshot.providers.splice(snapshot.providers.indexOf(row), 1); }
  });
  const env = { QWEN_API_KEY: "sk-synthetic-global-standard", DASHSCOPE_API_KEY: "sk-synthetic-legacy", QWEN_TOKEN_PLAN_API_KEY: "synthetic-token-plan", QWEN_TOKEN_PLAN_CN_API_KEY: "synthetic-token-plan-cn", POLICY_KV: fixtureKV(values), BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { async send(e) { events.push(e); } } };
  env.ACCESS_CONTROL = continuationAuthority(t, env);
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const policy = { enabled: true, generation: "fixture", providers: [id], models: [...inventory[id], ...unqualified[id]].map(m => `${id}/${m}`), tenantId: "fixture",
    monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false, ...(grantRouting ? { grantRouting } : {}) };
  await authorityCall(env, "/policies/initialize-all", [{ policyId: "paid", policy },
    { policyId: "unpriced", policy: { ...policy, requestCostMicros: null } }, { policyId: "foreign", policy: { ...policy, providers: ["qwen", "qwen-token-plan", "qwen-token-plan-cn"] } }]);
  await authorityCall(env, "/credentials/initialize-all", await Promise.all(["paid", "unpriced", "foreign"].map(async p => ({ credentialId: p,
    credential: { enabled: true, secretSha256: await sha256Hex(`fixture-${p}`), policyId: p, policyGeneration: "fixture" } }))));
  await authorityCall(env, "/connections/initialize-all", contracts.map(([providerId]) => ({ providerId, enabled: true })));
  for (const [foreignId] of contracts.filter(([other]) => other !== id)) {
    await putGrantCredentials(env, `oauth/paid/${foreignId}`, { provider: foreignId, kind: "api_key", enabled: true, credential: "synthetic-foreign-product" });
  }
  for (const policyId of ["paid", "unpriced"]) if (ownGrant) await putGrantCredentials(env, `oauth/${policyId}/${id}`, {
    provider: id, kind: "api_key", enabled: true, credential: id === "qwen-cn" ? "sk-synthetic-cn-standard" : "sk-sp-synthetic-selected-plan" });
  const f = { env, events, sent, grantKey: `oauth/paid/${id}`, reply: () => Response.json(result),
    async call(body, { manifest = false, policyId = "paid", routeId = id } = {}) {
      const response = await worker.fetch(new Request(`https://router.example${manifest ? `/v1/proxy/${routeId}/chat_completions` : `/v1/native/${routeId}/chat/completions`}`, {
        method: "POST", headers: { authorization: `Bearer clawrouter-live-${policyId}-fixture-${policyId}`, "content-type": "application/json", "x-api-key": "synthetic-caller-key" },
        body: JSON.stringify(manifest ? { body } : body),
      }), env, { waitUntil: p => { pending.push(p); p.catch(() => {}); } });
      responses.add(response); return response;
    }, drain };
  t.mock.method(globalThis, "fetch", async (url, init) => { const request = new Request(url, init); sent.push(request); return f.reply(request); });
  return f;
}

for (const [id, binding, base] of contracts) {
  const frozen = inventory[id];
  test(`${id} preserves the qualified frozen identities without pricing or cross-product credential fallback`, () => {
    const provider = providers.find(p => p.id === id);
    assert.deepEqual(provider.models.map(m => m.upstream), frozen);
    for (const m of provider.models) { assert.equal(m.id, `${id}/${m.upstream}`); assert.equal(m.pricing, null); assert.equal(m.nativeCapabilities, undefined); }
    const foreign = { QWEN_API_KEY: "sk-synthetic-global-standard", DASHSCOPE_API_KEY: "sk-synthetic-legacy", QWEN_TOKEN_PLAN_API_KEY: "synthetic-token-plan", QWEN_TOKEN_PLAN_CN_API_KEY: "synthetic-token-plan-cn" };
    for (const [other, otherBinding] of contracts) if (other !== id) foreign[otherBinding] = "synthetic-foreign-product";
    assert.throws(() => configuredUpstream(provider, null, foreign), e => e.code === "provider_not_configured");
    const credential = id === "qwen-cn" ? "sk-synthetic-explicit-standard" : "sk-sp-synthetic-explicit-plan";
    const selected = configuredUpstream(provider, null, { ...foreign, [binding]: credential });
    assert.equal(selected.baseUrl, base); assert.equal(selected.headers.get("authorization"), `Bearer ${credential}`);
    assert.deepEqual(provider.auth.grantTransports, {});
  });

  for (const manifest of [false, true]) for (const stream of [false, true]) test(`${id} ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} pins region, grant, replay and one reservation`, async t => {
    const f = await fixture(t, id), body = { model, stream, max_tokens: 256, stream_options: { include_usage: true }, enable_thinking: true,
      messages: [{ role: "assistant", content: null, reasoning_content: "synthetic-reasoning", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "synthetic-tool-result" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
    const wire = frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning", content: "synthetic-answer" }, finish_reason: null }] })
      + frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] })
      + frame({ id: result.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }], usage }) + "data: [DONE]\n\n";
    const upstreamErrors = [];
    f.reply = async request => {
      try {
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.headers.get("authorization"), id === "qwen-cn" ? "Bearer sk-synthetic-cn-standard" : "Bearer sk-sp-synthetic-selected-plan"); assert.equal(request.headers.get("x-api-key"), null);
        assert.deepEqual(await request.json(), body); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations()[0].reserved_micros, 7);
        if (!stream) return Response.json(result);
        const bytes = new TextEncoder().encode(wire); let offset = 0;
        return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
      } catch (e) { upstreamErrors.push(e); throw e; }
    };
    const r = await f.call({ ...body, model: manifest ? `${id}/${model}` : model }, { manifest });
    if (upstreamErrors.length) throw upstreamErrors[0]; assert.equal(r.status, 200);
    if (stream) assert.equal(await readResponse(r), wire); else assert.deepEqual(JSON.parse(await readResponse(r)), result);
    await f.drain(); assert.equal(f.sent.length, 1);
    const rows = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(rows.length, 1); assert.equal(rows[0].status, "success");
    assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].total_tokens, rows[0].cached_input_tokens, rows[0].actual_cost_micros], [100, 20, 120, 40, 7]);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-(?:selected|foreign|reasoning|tool-result|answer)|sk-(?:sp-)?synthetic/);
    const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations(); assert.equal(reservations.length, 1); assert.equal(reservations[0].settled, 1);
  });

  test(`${id} rejects cross-region policy, foreign model and unknown pricing before egress`, async t => {
    const f = await fixture(t, id), body = { model, messages: [], max_tokens: 16 };
    assert.equal((await f.call(body, { policyId: "foreign" })).status, 403);
    assert.equal((await f.call(body, { routeId: contracts.find(([other]) => other !== id)[0] })).status, 403);
    assert.equal((await f.call({ ...body, model: "unpermitted-model" })).status, 400);
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
    const r = await f.call({ model, messages: [] }); assert.equal(r.status, status); await readResponse(r); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(event.actual_cost_micros, 0);
  });
  test(`${id} routes every frozen model without changing its native identity`, async t => {
    const f = await fixture(t, id);
    for (const selected of frozen) {
      const body = { model: selected, messages: [{ role: "user", content: "synthetic-input" }], enable_thinking: true };
      f.reply = () => Response.json({ ...result, model: selected });
      const r = await f.call(body); assert.equal(r.status, 200);
      assert.equal((JSON.parse(await readResponse(r))).model, selected);
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
      const reader = r.body.getReader(), errors = [];
      try { assert.equal((await reader.read()).done, false); }
      catch (error) { errors.push(error); }
      try { await reader.cancel("synthetic disconnect"); }
      catch (error) { errors.push(error); }
      try { reader.releaseLock(); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Qwen reader retirement failed");
      assert.equal(canceled, true);
    } else assert.equal(await readResponse(r), wire);
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, `${base}/chat/completions`);
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    assert.equal(event.status, outcome === "disconnect" ? "client_error" : outcome === "embedded-error" ? "provider_error" : "success");
    assert.equal(event.actual_cost_micros, outcome === "embedded-error" ? 0 : 7);
    assert.equal(event.cost_basis, outcome === "embedded-error" ? "none" : "policy_fixed");
    assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 1);
  });

  test(`${id} rejects retired and plan-unsupported frozen cards even when the policy permits their names`, async t => {
    const provider = providers.find(p => p.id === id), f = await fixture(t, id);
    assert.equal(provider.endpoints.find(e => e.id === "chat_completions").modelPassthrough, undefined);
    for (const blocked of unqualified[id]) for (const manifest of [false, true]) {
      const r = await f.call({ model: manifest ? `${id}/${blocked}` : blocked, messages: [] }, { manifest });
      assert.equal(r.status, 400); assert.equal((JSON.parse(await readResponse(r))).error.code, "model_capability_unsupported");
    }
    assert.equal(f.sent.length, 0);
  });

  test(`${id} preserves the requested and observed serving identities separately`, async t => {
    const f = await fixture(t, id), observed = { ...result, model: "synthetic-serving-model" };
    f.reply = () => Response.json(observed);
    const r = await f.call({ model, messages: [] }); assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(await readResponse(r)), observed); assert.equal((await f.sent[0].json()).model, model);
    await f.drain();
    const [event] = f.events.filter(e => e.type === "clawrouter.usage.v1");
    assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
  });

}

test("qwen-cn preserves frozen 3.8 reasoning effort without a plan-model fallback", async t => {
  const f = await fixture(t, "qwen-cn");
  const body = { model: "qwen3.8-max", messages: [{ role: "user", content: "synthetic-input" }], enable_thinking: true, reasoning_effort: "xhigh" };
  f.reply = () => Response.json({ ...result, model: body.model });
  const r = await f.call(body); assert.equal(r.status, 200);
  assert.equal((JSON.parse(await readResponse(r))).model, body.model); assert.deepEqual(await f.sent[0].json(), body);
  await f.drain(); assert.equal(f.sent.length, 1);
});

test("regional KV fixture returns consumable bytes for scalar streams and preserves JSON, bulk and null", async () => {
  const value = { provider: "qwen-coding-cn", enabled: true }, kv = fixtureKV(new Map([["selected", value]]));
  const stream = await kv.get("selected", "stream");
  assert.ok(stream instanceof ReadableStream);
  const reader = stream.getReader({ mode: "byob" }), decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read(new Uint8Array(8));
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  assert.deepEqual(JSON.parse(text), value);
  assert.equal(await kv.get("selected", "json"), value);
  assert.deepEqual(await kv.get(["selected", "missing"], "json"), new Map([["selected", value], ["missing", null]]));
  assert.equal(await kv.get("missing", "stream"), null);
});

test("regional fixture joins original cancellation and every pending failure, including undefined", async () => {
  const taskFailure = new Error("synthetic task failure"), originalTask = Promise.reject(taskFailure);
  originalTask.catch(() => {});
  const response = new Response(new ReadableStream({ cancel() { return Promise.reject(undefined); } }));
  await assert.rejects(drainOwned(new Set([response]), [originalTask]), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [undefined, taskFailure]); return true;
  });
});

test("regional fixture cannot finish before its original response cancellation settles", async () => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { finish = resolve; });
  const response = new Response(new ReadableStream({ cancel() { entered(); return cleanup; } }));
  let complete = false;
  const joined = drainOwned(new Set([response]), []).then(() => { complete = true; });
  await started; assert.equal(complete, false);
  finish(); await joined; assert.equal(complete, true); assert.equal(response.body.locked, false);
});

for (const [id, binding, base] of contracts.filter(([id]) => id.startsWith("qwen-coding-"))) {
  test(`${id} checks the selected original credential before formatting without changing error ownership`, () => {
    const provider = providers.find(p => p.id === id), raw = " sk-sp-synthetic-opaque-é ";
    for (const grant of [null, { provider: id, kind: "api_key", credential: raw }]) {
      const written = [];
      applyProviderCredential(provider, grant, { [binding]: raw }, { set: (name, value) => written.push([name, value]) }, new URLSearchParams());
      assert.deepEqual(written, [["Authorization", `Bearer ${raw}`]]);
    }
    assert.throws(() => configuredUpstream(provider, { provider: id, kind: "api_key", credential: "sk-synthetic-payg" }, { [binding]: "sk-sp-synthetic-env" }), error => {
      assert.equal(error.status, 503); assert.equal(error.code, "provider_credentials_invalid");
      assert.equal(error instanceof SelectedGrantCredentialFailure, false); assert.equal(Object.hasOwn(error, "cause"), false); return true;
    });
    for (const credential of [undefined, ""]) assert.throws(() => configuredUpstream(provider,
      { provider: id, kind: "api_key", credential }, { [binding]: "sk-sp-synthetic-env" }), error => error.code === "provider_not_configured");
  });

  for (const source of ["environment", "grant"]) for (const manifest of [false, true]) {
    const route = manifest ? "manifest" : "native";
    test(`${id} ${source} ${route} accepts the selected plan key and historical padding at one exact endpoint`, async t => {
      const f = await fixture(t, id, { ownGrant: source === "grant" });
      for (const credential of ["sk-sp-synthetic-plan", " sk-sp-synthetic-padded "]) {
        if (source === "grant") await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential });
        else f.env[binding] = credential;
        const before = f.sent.length;
        const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
        assert.equal(r.status, 200); assert.deepEqual(JSON.parse(await readResponse(r)), result); await f.drain();
        assert.equal(f.sent.length, before + 1); const request = f.sent.at(-1);
        assert.equal(request.url, `${base}/chat/completions`); assert.equal(request.method, "POST");
        // The credential reaches formatting unchanged; Headers applies its own whitespace rules.
        assert.equal(request.headers.get("authorization"), new Headers({ authorization: `Bearer ${credential}` }).get("authorization"));
        assert.equal(request.headers.get("x-api-key"), null); assert.equal((await request.json()).model, model);
      }
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
      assert.equal(reservations.length, 2); assert.ok(reservations.every(r => r.reserved_micros === 7 && r.settled === 1));
    });

    test(`${id} ${source} ${route} rejects wrong products and every raw C0/DEL before initial POST or reserve`, async t => {
      const f = await fixture(t, id, { ownGrant: source === "grant" });
      for (const [, otherBinding] of contracts) f.env[otherBinding] = "sk-sp-synthetic-valid-environment";
      const controls = Array.from({ length: 33 }, (_, index) => String.fromCharCode(index === 32 ? 127 : index));
      const invalid = ["sk-synthetic-payg", "synthetic-oauth", "SK-SP-synthetic", "sk-sp-", "sk-sp-synthetic key",
        ...controls.map(control => `${control}sk-sp-synthetic${control}`)];
      for (const credential of invalid) {
        if (source === "grant") await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential });
        else f.env[binding] = credential;
        const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
        assert.equal(r.status, 503); const body = JSON.parse(await readResponse(r));
        assert.equal(body.error.code, "provider_credentials_invalid");
        assert.equal(body.error.message, "Qwen Coding Plan requires a plan credential");
        assert.doesNotMatch(JSON.stringify(body), /synthetic/); await f.drain();
        assert.equal(f.sent.length, 0); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 0);
      }
    });

    test(`${id} ${source} ${route} observes valid-invalid-valid rotation and removal without stale borrowing`, async t => {
      const f = await fixture(t, id, { ownGrant: source === "grant",
        // A grant-only policy excludes legitimate environment fallback after its final grant is revoked.
        ...(source === "grant" ? { grantRouting: { eligibleGrants: { [id]: [id] } } } : {}) });
      f.env[binding] = "sk-sp-synthetic-valid-env";
      for (const [credential, expected] of [["sk-sp-synthetic-first", 200], ["sk-synthetic-invalid", 503], ["sk-sp-synthetic-rotated", 200]]) {
        if (source === "grant") await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential });
        else f.env[binding] = credential;
        const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
        await readResponse(r); await f.drain(); assert.equal(r.status, expected);
      }
      assert.deepEqual(f.sent.map(r => r.headers.get("authorization")), ["Bearer sk-sp-synthetic-first", "Bearer sk-sp-synthetic-rotated"]);
      if (source === "grant") await revokeGrantCredentials(f.env, f.grantKey); else f.env[binding] = "";
      const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
      await readResponse(r); await f.drain(); assert.equal(r.status, 503); assert.equal(f.sent.length, 2);
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
      assert.equal(reservations.length, 2); assert.ok(reservations.every(r => r.settled === 1));
    });
  }

  for (const manifest of [false, true]) {
    test(`${id} ${manifest ? "manifest" : "native"} an invalid selected grant cannot substitute a valid pool member`, async t => {
      const f = await fixture(t, id, { grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } });
      f.env[binding] = "sk-sp-synthetic-valid-env";
      await putGrantCredentials(f.env, f.grantKey, { provider: id, kind: "api_key", enabled: true, credential: "sk-synthetic-invalid" });
      await putGrantCredentials(f.env, "oauth/paid/zz-alternate", { provider: id, kind: "api_key", enabled: true, credential: "sk-sp-synthetic-valid-alternate" });
      const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 503); assert.equal((JSON.parse(await readResponse(r))).error.code, "provider_credentials_invalid"); await f.drain();
      assert.equal(f.sent.length, 0); assert.equal(f.env.BUDGET_LEDGER.get("fixture:paid").reservations().length, 0);
    });

    test(`${id} ${manifest ? "manifest" : "native"} unrestricted revocation still permits the explicit same-product environment key`, async t => {
      const f = await fixture(t, id);
      f.env[binding] = "sk-sp-synthetic-valid-env"; await revokeGrantCredentials(f.env, f.grantKey);
      const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, 200); await readResponse(r); await f.drain();
      assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer sk-sp-synthetic-valid-env");
    });

    for (const status of [401, 429]) test(`${id} ${manifest ? "manifest" : "native"} invalid alternate preserves first ${status}, dispatch and settlement`, async t => {
      const f = await fixture(t, id, { grantRouting: { strategy: "round_robin", stickiness: "none", failover: true } });
      const alternate = "oauth/paid/zz-alternate";
      await putGrantCredentials(f.env, alternate, { provider: id, kind: "api_key", enabled: true, credential: "sk-synthetic-invalid-alternate" });
      const materialized = [], originalGet = f.env.GRANT_CREDENTIALS.get;
      t.mock.method(f.env.GRANT_CREDENTIALS, "get", function(key) {
        const stub = originalGet.call(this, key), fetch = stub.fetch;
        return { ...stub, fetch(...args) { if (new URL(args[0]).pathname === "/materialize") materialized.push(key); return fetch.apply(stub, args); } };
      });
      let retrySelections = 0;
      f.env.ACCESS_CONTROL.beforeFetch = async (_name, request) => {
        if (new URL(request.url).pathname === "/admission/resolve" && (await request.clone().json()).selection?.excludedKeys?.includes(f.grantKey)) retrySelections++;
      };
      const rejection = { error: { code: "plan_rejected", message: "synthetic-original-rejection" } };
      f.reply = () => {
        const [reservation] = f.env.BUDGET_LEDGER.get("fixture:paid").reservations();
        assert.deepEqual([reservation.reserved_micros, reservation.dispatch_started, reservation.settled], [7, 1, 0]);
        return Response.json(rejection, { status, headers: { "retry-after": "13" } });
      };
      const r = await f.call({ model: manifest ? `${id}/${model}` : model, messages: [] }, { manifest });
      assert.equal(r.status, status); assert.deepEqual(JSON.parse(await readResponse(r)), rejection); assert.equal(r.headers.get("retry-after"), "13");
      assert.equal(r.headers.get("x-clawrouter-grant-failover"), null); await f.drain();
      assert.equal(retrySelections, 1); assert.ok(materialized.includes(alternate), "invalid alternate actually materialized");
      assert.equal(f.sent.length, 1); assert.equal(f.sent[0].headers.get("authorization"), "Bearer sk-sp-synthetic-selected-plan");
      const reservations = f.env.BUDGET_LEDGER.get("fixture:paid").reservations(); assert.equal(reservations.length, 1);
      assert.deepEqual([reservations[0].reserved_micros, reservations[0].dispatch_started, reservations[0].settled], [0, 1, 1]);
      const events = f.events.filter(e => e.type === "clawrouter.usage.v1"); assert.equal(events.length, 1);
      assert.equal(events[0].actual_cost_micros, 0); assert.equal(events[0].cost_basis, "none");
    });
  }
}

test("ordinary Qwen PAYG remains outside Coding Plan validation", () => {
  const provider = snapshot.providers.find(p => p.id === "qwen"), raw = "sk-synthetic-payg";
  for (const grant of [null, { provider: "qwen", kind: "api_key", credential: raw }]) {
    const configured = configuredUpstream(provider, grant, { QWEN_API_KEY: raw });
    assert.equal(configured.headers.get("authorization"), `Bearer ${raw}`);
    assert.equal(configured.baseUrl, provider.base_urls.default);
  }
});
