import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture, startBundledWorkerdFixture } from '../../test/helpers/workerd.mjs';

const cases = Object.fromEntries([
  ...[401, 403, 429].flatMap(status => ['resolve', 'reject'].map(late => [`held-${status}-${late}`, { status, late, held: true }])),
  ['final-await', { status: 429, late: 'reject', finalAbort: true }],
  ['rejection-control', { status: 429, late: 'reject' }],
  ['success-control', { status: 429, late: 'resolve' }],
  ['disabled-control', { status: 429, disabled: true }],
  ['uncertain-control', { status: 429, uncertain: true }],
]);
const router = String.raw`
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {GrantCredentialObject as Grant,putGrantCredentials} from './worker/grant-credentials.ts';
import {BudgetLedgerObject as Budget,UsageLedgerObject as Usage,ingestUsage} from './worker/ledgers.ts';
import {HttpOperation} from './worker/http-operation.ts';
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
const gate=async(id,phase)=>{const r=await raw('https://alternate-gate.example/gate/'+id+'/'+phase);if(!r.ok)throw Error('fixture barrier failure');await r.text();};
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
      if(a.late==='reject'){a.altRejected=true;throw Error('fixture alternate preparation rejection');}
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
 const a={id,...CASES[id],active:false,admissions:0,alternates:0,materializations:0,provider:0,excludedCount:0,altEntered:false,altReply:false,altRejected:false,
  aborted:false,waitObserved:0,interceptions:0,activeWhenQueued:false,originalStatus:null,outward:false,status:null,background:0,backgroundFailed:false,events:0,eventId:null,eventStatus:null,eventCost:null,ingested:false,reservations:[],usageNames:[]};
 const env=environment(bindings,a),policy={enabled:true,generation:'g1',providers:['openai'],tenantId:'default',monthlyBudgetMicros:1000000,requestCostMicros:7,
  retainRequestContent:false,grantRouting:{strategy:'round_robin',stickiness:'none',environmentFallback:false,failover:!a.disabled}};
 await authorityCall(env,'/users/initialize-all',[]);
 await authorityCall(env,'/policies/initialize-all',[{policyId:'fixture',policy}]);
 await authorityCall(env,'/credentials/initialize-all',[{credentialId:'fixture',credential:{enabled:true,secretSha256:await sha256Hex('fixture-secret'),policyId:'fixture',policyGeneration:'g1'}}]);
 await authorityCall(env,'/connections/initialize-all',[{providerId:'openai',enabled:true,monthlyBudgetMicros:1000000}]);
 for(const suffix of ['a','b'])await putGrantCredentials(env,'oauth/fixture/account-'+suffix,{provider:'openai',kind:'subscription',enabled:true,
  accessToken:'synthetic-access-'+suffix,accountId:'synthetic-account-'+suffix,expiresAt:'2099-01-01T00:00:00.000Z'});
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
 const body=await request.text(),caller=new AbortController(),env=environment(bindings,a),localBackground=[];
 const instance=u.searchParams.get('instance')==='omitted'?'omitted':'fixed';
 const label=phase=>console.log('alternate-final-await',JSON.stringify({instance,case:id,phase}));
 const track=p=>{a.background++;const observed=Promise.resolve(p).then(()=>{a.background--;},()=>{a.background--;a.backgroundFailed=true;});
  if(a.finalAbort)localBackground.push(observed);ctx.waitUntil(observed);};
 if(a.held)track(gate(id,'abort').then(()=>{a.aborted=true;caller.abort(Error('fixture caller abort'));}));
 const originalWait=HttpOperation.prototype.wait;
 HttpOperation.prototype.wait=function(pending,...args){
  const result=originalWait.call(this,pending,...args);
  if(a.finalAbort&&args.length===0&&a.provider===1){a.interceptions++;result.then(()=>{},()=>{
   if(a.altRejected&&a.waitObserved===0){a.waitObserved++;a.activeWhenQueued=!caller.signal.aborted;
    queueMicrotask(()=>{a.aborted=true;caller.abort(Error('fixture final-await abort'));});}
  });}
  return result; // SAME promise: the observer never wraps the production wait.
 };
 globalThis.fetch=(input,init)=>{
  a.provider++;
  if(a.provider===2&&a.uncertain)throw Error('fixture alternate invocation uncertainty');
  const ordinal=a.provider;
  return raw('https://alternate-gate.example/provider/'+id+'/'+ordinal,{...init,signal:init.signal}).then(response=>{if(ordinal===1)a.originalStatus=response.status;return response;});
 };
 a.active=true;
 try{
  const routed=new Request('https://router.example/v1/responses',{method:'POST',headers:request.headers,body,signal:caller.signal});
  const response=await worker.fetch(routed,env,{waitUntil:track});a.outward=true;a.status=response.status;
  if(!a.finalAbort)return response;
  // BOTH instances observe the ACTUAL public handler response in its originating
  // context. An already-errored 429 body need not survive the outer HTTP bridge.
  const routedStatus=response.status;label('routed-response-receipt');
  let text,bodyOutcome='fulfilled',errorCode=null,jsonParsed=false;
  try{text=await response.text();}catch{bodyOutcome='rejected';}
  if(bodyOutcome==='fulfilled'){try{const value=JSON.parse(text);jsonParsed=true;
   if(value?.error?.code==='provider_unavailable')errorCode='provider_unavailable';}catch{}}
  text=undefined;label('body-settled');
  // Only request-local void observers are retained; no promise crosses requests.
  while(localBackground.length)await Promise.all(localBackground.splice(0));
  return Response.json({fixture:'alternate-final-await',instance,case:id,phase:'body-settled',routedStatus,bodyOutcome,errorCode,jsonParsed});
 }finally{globalThis.fetch=raw;HttpOperation.prototype.wait=originalWait;}
},queue:worker.queue};`.replace('__CASES__', JSON.stringify(cases));

