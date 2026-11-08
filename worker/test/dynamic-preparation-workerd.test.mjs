import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const cases = Object.fromEntries([
  ['healthy', { status: 200, healthy: true }],
  ['initial-overflow', { status: 200, initial: true }],
  ...[401, 403, 429].map(status => ['alternate-' + status, { status }]),
  ['held-overflow', { status: 429, held: true }],
  ['held-abort', { status: 429, held: true, abortHeld: true }],
  ['final-await-abort', { status: 429, finalAbort: true }],
]);
const router = String.raw`
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {GrantCredentialObject as Grant,putGrantCredentials} from './worker/grant-credentials.ts';
import {BudgetLedgerObject as Budget,UsageLedgerObject as Usage,ingestUsage} from './worker/ledgers.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {isPreparationLimit} from './worker/provider-templates.ts';
import {sha256Hex} from './worker/utils.ts';
export {PolicyBindingIndexObject} from './worker/index.ts';
// Real grant SQL/projection calls use the SAME case-specific authority namespace.
// Only the fixture routing label is added; credentials and owner protocol are real.
export class GrantCredentialObject extends Grant {
 constructor(state,bindings){const scope={id:null};
  super(state,{...bindings,ACCESS_CONTROL:{idFromName:name=>bindings.ACCESS_CONTROL.idFromName(scope.id+'/'+name),get:id=>bindings.ACCESS_CONTROL.get(id)}});
  this.fixtureScope=scope;
 }
 fetch(request){const id=request.headers.get('x-fixture-case');
  if(!id||(this.fixtureScope.id&&this.fixtureScope.id!==id))throw Error('fixture owner scope mismatch');
  this.fixtureScope.id=id;return super.fetch(request);
 }
}
export class BudgetLedgerObject extends Budget {
 constructor(state){super(state);this.fixtureSql=state.storage.sql;}
 fetch(request){return new URL(request.url).pathname==='/fixture-sql'
  ?Response.json([...this.fixtureSql.exec('SELECT reservation_id,settled,reserved_micros,dispatch_started FROM budget_reservations')]):super.fetch(request);}
}
export class UsageLedgerObject extends Usage {
 constructor(state){super(state);this.fixtureSql=state.storage.sql;}
 fetch(request){return new URL(request.url).pathname==='/fixture-sql'
  ?Response.json([...this.fixtureSql.exec('SELECT id,status,actual_cost_micros FROM usage_events')]):super.fetch(request);}
}
const CASES=__CASES__,states=new Map(),raw=globalThis.fetch.bind(globalThis);
const gate=async(id,phase)=>{const r=await raw('https://dynamic-gate.example/gate/'+id+'/'+phase);if(!r.ok)throw Error('fixture barrier failure');await r.text();};
// Only scalars and bounded synthetic ID lists survive a request. Every stub and
// wrapped environment below is constructed from THAT request's current bindings.
function environment(bindings,a){
 const env={...bindings},names=new Map();
 for(const binding of ['ACCESS_CONTROL','GRANT_CREDENTIALS','BUDGET_LEDGER','USAGE_LEDGER']){
  const original=bindings[binding];
  env[binding]={idFromName(name){const id=original.idFromName(a.id+'/'+name);names.set(String(id),name);
   if(binding==='USAGE_LEDGER'&&!a.usageNames.includes(name))a.usageNames.push(name);return id;},
   get(id){const stub=original.get(id);return {async fetch(input,init){
    const path=new URL(typeof input==='string'?input:input.url??String(input)).pathname;
    if(a.active&&binding==='ACCESS_CONTROL'&&path==='/admission/resolve'){
     const body=JSON.parse(init.body);a.admissions++;
     if(body.selection?.excludedKeys?.length){
      a.alternates++;a.excludedCount=body.selection.excludedKeys.length;a.altEntered=true;
      if(a.held)await gate(a.id,'prepare');

     }
    }
    if(a.active&&binding==='GRANT_CREDENTIALS'&&path==='/materialize')a.materializations++;
    if(a.active&&binding==='BUDGET_LEDGER'&&path==='/reserve'){
     const body=JSON.parse(init.body);a.reservations.push({name:names.get(String(id)),id:body.reservationId});
    }
    const options=binding==='GRANT_CREDENTIALS'?{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),'x-fixture-case':a.id}}:init;
    const response=await stub.fetch(input,options);
    if(a.active&&binding==='ACCESS_CONTROL'&&path==='/admission/resolve'&&a.altEntered)a.altReply=true;
    return response;
   }};}};
 }
 env.USAGE_QUEUE={async send(event){a.events++;a.eventId=event.id;a.eventStatus=event.status;a.eventCost=event.actual_cost_micros;
  const receipt=await ingestUsage(env,event);a.ingested=receipt.eventId===event.id;}};
 return env;
}
async function setup(bindings,id){
 const a={id,...CASES[id],active:false,admissions:0,alternates:0,materializations:0,provider:0,excludedCount:0,altEntered:false,altReply:false,
  aborted:false,waitObserved:0,interceptions:0,activeWhenQueued:false,capacityObserved:false,originalStatus:null,outward:false,status:null,background:0,backgroundFailed:false,events:0,eventId:null,eventStatus:null,eventCost:null,ingested:false,reservations:[],usageNames:[]};
 const env=environment(bindings,a),policy={enabled:true,generation:'g1',providers:['openai'],tenantId:'default',monthlyBudgetMicros:1000000,requestCostMicros:7,
  retainRequestContent:false,grantRouting:{strategy:'round_robin',stickiness:'none',environmentFallback:false,failover:true}};
 await authorityCall(env,'/users/initialize-all',[]);
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'openai',enabled:true,monthlyBudgetMicros:1000000}]);
 for(const suffix of ['a','b'])await putGrantCredentials(env,'oauth/fixture/account-'+suffix,{provider:'openai',kind:'subscription',enabled:true,
  accessToken:'s'.repeat(8000),accountId:'synthetic-account-'+suffix,expiresAt:'2099-01-01T00:00:00.000Z'});
 states.set(id,a);return a;
}
export default {async fetch(request,bindings,ctx){const u=new URL(request.url),id=u.searchParams.get('case');
 if(!CASES[id])return new Response(null,{status:404});
 if(u.pathname==='/setup'){await setup(bindings,id);return Response.json({ready:true});}
 const a=states.get(id);if(!a)throw Error('fixture not initialized');
 if(u.pathname==='/state')return Response.json(a);
 if(u.pathname==='/sql'){
  const budgets=[],usage=[];
  for(const entry of a.reservations){const stub=bindings.BUDGET_LEDGER.get(bindings.BUDGET_LEDGER.idFromName(id+'/'+entry.name));
   budgets.push({expected:entry.id,rows:await (await stub.fetch('https://clawrouter.internal/fixture-sql')).json()});}
  for(const name of a.usageNames){const stub=bindings.USAGE_LEDGER.get(bindings.USAGE_LEDGER.idFromName(id+'/'+name));
   usage.push(...await (await stub.fetch('https://clawrouter.internal/fixture-sql')).json());}
  return Response.json({budgets,usage});
 }
 if(u.pathname!=='/v1/responses')return new Response(null,{status:404});
 // Small incoming body is consumed before readiness barriers. The diagnostic
 // HTTP client stays connected; only the ORIGINAL routed signal is aborted.
 const body=await request.text(),caller=new AbortController(),env=environment(bindings,a);
 let hasPrimary=false,primary,response,bodyText;
 const outcomes=[];
 const track=p=>{a.background++;const observed=Promise.resolve(p).then(()=>({failed:false}),error=>({failed:true,error})).then(outcome=>{
  a.background--;if(outcome.failed)a.backgroundFailed=true;return outcome;});
  outcomes.push(observed);ctx.waitUntil(observed);return observed;};
 if(a.abortHeld)track(gate(id,'abort').then(()=>{a.aborted=true;caller.abort(Error('fixture caller abort'));}));
 const originalWait=HttpOperation.prototype.wait;
 HttpOperation.prototype.wait=function(pending,...args){
  const result=originalWait.call(this,pending,...args);
  if(a.finalAbort&&args.length===0&&a.provider===1){a.interceptions++;result.then(()=>{},error=>{
   if(isPreparationLimit(error)&&a.waitObserved===0){a.capacityObserved=true;a.waitObserved++;a.activeWhenQueued=!caller.signal.aborted;
    queueMicrotask(()=>{a.aborted=true;caller.abort(Error('fixture final-await abort'));});}
  });}
  return result;
 };
 globalThis.fetch=(input,init)=>{
  a.provider++;
  const ordinal=a.provider;
  return raw('https://dynamic-gate.example/provider/'+id+'/'+ordinal,{...init,signal:init.signal}).then(response=>{if(ordinal===1)a.originalStatus=response.status;return response;});
 };
 a.active=true;
 try{
  const routed=new Request('https://router.example/v1/responses',{method:'POST',headers:request.headers,body,signal:caller.signal});
  response=await worker.fetch(routed,env,{waitUntil:track});a.outward=true;a.status=response.status;
  // ORIGINAL body delivery releases accounting work; consume ONCE before joining it.
  bodyText=await response.text();
  if(bodyText.length>16384)throw Error('fixture diagnostic body limit');
 }catch(error){hasPrimary=true;primary=error;a.outward=true;}
 finally{
  const failures=[];let index=0;
  while(index<outcomes.length){const outcome=await outcomes[index++];if(outcome.failed)failures.push(outcome.error);}
  globalThis.fetch=raw;HttpOperation.prototype.wait=originalWait;
  if(hasPrimary||failures.length){
   if(failures.length)throw new AggregateError(hasPrimary?[primary,...failures]:failures,'dynamic fixture independent failures');
   throw primary;
  }
 }
 return Response.json({fixture:'dynamic-preparation-handler-observation',status:response.status,body:bodyText});
},queue:worker.queue};`.replace('__CASES__', JSON.stringify(cases));

