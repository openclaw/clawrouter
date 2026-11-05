import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

async function barriers(t) {
  const held = new Map(), released = new Set(), counts = new Map();
  const server = createServer((request, response) => {
    const key = request.url;
    if (request.method !== "GET" || request.headers.authorization || !/^\/(upload|response|metadata|download)\/(abort|read|cleanup)$/.test(key)) { response.writeHead(400); response.end(); return; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) !== 1) { response.writeHead(409); response.end(); return; }
    if (released.has(key)) response.end("released"); else held.set(key, response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:" + server.address().port,
    release(mode, phase) { const key = "/" + mode + "/" + phase; released.add(key); held.get(key)?.end("released"); held.delete(key); },
    count(mode, phase) { return counts.get("/" + mode + "/" + phase) ?? 0; } };
}

const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
import {managedLifecycleAdapter} from './worker/managed-lifecycle-adapters.ts';
import {readGoogleOmniFileState,readGoogleOmniFile} from './worker/provider-google-omni-files.ts';
const rawFetch=globalThis.fetch.bind(globalThis),release=BodyLease.prototype.release;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let active,initialized=false;
BodyLease.prototype.release=function(){const before=bodyBudgetCharged();release.call(this);if(active&&bodyBudgetCharged()<before){
 active.releases++;if(active.releaseEvents.length<8)active.releaseEvents.push({phase:active.phase,before,after:bodyBudgetCharged(),
 sourceLocked:active.source?.locked??false,physicalLocked:active.physical?.locked??false,cleanup:active.cleanup,readRetired:active.readRetired});
}};
const state=()=>active?{mode:active.mode,phase:active.phase,errorCode:active.errorCode,errorClass:active.errorClass,
 fetches:active.fetches,reads:active.reads,cancels:active.cancels,cleanup:active.cleanup,readRetired:active.readRetired,
 results:active.results,status:active.status,releases:active.releases,releaseEvents:active.releaseEvents,charged:bodyBudgetCharged(),
 sourceLocked:active.source?.locked??false,physicalLocked:active.physical?.locked??false}:{};
const gate=(a,phase)=>rawFetch('https://retirement-gate.example/'+a.mode+'/'+phase,{redirect:'manual'}).then(async response=>{
 if(!response.ok)throw new Error('fixture gate rejected');await response.text();
});
function hold(response,a){
 a.physical=response.body;const reader=response.body.getReader();let stopped=false,first=true,cancellation,pulling;
 const cancel=reason=>cancellation??=(async()=>{
  stopped=true;a.cancels++;
  const cleanup=(async()=>{try{await reader.cancel(reason);}catch{}await gate(a,'cleanup');a.cleanup=true;})();
  await Promise.allSettled([pulling,cleanup]);reader.releaseLock();
 })();
 a.source=new ReadableStream({pull(controller){return pulling=(async()=>{
  a.reads++;a.phase='physical-read';let next;
  try{next=await reader.read();}finally{if(first){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}
  if(stopped)return;if(next.done)controller.close();else controller.enqueue(next.value);
 })();},cancel},{highWaterMark:0});
 return new Response(a.source,{status:response.status,headers:response.headers});
}
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),a=active;
 if(a)a.fetches++;
 const response=await rawFetch(request);
 const selected=a&&(a.mode==='response'&&request.url==='https://api.groq.com/openai/v1/audio/transcriptions'
  ||a.mode==='metadata'&&request.url.endsWith('/v1/files/fixture-video')
  ||a.mode==='download'&&request.url.endsWith('/v1/files/fixture-video:download'));
 return selected?hold(response,a):response;
};
const groq=structuredClone(snapshot.providers.find(p=>p.id==='groq'));
const audio={id:'transcription',path:'/v1/audio/transcriptions',path_params:[],path_param_styles:{},
 request_format:'groq.transcription',response_format:'groq.transcription',native_proxy:true,timeout_ms:10000,method:'POST',methods:['POST'],auth:null,headers:{},request_headers:[],response_headers:[],query:{},streaming:null};
