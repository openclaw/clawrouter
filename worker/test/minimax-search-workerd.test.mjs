import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
const origin = "https://router.example", issuer = "https://search-workerd.cloudflareaccess.com", email = "search-admin@example.invalid";
async function access() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "search-fixture" };
  const enc = x => Buffer.from(JSON.stringify(x)).toString("base64url");
  const unsigned = enc({ alg: "RS256", kid: jwk.kid }) + "." + enc({ iss: issuer, aud: "search-fixture", email, sub: "synthetic-admin", exp: Math.floor(Date.now()/1000)+600 });
  return { jwk, jwt: unsigned + "." + Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned))).toString("base64url") };
}
async function barriers(t) {
  const held = new Map(), released = new Set(), entered = new Map();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.headers.authorization || !/^\/[a-z-]+\/[a-z-]+$/.test(request.url)) { response.writeHead(400); response.end(); return; }
    entered.get(request.url)?.resolve();
    if (released.has(request.url)) response.end("released"); else held.set(request.url, response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: "http://127.0.0.1:"+server.address().port, entered(mode, phase) { const key="/"+mode+"/"+phase; if (held.has(key)) return Promise.resolve(); const wait=Promise.withResolvers(); entered.set(key,wait); return wait.promise; }, release(mode, phase) { const k="/"+mode+"/"+phase; released.add(k); held.get(k)?.end("released"); held.delete(k); } };
}
const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import {GrantCredentialObject as BaseGrantCredentialObject} from './worker/grant-credentials.ts';
import worker from './worker/index.ts';
import {snapshot} from './worker/providers.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials,revokeGrantCredentials} from './worker/grant-credentials.ts';
import {sha256Hex} from './worker/utils.ts';
import {BodyLease,bodyBudgetCharged} from './worker/body-budget.ts';
import {usageStub} from './worker/ledgers.ts';
import {configureSearch} from './worker/test/minimax-search-declaration-fixture.mjs';
const region=REGION,actor={auth:'cloudflare_access',role:'admin',email:'search-admin@example.invalid'},key='oauth/fixture/search';
configureSearch(snapshot.providers.find(p=>p.id==='minimax'),region);
const original=globalThis.fetch.bind(globalThis),deferred=()=>Promise.withResolvers();
let initialized,active,pending=new Set();
const state=()=>active?{mode:active.mode,status:active.status,error:active.error,results:active.results,fetches:active.fetches,materializations:active.materializations,
 reads:active.reads,byob:active.byob,maxBacking:active.maxBacking,wire:active.wire,eof:active.eof,cancels:active.cancels,
 cleanup:active.cleanup,readRetired:active.readRetired,locked:active.source?.locked??false,charged:bodyBudgetCharged(),atFetch:active.atFetch,outputBytes:active.outputBytes,pending:pending.size}:{};