test('actual public preparation shares capacity across alternates and joins before abort precedence', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-preparation-'));
  const gates = new Map(), released = new Set(), roots = [], visited = [];
  let runtime, server, releaseFuture = false, hasPrimary = false, primary, json;
  const release = key => { released.add(key); gates.get(key)?.end('released'); gates.delete(key); };
  const releaseAll = () => { releaseFuture = true; for (const key of gates.keys()) release(key); };
  const drain = async () => {
    for (const id of visited) {
      let last;
      for (let n = 0; n < 500; n++) { last = await json('/state?case=' + id); if (!last.background) break; await delay(10); }
      assert.equal(last.background, 0, id); assert.equal(last.backgroundFailed, false, id);
    }
  };
  // Cleanup exists before the server, runtime or any public client starts.
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const observed of roots) { const outcome = await observed; if (outcome.failed) failures.push(outcome.error); }
    if (runtime) { try { await drain(); } catch (error) { failures.push(error); } try { await runtime.dispose(); } catch (error) { failures.push(error); } }
    if (server) try { await new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', releaseAll);
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'dynamic preparation cleanup');
  });
  t.signal.addEventListener('abort', releaseAll, { once: true });
  try {
    server = createServer({ maxHeaderSize: 65536 }, (request, response) => {
      const parts = new URL(request.url, 'http://fixture').pathname.split('/').filter(Boolean); request.resume();
      if (parts[0] === 'gate') {
        const key = parts.slice(1).join('/');
        if (releaseFuture || released.has(key)) response.end('released'); else gates.set(key, response);
      } else if (parts[0] === 'provider') {
        const status = parts[2] === '1' ? cases[parts[1]].status : 200;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(status === 200 ? { object: 'response', id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } : { error: 'original rejection' }));
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://dynamic-gate.example')throw Error('unexpected egress');return fetch(${JSON.stringify(origin)}+u.pathname,request);}};`;
    runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true });
    const call = (path, options) => {
      // One original Response and body consumer, immediately outcome-observed.
      const pending = runtime.dispatchFetch('https://router.example' + path, { ...options, signal: t.signal }).then(async response => ({ status: response.status, text: await response.text() }));
      roots.push(pending.then(value => ({ failed: false, value }), error => ({ failed: true, error })));
      return pending;
    };
    json = async path => { const response = await call(path); assert.equal(response.status, 200); return JSON.parse(response.text); };
    for (const [id, mode] of Object.entries(cases)) {
      assert.equal((await json('/setup?case=' + id)).ready, true); visited.push(id);
      const started = call('/v1/responses?case=' + id, { method: 'POST', headers: {
        authorization: 'Bearer clawrouter-live-fixture-fixture-secret', 'content-type': 'application/json',
        'openai-organization': 'o'.repeat(mode.initial ? 8193 : 8192), 'openai-project': 'p'.repeat(8192),
      }, body: JSON.stringify({ model: 'openai/gpt-6-astra', input: 'fixture', stream: false }) });
      const early = started.then(() => { throw Error('public request completed before held preparation'); }, error => { throw error; }); early.catch(() => {});
      const wait = async predicate => {
        let last;
        for (let n = 0; n < 1000; n++) {
          last = await Promise.race([early, json('/state?case=' + id)]);
          if (predicate(last)) return last;
          await Promise.race([early, delay(10)]);
        }
        assert.fail('dynamic preparation arrival expired: ' + JSON.stringify({ altEntered: last.altEntered, outward: last.outward, provider: last.provider, aborted: last.aborted }));
      };
      if (mode.held) {
        let state = await wait(s => s.altEntered && gates.has(id + '/prepare') && (!mode.abortHeld || gates.has(id + '/abort')));
        assert.equal(state.outward, false); assert.equal(state.provider, 1); assert.equal(state.materializations, 1); assert.equal(state.events, 0);
        if (mode.abortHeld) {
          release(id + '/abort'); state = await wait(s => s.aborted);
          assert.equal(state.outward, false); assert.equal(state.events, 0); assert.equal(state.provider, 1);
        }
        release(id + '/prepare');
      }
      const response = await started;
      const status = mode.healthy ? 200 : mode.abortHeld || mode.finalAbort ? 502 : 503;
      assert.equal(response.status, 200, id + ' diagnostic transport');
      const diagnostic = JSON.parse(response.text);
      assert.equal(diagnostic.fixture, 'dynamic-preparation-handler-observation');
      assert.equal(diagnostic.status, status, id);
      const value = JSON.parse(diagnostic.body);
      if (!mode.healthy) assert.equal(value.error.code, status === 502 ? 'provider_unavailable' : 'provider_preparation_unavailable', id);
      assert.doesNotMatch(response.text, /synthetic-access|fixture-secret|s{32}|o{32}|p{32}/);
      await drain(); const state = await json('/state?case=' + id), sql = await json('/sql?case=' + id);
      assert.equal(state.provider, mode.initial ? 0 : 1, id); assert.equal(state.alternates, mode.initial || mode.healthy ? 0 : 1, id);
      assert.equal(state.events, 1); assert.equal(state.ingested, true); assert.equal(sql.usage.length, 1); assert.equal(sql.usage[0].id, state.eventId);
      assert.equal(sql.usage[0].status, mode.healthy ? 'success' : mode.abortHeld || mode.finalAbort ? 'client_error' : 'provider_error');
      assert.equal(sql.usage[0].actual_cost_micros, mode.healthy ? 7 : 0);
      assert.equal(sql.budgets.length, mode.initial ? 0 : 2);
      for (const budget of sql.budgets) {
        assert.equal(budget.rows.length, 1); const row = budget.rows[0];
        assert.equal(row.reservation_id, budget.expected); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, mode.healthy ? 7 : 0);
        assert.equal(row.dispatch_started, 1);
      }
      if (mode.finalAbort) { assert.equal(state.capacityObserved, true); assert.equal(state.waitObserved, 1); assert.equal(state.interceptions, 1); assert.equal(state.activeWhenQueued, true); assert.equal(state.originalStatus, 429); assert.equal(state.aborted, true); }
    }
    await drain(); // Disposal below is fixture cleanup, not operation retirement proof.
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
