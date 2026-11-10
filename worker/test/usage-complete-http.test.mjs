import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {completeFixture} from './usage-complete-fixture.mjs';
import {perRequestAuthority} from './typescript-setup.mjs';
const {default:handler}=await import('../index.ts');
const {exportRefreshedUsage}=await import('../../admin/src/complete-usage.ts');
perRequestAuthority();
const token='synthetic-report-token',hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t){
 const f=await completeFixture(t),kv=new Map();
 Object.assign(f.env,{CLAWROUTER_LOCAL_AUTH:'enabled',CLAWROUTER_LOCAL_ADMIN_EMAIL:'alice@example.com',CLAWROUTER_ADMIN_TOKEN_SHA256:hash(token)});
 f.env.POLICY_KV={get:async(k,kind)=>{const v=kv.get(k);return v===undefined?null:kind==='json'?JSON.parse(v):v;},put:async(k,v)=>kv.set(k,v),delete:async k=>kv.delete(k),list:async()=>({keys:[],list_complete:true})};
 const http=async(path,headers={},method='GET',body)=>{const response=await handler.fetch(new Request('https://console.example'+path,{method,headers,body}),f.env,{waitUntil(){}});if(path.includes('/usage/')){assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');}return response;};
 const login=async()=>{const r=await http('/v1/session/login',{origin:'https://console.example','content-type':'application/json'},'POST',JSON.stringify({token}));assert.equal(r.status,200,await r.clone().text());return r.headers.get('set-cookie').split(';')[0];};
 const cookie=await login();await f.personal();
 const p=new URLSearchParams({from:new Date(f.query.from).toISOString(),to:new Date(f.query.to).toISOString(),groupBy:'model',intent:'browse'});
 return {...f,set hook(value){f.hook=value;},kv,http,login,cookie,p,headers:{cookie},bearer:{authorization:'Bearer '+token}};
}
async function value(response){assert.equal(response.status,200,await response.clone().text());assert.match(response.headers.get('cache-control'),/no-store/);const o=await response.json();assert.equal(o.kind,'complete',JSON.stringify(o));return o.value;}
const params=(f,report,extra={})=>{const p=new URLSearchParams({from:new Date(report.query.from).toISOString(),to:new Date(report.query.to).toISOString(),groupBy:report.query.groupBy,cut:report.cut,...extra});return p;};
test('real local login, personal authority, owner predicates and private report/events/validation',async t=>{
 const f=await fixture(t);await f.ingest(0,f.event('mine'));await f.ingest(0,f.event('other',{principal_id:'bob@example.com'}));
 const report=await value(await f.http('/v1/session/usage/report?'+f.p,f.headers));assert.equal(report.metrics.calls,1);assert.equal(report.query.filters.user,'alice@example.com');assert.match(report.cut,/^[A-Za-z0-9_-]{43}$/);
 const page=await value(await f.http('/v1/session/usage/events?'+params(f,report),f.headers));assert.deepEqual(page.events.map(e=>e.id),['mine']);assert.equal(page.coverage.historicalLocations,'not_exhaustively_assessed');
 assert.deepEqual(await value(await f.http('/v1/session/usage/validate?'+params(f,report),f.headers)),{valid:true});
 const json=JSON.stringify({report,page});for(const k of ['sessionBinding','authorityDigest','tenantId','policyId','epoch','seq','event_json'])assert.equal(json.includes('"'+k+'"'),false,k);
 assert.equal((await f.http('/v1/session/usage/report?'+f.p,f.bearer)).status,401);
 assert.equal((await f.http('/v1/session/usage/report?'+f.p+'&user=bob@example.com',f.headers)).status,400);
});
test('credential binding distinguishes new session, foreign DELETE denied, own DELETE idempotent and same-origin guarded',async t=>{
 const f=await fixture(t),r=await value(await f.http('/v1/session/usage/report?'+f.p,f.headers)),cookie2=await f.login();
 assert.equal((await f.http('/v1/session/usage/events?'+params(f,r),{cookie:cookie2})).status,410);
 assert.equal((await f.http('/v1/session/usage/report?cut='+r.cut,{cookie:cookie2},'DELETE')).status,410);
 assert.equal((await f.http('/v1/session/usage/report?cut='+r.cut,{...f.headers,origin:'https://evil.example'},'DELETE')).status,403);
 assert.deepEqual(await value(await f.http('/v1/session/usage/validate?'+params(f,r),f.headers)),{valid:true});
 for(let i=0;i<2;i++)assert.deepEqual(await value(await f.http('/v1/session/usage/report?cut='+r.cut,f.headers,'DELETE')),{released:true});
 await f.http('/v1/session/logout',f.headers,'POST');assert.equal((await f.http('/v1/session/usage/events?'+params(f,r),f.headers)).status,401);
});
test('admin token sees retained owners without impersonation; rotation invalidates; personal no-access distinct from zero',async t=>{
 const f=await fixture(t);await f.ingest(0,f.event('other',{principal_id:'bob@example.com'}));const p=new URLSearchParams(f.p);p.set('groupBy','user');
 const r=await value(await f.http('/v1/admin/usage/report?'+p,f.bearer));assert.equal(r.metrics.calls,1);assert.equal(r.groups[0].identity.value,'bob@example.com');
 f.env.CLAWROUTER_ADMIN_TOKEN_SHA256=hash('rotated');assert.equal((await f.http('/v1/admin/usage/events?'+params(f,r),f.bearer)).status,401);
 assert.equal((await f.http('/v1/admin/usage/events?'+params(f,r),{authorization:'Bearer rotated'})).status,410);
 assert.equal((await f.direct('/mutate',{seed:{principal:{principalType:'user',principalId:'alice@example.com'},bindings:[]},binding:{principalType:'user',principalId:'alice@example.com',policyId:'p0',enabled:false,priority:0}})).status,200);
 assert.equal((await (await f.http('/v1/session/usage/report?days=7',f.headers)).json()).kind,'no_access');
});
test('HTTP parser rejects malformed capabilities and unknown/private selectors without shard work',async t=>{
 const f=await fixture(t);for(const query of ['intent=invalid','intent=summary&cut='+ 'a'.repeat(43),'intent=export&cut='+'a'.repeat(43),'days=7&days=7','tenantId=other','policyId=p0','grain=minute&days=7','keyKind=session&key=forbidden','cut=','model='+ 'é'.repeat(257),'limit=3','cursor='+'a'.repeat(43)]){
  const before=f.calls.filter(c=>c.kind==='shard').length;assert.equal((await f.http('/v1/session/usage/report?'+query,f.headers)).status,400,query.slice(0,80));assert.equal(f.calls.filter(c=>c.kind==='shard').length,before);
 }
});
test('forty summary HTTP refreshes allocate zero roots; browse replacement and protected export coexist',async t=>{
 const f=await fixture(t);for(let i=0;i<40;i++)assert.equal((await value(await f.http('/v1/session/usage/report?days=7',f.headers))).cut,null);
 assert.equal(f.owner.usageCuts?.roots.size??0,0);
 const a=await value(await f.http('/v1/session/usage/report?'+f.p,f.headers));const ep=new URLSearchParams(f.p);ep.set('intent','export');
 const e=await value(await f.http('/v1/session/usage/report?'+ep,f.headers));await value(await f.http('/v1/session/usage/report?'+ep,f.headers));assert.equal((await f.http('/v1/session/usage/report?'+ep,f.headers)).status,422);
 await value(await f.http('/v1/session/usage/report?'+f.p,f.headers));await value(await f.http('/v1/session/usage/report?'+f.p,f.headers));assert.equal((await f.http('/v1/session/usage/events?'+params(f,a),f.headers)).status,410);
 assert.deepEqual(await value(await f.http('/v1/session/usage/validate?'+params(f,e),f.headers)),{valid:true});
});
test('shared client exports fresh real HTTP snapshot and final source change produces no prepared file',async t=>{
 const f=await fixture(t);await f.ingest(0,f.event('old'));const browse=await value(await f.http('/v1/session/usage/report?'+f.p,f.headers));await f.ingest(0,f.event('new',{input_tokens:0,actual_cost_micros:0,cost_basis:'unpriced_usage'}));
 let mutate=false;const request=async(_origin,path,init={})=>{if(mutate&&path.startsWith('/v1/session/usage/validate'))[...f.shards.values()][0].sql.exec("UPDATE usage_events SET status='error' WHERE id='old'");const r=await f.http(path,f.headers,init.method??'GET');if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
 const options={request,origin:'https://console.example',audience:'personal',query:browse.query,signal:new AbortController().signal,isCurrent:()=>true};
 const file=await exportRefreshedUsage(options,'json'),out=JSON.parse(file.content);assert.equal(out.events.length,2);assert.equal(browse.metrics.calls,1);assert.equal(out.metadata.totals.metrics.calls,2);assert.equal('cut' in out.metadata,false);
 mutate=true;await assert.rejects(exportRefreshedUsage(options,'csv'),/HTTP 409|HTTP 410/);
});

test('signed Cloudflare assertion uses existing verifier, live authority, assertion lifetime and admin role',async t=>{
 const f=await fixture(t),issuer='https://complete-http.cloudflareaccess.com',certs=issuer+'/cdn-cgi/access/certs';
 const {accessCertsResponse}=await import('./access-byte-fixture.mjs');
 Object.assign(f.env,{CLAWROUTER_ACCESS_TEAM_DOMAIN:issuer,CLAWROUTER_ACCESS_AUD:'complete-http',CLAWROUTER_ACCESS_ADMIN_EMAILS:'alice@example.com'});
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']),jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'complete-http'};
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(String(url),certs);return accessCertsResponse({keys:[jwk]},certs);});
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 async function jwt(extra={}){const value=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:issuer,aud:'complete-http',email:'alice@example.com',sub:'actor',exp:Math.floor(Date.now()/1000)+600,...extra});return value+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(value))).toString('base64url');}
 const assertion=await jwt(),headers={'cf-access-jwt-assertion':assertion};
 await f.ingest(0,f.event('mine'));await f.ingest(0,f.event('foreign',{principal_id:'bob@example.com'}));
 const r=await value(await f.http('/v1/session/usage/report?'+f.p,headers));assert.equal(r.metrics.calls,1);
 assert.deepEqual((await value(await f.http('/v1/session/usage/events?'+params(f,r),headers))).events.map(e=>e.id),['mine']);
 const admin=await value(await f.http('/v1/admin/usage/report?'+f.p,headers));assert.equal(admin.metrics.calls,2);
 const replacement={'cf-access-jwt-assertion':await jwt({jti:'new-assertion'})};assert.equal((await f.http('/v1/session/usage/events?'+params(f,r),replacement)).status,410);
 assert.equal((await f.http('/v1/admin/usage/report?cut='+admin.cut,headers,'DELETE')).status,200);
 assert.equal((await f.http('/v1/session/usage/report?'+f.p,{'cf-access-jwt-assertion':await jwt({exp:Math.floor(Date.now()/1000)-1})})).status,401);
 f.env.CLAWROUTER_ACCESS_ADMIN_EMAILS='';assert.equal((await f.http('/v1/admin/usage/report?'+f.p,headers)).status,403);
 assert.equal((await f.http('/v1/session/usage/events?'+params(f,r),headers)).status,410,'role transition invalidates old binding');
 assert.equal((await f.direct('/users/put',{email:'alice@example.com',record:{enabled:false,tenantId:'tenant',role:'user',groups:[]}})).status,200);
 assert.equal((await f.http('/v1/session/usage/report?'+f.p,headers)).status,401);
});
test('authority change during real HTTP final validation never publishes a report',async t=>{
 const f=await fixture(t);let changed=false;
 f.hook=async entry=>{if(!changed&&entry.kind==='shard'&&entry.body.action==='validate'){changed=true;await f.direct('/policies/put',{policyId:'p0',policy:{tenantId:'tenant',enabled:false,providers:[]}});}};
 const r=await f.http('/v1/session/usage/report?'+f.p,f.headers);assert.equal(changed,true);assert.notEqual(r.status,200);assert.equal((await r.json()).kind,'restart');assert.equal(f.owner.usageCuts?.roots.size??0,0);
});