// The supported esbuild fixture hook removes ONLY the new outside fence, in
// memory. Shared source and all join/retry logic remain unchanged.
async function withoutOutsideFence(directory, upstream) {
  const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  const target = resolve('worker/proxy.ts');
  const anchor = '      signal.throwIfAborted();\n      if (retry) {';
  const bundle = await build({ stdin: { contents: router, resolveDir: process.cwd(), sourcefile: 'alternate-fixture.ts', loader: 'ts' },
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', plugins: [{ name: 'omit-only-final-fence', setup(build) {
      build.onLoad({ filter: /[\\/]worker[\\/]proxy\.ts$/ }, async ({ path }) => {
        assert.equal(resolve(path), target); const source = await readFile(path, 'utf8');
        assert.equal(source.split(anchor).length, 2, 'unique outside final-join fence');
        return { contents: source.replace(anchor, '      if (retry) {'), loader: 'ts', resolveDir: dirname(path) };
      });
    } }] });
  return startBundledWorkerdFixture(directory, bundle.outputFiles[0].text, upstream, { preventEviction: true });
}

test('public alternate preparation joins held resolution/rejection and fences the final-await abort', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alternate-preparation-'));
  const gates = new Map(), released = new Set(), clients = [], visited = [];
  let runtime, server, primary, releaseFuture = false;
  const controller = new AbortController();
  const release = key => { released.add(key); gates.get(key)?.end('released'); gates.delete(key); };
  const releaseAll = () => { releaseFuture = true; for (const key of gates.keys()) release(key); };
  const abort = () => { releaseAll(); controller.abort(t.signal.reason); };
  t.signal.addEventListener('abort', abort, { once: true });
  let json;
  const drain = async () => {
    for (const id of visited) {
      let s = await json('/state?case=' + id);
      for (let n = 0; s.background && n < 500; n++) { await delay(10); s = await json('/state?case=' + id); }
      assert.equal(s.background, 0); assert.equal(s.backgroundFailed, false);
    }
  };
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const r of await Promise.allSettled(clients)) if (r.status === 'rejected' && r.reason !== primary) failures.push(r.reason);
    if (runtime) { try { await drain(); } catch (e) { failures.push(e); } try { await runtime.dispose(); } catch (e) { failures.push(e); } }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (e) { failures.push(e); }
    t.signal.removeEventListener('abort', abort);
    if (failures.length) throw new AggregateError(failures, 'alternate fixture cleanup');
  });
  try {
    server = createServer((request, response) => {
      const parts = new URL(request.url, 'http://fixture').pathname.split('/').filter(Boolean);
      request.resume();
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
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://alternate-gate.example')throw Error('unexpected egress');return fetch(${JSON.stringify(origin)}+u.pathname,request);}};`;
    runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true });
    const call = (path, options) => {
      const url = new URL('https://router.example' + path), id = url.searchParams.get('case');
      const instance = url.searchParams.get('instance') === 'omitted' ? 'omitted' : 'fixed';
      const diagnostic = url.pathname === '/v1/responses' && id === 'final-await';
      let phase = 'dispatch-started';
      if (diagnostic) t.diagnostic(JSON.stringify({ instance, case: id, phase }));
      const pending = runtime.dispatchFetch(url.href, { ...options, signal: controller.signal }).then(async r => {
        phase = 'diagnostic-headers-received';
        if (diagnostic) t.diagnostic(JSON.stringify({ instance, case: id, phase }));
        return { status: r.status, text: await r.text() };
      }).catch(error => {
        t.diagnostic(JSON.stringify({ instance, case: Object.hasOwn(cases, id) ? id : 'control', phase }));
        throw error; // Every unexpected outer transport failure retains identity.
      });
      pending.catch(() => {}); clients.push(pending); return pending;
    };
    json = async path => { const r = await call(path); assert.equal(r.status, 200); return JSON.parse(r.text); };
    const request = (id, variant = false) => call('/v1/responses?case=' + id + '&instance=' + (variant ? 'omitted' : 'fixed'), { method: 'POST', headers: {
      authorization: 'Bearer clawrouter-live-fixture-fixture-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-6-astra', input: 'fixture', stream: false }) });
    for (const [id, mode] of Object.entries(cases)) {
      assert.equal((await json('/setup?case=' + id)).ready, true); visited.push(id);
      const started = request(id);
      const early = started.then(() => { throw Error('public request completed before held alternate'); }, error => { throw error; }); early.catch(() => {});
      const wait = async predicate => {
        let last;
        for (let n = 0; n < 1000; n++) {
          last = await Promise.race([early, json('/state?case=' + id)]);
          if (predicate(last)) return last;
          await Promise.race([early, delay(10)]);
        }
        assert.fail('alternate arrival expired: ' + JSON.stringify(last));
      };
      if (mode.held) {
        let s = await wait(s => s.altEntered && gates.has(id + '/prepare') && gates.has(id + '/abort'));
        assert.equal(s.outward, false); assert.equal(s.provider, 1); assert.equal(s.alternates, 1); assert.equal(s.materializations, 1);
        release(id + '/abort'); s = await wait(s => s.aborted);
        await Promise.race([early, delay(10)]);
        s = await wait(s => s.aborted);
        assert.equal(s.outward, false); assert.equal(s.events, 0); assert.equal(s.provider, 1);
        release(id + '/prepare');
      }
      const response = await started;
      const expected = mode.held || mode.finalAbort || mode.uncertain ? 502 : id === 'success-control' ? 200 : 429;
      if (mode.finalAbort) {
        assert.equal(response.status, 200, 'diagnostic transport, not routed status');
        const observed = JSON.parse(response.text);
        assert.deepEqual(observed, { fixture: 'alternate-final-await', instance: 'fixed', case: id, phase: 'body-settled',
          routedStatus: 502, bodyOutcome: 'fulfilled', errorCode: 'provider_unavailable', jsonParsed: true });
      } else {
        assert.equal(response.status, expected, id);
        if (expected === 502) assert.equal(JSON.parse(response.text).error.code, 'provider_unavailable');
      }
      if (expected === 429) assert.deepEqual(JSON.parse(response.text), { error: 'original rejection' });
      await drain(); const s = await json('/state?case=' + id), sql = await json('/sql?case=' + id);
      assert.equal(s.provider, id === 'success-control' || mode.uncertain ? 2 : 1);
      assert.equal(s.alternates, mode.disabled ? 0 : 1); assert.equal(s.excludedCount, mode.disabled ? 0 : 1);
      assert.equal(s.admissions, mode.disabled ? 1 : 2);
      assert.equal(s.materializations, mode.disabled || mode.late === 'reject' ? 1 : 2);
      assert.equal(s.events, 1); assert.equal(s.ingested, true); assert.equal(sql.usage.length, 1); assert.equal(sql.usage[0].id, s.eventId);
      assert.equal(sql.usage[0].status, mode.uncertain ? 'provider_error' : expected === 200 ? 'success' : 'client_error');
      const cost = mode.uncertain || expected === 200 ? 7 : 0;
      assert.equal(sql.usage[0].actual_cost_micros, cost); assert.equal(sql.budgets.length, 2);
      for (const budget of sql.budgets) {
        assert.equal(budget.rows.length, 1); const row = budget.rows[0];
        assert.equal(row.reservation_id, budget.expected); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, cost); assert.equal(row.dispatch_started, 1);
      }
      if (mode.finalAbort) { assert.equal(s.waitObserved, 1); assert.equal(s.interceptions, 1); assert.equal(s.activeWhenQueued, true); assert.equal(s.originalStatus, 429); assert.equal(s.aborted, true); }
    }
    // All original requests/background work retire BEFORE disposing the first runtime.
    await drain(); await runtime.dispose(); runtime = null; visited.length = 0;
    runtime = await withoutOutsideFence(directory, upstream);
    assert.equal((await json('/setup?case=final-await')).ready, true); visited.push('final-await');
    const response = await request('final-await', true);
    assert.equal(response.status, 200, 'diagnostic transport, not routed status');
    const observed = JSON.parse(response.text);
    assert.equal(observed.fixture, 'alternate-final-await'); assert.equal(observed.instance, 'omitted');
    assert.equal(observed.case, 'final-await'); assert.equal(observed.phase, 'body-settled');
    assert.equal(observed.routedStatus, 429, 'omitting ONLY the fence returns an ACTUAL routed 429');
    assert.ok(['fulfilled', 'rejected'].includes(observed.bodyOutcome));
    t.diagnostic(JSON.stringify({ instance: 'omitted', case: 'final-await', phase: 'body-settled', routedStatus: observed.routedStatus, bodyOutcome: observed.bodyOutcome }));
    await drain(); const s = await json('/state?case=final-await'), sql = await json('/sql?case=final-await');
    assert.equal(s.waitObserved, 1); assert.equal(s.interceptions, 1); assert.equal(s.activeWhenQueued, true); assert.equal(s.originalStatus, 429); assert.equal(s.aborted, true); assert.equal(s.provider, 1); assert.equal(s.alternates, 1);
    assert.equal(sql.usage.length, 1); assert.equal(sql.usage[0].status, 'client_error');
    assert.equal(s.events, 1); assert.equal(s.ingested, true); assert.equal(sql.usage[0].id, s.eventId); assert.equal(sql.budgets.length, 2);
    for (const budget of sql.budgets) {
      assert.equal(budget.rows.length, 1); const row = budget.rows[0];
      assert.equal(row.reservation_id, budget.expected); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, 0);
    }
  } catch (error) { primary = error; throw error; }
});
