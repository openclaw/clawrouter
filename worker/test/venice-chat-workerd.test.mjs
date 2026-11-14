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
const originalFetch = globalThis.fetch.bind(globalThis); let fetches = 0;
globalThis.fetch = (input, init) => { const url = input instanceof Request ? input.url : String(input);
  if(url !== 'https://api.venice.ai/api/v1/chat/completions') throw new Error('unexpected physical destination');
  fetches++; return originalFetch(input, init);
};
export default { async fetch(request, env) {
  // Keep the response consumer, its upstream I/O and settlement promises in
  // the same actual workerd request scope. The upstream barrier stays closed
  // until the real Worker response has delivered the complete first frame.
  const pending = [];
  async function phase(name, promise) {
    let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('phase timed out: '+name)),10000);})]); }
    finally { clearTimeout(timer); }
  }
  await authorityCall(env, '/policies/initialize-all', [{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['venice'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env, '/credentials/initialize-all', [{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env, '/connections/initialize-all', [{providerId:'venice',enabled:true,monthlyBudgetMicros:10000}]);
  await putGrantCredentials(env, 'oauth/fixture/venice', {provider:'venice',kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  const response = await phase('Worker response',worker.fetch(new Request('https://router.example/v1/native/venice/chat/completions',{method:'POST',
    headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},
    body:JSON.stringify({model:${JSON.stringify(selected)},messages:[{role:'user',content:'Synthetic prompt.'}],stream:true})
  }),env,{waitUntil(value){pending.push(value);}}));
  const reader=response.body.getReader(); let initial='',rest='',failed=false;
  try {
    while(initial.length<${first.length}){const next=await phase('first selected frame',reader.read());if(next.done)throw new Error('early EOF');initial+=new TextDecoder().decode(next.value);}
    if(initial!==${JSON.stringify(first)})throw new Error('unexpected first frame');
    const released=await phase('release future upstream bytes',originalFetch('https://api.venice.ai/release'));await released.text();
    try{for(;;){const next=await phase('foreign-frame denial',reader.read());if(next.done)break;rest+=new TextDecoder().decode(next.value);}}catch(error){if(error?.code!=='invalid_venice_returned_model')throw error;failed=true;}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  while(pending.length)await phase('settlement',Promise.all(pending.splice(0)));
  return Response.json({status:response.status,initial,rest,failed,fetches,capacity:bodyBudgetCharged()});
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
  const response = await fetch(origin); assert.equal(response.status, 200, await response.clone().text());
  const proof = await response.json(); assert.equal(proof.status, 200); assert.equal(proof.initial, first);
  assert.equal(proof.failed, true); assert.doesNotMatch(proof.rest, /FORBIDDEN_CONTENT|synthetic-foreign/);
  assert.equal(proof.fetches, 1); assert.equal(proof.capacity, 0);
});