for(const audience of ['personal','admin'])test(audience+' autumn calendar range clips before registry admission and binds continuations/export',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-09T06:00:00Z')});
 const f=await fixture(t),endpoint=audience==='personal'?'/v1/session/usage':'/v1/admin/usage',headers=audience==='personal'?f.headers:f.bearer;
 const requestedFrom=Date.parse('2026-10-10T04:00:00Z'),to=Date.parse('2026-11-09T05:00:00Z'),floor=f.now-30*86400000+15*60000; // Existing cut TTL safety margin.
 await f.ingest(0,f.event('boundary',{occurred_at_ms:floor+1}));await f.ingest(0,f.event('recent',{occurred_at_ms:to-1000}));
 const selection=new URLSearchParams({from:'2026-10-10',to:'2026-11-09',timezone:'America/New_York',model:'model'});
 const summary=await value(await f.http(endpoint+'/report?'+selection,headers));
 assert.equal(summary.cut,null);assert.equal(f.owner.usageCuts?.roots.size??0,0);assert.equal(summary.metrics.calls,2);
 assert.equal(summary.query.from,floor);assert.equal(summary.coverage.clippedFrom,requestedFrom);assert.equal(summary.coverage.effectiveFrom,floor);
 const browse=await value(await f.http(endpoint+'/report?'+selection+'&intent=browse',headers));assert.equal(browse.metrics.calls,2);
 const root=[...f.owner.usageCuts.roots.values()].find(r=>r.handle===browse.cut);assert.ok(root);assert.equal(root.base.from,to-30*86400000);assert.equal(root.capture.requestedFrom,requestedFrom);assert.equal(JSON.stringify(browse).includes('requestedFrom'),false);
 assert.equal((await f.http(endpoint+'/report?'+selection+'&intent=browse&cut='+browse.cut,headers)).status,400,'continuation requires the returned effective range');
 const p=params(f,browse,{timezone:'America/New_York',model:'model',limit:'1'}),first=await value(await f.http(endpoint+'/events?'+p,headers));
 assert.deepEqual(first.events.map(e=>e.id),['recent']);assert.ok(first.nextCursor);assert.equal(first.coverage.clippedFrom,requestedFrom);
 p.set('cursor',first.nextCursor);const second=await value(await f.http(endpoint+'/events?'+p,headers));assert.deepEqual(second.events.map(e=>e.id),['boundary']);assert.equal(second.nextCursor,null);
 p.set('model','other');assert.notEqual((await f.http(endpoint+'/events?'+p,headers)).status,200);
 const validation=params(f,browse,{timezone:'America/New_York',model:'model'});assert.deepEqual(await value(await f.http(endpoint+'/validate?'+validation,headers)),{valid:true});
 const exported=await value(await f.http(endpoint+'/report?'+selection+'&intent=export',headers));assert.notEqual(exported.cut,browse.cut);assert.equal(exported.coverage.clippedFrom,requestedFrom);assert.equal(exported.metrics.calls,2);
 const final=params(f,exported,{timezone:'America/New_York',model:'model'});assert.deepEqual(await value(await f.http(endpoint+'/validate?'+final,headers)),{valid:true});
 const exportPage=await value(await f.http(endpoint+'/events?'+final,headers));assert.equal(exportPage.events.length,2);assert.equal(exportPage.coverage.clippedFrom,requestedFrom);
 // Client inputs are owned by controls and may change while the fresh capture awaits.
 const query=structuredClone({...browse.query,from:requestedFrom}),rangeInput={from:'2026-10-10',to:'2026-11-09',timezone:'America/New_York'},requests=[];
 const request=async(_origin,path,init={})=>{const response=await f.http(path,headers,init.method??'GET');requests.push({path,method:init.method,status:response.status});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const work=exportRefreshedUsage({request,origin:'https://console.example',audience,query,rangeInput,signal:new AbortController().signal,isCurrent:()=>true},'json');
 query.from=to-3600000;query.filters.model='changed';query.timezone='UTC';rangeInput.from='2026-02-30';rangeInput.timezone='UTC';
 const file=JSON.parse((await work).content);assert.equal(file.events.length,2);assert.equal(file.metadata.coverage.clippedFrom,requestedFrom);assert.equal(file.metadata.range.from,floor);assert.equal(file.metadata.range.timezone,'America/New_York');assert.equal(file.metadata.filters.model,'model');
 const firstRequest=new URL(requests[0].path,'https://console.example').searchParams;assert.equal(firstRequest.get('from'),'2026-10-10');assert.equal(firstRequest.get('to'),'2026-11-09');
 assert.deepEqual(requests.map(r=>r.method==='DELETE'?'release':r.path.split('?')[0].split('/').at(-1)),['report','events','validate','release']);
 for(const r of requests.slice(1,3))assert.equal(new URL(r.path,'https://console.example').searchParams.get('from'),new Date(floor).toISOString());
 const released=new URL(requests.at(-1).path,'https://console.example').searchParams.get('cut');assert.equal([...f.owner.usageCuts.roots.values()].some(root=>root.handle===released),false);
 assert.ok(f.calls.some(c=>c.path==='/usage-cuts/reserve'));
 for(const c of f.calls){const q=c.kind==='shard'?c.body.query:c.body.base??c.body.query;if(q)assert.ok(q.to-q.from<=30*86400000,'every service/shard/registry query keeps elapsed bound');}
 const over={...root.base,from:requestedFrom};assert.equal((await f.direct('/usage-cuts/reserve',{binding:root.binding,purpose:'browse',base:over})).status,400);
 let changed=false;f.hook=async entry=>{if(!changed&&entry.kind==='shard'&&entry.body.action==='validate'){changed=true;if(audience==='admin')f.env.CLAWROUTER_ADMIN_TOKEN_SHA256=hash('rotated');else await f.direct('/policies/put',{policyId:'p0',policy:{tenantId:'tenant',enabled:false,providers:[]}});}};
 assert.notEqual((await f.http(endpoint+'/validate?'+final,headers)).status,200);assert.equal(changed,true);
});
for(const audience of ['personal','admin'])test(audience+' calendar allowance does not relax HTTP elapsed, minute, future or selector guards',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-09T06:00:00Z')});const f=await fixture(t),endpoint=audience==='personal'?'/v1/session/usage':'/v1/admin/usage',headers=audience==='personal'?f.headers:f.bearer;
 for(const fields of [
  {from:'2026-10-09',to:'2026-11-09'},
  {from:'2026-10-10T04:00:00Z',to:'2026-11-09T05:00:00Z'},
  {from:'2026-10-10',to:'2026-11-09T05:00:00Z'},
  {from:'2026-11-01',to:'2026-11-02',grain:'minute'},
  {from:'2026-11-09',to:'2026-11-10'},
  {from:'2026-02-30',to:'2026-03-01'},
  {from:'2026-11-08',to:'2026-11-09',requestedFrom:'0'},
  {from:'2026-11-08',to:'2026-11-09',tenantId:'other'},
 ]){const usageCalls=()=>f.calls.filter(c=>c.kind==='shard'||c.path.startsWith('/usage-')).length,before=usageCalls(),p=new URLSearchParams({timezone:'America/New_York',...fields});assert.equal((await f.http(endpoint+'/report?'+p,headers)).status,400,p.toString());assert.equal(usageCalls(),before,'reject before usage service calls');}
});

