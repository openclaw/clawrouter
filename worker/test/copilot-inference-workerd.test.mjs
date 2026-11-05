import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const origin = "https://router.example", issuer = "https://device-workerd.cloudflareaccess.com";
const email = "device-admin@example.invalid", key = "oauth/fixture/copilot";
const path = "/v1/admin/upstream-grants/policies/fixture/copilot/authorize";
async function access() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "device-workerd-key" };
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "device-workerd", email, sub: "device-workerd-admin", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return { jwk, jwt: `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}` };
}

const MiB=1024*1024;
function maximumAccount(){
 const prefix='https://api.individual.githubcopilot.com/',root={endpoints:{api:prefix+'\ud800'.repeat(4096-prefix.length)}};
 let deep={};root.deep=deep;for(let i=1;i<63;i++){deep.n={};deep=deep.n;}root.rows=Array(2048).fill(null);
 for(let i=0;i<446;i++)root['o'+i]={};for(let i=0;i<1536;i++)root['s'+i]='';root.s0='x'.repeat(16*MiB-Buffer.byteLength(JSON.stringify(root)));
 return JSON.stringify(root);
}
function maximumCatalog(){
 const data=Array.from({length:4096},(_,i)=>({id:'model-'+i,model_picker_enabled:true,policy:{state:'enabled'},supported_endpoints:['/responses']}));
 const text='{"data":'+JSON.stringify(data)+',"discarded":['+'['.repeat(62)+']'.repeat(62)+','+'[],'.repeat(20416)+'null,'.repeat(102401)+'null],"meta":{'+Array(110588).fill('"":0').join(',')+'},"padding":"';
 const result=text+'x'.repeat(2*MiB-Buffer.byteLength(text+'"}'))+'"}';assert.equal(Buffer.byteLength(result),2*MiB);return result;
}
async function ioFixture(t){
 let mode='setup';const gates=new Map(),released=new Set(),counts={account:0,catalog:0,inference:0};
 const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/gate/')){if(released.has(req.url))res.end('released');else gates.set(req.url,res);return;}
  const phase=req.url==='/account'?'account':req.url==='/catalog'?'catalog':req.url==='/inference'?'inference':null;if(!phase){res.writeHead(404);res.end();return;}counts[phase]++;
  if(phase==='inference'){
   let body='';for await(const part of req)body+=part;const input=JSON.parse(body),format=req.headers['x-fixture-api'];let text;
   const value=format==='messages'?{id:'reply',type:'message',role:'assistant',model:'model-0',content:[{type:'text',text:'hello'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}}:format==='responses'?{id:'reply',object:'response',status:'completed',model:'model-0',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}}:{id:'reply',object:'chat.completion',model:'model-0',choices:[{index:0,message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}};
   if(['held-inference','cleanup-error','revoke','replace','account-cancel'].includes(mode)){res.writeHead(200,{'content-type':input.stream?'text/event-stream':'application/json'});res.write(' ');return;}
   if(input.stream){const frame='data: '+JSON.stringify({model:'model-0',choices:[{delta:{content:'hello'}}]})+'\n\n';text=format==='messages'?'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:value})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n':format==='responses'?'event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:value})+'\n\n':frame+'data: [DONE]\n\n';
    if(mode==='maximum-stream'){const prefix='data: {"x":"',suffix='"}\n\n',chunk=prefix+'x'.repeat(65536-Buffer.byteLength(prefix+suffix))+suffix;text=chunk.repeat(512);}
    if(mode==='incremental'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame);gates.set('/gate/incremental/stream',{end(){res.end('data: [DONE]\n\n');}});return;}
    if(mode==='bad-frame')text=frame+'data: {"x":['+Array(4096).fill(0).join(',')+']}\n\n';
   }else{text=JSON.stringify(value);if(mode==='maximum')text='{"x":"'+'x'.repeat(262144-8)+'"}';}
   res.writeHead(200,{'content-type':input.stream?'text/event-stream':'application/json','content-length':Buffer.byteLength(text)});res.end(text);return;
  }

  if((mode==='held-account'&&phase==='account')||(mode==='held-catalog'&&phase==='catalog')||(['held-inference','cleanup-error','revoke','replace','account-cancel'].includes(mode)&&phase==='inference')){res.writeHead(200,{'content-type':'application/json'});res.write(' ');return;}
  let text=phase==='account'?(mode==='maximum'?maximumAccount():'{"endpoints":{"api":"https://api.individual.githubcopilot.com/v1"}}')
   :(mode==='maximum'?maximumCatalog():JSON.stringify({data:mode==='empty'?[]:[{id:'model-0',model_picker_enabled:true,policy:{state:mode==='unknown'?'future':'enabled'},supported_endpoints:['/chat/completions','/messages','/responses']}]}));
  if(mode==='destination'&&phase==='account')text='{"endpoints":{"api":"https://api.business.githubcopilot.com"}}';
  res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text)});res.end(text);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 return{origin:`http://127.0.0.1:${server.address().port}`,setMode(m){mode=m;},counts,release(name){const p='/gate/'+name;released.add(p);gates.get(p)?.end('released');gates.delete(p);}};
}
const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {GrantCredentialObject as Owner,inspectGrantCredentials,putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {authorityCall} from './worker/authority.ts';
import {authenticateProxyKey} from './worker/proxy-auth.ts';
import {publicControlAuthorization} from './worker/response-control-authorization.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
import {sha256Hex} from './worker/utils.ts';
let mode='setup',readers=[],currentKey,contextEnv,firstSignal,events=[];
const originalFetch=globalThis.fetch,gate=phase=>originalFetch('https://catalog-fixture.example/gate/'+mode+'/'+phase).then(r=>r.text());
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input),phase=url.includes('/copilot_internal/user')?'account':url.endsWith('/models')?'catalog':url.startsWith('https://api.individual.githubcopilot.com/')?'inference':null;
 const response=await originalFetch(input,init);if(!phase||mode==='setup')return response;
 if(phase==='account')firstSignal=init.signal;else if(firstSignal!==init.signal)throw Error('operation signal changed');
 const a={phase,reads:0,cancels:0,unlocks:0,readRetired:false,cleanup:false,body:response.body,maximumBacking:0};readers.push(a);
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{const native=getReader(options);return{
  async read(view){a.reads++;const exact=mode==='reads-exact',over=mode==='reads-over-'+phase;
   if((exact||over)&&a.reads<=(over?8191:8190))return{done:false,value:view.subarray(0,0)};
   const pending=native.read(view);
   try{const part=await pending;if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}
   finally{if(((mode==='held-account'&&phase==='account')||(mode==='held-catalog'&&phase==='catalog')||(['held-inference','cleanup-error','revoke','replace','account-cancel'].includes(mode)&&phase==='inference'))&&a.reads===2){await gate('read');a.readRetired=true;}}
  },async cancel(reason){a.cancels++;await native.cancel(reason);if(mode.startsWith('held-')||['cleanup-error','revoke','replace','account-cancel','late'].includes(mode)){await gate('cleanup');a.cleanup=true;}if(mode==='cleanup-error')throw Error('synthetic cleanup failure');},
  releaseLock(){native.releaseLock();a.unlocks++;}};};
 if(mode==='late'&&phase==='inference')await gate('response');
 if(mode==='tighten'&&phase==='catalog')await authorityCall(contextEnv,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:[]}});
 return response;
};
export class GrantCredentialObject extends Owner{
 constructor(state,env){super(state,{...env,USAGE_QUEUE:{async send(event){events.push(event);}}});this.fixtureState=state;this.fixtureEnv=env;}
 async fetch(request){const p=new URL(request.url).pathname;
  if(p==='/fixture/mode'){mode=await request.text();readers=[];events=[];return Response.json({ok:true});}
  if(p==='/fixture/stats'){const competitor=new BodyLease(),admitted=competitor.grow(8*1024*1024);competitor.release();return Response.json({charged:bodyBudgetCharged(),contender:admitted,events,readers:readers.map(a=>({phase:a.phase,reads:a.reads,cancels:a.cancels,unlocks:a.unlocks,locked:a.body.locked,readRetired:a.readRetired,cleanup:a.cleanup,maximumBacking:a.maximumBacking}))});}
  if(p==='/fixture/inference'){
   const supplied=await request.json(),r=await this.fixtureState.storage.get('credential'),b=r.copilotAccountBinding;contextEnv=this.fixtureEnv;
   const format=supplied.format??'openai.responses',stream=supplied.stream??false;
   const body={model:'model-0',stream,...(format==='openai.responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})};
   if(mode==='maximum')body.padding='';
   const input={initiator:'user',body,key:r.grantKey,expectedGeneration:r.generation,expectedLineage:r.lineage,deviceAttemptId:r.copilotDeviceAttempt.id,accountAttemptId:b.accountAttemptId,
    authorization:supplied.authorization,deadline:Date.now()+30000,runtimeIdentity:{ownerBinding:b.ownerBinding,integrationId:'fixture',editorVersion:'Fixture/1',editorPluginVersion:'Fixture/1',userAgent:'Fixture/1'},selection:{modelId:'github-copilot/model-0',format}};
   if(mode==='maximum')body.padding='x'.repeat(262144-new TextEncoder().encode(JSON.stringify(input)).length);
   const abort=new AbortController();if(mode==='held-input'||mode==='held-account'||mode==='held-catalog'||mode==='held-inference'||mode==='cleanup-error'||mode==='late')this.fixtureState.waitUntil(gate('abort').then(()=>abort.abort()));
   const native=new Request('https://clawrouter.internal/copilot-inference',{method:'POST',headers:{'content-type':'application/json','x-clawrouter-copilot-deadline':String(input.deadline)},body:JSON.stringify(input),signal:abort.signal});
   const a={phase:'input',reads:0,cancels:0,unlocks:0,maximumBacking:0,body:native.body};readers.push(a);const get=native.body.getReader.bind(native.body);
   native.body.getReader=options=>{const r=get(options);return{async read(view){a.reads++;if((mode==='reads-exact'||mode==='reads-over-input')&&a.reads<=(mode==='reads-over-input'?8191:8190))return{done:false,value:view.subarray(0,0)};try{const part=await r.read(view);if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}finally{if(mode==='held-input'&&a.reads===1){await gate('read');a.readRetired=true;}}},async cancel(reason){a.cancels++;await r.cancel(reason);if(mode==='held-input'){await gate('cleanup');a.cleanup=true;}},releaseLock(){a.unlocks++;r.releaseLock();}};};
   return super.fetch(native);
  }
  return super.fetch(request);
 }
}
export default{async fetch(request,env,ctx){
 const url=new URL(request.url),key='oauth/fixture/'+(url.searchParams.get('grant')??'copilot');
 if(url.pathname==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,requestCostMicros:700}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'catalog',credential:{enabled:true,policyId:'fixture',policyGeneration:'g1',principalId:null,secretSha256:await sha256Hex('abcdefgh')}}]);return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/policy'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,requestCostMicros:700}});return Response.json({ok:true});}
 if(url.pathname==='/fixture/unknown'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null,monthlyBudgetMicros:1000}});return Response.json({ok:true});}
 if(url.pathname==='/fixture/inference'){const auth=await authenticateProxyKey(new Headers({authorization:'Bearer clawrouter-live-catalog-abcdefgh'}),env);if(auth instanceof Response)return auth;
  return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://clawrouter.internal/fixture/inference',{method:'POST',body:JSON.stringify({authorization:publicControlAuthorization(auth),format:url.searchParams.get('format')??'openai.responses',stream:url.searchParams.get('stream')==='true'})});}
 if(url.pathname==='/fixture/mode'||url.pathname==='/fixture/stats')return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://clawrouter.internal'+url.pathname,{method:'POST',body:url.searchParams.get('mode')??''});
 if(url.pathname==='/fixture/owner'){const g=await inspectGrantCredentials(env,key);return Response.json({generation:g.credentialGeneration,lineage:g.credentialLineage,status:g.credentialStatus,hasAccessToken:g.hasAccessToken,hasCredential:g.hasCredential});}
 if(url.pathname==='/fixture/revoke'){await revokeGrantCredentials(env,key);return Response.json({ok:true});}
 if(url.pathname==='/fixture/replace'){await putGrantCredentials(env,key,{provider:'github-copilot',kind:'api_key',credential:'synthetic-replacement'});return Response.json({ok:true});}
 return worker.fetch(request,env,ctx);
},queue:worker.queue};`;
function upstream(io,signed){return `export default{async fetch(request){
 if(request.url===${JSON.stringify(issuer+'/cdn-cgi/access/certs')})return Response.json({keys:[${JSON.stringify(signed.jwk)}]});
 if(request.url==='https://github.com/login/device/code')return Response.json({device_code:'synthetic-private-device-code',user_code:'SYNTHETIC-CODE',verification_uri:'https://github.com/login/device',expires_in:900,interval:1});
 if(request.url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'synthetic-original-github-token',token_type:'bearer',scope:'read:user'});
 const phase=request.url==='https://api.github.com/copilot_internal/user'?'account':request.url.startsWith('https://api.individual.githubcopilot.com/')&&request.url.endsWith('/models')?'catalog':request.url.startsWith('https://api.individual.githubcopilot.com/')?'inference':null;
 if(phase){if(request.method!==(phase==='inference'?'POST':'GET')||request.headers.get('authorization')!=='Bearer synthetic-original-github-token'||request.headers.has('cf-access-jwt-assertion'))throw Error('original token');
  if(phase==='catalog'&&request.headers.get('copilot-integration-id')!=='fixture')throw Error('runtime identity');return fetch(${JSON.stringify(io.origin)}+'/'+phase,{method:request.method,...(phase==='inference'?{body:request.body,headers:{'x-fixture-api':new URL(request.url).pathname.split('/').at(-1)}}:{}),signal:request.signal});}
 if(request.url.startsWith('https://catalog-fixture.example/gate/'))return fetch(${JSON.stringify(io.origin)}+new URL(request.url).pathname);
 return new Response(null,{status:400});}};`;}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Error(label+' did not settle')),5000);})]);}finally{clearTimeout(timer);}}
async function body(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|synthetic-private|apiBaseUrl|ownerBinding|copilotAccountBinding/);return JSON.parse(text);}


test('actual workerd private Copilot inference three APIs, composite limits and physical retirement',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'copilot-inference-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const io=await ioFixture(t),signed=await access(),runtime=await startWorkerdFixture(directory,router,upstream(io,signed),{preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'device-workerd',CLAWROUTER_ACCESS_ADMIN_EMAILS:email}});t.after(()=>runtime.dispose());
 const request=(p,grant,mode)=>runtime.dispatchFetch(origin+p+'?grant='+grant+(mode?'&mode='+mode:''));
 const control=async(p,grant,mode)=>{const r=await request(p,grant,mode);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const run=(grant,flow,value)=>runtime.dispatchFetch(origin+path.replace('/copilot/','/'+grant+'/')+'?flow='+flow,{method:'POST',headers:{origin,'content-type':'application/json','cf-access-jwt-assertion':signed.jwt},body:JSON.stringify({flow,provider:'github-copilot',...value})});
 const until=async(grant,predicate)=>{let s;for(let i=0;i<150;i++){s=await control('/fixture/stats',grant);if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}assert.fail(JSON.stringify(s));};
 await control('/fixture/setup','copilot');
 const cases=[...['openai.chat_completions','anthropic.messages','openai.responses'].flatMap(format=>[false,true].map(stream=>({mode:format+'-'+stream,format,stream}))),...['maximum','maximum-stream','incremental','reads-exact','reads-over-input','reads-over-account','reads-over-catalog','reads-over-inference','held-input','held-account','held-catalog','held-inference','cleanup-error','late','revoke','replace','account-cancel','tighten','destination','empty','unknown','unknown-price','bad-frame','downstream-cancel'].map(mode=>({mode,format:'openai.responses',stream:['maximum-stream','incremental','bad-frame'].includes(mode)}))];
 for(const {mode,format,stream} of cases)await t.test(mode,async()=>{
  const grant='inference-'+mode.replaceAll('.','-');io.setMode(mode==='maximum'?'maximum':'setup');await control('/fixture/policy',grant);await control('/fixture/mode',grant,'setup');
  const begun=await body(await run(grant,'copilot-device.v1',{operation:'begin',githubDomain:'github.com',intentId:'synthetic-'+mode,expectedGeneration:0}));
  await new Promise(r=>setTimeout(r,Math.max(0,begun.nextPollAt-Date.now())+10));
  assert.equal((await body(await run(grant,'copilot-device.v1',{operation:'poll',attemptId:begun.attemptId}))).status,'committed');
  const original=await control('/fixture/owner',grant),account=operation=>run(grant,'copilot-account.v1',{operation,attemptId:begun.attemptId,expectedGeneration:original.generation,expectedLineage:original.lineage});
  assert.equal((await body(await account('qualify'))).status,'qualified');await until(grant,s=>s.charged===0);
  io.setMode(mode);await control('/fixture/mode',grant,mode);if(mode==='unknown-price')await control('/fixture/unknown',grant);const counts={...io.counts};
  const pending=runtime.dispatchFetch(origin+'/fixture/inference?grant='+grant+'&format='+format+'&stream='+stream);
  const held=['held-input','held-account','held-catalog','held-inference','cleanup-error','late','revoke','replace','account-cancel'].includes(mode);
  if(held){
   const target=mode==='held-input'?'input':mode==='held-account'?'account':mode==='held-catalog'?'catalog':'inference';
   const readResponse=target==='inference'&&mode!=='late'?await pending:null;
   let consuming=readResponse?.text();if(consuming)void consuming.catch(()=>{});
   await until(grant,s=>s.readers.some(r=>r.phase===target&&r.reads===(mode==='late'?0:mode==='held-input'?1:2)));
   if(mode==='revoke'||mode==='replace')await bounded(control('/fixture/'+mode,grant),'owner mutation');
   else if(mode==='account-cancel')assert.equal((await body(await bounded(account('cancel'),'account cancellation'))).status,'cancelled');
   else io.release(mode+'/abort');
   if(consuming)await assert.rejects(bounded(consuming,'prompt delivery failure'));else await body(await bounded(pending,'prompt failure'),503);
   let stats=await control('/fixture/stats',grant);assert.equal(stats.charged,96*MiB);assert.equal(stats.contender,false);
   if(mode==='late')io.release(mode+'/response');
   stats=await until(grant,s=>s.readers.some(r=>r.phase===target&&r.cancels===1));assert.equal(stats.readers.find(r=>r.phase===target).locked,true);
   io.release(mode+'/cleanup');stats=await until(grant,s=>s.readers.some(r=>r.phase===target&&r.cleanup));
   if(mode!=='late'){assert.equal(stats.charged,96*MiB);assert.equal(stats.readers.find(r=>r.phase===target).locked,true);io.release(mode+'/read');}
   stats=await until(grant,s=>s.charged===0);assert.equal(stats.readers.find(r=>r.phase===target).unlocks,1);assert.ok(stats.readers.every(r=>!r.locked));assert.equal(stats.events.length,target==='input'?0:1);if(target!=='input')assert.equal(stats.events[0].actual_cost_micros,target==='inference'?700:0);
  }else{
   const response=await pending;
   if(mode==='incremental'){
    assert.equal(response.status,200);const reader=response.body.getReader(),first=await bounded(reader.read(),'first authorized frame');assert.match(new TextDecoder().decode(first.value),/hello/);assert.equal((await control('/fixture/stats',grant)).charged,96*MiB);io.release('incremental/stream');while(!(await reader.read()).done){}reader.releaseLock();
   }else if(mode==='downstream-cancel'){assert.equal(response.status,200);await response.body.cancel();}
   else if(mode==='unknown-price'){await body(response,400);assert.deepEqual(io.counts,counts);}
   else if(mode==='bad-frame'||mode==='reads-over-inference')await assert.rejects(response.text());
   else if(mode.startsWith('reads-over'))await body(response,503);
   else if(['tighten','destination','empty','unknown'].includes(mode))await body(response,409);
   else {assert.equal(response.status,200);const text=await response.text();if(mode==='maximum')assert.equal(Buffer.byteLength(text),262144);if(mode==='maximum-stream')assert.equal(Buffer.byteLength(text),32*MiB);}
   const stats=await until(grant,s=>s.charged===0);assert.ok(stats.readers.every(r=>!r.locked&&r.unlocks===1&&r.maximumBacking<=16384));
   if(mode==='reads-exact'){assert.equal(stats.readers.length,4);assert.equal(stats.readers.reduce((n,r)=>n+r.reads,0),32768);}
   if(mode.startsWith('reads-over'))assert.equal(stats.readers.at(-1).reads,8192);
   if(io.counts.inference>counts.inference){assert.equal(stats.events.length,1);assert.equal(stats.events[0].actual_cost_micros,700);}
  }
  assert.ok(io.counts.inference-counts.inference<=1);assert.ok(io.counts.account-counts.account<=1);assert.ok(io.counts.catalog-counts.catalog<=1);
 });
});
