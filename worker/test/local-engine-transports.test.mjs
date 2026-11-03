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
 for (const id of ${JSON.stringify(ids)}) { const key=id.toUpperCase().replaceAll("-","_"); env[key+"_BASE_URL"]="https://"+id+".example.com/v1"; env[key+"_MODEL"]="tenant/model"; }
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

async function fixture(t) {
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
  for (const provider of ids) {
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
    const list = await f.call(`/v1/native/${id}/models`);
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
    const response = await f.call(`/v1/native/${id}/models`);
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
