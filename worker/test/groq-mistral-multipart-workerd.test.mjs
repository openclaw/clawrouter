import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
const facts={groq:'whisper-large-v3-turbo',mistral:'voxtral-mini-latest'}, originalFetch=globalThis.fetch.bind(globalThis),charges=[];
globalThis.fetch=(input,init)=>{charges.push(bodyBudgetCharged());return originalFetch(input,init);};
for(const [id,upstream] of Object.entries(facts)) {
 const provider=snapshot.providers.find(p=>p.id===id), template=snapshot.providers.find(p=>p.id==='openai').endpoints.find(e=>e.id==='transcriptions');
 provider.endpoints=provider.endpoints.filter(e=>e.id!=='transcription');provider.endpoints.push({...structuredClone(template),id:'transcription',path:'/v1/audio/transcriptions',request_format:id+'.transcription',response_format:id+'.transcription',headers:{},query:{},native_proxy:true});
 provider.capabilities=provider.capabilities.filter(c=>c.endpoint!=='transcription');provider.capabilities.push({id:'audio.transcription',endpoint:'transcription',methods:['POST']});
 provider.models=provider.models.filter(m=>m.id!==id+'/'+upstream);provider.models.push({id:id+'/'+upstream,upstream,capabilities:['audio.transcription'],pricing:null,pricing_ref:null});
}
export default {async fetch(request,env) {
 const pending=[],results=[];const drain=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['groq','mistral'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',['groq','mistral'].map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
 for(const [id,model] of Object.entries(facts)) {
  await putGrantCredentials(env,'oauth/fixture/'+id,{provider:id,kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  for(const native of [true,false]) {
   const body=new FormData();body.set('model',native?model:id+'/'+model);body.set('language','en');body.set('file',new File([new Uint8Array([0,255,128,42])],'sample.wav',{type:'audio/wav'}));
   const response=await worker.fetch(new Request('https://router.example/v1/'+(native?'native/'+id+'/v1/audio/transcriptions':'proxy/'+id+'/transcription'),{method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret'},body}),env,{waitUntil:p=>pending.push(p)});
   results.push({id,native,status:response.status,body:await response.json(),accounting:response.headers.get('x-clawrouter-accounting')});await drain();
   if(bodyBudgetCharged()!==0)throw new Error('capacity retained after producer EOF');
  }
 }
 return Response.json({results,charges,finalCapacity:bodyBudgetCharged()});
},queue:worker.queue};`;
const upstream = `export default {async fetch(request){
 const id=request.url==='https://api.groq.com/openai/v1/audio/transcriptions'?'groq':request.url==='https://api.mistral.ai/v1/audio/transcriptions'?'mistral':null;
 if(!id||request.method!=='POST'||request.headers.get('authorization')!=='Bearer synthetic-original-key')return new Response('unqualified',{status:400});
 const body=await request.formData(),file=body.get('file'),expected=id==='groq'?'whisper-large-v3-turbo':'voxtral-mini-latest';
 if(JSON.stringify([...body.keys()])!==JSON.stringify(['model','language','file'])||body.get('model')!==expected||body.get('language')!=='en'||file.name!=='sample.wav'||file.type!=='audio/wav'||JSON.stringify([...new Uint8Array(await file.arrayBuffer())])!==JSON.stringify([0,255,128,42]))return new Response('multipart changed',{status:400});
 return Response.json({text:'synthetic transcript',usage:{input_tokens:1000,output_tokens:2000},duration:2});
}};`;

test("workerd preserves original multipart wire and selected credentials through native and manifest Groq/Mistral dispatch", { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-native-multipart-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const instance = await startWorkerdFixture(temporary, router, upstream); t.after(() => instance.dispose());
  const response = await fetch((await instance.ready).origin); assert.equal(response.status, 200, await response.clone().text());
  const proof = await response.json(); assert.equal(proof.results.length, 4);
  for (const item of proof.results) { assert.equal(item.status, 200, JSON.stringify(item)); assert.equal(item.body.text, "synthetic transcript"); assert.equal(item.accounting, "policy-fixed"); }
  assert.deepEqual(proof.charges, Array(4).fill(96 * 1024 * 1024)); assert.equal(proof.finalCapacity, 0);
});