groq.capabilities=groq.capabilities.filter(c=>c.endpoint!=='transcription');groq.capabilities.push({id:'audio.transcription',endpoint:'transcription',methods:['POST']});
groq.endpoints=groq.endpoints.filter(e=>e.id!=='transcription');groq.endpoints.push(audio);
groq.models=groq.models.filter(m=>m.id!=='groq/whisper-large-v3-turbo');groq.models.push({id:'groq/whisper-large-v3-turbo',upstream:'whisper-large-v3-turbo',capabilities:['audio.transcription'],pricing:null,pricing_ref:null});
snapshot.providers=snapshot.providers.map(p=>p.id==='groq'?groq:p);
const replicate=snapshot.providers.find(p=>p.id==='replicate'),create=replicate.endpoints.find(e=>e.id==='predictions');
create.lifecycle.files={metadata:'retirement_file',download:'retirement_download'};
for(const [id,suffix]of [['retirement_file',''],['retirement_download',':download']])replicate.endpoints.push({
 ...structuredClone(replicate.endpoints.find(e=>e.id==='prediction')),id,path:'/v1/files/'+String.fromCharCode(36)+'{file_id}'+suffix,path_params:['file_id'],path_param_styles:{},query:{},headers:{},
 request_format:'fixture.file',response_format:id==='retirement_file'?'fixture.file':'fixture.bytes',method:'GET',methods:['GET'],native_proxy:true});