const gate=(a,phase)=>original('https://search-gate.example/'+a.mode+'/'+phase,{redirect:'manual'}).then(async r=>{if(!r.ok)throw new Error('fixture gate');await r.text();});
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);
 if(request.url==='https://search-workerd.cloudflareaccess.com/cdn-cgi/access/certs')return original(request);
 const a=active;if(!a||!/^https:\/\/api\.minimax(?:i)?\.(io|com)\/v1\/coding_plan\/search$/.test(request.url))throw new Error('fixture unexpected destination');
 a.fetches++;a.atFetch=bodyBudgetCharged();const response=await original(request);a.source=response.body;
 const get=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{
  const reader=get(options);if(options?.mode==='byob')a.byob++;let first=true,cancel;
  return {async read(...args){a.reads++;try{const part=await reader.read(...args);if(part.value){a.wire+=part.value.byteLength;a.maxBacking=Math.max(a.maxBacking,part.value.buffer.byteLength);}if(part.done)a.eof=true;return part;}
   finally{if(first&&['held-input','cleanup-reject'].includes(a.mode)){first=false;a.ready.resolve();await gate(a,'read');a.readRetired=true;}}},
   cancel(reason){return cancel??=(async()=>{a.cancels++;try{await reader.cancel(reason);}finally{if(['held-input','cleanup-reject','late'].includes(a.mode))await gate(a,'cleanup');a.cleanup=true;if(a.mode==='cleanup-reject')throw new Error('synthetic cleanup rejection');}})();},
   releaseLock(){reader.releaseLock();}};
 };
 if(a.mode==='late'){a.ready.resolve();await gate(a,'fetch');}
 return response;
};
// This fixture-only subclass holds the actual owner -> authority ACK. It does
// not depend on shared globals across Worker and Durable Object isolates.
export class GrantCredentialObject extends BaseGrantCredentialObject {
 constructor(state,env){
  const held={armed:false},authority=env.ACCESS_CONTROL;
  const wrapped={...env,ACCESS_CONTROL:{idFromName:n=>authority.idFromName(n),get:id=>{const stub=authority.get(id);return {async fetch(input,init){
   const response=await stub.fetch(input,init);
   if(held.armed&&new URL(input).pathname==='/grant-pools/admit'){held.armed=false;await gate({mode:'admin-pool'},'ack');}
   return response;
  }}}}};
  super(state,wrapped);this.fixtureHeld=held;
 }
 fetch(request){if(new URL(request.url).pathname==='/fixture/arm'){this.fixtureHeld.armed=true;return Promise.resolve(Response.json({armed:true}));}return super.fetch(request);}
}
export default {async fetch(request,bindings,context){
 const env={...bindings,MINIMAX_API_KEY:'synthetic-forbidden-environment-key'},u=new URL(request.url);
 const policy={enabled:true,generation:'g1',providers:['minimax'],tenantId:'fixture',monthlyBudgetMicros:100000,requestCostMicros:700,retainRequestContent:false,grantRouting:{eligibleGrants:{minimax:['search']},environmentFallback:true,failover:true}};
 initialized??=(async()=>{
  await authorityCall(env,'/users/initialize-all',[{email:actor.email,record:{role:'admin',enabled:true,tenantId:'fixture',groups:[],contentRetentionDisabled:false}}]);
  await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
  await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
  await authorityCall(env,'/connections/initialize-all',[{providerId:'minimax',enabled:true,monthlyBudgetMicros:100000}]);
 })();await initialized;
 if(u.pathname==='/state')return Response.json(state());
 if(u.pathname==='/events')return usageStub(env,'fixture','fixture').fetch('https://usage/snapshot?events=admin');
 if(u.pathname==='/contend'){const l=new BodyLease(),allowed=l.grow(12*1024*1024),full=bodyBudgetCharged(),next=new BodyLease(),extra=next.grow(1024*1024);next.release();l.release();return Response.json({allowed,full,extra,charged:bodyBudgetCharged()});}
 if(u.pathname==='/demote-next')return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://owner/fixture/arm');
 if(u.pathname==='/demote'){await authorityCall(env,'/users/put',{email:actor.email,record:{role:'user',enabled:true,tenantId:'fixture',groups:[],contentRetentionDisabled:false}});return Response.json({demoted:true});}
 if(u.pathname==='/owner'){const g=await inspectGrantCredentials(env,key);return Response.json({generation:g.credentialGeneration,lineage:g.credentialLineage,binding:g.minimaxSearchBinding});}
 if(u.pathname!=='/start')return worker.fetch(request,env,context);
 const mode=u.searchParams.get('mode'),manifest=u.searchParams.has('manifest'),a=active={mode,ready:deferred(),status:null,error:null,results:0,fetches:0,materializations:0,reads:0,byob:0,maxBacking:0,wire:0,eof:false,cancels:0,cleanup:false,readRetired:false,outputBytes:0};
 if(mode==='unpriced')await authorityCall(env,'/policies/put',{policyId:'fixture',policy:{...policy,requestCostMicros:null}});
 const grants=env.GRANT_CREDENTIALS;env.GRANT_CREDENTIALS={idFromName:n=>grants.idFromName(n),get:id=>{const stub=grants.get(id);return {fetch(input,init){if(new URL(input).pathname==='/materialize')a.materializations++;return stub.fetch(input,init);}}}};
 const ledger=env.BUDGET_LEDGER;env.BUDGET_LEDGER={idFromName:n=>ledger.idFromName(n),get:id=>{const stub=ledger.get(id);let once=false;return {async fetch(input,init){const r=await stub.fetch(input,init);if(new URL(input).pathname==='/dispatch'&&mode==='revoke'&&!once){once=true;await revokeGrantCredentials(env,key,undefined,actor);}return r;}}}};
 const controller=new AbortController();const track=p=>{const held=Promise.resolve(p).finally(()=>pending.delete(held));pending.add(held);context.waitUntil(held);};
 if(['held-input','cleanup-reject','late'].includes(mode))track(a.ready.promise.then(()=>gate(a,'abort')).then(()=>controller.abort(new DOMException('controlled fixture abort','AbortError'))));
 track((async()=>{
  const response=await worker.fetch(new Request('https://router.example'+(manifest?'/v1/proxy/minimax/search':'/v1/native/minimax/v1/coding_plan/search'),{
   method:'POST',headers:{authorization:'Bearer clawrouter-live-fixture-fixture-secret','content-type':'application/json'},body:request.body,signal:controller.signal}),env,{waitUntil:track});
  a.status=response.status;if(!response.ok){const text=await response.text();try{a.error=JSON.parse(text).error?.code??null;}catch{}return;}
  if(['unclaimed','delivery-cancel'].includes(mode)){a.ready.resolve();await gate(a,'delivery');}
  const reader=response.body.getReader();try{if(mode==='delivery-cancel')await reader.cancel();else for(;;){const part=await reader.read();if(part.done)break;a.outputBytes+=part.value.byteLength;}}finally{reader.releaseLock();}
 })().catch(error=>{a.error=error.name;}).finally(()=>{a.results++;a.ready.resolve();}));
 await a.ready.promise;return Response.json(state());
},queue:worker.queue};`;
function upstream(gates, jwk) { return String.raw`
const encoder=new TextEncoder();
export class SearchSource {async fetch(request){
 if(request.headers.get('authorization')!=='Bearer synthetic-search-key'||request.method!=='POST')return new Response(null,{status:400});
 const body=await request.json();if(Object.keys(body).join(',')!=='q')return new Response(null,{status:400});
 const maximum=body.q.length===4096;
 const value={base_resp:{status_code:0},organic:Array.from({length:maximum?100:1},(_,i)=>({title:'Synthetic '+i,link:'https://example.invalid/'+i,snippet:'x'.repeat(maximum?4096:8)})),related_searches:Array.from({length:maximum?50:0},()=>({query:'synthetic'}))};
 if(maximum){value.discarded=Array(6000).fill(null);value.padding=Array(8).fill('x'.repeat(65536));}
 let text=JSON.stringify(value);if(maximum)text+=' '.repeat(1048576-text.length);let at=0;
 return new Response(new ReadableStream({type:'bytes',pull(c){if(at===text.length){c.close();c.byobRequest?.respond(0);return;}const end=Math.min(at+16384,text.length);c.enqueue(encoder.encode(text.slice(at,end)));at=end;},cancel(){text='';}},{highWaterMark:0}),{headers:{'content-type':'application/json','content-length':String(text.length),'content-encoding':'identity'}});
}}
export default {async fetch(request,env){const url=new URL(request.url);
 if(url.href==='https://search-workerd.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[JWK]});
 if(url.hostname==='search-gate.example')return fetch(GATES+url.pathname,{redirect:'manual'});
 if(!['api.minimax.io','api.minimaxi.com'].includes(url.hostname)||url.pathname!=='/v1/coding_plan/search')throw new Error('unexpected fixture destination');
 return env.SEARCH_SOURCE.get(env.SEARCH_SOURCE.idFromName('synthetic')).fetch(request);
}};`.replace('JWK',JSON.stringify(jwk)).replace('GATES',JSON.stringify(gates)); }
for (const region of ["global", "cn"]) test(`Search actual isolated workerd ${region}: SQL attestation, both routes, maximum, retirement, no fallback`, { timeout: 120000 }, async t => {
  const temporary=await mkdtemp(join(tmpdir(),"minimax-search-workerd-"));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const gates=await barriers(t),signed=await access(),runtime=await startWorkerdFixture(temporary,router.replace('REGION',JSON.stringify(region)),upstream(gates.origin,signed.jwk),{
    preventEviction:true,bindings:{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'search-fixture',CLAWROUTER_ACCESS_ADMIN_EMAILS:email},upstreamDurableObjects:{SEARCH_SOURCE:{className:'SearchSource',useSQLite:true}}});
  t.after(async()=>{for(const mode of ['held-input','cleanup-reject','late','unclaimed','delivery-cancel','admin-pool'])for(const phase of ['abort','read','cleanup','delivery','fetch','ack'])gates.release(mode,phase);await runtime.dispose();});
  const call=async path=>{const r=await runtime.dispatchFetch(origin+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
  const until=async predicate=>{let s;for(let i=0;i<300;i++){s=await call('/state');if(predicate(s))return s;await delay(10);}assert.fail(JSON.stringify(s));};
  const put=async()=>runtime.dispatchFetch(origin+'/v1/admin/upstream-grants/policies/fixture/search',{method:'PUT',headers:{origin,'content-type':'application/json','cf-access-jwt-assertion':signed.jwt},body:JSON.stringify({provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-search-key',accountId:'synthetic-account',minimaxSearchAuthorization:region==='global'?'minimax-global-tokenplan-search':'minimax-cn-tokenplan-search'})});
  let r=await put();assert.equal(r.status,200,await r.clone().text());assert.doesNotMatch(await r.text(),/synthetic-search-key/);
  for(const mode of ['native','manifest','maximum','held-input','cleanup-reject','late','unclaimed','delivery-cancel','unpriced']){
    const body={q:mode==='maximum'?'x'.repeat(4096):mode};let wire=JSON.stringify(mode==='manifest'?{body}:body);if(mode==='maximum')wire+=' '.repeat(65536-wire.length);
    r=await runtime.dispatchFetch(origin+'/start?mode='+mode+(mode==='manifest'?'&manifest=1':''),{method:'POST',body:wire});let s=await r.json();assert.equal(r.status,200,JSON.stringify(s));
    if(['held-input','cleanup-reject','late'].includes(mode)){
      gates.release(mode,'abort');s=await until(s=>s.results===1);assert.notEqual(s.status,200,JSON.stringify(s));assert.equal(s.charged,72*1048576);
      if(mode==='late')gates.release(mode,'fetch');s=await until(s=>s.cancels===1);assert.equal(s.locked,true);
      assert.deepEqual(await call('/contend'),{allowed:true,full:96*1048576,extra:false,charged:72*1048576});
      gates.release(mode,'cleanup');s=await until(s=>s.cleanup);if(mode!=='late'){assert.equal(s.locked,true);assert.equal(s.charged,72*1048576);gates.release(mode,'read');}
    }else if(['unclaimed','delivery-cancel'].includes(mode)){assert.equal(s.status,200,JSON.stringify(s));assert.equal(s.charged,72*1048576);gates.release(mode,'delivery');}
    s=await until(s=>s.results===1&&s.pending===0);assert.equal(s.charged,0,JSON.stringify(s));assert.equal(s.locked,false);
    assert.equal(s.fetches,mode==='unpriced'?0:1,JSON.stringify(s));assert.equal(s.materializations,mode==='unpriced'?0:1);
    if(mode==='maximum'){assert.equal(s.wire,1048576,JSON.stringify(s));assert.ok(s.outputBytes>900000);assert.ok(s.byob>0);assert.ok(s.maxBacking<=16384);}
    if(mode==='unpriced')assert.equal(s.error,'pricing_required',JSON.stringify(s));
  }
  const before=await call('/owner');await call('/demote-next');const mutation=put();await gates.entered('admin-pool','ack');await call('/demote');gates.release('admin-pool','ack');r=await mutation;assert.equal(r.status,403,await r.clone().text());await r.text();assert.deepEqual(await call('/owner'),before);
  const events=(await call('/events')).events;assert.equal(events.length,9);assert.ok(events.every(e=>e.total_tokens===null));assert.equal(events.filter(e=>e.actual_cost_micros===700).length,8);
});
