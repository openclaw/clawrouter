import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const selected = "zai-org-glm-5-2";
const first = `data: ${JSON.stringify({ object: "chat.completion.chunk", model: selected, choices: [{ delta: { content: "AUTHORIZED_CONTENT" }, finish_reason: null }] })}\n\n`;
const foreign = `data: ${JSON.stringify({ object: "chat.completion.chunk", model: "synthetic-foreign", choices: [{ delta: { content: "FORBIDDEN_CONTENT" }, finish_reason: null }] })}\n\n`;
const router = `
export { PolicyBindingIndexObject, BudgetLedgerObject, UsageLedgerObject, GrantCredentialObject } from './worker/index.ts';
import worker from './worker/index.ts';
import { authorityCall } from './worker/authority.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { sha256Hex } from './worker/utils.ts';
import { bodyBudgetCharged } from './worker/body-budget.ts';
const originalFetch = globalThis.fetch.bind(globalThis), pending = []; let fetches = 0;
globalThis.fetch = (input, init) => { const url = input instanceof Request ? input.url : String(input);
  if(url !== 'https://api.venice.ai/api/v1/chat/completions') throw new Error('unexpected physical destination');
  fetches++; return originalFetch(input, init);
};
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if(path === '/release') return originalFetch('https://api.venice.ai/release');
  if(path === '/proof') { while(pending.length) await Promise.all(pending.splice(0)); return Response.json({fetches,capacity:bodyBudgetCharged()}); }
  await authorityCall(env, '/policies/initialize-all', [{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['venice'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env, '/credentials/initialize-all', [{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env, '/connections/initialize-all', [{providerId:'venice',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env, 'oauth/fixture/venice', {provider:'venice',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  return worker.fetch(new Request('https://router.example/v1/native/venice/chat/completions',{method:'POST',
    headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},
    body:JSON.stringify({model:${JSON.stringify(selected)},messages:[{role:'user',content:'Synthetic prompt.'}],stream:true})
  }),env,{waitUntil(value){pending.push(value);}});
},queue:worker.queue};`;
const upstream = `
let release; const barrier = new Promise(resolve=>{release=resolve;});
export default {async fetch(request){
  if(new URL(request.url).pathname === '/release'){release();return new Response('released');}
  if(request.url !== 'https://api.venice.ai/api/v1/chat/completions' || request.method !== 'POST'
    || request.headers.get('authorization') !== 'Bearer synthetic-original-key') return new Response('invalid original dispatch',{status:400});
  let sent=false,canceled=false;
  return new Response(new ReadableStream({async pull(controller){
    if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(${JSON.stringify(first)}));return;}
    await barrier;if(!canceled){controller.enqueue(new TextEncoder().encode(${JSON.stringify(foreign)}));controller.close();}
  },cancel(){canceled=true;release();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
}};`;

test("workerd Venice sends selected-model output before future bytes, withholds foreign output and releases capacity", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-venice-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const origin = (await instance.ready).origin;
  const response = await fetch(origin); assert.equal(response.status, 200);
  const reader = response.body.getReader(); let initial = "";
  while (initial.length < first.length) { const next = await reader.read(); assert.equal(next.done, false); initial += new TextDecoder().decode(next.value); }
  assert.equal(initial, first);
  const release = await fetch(`${origin}/release`); assert.equal(release.status, 200); await release.text();
  let rest = "";
  try { for (;;) { const next = await reader.read(); if(next.done) break; rest += new TextDecoder().decode(next.value); } } catch {} finally { reader.releaseLock(); }
  assert.doesNotMatch(rest, /FORBIDDEN_CONTENT|synthetic-foreign/);
  const proof = await (await fetch(`${origin}/proof`)).json(); assert.equal(proof.fetches, 1); assert.equal(proof.capacity, 0);
});
