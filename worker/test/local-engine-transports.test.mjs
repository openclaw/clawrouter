import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const ids = ["llama-cpp", "lmstudio", "ollama", "omlx", "sglang", "vllm"];
const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...ids.map(id => `providers/${id}.provider.yaml`)], { encoding: "utf8" }));

const router = `
import worker, { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import { putGrantCredentials, revokeGrantCredentials } from './worker/grant-credentials.ts';
import { snapshot } from './worker/providers.ts';
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject };
for (const provider of ${JSON.stringify(compiled.providers)}) { const index=snapshot.providers.findIndex(p=>p.id===provider.id); if(index<0) snapshot.providers.push(provider); else snapshot.providers[index]=provider; }
Object.assign(snapshot.model_index,${JSON.stringify(compiled.model_index)});
const pending = [];
export default { ...worker, async fetch(request, env, context) {
 for (const id of ${JSON.stringify(ids)}) { const key=id.toUpperCase().replaceAll("-","_"); env[key+"_BASE_URL"]="https://"+id+".example.com"+(id==="ollama"?"":"/v1"); env[key+"_MODEL"]="tenant/model"; }
 const path = new URL(request.url).pathname;
 if (path === '/fixture/object') { const b = await request.json(); const ns = env[b.binding]; return ns.get(ns.idFromName(b.name)).fetch('https://authority'+b.path, {method:'POST',body:JSON.stringify(b.value)}); }
 if (path === '/fixture/grant') { const b = await request.json(); return Response.json(b.revoke ? await revokeGrantCredentials(env,b.key) : await putGrantCredentials(env,b.key,b.grant)); }
 if (path === '/fixture/drain') { await Promise.all(pending.splice(0)); return new Response('ok'); }
 if (path === '/fixture/upstream') return fetch('https://upstream/fixture', {method:'POST',body:request.body});
 return worker.fetch(request,env,{waitUntil(promise){pending.push(promise);context.waitUntil(promise);},passThroughOnException(){context.passThroughOnException();}});
}, async queue(batch) {
 await fetch('https://upstream/events', {method:'POST',body:JSON.stringify(batch.messages.map(m=>m.body))}); batch.ackAll();
} };
`;
const upstream = `
export class Upstream {
 constructor(state) { this.storage=state.storage; }
 async fetch(request) {
 const path=new URL(request.url).pathname;
 if(path==='/fixture') { const b=await request.json(); if(b.replies) await this.storage.put('replies',b.replies); return Response.json({calls:await this.storage.get('calls')??[],events:await this.storage.get('events')??[]}); }
 if(path==='/events') { await this.storage.put('events',[...await this.storage.get('events')??[],...await request.json()]); return new Response('ok'); }
 const calls=await this.storage.get('calls')??[];
 calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()}); await this.storage.put('calls',calls);
 const replies=await this.storage.get('replies')??[], reply=replies.length>1?replies.shift():replies[0]; await this.storage.put('replies',replies);
 if(reply?.disconnect) throw new Error('synthetic upstream failure');
 return new Response(reply?.status===304?null:reply?.wire??JSON.stringify(reply?.body??{}),{status:reply?.status??200,headers:{'content-type':'application/json','x-request-id':'upstream-fixture',...reply?.headers}});
 }
}
export default {fetch(request,env){return env.UPSTREAM.get(env.UPSTREAM.idFromName('fixture')).fetch(request);}};
`;