test('calendar provenance is private disclosure, never authority to broaden effective reads',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-09T06:00:00Z')});const f=await fixture(t);
 const q={...f.query,from:f.now-30*86400000},requestedFrom=q.from-3600000;
 for(const input of [
  ...[-1,'invalid',q.from,q.to-31*86400000-1].map(requestedFrom=>({query:q,requestedFrom})),
  {query:{...q,from:q.from+1},requestedFrom},
  {kind:'events',query:q,cut:'a'.repeat(43),requestedFrom},
 ]){const before=f.calls.length;await assert.rejects(f.read(input),e=>e.status===400);assert.equal(f.calls.length,before);}
 const r=await value(await f.http('/v1/session/usage/report?from=2026-10-10&to=2026-11-09&timezone=America/New_York&intent=browse',f.headers));
 const root=[...f.owner.usageCuts.roots.values()].find(root=>root.handle===r.cut);
 for(const requestedFrom of [-1,'invalid',root.base.from,root.base.to-31*86400000-1]){
  const reserve=await f.direct('/usage-cuts/reserve',{binding:root.binding,purpose:'export',base:root.base});assert.equal(reserve.status,200);const {operation}=await reserve.json();
  const rejected=await f.direct('/usage-cuts/finalize',{binding:root.binding,operation,capture:{...root.capture,requestedFrom}});assert.equal(rejected.status,400);
  assert.equal((await f.direct('/usage-cuts/observe',{binding:root.binding,operation})).status,410);
 }
 const outside=await f.http('/v1/session/usage/report?from=2025-10-10&to=2025-11-09&timezone=America/New_York&intent=export',f.headers);
 assert.equal(outside.status,200);assert.equal((await outside.json()).kind,'outside_retained_range');assert.equal(f.owner.usageCuts.roots.size,1,'outside range leaves only the existing browse root');
});
