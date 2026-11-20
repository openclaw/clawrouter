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

async function ioFixture(t) {
  let mode='maximum';const gates=new Map(),released=new Set(),counts=new Map();let accountFetches=0;
  function maximum(){
    const prefix='https://api.individual.githubcopilot.com/';
    const root={endpoints:{api:prefix+'\ud800'.repeat(4096-prefix.length)}};
    let deep={};root.deep=deep;for(let i=1;i<63;i++){deep.n={};deep=deep.n;}
    root.rows=Array(2048).fill(null);for(let i=0;i<446;i++)root['o'+i]={};
    for(let i=0;i<1536;i++)root['s'+i]='';
    root.s0='x'.repeat(16777216-Buffer.byteLength(JSON.stringify(root)));
    const text=JSON.stringify(root);assert.equal(Buffer.byteLength(text),16777216);return text;
  }
  const server=createServer((request,response)=>{
    const p=request.url;counts.set(p,(counts.get(p)??0)+1);
    if(p==='/account'){
      accountFetches++;
      if(mode==='cancel'||mode==='revoke'||mode==='replace'||mode==='cleanup-error'){
        response.writeHead(200,{'content-type':'application/json'});response.write(' ');return;
      }
      const text=mode==='maximum'?maximum():'{"endpoints":{"api":"https://api.individual.githubcopilot.com/v1"}}';
      response.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text)});response.end(text);return;
    }
    if(p.startsWith('/gate/')){if(released.has(p))response.end('released');else gates.set(p,response);return;}
    response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return{origin:`http://127.0.0.1:${server.address().port}`,setMode(value){mode=value;},get fetches(){return accountFetches;},
    count(phase){return counts.get('/gate/'+phase)??0;},release(phase){const p='/gate/'+phase;released.add(p);gates.get(p)?.end('released');gates.delete(p);}};
}
const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {GrantCredentialObject as CredentialOwner,inspectGrantCredentials,putGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {authorityCall} from './worker/authority.ts';
import {bodyBudgetCharged,BodyLease} from './worker/body-budget.ts';
let mode='maximum',active;
const originalFetch=globalThis.fetch;
const gate=phase=>originalFetch('https://account-fixture.example/gate/'+mode+'/'+phase).then(async r=>{if(!r.ok)throw new Error('barrier');await r.text();});
globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input);
 const response=await originalFetch(input,init);
 if(url!=='https://api.github.com/copilot_internal/user')return response;
 const a=active={reads:0,cancels:0,unlocks:0,readRetired:false,cleanup:false,body:response.body,maximumBacking:0};
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{
  const native=getReader(options);
  return{async read(view){
   a.reads++;
   if((mode==='reads-exact'||mode==='reads-over')&&a.reads<=(mode==='reads-exact'?8190:8191))return{done:false,value:view.subarray(0,0)};
   const pending=native.read(view);
   try{const part=await pending;if(part.value)a.maximumBacking=Math.max(a.maximumBacking,part.value.buffer.byteLength);return part;}
   finally{if(['cancel','revoke','replace','cleanup-error'].includes(mode)&&a.reads===2){await gate('read');a.readRetired=true;}}
  },async cancel(reason){a.cancels++;await native.cancel(reason);if(['cancel','revoke','replace','cleanup-error','late'].includes(mode)){await gate('cleanup');a.cleanup=true;}if(mode==='cleanup-error')throw new Error('synthetic cleanup rejection');},
  releaseLock(){native.releaseLock();a.unlocks++;}};
 };
 if(mode==='late')await gate('response');
 return response;
};
export class GrantCredentialObject extends CredentialOwner{
 async fetch(request){const p=new URL(request.url).pathname;
  if(p==='/fixture/mode'){mode=await request.text();active=undefined;return Response.json({ok:true});}
  if(p==='/fixture/stats'){
   const contender=new BodyLease(),admitted=contender.grow(17*1024*1024);contender.release();
   return Response.json({charged:bodyBudgetCharged(),contender:admitted,reads:active?.reads,cancels:active?.cancels,unlocks:active?.unlocks,
    locked:active?.body.locked,cleanup:active?.cleanup,readRetired:active?.readRetired,maximumBacking:active?.maximumBacking});}
  return super.fetch(request);
 }
}
export default{async fetch(request,env,ctx){
 const url=new URL(request.url),key='oauth/fixture/'+(url.searchParams.get('grant')??'copilot');
 if(url.pathname==='/fixture/setup'){await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);return Response.json({ok:true});}
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
 if(request.url==='https://api.github.com/copilot_internal/user'){
  if(request.method!=='GET'||request.headers.get('authorization')!=='Bearer synthetic-original-github-token'||request.headers.has('cf-access-jwt-assertion'))throw new Error('account authority');
  return fetch(${JSON.stringify(io.origin+'/account')},{signal:request.signal});
 }
 if(request.url.startsWith('https://account-fixture.example/gate/'))return fetch(${JSON.stringify(io.origin)}+new URL(request.url).pathname);
 return new Response(null,{status:400});
}};`;}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' did not settle')),5000);})]);}finally{clearTimeout(timer);}}
async function publicBody(response,status=200){const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(text,/synthetic-original|synthetic-private|apiBaseUrl|ownerBinding|copilotAccountBinding/);return JSON.parse(text);}

test('actual workerd Copilot private account maximum shape, reads and cross-request owner retirement',{timeout:120000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'copilot-account-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const io=await ioFixture(t),signed=await access();
 const runtime=await startWorkerdFixture(directory,router,upstream(io,signed),{preventEviction:true,
  bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'device-workerd',CLAWROUTER_ACCESS_ADMIN_EMAILS:email}});t.after(()=>runtime.dispose());
 const control=async(p,grant,mode)=>{const r=await runtime.dispatchFetch(origin+p+'?grant='+grant+(mode?'&mode='+mode:''));assert.equal(r.status,200,await r.clone().text());return r.json();};
 await control('/fixture/setup','copilot');
 const run=(grant,flow,body)=>runtime.dispatchFetch(origin+path.replace('/copilot/','/'+grant+'/')+'?flow='+flow,{method:'POST',headers:{origin,'content-type':'application/json','cf-access-jwt-assertion':signed.jwt},body:JSON.stringify({flow,provider:'github-copilot',...body})});
 const until=async(grant,predicate)=>{let s;for(let i=0;i<100;i++){s=await control('/fixture/stats',grant);if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}assert.fail(JSON.stringify(s));};
 for(const mode of ['maximum','reads-exact','reads-over','cancel','cleanup-error','revoke','replace','late'])await t.test(mode,async()=>{
  const grant='account-'+mode;io.setMode(mode);
  const begin=await publicBody(await run(grant,'copilot-device.v1',{operation:'begin',githubDomain:'github.com',intentId:'synthetic-account-'+mode,expectedGeneration:0}));
  await new Promise(r=>setTimeout(r,Math.max(0,begin.nextPollAt-Date.now())+10));
  assert.equal((await publicBody(await run(grant,'copilot-device.v1',{operation:'poll',attemptId:begin.attemptId}))).status,'committed');
  const original=await control('/fixture/owner',grant);
  await control('/fixture/mode',grant,mode);
  const input={attemptId:begin.attemptId,expectedGeneration:original.generation,expectedLineage:original.lineage};
  const account=operation=>run(grant,'copilot-account.v1',{...input,operation});
  const before=io.fetches,pending=account('qualify');
  if(['maximum','reads-exact','reads-over'].includes(mode)){
   const v=await publicBody(await pending);assert.equal(v.status,mode==='reads-over'?'unknown':'qualified');
   const stats=await until(grant,s=>s.charged===0);assert.equal(stats.locked,false);assert.equal(stats.unlocks,1);assert.ok(stats.maximumBacking<=16384);
   if(mode!=='maximum')assert.equal(stats.reads,8192);
   assert.equal((await publicBody(await account('status'))).status,v.status);
   assert.deepEqual(await control('/fixture/owner',grant),original);
  }else{
   await until(grant,s=>mode==='late'?s.reads===0:s.reads===2);
   const status=await publicBody(await bounded(account('status'),'separate status'));assert.equal(status.status,'qualifying');
   if(mode==='revoke'||mode==='replace')await bounded(control('/fixture/'+mode,grant),'separate owner mutation');
   else assert.equal((await publicBody(await bounded(account('cancel'),'separate cancel'))).status,'cancelled');
   const publicResponse=await bounded(pending,'prompt public account cancellation');await publicBody(publicResponse,mode==='revoke'||mode==='replace'?409:200);
   let stats=await control('/fixture/stats',grant);assert.equal(stats.charged,64*1024*1024);assert.equal(stats.contender,false);
   if(mode==='late'){io.release(mode+'/response');await until(grant,s=>s.cancels===1);io.release(mode+'/cleanup');}
   else{
    stats=await until(grant,s=>s.cancels===1);assert.equal(stats.locked,true);
    io.release(mode+'/cleanup');stats=await until(grant,s=>s.cleanup);assert.equal(stats.locked,true);assert.equal(stats.charged,64*1024*1024);assert.equal(stats.readRetired,false);
    io.release(mode+'/read');
   }
   stats=await until(grant,s=>s.charged===0);assert.equal(stats.locked,false);assert.equal(stats.cancels,1);assert.equal(stats.unlocks,1);
   if(mode!=='revoke'&&mode!=='replace')assert.equal((await publicBody(await account('status'))).status,'cancelled');
  }
  assert.equal(io.fetches,before+1);
 });
});