async function fixture(t, { grants = true } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "cr-local-engine-"));
  const mf = await startWorkerdFixture(temporary, router, upstream, { upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } });
  t.after(async () => { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const call = (path, init = {}) => mf.dispatchFetch("https://router.example" + path, { ...init,
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-key", "content-type": "application/json", ...init.headers } });
  const object = async (path, value) => {
    const response = await call("/fixture/object", { method: "POST", body: JSON.stringify({ binding: "ACCESS_CONTROL", name: "policy-bindings", path, value }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  const policy = { enabled: true, generation: "g1", providers: ids, tenantId: "tenant", requestCostMicros: 17, retainRequestContent: false };
  await object("/policies/initialize-all", [{ policyId: "fixture", policy }]);
  await object("/credentials/initialize-all", [{ credentialId: "fixture", credential: {
    enabled: true, policyId: "fixture", policyGeneration: "g1", secretSha256: createHash("sha256").update("fixture-key").digest("hex"),
  } }]);
  await object("/connections/initialize-all", ids.map(providerId => ({ providerId, enabled: true })));
  for (const provider of grants ? ids : []) {
    const response = await call("/fixture/grant", { method: "POST", body: JSON.stringify({ key: "oauth/fixture/" + provider,
      grant: { provider, kind: "api_key", enabled: true, credential: "fixture-" + provider + "-key" } }) });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const state = async replies => {
    const response = await call("/fixture/upstream", { method: "POST", body: JSON.stringify(replies ? { replies } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { call, state, policy, async update(change) { Object.assign(policy, change); await object("/policies/put", { policyId: "fixture", policy }); },
    async events(count) {
      await call("/fixture/drain");
      for (let n = 0; n < 100; n++) { const value = await state(); if (value.events.length >= count) return value.events; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.fail("usage events not collected");
    } };
}

test("configured local engines route scoped discovery and stream tools through the real Worker", async t => {
  const f = await fixture(t);
  let events = 0;
  for (const id of ids) {
    const catalog = { object: "list", data: [{ id: "tenant/model", object: "model", owned_by: "fixture" }] };
    await f.state([{ body: catalog }]);
    const list = await f.call(`/v1/native/${id}${id === "ollama" ? "/v1" : ""}/models`);
    assert.equal(list.status, 200, await list.clone().text());
    assert.deepEqual(await list.json(), catalog);
    let sent = (await f.state()).calls.at(-1);
    assert.equal(sent.url, `https://${id}.example.com/v1/models`);
    assert.equal(sent.method, "GET");
    assert.equal(sent.body, "");
    assert.equal(sent.headers.authorization, `Bearer fixture-${id}-key`);
    const metadataEvent = (await f.events(++events)).at(-1);
    assert.equal(metadataEvent.actual_cost_micros, 0);
    assert.equal(metadataEvent.cost_basis, "none");

    const chunks = [
      { id: "chat_fixture", choices: [{ index: 0, delta: { reasoning_content: "fixture-thinking", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chat_fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ];
    const wire = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    await f.state([{ wire, headers: { "content-type": "text/event-stream" } }]);
    const body = { model: `${id}/configured`, stream: true, messages: [{ role: "user", content: "fixture input" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
    const response = await f.call("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), wire);
    sent = (await f.state()).calls.at(-1);
    assert.equal(sent.url, `https://${id}.example.com/v1/chat/completions`);
    assert.deepEqual(JSON.parse(sent.body), { ...body, model: "tenant/model" });
    assert.equal(sent.headers.authorization, `Bearer fixture-${id}-key`);
    const event = (await f.events(++events)).at(-1);
    assert.equal(event.provider, id);
    assert.equal(event.input_tokens, 7);
    assert.equal(event.output_tokens, 3);
    assert.equal(event.actual_cost_micros, 17);
    assert.equal(event.grant_key, "oauth/fixture/" + id);
  }
});

test("local-engine filtered discovery retains OpenAI shape and hides denied models", async t => {
  const f = await fixture(t);
  await f.update({ models: ids.map(id => `${id}/tenant/model`) });
  for (const id of ids) {
    const allowed = { id: "tenant/model", object: "model" };
    await f.state([{ body: { object: "list", data: [allowed, { id: "private-model", object: "model" }] } }]);
    const response = await f.call(`/v1/native/${id}${id === "ollama" ? "/v1" : ""}/models`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { object: "list", data: [allowed] });
  }
});

test("local-engine unknown tariffs fail before egress under hard budgets", async t => {
  const f = await fixture(t);
  await f.update({ requestCostMicros: null, budgetMode: "reserve", monthlyBudgetMicros: 1000 });
  for (const id of ids) {
    const response = await f.call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: `${id}/configured`, messages: [{ role: "user", content: "fixture input" }] }) });
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).error.code, "pricing_required");
  }
  assert.equal((await f.state()).calls.length, 0);
});


for (const streaming of [false, true]) for (const manifest of [false, true]) test(`configured Ollama ${manifest ? "manifest" : "native"} ${streaming ? "NDJSON" : "JSON"} keeps native tools and final counters`, async t => {
  const f = await fixture(t);
  const body = { model: "tenant/model", messages: [{ role: "assistant", content: "", thinking: "synthetic thinking", tool_calls: [{ function: { name: "lookup", arguments: { key: "value" } } }] }, { role: "tool", content: "synthetic result", tool_name: "lookup" }], stream: streaming, think: "high", options: { num_predict: 32 } };
  const partial = { model: "tenant/model", message: { role: "assistant", content: "", thinking: "synthetic output", tool_calls: [{ function: { name: "lookup", arguments: { key: "value" } } }] }, done: false };
  const final = { model: "tenant/model", message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 17, prompt_eval_cached_count: 3, eval_count: 4 };
  const wire = streaming ? [partial, final].map(value => JSON.stringify(value) + "\n").join("") : JSON.stringify(final);
  await f.state([{ wire, headers: { "content-type": streaming ? "application/x-ndjson" : "application/json" } }]);
  const response = await f.call(manifest ? "/v1/proxy/ollama/native_chat" : "/v1/native/ollama/api/chat", { method: "POST", body: JSON.stringify(manifest ? { body: { ...body, model: "ollama/configured" } } : body) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), wire);
  const sent = (await f.state()).calls.at(-1);
  assert.equal(sent.url, "https://ollama.example.com/api/chat");
  assert.equal(sent.headers.authorization, "Bearer fixture-ollama-key");
  assert.deepEqual(JSON.parse(sent.body), body);
  const [event] = await f.events(1);
  assert.equal(event.provider, "ollama");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.cached_input_tokens, event.total_tokens], [17, 4, 3, 21]);
  assert.equal(event.cost_basis, "policy_fixed");
  assert.equal(event.actual_cost_micros, 17);
  assert.equal(event.credential_id, "fixture");
  assert.equal(event.grant_key, "oauth/fixture/ollama");
  assert.doesNotMatch(JSON.stringify(event), /synthetic thinking|synthetic result|synthetic output|fixture-ollama-key/);
});

test("configured Ollama native tags filter the caller's model scope without inference charges", async t => {
  const f = await fixture(t);
  await f.update({ models: ["ollama/tenant/model"] });
  const allowed = { name: "tenant/model", model: "tenant/model", details: { family: "fixture" } };
  await f.state([{ body: { models: [allowed, { name: "private-model", model: "private-model" }] } }]);
  const response = await f.call("/v1/native/ollama/api/tags");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { models: [allowed] });
  const sent = (await f.state()).calls.at(-1);
  assert.equal(sent.url, "https://ollama.example.com/api/tags");
  assert.equal(sent.body, "");
  const [event] = await f.events(1);
  assert.equal(event.cost_basis, "none");
  assert.equal(event.actual_cost_micros, 0);
});


test("configured local servers accept optional upstream auth without a placeholder key", async t => {
  const f = await fixture(t, { grants: false });
  for (const id of ids) {
    await f.state([{ body: { id: "synthetic", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "synthetic answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } }]);
    const response = await f.call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: `${id}/configured`, messages: [{ role: "user", content: "synthetic input" }] }) });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    const sent = (await f.state()).calls.at(-1);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers["x-api-key"], undefined);
    assert.equal(JSON.parse(sent.body).model, "tenant/model");
  }
  const events = await f.events(ids.length);
  assert.equal(events.filter(event => event.status === "success").length, ids.length);
  assert.ok(events.every(event => event.credential_id === "fixture" && event.actual_cost_micros === 17));
});

for (const streaming of [false, true]) test(`LM Studio Messages ${streaming ? "SSE" : "JSON"} preserves native tools and usage`, async t => {
  const f = await fixture(t);
  const body = { model: "lmstudio/configured", max_tokens: 32, stream: streaming, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name: "lookup", input: { key: "value" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "synthetic result" }] }], tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }] };
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: "tenant/model", content: [{ type: "text", text: "synthetic answer" }], stop_reason: "end_turn", usage: { input_tokens: 17, output_tokens: 4 } };
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 17, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  const wire = streaming ? events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(message);
  await f.state([{ wire, headers: { "content-type": streaming ? "text/event-stream" : "application/json" } }]);
  const response = await f.call("/v1/messages", { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await response.text(), wire);
  const sent = (await f.state()).calls.at(-1);
  assert.equal(sent.url, "https://lmstudio.example.com/v1/messages");
  assert.equal(sent.headers.authorization, "Bearer fixture-lmstudio-key");
  assert.deepEqual(JSON.parse(sent.body), { ...body, model: "tenant/model" });
  const [event] = await f.events(1);
  assert.equal(event.provider, "lmstudio");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [17, 4, 21]);
  assert.equal(event.actual_cost_micros, 17);
  assert.equal(event.credential_id, "fixture");
});