managedLifecycleAdapter('replicate.predictions').files={protocol:'replicate.predictions',
 describe(){return [{id:'fixture-video',mimeType:'video/mp4'}];},
 identify(_action,params,query){if(Object.keys(params).join()!=='file_id'||params.file_id!=='fixture-video'||query.size)throw new Error('invalid fixture file');return params.file_id;},
 control(action,endpoint,descriptor){return {path:'/v1/files/'+descriptor.id+(action==='download'?':download':''),query:new URLSearchParams()};},
 async readState(response,descriptor){const result=await readGoogleOmniFileState(response,'files/'+descriptor.id);return {id:descriptor.id,status:result.state.toLowerCase(),body:{name:result.name,state:result.state}};},
 readFile(response,_descriptor,limit){return readGoogleOmniFile(response,limit);},
 rewrite(body,paths){return {...body,files:paths};}
};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/state')return Response.json(state());
 if(url.pathname==='/contend'){const lease=new BodyLease(),allowed=lease.grow(33*1024*1024);lease.release();return Response.json({allowed,charged:bodyBudgetCharged()});}
 if(url.pathname!=='/start'||active&&active.releases!==1)return new Response(null,{status:409});
 const mode=url.searchParams.get('mode');if(!['upload','response','metadata','download'].includes(mode))return new Response(null,{status:400});
 const headers={authorization:'Bearer clawrouter-live-fixture-fixture-secret'};
 if(!initialized){
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['groq','replicate'],tenantId:'fixture',monthlyBudgetMicros:10000,requestCostMicros:700,retainRequestContent:false}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',['groq','replicate'].map(providerId=>({providerId,enabled:true,monthlyBudgetMicros:10000})));
  for(const provider of ['groq','replicate'])await putGrantCredentials(env,'oauth/fixture/'+provider,{provider,kind:'api_key',enabled:true,credential:'synthetic-original-key'});
  const created=await worker.fetch(new Request('https://router.example/v1/native/replicate/v1/predictions',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({version:'1'.repeat(64),input:{prompt:'synthetic fixture'}})}),env,ctx);
  if(created.status!==200)throw new Error('fixture create failed '+created.status+' '+await created.text());await created.text();initialized=true;
 }
 const a={mode,phase:'setup',fetches:0,reads:0,cancels:0,cleanup:false,readRetired:false,results:0,status:0,releases:0,releaseEvents:[],ready:deferred(),abort:new AbortController()};active=a;
 let target;
 if(mode==='upload'){
  const source=hold(await rawFetch('https://retirement-source.example/upload',{redirect:'manual'}),a);
  target=new Request('https://router.example/v1/native/groq/v1/audio/transcriptions',{method:'POST',headers:{...headers,'content-type':'multipart/form-data; boundary=x'},body:source.body,signal:a.abort.signal});
 }else if(mode==='response'){
  const form=new FormData();form.set('model','groq/whisper-large-v3-turbo');form.set('file',new File([new Uint8Array([1,2,3,4])],'fixture.wav',{type:'audio/wav'}));
  target=new Request('https://router.example/v1/proxy/groq/transcription',{method:'POST',headers,body:form,signal:a.abort.signal});
 }else target=new Request('https://router.example/v1/native/replicate/v1/files/fixture-video'+(mode==='download'?':download':''),{headers:{...headers,'x-clawrouter-job-id':'prediction_fixture_001'},signal:a.abort.signal});
 ctx.waitUntil(gate(a,'abort').then(()=>a.abort.abort(new Error('synthetic caller cancellation'))));
 ctx.waitUntil(worker.fetch(target,env,ctx).then(async response=>{a.status=response.status;const text=await response.text();try{a.errorCode=JSON.parse(text)?.error?.code;}catch{}a.results++;a.phase='result';a.ready.resolve();})
  .catch(error=>{a.errorClass=error?.name;a.results++;a.phase='rejected';a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};
`;
const upstream = origin => String.raw`
export default {async fetch(request){
 const url=new URL(request.url);
 if(url.origin==='https://retirement-gate.example'){
  if(request.headers.has('authorization'))throw new Error('gate credential leak');return fetch(BARRIER_ORIGIN+url.pathname,{redirect:'manual',signal:request.signal});
 }
 if(url.origin==='https://retirement-source.example')return new Response('prefix');
 if(request.headers.get('authorization')!=='Bearer synthetic-original-key')throw new Error('wrong original key');
 if(url.href==='https://api.groq.com/openai/v1/audio/transcriptions'){
  const form=await request.formData();if(form.get('model')!=='whisper-large-v3-turbo')throw new Error('wrong model');return Response.json({text:'synthetic'});
 }
 if(url.href==='https://api.replicate.com/v1/predictions')return Response.json({id:'prediction_fixture_001',version:'1'.repeat(64),status:'succeeded',input:{prompt:'synthetic fixture'},output:['https://media.example/final.png'],error:null,logs:'',urls:{get:'https://api.replicate.com/v1/predictions/prediction_fixture_001',cancel:'https://api.replicate.com/v1/predictions/prediction_fixture_001/cancel'}});
 if(url.href==='https://api.replicate.com/v1/files/fixture-video')return Response.json({name:'files/fixture-video',state:'ACTIVE',mimeType:'video/mp4'});
 if(url.href==='https://api.replicate.com/v1/files/fixture-video:download')return new Response(new Uint8Array([0,255,128,7]),{headers:{'content-type':'video/mp4'}});
 throw new Error('unexpected fixture fetch');
}};
`.replace("BARRIER_ORIGIN",JSON.stringify(origin));

test("workerd multipart and original-job file aborts keep physical input and capacity until first cleanup retires", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "multipart-managed-retirement-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const controls = await barriers(t), modes = ["upload", "response", "metadata", "download"];
  const runtime = await startWorkerdFixture(temporary, router, upstream(controls.origin), { preventEviction: true });
  t.after(async () => { for (const mode of modes) for (const phase of ["abort", "read", "cleanup"]) controls.release(mode,phase); await runtime.dispose(); });
  const call = async path => { const response = await runtime.dispatchFetch("https://router.example"+path); assert.equal(response.status,200,await response.clone().text()); return response.json(); };
  const until = async predicate => { let value; for(let i=0;i<100;i++){value=await call('/state');if(predicate(value))return value;await delay(10);}assert.fail(JSON.stringify(value)); };
  for (const mode of modes) {
    const charge=(mode==='upload'||mode==='response'?96:32)*1024*1024;
    let state=await call('/start?mode='+mode);assert.equal(state.charged,charge,JSON.stringify(state));assert.equal(state.reads,1,JSON.stringify(state));
    controls.release(mode,'abort');state=await until(s=>s.results===1&&s.cancels===1);
    assert.equal(state.status,mode==='upload'?400:499,JSON.stringify(state));assert.equal(state.releases,0,JSON.stringify(state));assert.equal(state.charged,charge,JSON.stringify(state));
    assert.equal(state.sourceLocked,true);assert.equal(state.physicalLocked,true);assert.deepEqual(await call('/contend'),{allowed:false,charged:charge});
    const first=mode==='upload'||mode==='metadata'?'read':'cleanup',second=first==='read'?'cleanup':'read';
    controls.release(mode,first);state=await until(s=>first==='read'?s.readRetired:s.cleanup);
    assert.equal(state.charged,charge,JSON.stringify(state));assert.equal(state.releases,0,JSON.stringify(state));assert.equal(state.sourceLocked,true);
    controls.release(mode,second);state=await until(s=>s.releases===1);
    assert.equal(state.charged,0);assert.equal(state.sourceLocked,false);assert.equal(state.physicalLocked,false);assert.equal(state.cleanup,true);assert.equal(state.readRetired,true);
    assert.equal(state.cancels,1);assert.equal(state.results,1);assert.equal(state.fetches,mode==='upload'?0:mode==='download'?2:1);
    for(const phase of ['abort','read','cleanup'])assert.equal(controls.count(mode,phase),1);
  }
});
