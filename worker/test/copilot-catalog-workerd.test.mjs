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
 let mode='setup';const gates=new Map(),released=new Set(),counts={account:0,catalog:0};
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/gate/')){if(released.has(req.url))res.end('released');else gates.set(req.url,res);return;}
  const phase=req.url==='/account'?'account':req.url==='/catalog'?'catalog':null;if(!phase){res.writeHead(404);res.end();return;}counts[phase]++;
  if((mode==='held-account'&&phase==='account')||(['held-catalog','cleanup-error','revoke','replace','account-cancel'].includes(mode)&&phase==='catalog')){res.writeHead(200,{'content-type':'application/json'});res.write(' ');return;}
  let text=phase==='account'?(mode==='maximum'?maximumAccount():'{"endpoints":{"api":"https://api.individual.githubcopilot.com/v1"}}')
   :(mode==='maximum'?maximumCatalog():JSON.stringify({data:mode==='empty'?[]:[{id:'model-0',model_picker_enabled:true,policy:{state:mode==='unknown'?'future':'enabled'},supported_endpoints:['/responses']}]}));
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
let mode='setup',readers=[],currentKey,contextEnv,firstSignal;
const originalFetch=globalThis.fetch,gate=phase=>originalFetch('https://catalog-fixture.example/gate/'+mode+'/'+phase).then(r=>r.text());
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input),phase=url.includes('/copilot_internal/user')?'account':url.endsWith('/models')?'catalog':null;
 const response=await originalFetch(input,init);if(!phase||mode==='setup')return response;
 if(phase==='account')firstSignal=init.signal;else if(firstSignal!==init.signal)throw Error('operation signal changed');
 const a={phase,reads:0,cancels:0,unlocks:0,readRetired:false,cleanup:false,body:response.body,maximumBacking:0};readers.push(a);
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{const native=getReader(options);return{
  async read(view){a.reads++;const exact=mode==='reads-exact',over=mode==='reads-over-'+phase;
   if((exact||over)&&a.reads<=(over?8191:8190))return{done:false,value:view.subarray(0,0)};
   const pending=native.read(view);
   try{const part=await pending;if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}
   finally{if(((mode==='held-account'&&phase==='account')||(['held-catalog','cleanup-error','revoke','replace','account-cancel'].includes(mode)&&phase==='catalog'))&&a.reads===2){await gate('read');a.readRetired=true;}}
  },async cancel(reason){a.cancels++;await native.cancel(reason);if(mode.startsWith('held-')||['cleanup-error','revoke','replace','account-cancel','late'].includes(mode)){await gate('cleanup');a.cleanup=true;}if(mode==='cleanup-error')throw Error('synthetic cleanup failure');},
  releaseLock(){native.releaseLock();a.unlocks++;}};};
 if(mode==='late'&&phase==='catalog')await gate('response');
 if(mode==='tighten'&&phase==='catalog')await authorityCall(contextEnv,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:[]}});
 return response;
};
export class GrantCredentialObject extends Owner{
 constructor(state,env){super(state,env);this.fixtureState=state;this.fixtureEnv=env;}
 async fetch(request){const p=new URL(request.url).pathname;
  if(p==='/fixture/mode'){mode=await request.text();readers=[];return Response.json({ok:true});}
  if(p==='/fixture/stats'){const competitor=new BodyLease(),admitted=competitor.grow(8*1024*1024);competitor.release();return Response.json({charged:bodyBudgetCharged(),contender:admitted,readers:readers.map(a=>({phase:a.phase,reads:a.reads,cancels:a.cancels,unlocks:a.unlocks,locked:a.body.locked,readRetired:a.readRetired,cleanup:a.cleanup,maximumBacking:a.maximumBacking}))});}
  if(p==='/fixture/catalog'){
   const supplied=await request.json(),r=await this.fixtureState.storage.get('credential'),b=r.copilotAccountBinding;contextEnv=this.fixtureEnv;
   const input={key:r.grantKey,expectedGeneration:r.generation,expectedLineage:r.lineage,deviceAttemptId:r.copilotDeviceAttempt.id,accountAttemptId:b.accountAttemptId,
    authorization:supplied.authorization,deadline:Date.now()+30000,runtimeIdentity:{ownerBinding:b.ownerBinding,integrationId:'fixture',editorVersion:'Fixture/1',editorPluginVersion:'Fixture/1',userAgent:'Fixture/1'},selection:{modelId:'github-copilot/model-0',format:'openai.responses'}};
   const abort=new AbortController();if(mode==='held-account'||mode==='held-catalog'||mode==='cleanup-error'||mode==='late')this.fixtureState.waitUntil(gate('abort').then(()=>abort.abort()));
   return super.fetch(new Request('https://clawrouter.internal/copilot-catalog',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:abort.signal}));
  }
  return super.fetch(request);
 }
}
export default{async fetch(request,env,ctx){
 const url=new URL(request.url),key='oauth/fixture/'+(url.searchParams.get('grant')??'copilot');
 if(url.pathname==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null}}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'catalog',credential:{enabled:true,policyId:'fixture',policyGeneration:'g1',principalId:null,secretSha256:await sha256Hex('abcdefgh')}}]);return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/policy'){await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{enabled:true,generation:'g1',providers:['github-copilot'],models:null}});return Response.json({ok:true});}
 if(url.pathname==='/fixture/catalog'){const auth=await authenticateProxyKey(new Headers({authorization:'Bearer clawrouter-live-catalog-abcdefgh'}),env);if(auth instanceof Response)return auth;
  return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://clawrouter.internal/fixture/catalog',{method:'POST',body:JSON.stringify({authorization:publicControlAuthorization(auth)})});}
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
 const phase=request.url==='https://api.github.com/copilot_internal/user'?'account':request.url.startsWith('https://api.individual.githubcopilot.com/')&&request.url.endsWith('/models')?'catalog':null;
 if(phase){if(request.method!=='GET'||request.headers.get('authorization')!=='Bearer synthetic-original-github-token'||request.headers.has('cf-access-jwt-assertion'))throw Error('original token');
  if(phase==='catalog'&&request.headers.get('copilot-integration-id')!=='fixture')throw Error('runtime identity');return fetch(${JSON.stringify(io.origin)}+'/'+phase,{signal:request.signal});}
 if(request.url.startsWith('https://catalog-fixture.example/gate/'))return fetch(${JSON.stringify(io.origin)}+new URL(request.url).pathname);
 return new Response(null,{status:400});}};`;}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Error(label+' did not settle')),5000);})]);}finally{clearTimeout(timer);}}
async function body(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|synthetic-private|apiBaseUrl|ownerBinding|copilotAccountBinding/);return JSON.parse(text);}

test('actual workerd owner-bound Copilot catalog two-response maximum shape and physical retirement',{timeout:120000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'copilot-catalog-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const io=await ioFixture(t),signed=await access(),runtime=await startWorkerdFixture(directory,router,upstream(io,signed),{preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'device-workerd',CLAWROUTER_ACCESS_ADMIN_EMAILS:email}});t.after(()=>runtime.dispose());
 const request=(p,grant,mode)=>runtime.dispatchFetch(origin+p+'?grant='+grant+(mode?'&mode='+mode:''));
 const control=async(p,grant,mode)=>{const r=await request(p,grant,mode);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const run=(grant,flow,value)=>runtime.dispatchFetch(origin+path.replace('/copilot/','/'+grant+'/')+'?flow='+flow,{method:'POST',headers:{origin,'content-type':'application/json','cf-access-jwt-assertion':signed.jwt},body:JSON.stringify({flow,provider:'github-copilot',...value})});
 const until=async(grant,predicate)=>{let s;for(let i=0;i<100;i++){s=await control('/fixture/stats',grant);if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}assert.fail(JSON.stringify(s));};
 await control('/fixture/setup','copilot');
 for(const mode of ['maximum','reads-exact','reads-over-account','reads-over-catalog','held-account','held-catalog','cleanup-error','late','revoke','replace','account-cancel','tighten','destination','empty','unknown'])await t.test(mode,async()=>{
  const grant='catalog-'+mode;io.setMode(mode==='maximum'?'maximum':'setup');await control('/fixture/policy',grant);await control('/fixture/mode',grant,'setup');
  const begun=await body(await run(grant,'copilot-device.v1',{operation:'begin',githubDomain:'github.com',intentId:'synthetic-catalog-'+mode,expectedGeneration:0}));
  await new Promise(r=>setTimeout(r,Math.max(0,begun.nextPollAt-Date.now())+10));
  assert.equal((await body(await run(grant,'copilot-device.v1',{operation:'poll',attemptId:begun.attemptId}))).status,'committed');
  const original=await control('/fixture/owner',grant),account=operation=>run(grant,'copilot-account.v1',{operation,attemptId:begun.attemptId,expectedGeneration:original.generation,expectedLineage:original.lineage});
  assert.equal((await body(await account('qualify'))).status,'qualified');await until(grant,s=>s.charged===0);
  io.setMode(mode);await control('/fixture/mode',grant,mode);const counts={...io.counts},pending=request('/fixture/catalog',grant);
  const held=['held-account','held-catalog','cleanup-error','late','revoke','replace','account-cancel'].includes(mode);
  if(held){
   const target=mode==='held-account'?'account':'catalog';
   await until(grant,s=>s.readers.some(r=>r.phase===target&&r.reads===(mode==='late'?0:2)));
   if(mode==='revoke'||mode==='replace')await bounded(control('/fixture/'+mode,grant),'owner mutation');
   else if(mode==='account-cancel')assert.equal((await body(await bounded(account('cancel'),'account cancellation'))).status,'cancelled');
   else io.release(mode+'/abort');
   await body(await bounded(pending,'prompt failure'),503);let stats=await control('/fixture/stats',grant);assert.equal(stats.charged,82*MiB);assert.equal(stats.contender,false);
   if(mode==='late')io.release(mode+'/response');
   stats=await until(grant,s=>s.readers.some(r=>r.cancels===1));const physical=stats.readers.find(r=>r.cancels===1);assert.equal(physical.locked,true);
   io.release(mode+'/cleanup');stats=await until(grant,s=>s.readers.some(r=>r.cleanup));
   if(mode!=='late'){assert.equal(stats.charged,82*MiB);assert.equal(stats.readers.find(r=>r.cancels===1).locked,true);io.release(mode+'/read');}
   stats=await until(grant,s=>s.charged===0);assert.equal(stats.readers.find(r=>r.cancels===1).unlocks,1);assert.ok(stats.readers.every(r=>!r.locked));
  }else{
   const status=mode.startsWith('reads-over')?503:mode==='destination'?409:200;
   const value=await body(await pending,status),stats=await until(grant,s=>s.charged===0);assert.ok(stats.readers.every(r=>!r.locked&&r.unlocks===1&&r.maximumBacking<=16384));
   if(mode==='maximum'){assert.equal(value.data.length,4096);assert.equal(value.selection.eligible,true);}
   if(mode==='reads-exact'){assert.equal(stats.readers.length,2);assert.equal(stats.readers.reduce((n,r)=>n+r.reads,0),16384);}
   if(mode.startsWith('reads-over'))assert.equal(stats.readers.at(-1).reads,8192);
   if(['tighten','empty'].includes(mode)){assert.deepEqual(value.data,[]);assert.equal(value.selection.eligible,false);}
   if(mode==='unknown')assert.equal(value.selection.eligible,false);
  }
  assert.equal(io.counts.account,counts.account+1);assert.equal(io.counts.catalog,counts.catalog+(['held-account','reads-over-account','destination'].includes(mode)?0:1));
 });
});
