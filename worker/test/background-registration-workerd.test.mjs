import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBundledWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import worker from './worker/index.ts';
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {resolveAdmission,flushSelections,setCoalesceWindowMs} from './worker/admission-cache.ts';
import {tryRunInBackground,pendingBackgroundWork,backgroundMark} from './worker/hot-cache.ts';
import {putGrantCredentials} from './worker/grant-credentials.ts';
import {ingestUsage} from './worker/ledgers.ts';
import {sha256Hex} from './worker/utils.ts';
const raw=globalThis.fetch.bind(globalThis),key='oauth/background-a/selected';
// Cross-request state contains scalars ONLY. All native handles and promises
// below belong to the request that creates and joins them.
const a={roots:0,rootsSettled:0,rootFailures:0,cache:null,records:0,commits:0,baseline:0,after:0,reads:0,pending:0,
 cancels:0,nativeCancelSettled:false,cancelHeld:false,cancelRejected:false,unlocks:0,locked:false,
 unlockAfterRoots:false,facadeDone:false,probeStarts:0,done:false};
const b={entered:false,mark:0,delivered:false,status:0,events:0,ingested:false,facadeDone:false,backgroundFailed:false,ownIO:false,done:false};
const gate=async label=>{const r=await raw('https://background-fixture.example/gate/'+label);if(!r.ok)throw Error('fixture barrier failed');await r.text();};
const pause=()=>new Promise(resolve=>setTimeout(resolve,1));
async function joinCohort(mark){for(;;){const facade=pendingBackgroundWork(mark);if(!facade)return;await facade;await pause();}}
async function count(env){const r=await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://clawrouter.internal/grant-pools/stats',
 {method:'POST',body:JSON.stringify({keys:[key]})});if(!r.ok)throw Error('stats failed');return(await r.json()).stats[key].selectedCount;}
function observe(response){const body=response.body;if(!body)throw Error('missing actual fault body');const get=body.getReader.bind(body);
 body.getReader=options=>{const reader=get(options),read=reader.read.bind(reader),cancel=reader.cancel.bind(reader),unlock=reader.releaseLock.bind(reader);let first;
  a.locked=body.locked;
  reader.read=(...args)=>{a.reads++;a.pending++;const p=read(...args);return p.then(value=>{a.pending--;return value;},error=>{a.pending--;throw error;});};
  reader.cancel=(...args)=>{if(first)return first;let yes,no;first=new Promise((resolve,reject)=>{yes=resolve;no=reject;});a.cancels++;
   (async()=>{await cancel(...args);a.nativeCancelSettled=true;a.cancelHeld=true;
    await gate('cleanup');a.cancelHeld=false;a.cancelRejected=true;throw Error('labelled FIRST cancellation rejection');})().then(yes,no);return first;};
  reader.releaseLock=()=>{unlock();a.unlocks++;a.locked=body.locked;a.unlockAfterRoots=a.pending===0&&!a.cancelHeld&&a.nativeCancelSettled;};
  return reader;};return response;}
function controlled(bindings){const ns=bindings.ACCESS_CONTROL;return {...bindings,ACCESS_CONTROL:{idFromName:n=>ns.idFromName(n),get:id=>{const stub=ns.get(id);return {async fetch(input,init){
  if(new URL(input).pathname!=='/grant-pools/record')return stub.fetch(input,init);
  a.records++;const original=await stub.fetch(input,init);if(!original.ok)throw Error('actual additive commit failed');a.commits++;
  await original.body.cancel();
  // Labelled ACK fault AFTER the real SQLite commit, never a healthy substitute.
  return observe(await raw('https://background-fixture.example/fault',{redirect:'manual'}));
 }}}}};}
async function input(){return{credentialId:'background_a',secretSha256:await sha256Hex('synthetic-background-secret'),providers:[{id:'anthropic',tokenRef:'anthropic'}],
 selection:{providerId:'anthropic',endpointId:'messages',mode:'http',model:'claude-sonnet-5',catalogModelId:'anthropic/claude-sonnet-5',capability:'llm.chat'}};}
async function setup(env){const policy=id=>({enabled:true,generation:'g1',providers:['anthropic'],models:['anthropic/claude-sonnet-5'],tenantId:id,monthlyBudgetMicros:null,
 requestCostMicros:7,retainRequestContent:false,grantRouting:{eligibleGrants:{anthropic:['selected']},environmentFallback:false,failover:false}});
 await authorityCall(env,'/users/initialize-all',[]);
 await authorityCall(env,'/policies/initialize-all',['a','b'].map(id=>({policyId:'background-'+id,policy:policy('background-'+id)})));
 const secretSha256=await sha256Hex('synthetic-background-secret');
 await authorityCall(env,'/credentials/initialize-all',['a','b'].map(id=>({credentialId:'background_'+id,credential:{enabled:true,policyId:'background-'+id,policyGeneration:'g1',secretSha256}})));
 await authorityCall(env,'/connections/initialize-all',[{providerId:'anthropic',enabled:true}]);
 for(const id of ['a','b'])await putGrantCredentials(env,'oauth/background-'+id+'/selected',{provider:'anthropic',kind:'subscription',enabled:true,accessToken:'synthetic-background-'+id});
 const mark=backgroundMark();await resolveAdmission(env,await input());await joinCohort(mark);a.baseline=await count(env);
 setCoalesceWindowMs(1);
}
export default {async fetch(request,env,ctx){const path=new URL(request.url).pathname;
 if(path==='/setup'){await setup(env);return Response.json({ready:true,baseline:a.baseline});}
 if(path==='/state')return Response.json({a,b});
 if(path==='/probe'){const accepted=tryRunInBackground(()=>{a.probeStarts++;});return Response.json({accepted,starts:a.probeStarts});}
 if(path==='/sql')return Response.json({count:await count(env),records:a.records});
 if(path==='/flush-empty'){await flushSelections(controlled(env));return Response.json({count:await count(env),records:a.records});}
 if(path==='/a'){
  await request.text(); // Small ingress consumed; keep THIS fixture request alive.
  const mark=backgroundMark(),roots=[];let fixtureGate;
  try{
   for(let i=0;i<63;i++){
    // 63 distinct labelled fixture promises share ONE originating HTTP gate.
    // They are registration primitives, not 63 physical outbound connections.
    if(!tryRunInBackground(()=>{fixtureGate??=gate('fixture-roots');const original=fixtureGate.then(()=>undefined);
     roots.push(original.then(()=>{a.rootsSettled++;},()=>{a.rootsSettled++;a.rootFailures++;}));return original;}))throw Error('fixture root admission failed');
    a.roots++;
   }
   const selected=await resolveAdmission(controlled(env),await input());a.cache=selected.cache;
   if(a.cache!=='hit'||!selected.admission.selection?.selected)throw Error('real cached selection required');
   const facade=pendingBackgroundWork(mark);if(!facade)throw Error('missing live cohort');await facade;a.facadeDone=true;
   await gate('finish-a');
  }finally{await Promise.all(roots);await joinCohort(mark);a.after=await count(env);a.done=true;}
  if(a.rootFailures)throw Error('fixture roots failed');
  return Response.json({a,b});
 }
 if(path==='/b'){
  await request.text();b.mark=backgroundMark();
  const local=[],e={...env,CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS:'0'},ns=env.ACCESS_CONTROL;
  // The REAL index entry has captured its mark before this admission barrier.
  // Construct this wrapper and its native stubs in B's original request only.
  e.ACCESS_CONTROL={idFromName:n=>ns.idFromName(n),get:id=>{const stub=ns.get(id);return {async fetch(input,init){
   if(new URL(input).pathname==='/admission/resolve'&&!b.entered){b.entered=true;await gate('enter-b');}
   return stub.fetch(input,init);
  }}}};
  e.USAGE_QUEUE={async send(event){b.events++;const receipt=await ingestUsage(e,event);b.ingested=receipt.eventId===event.id;}};
  const track=p=>{const observed=Promise.resolve(p).then(()=>{},()=>{b.backgroundFailed=true;});local.push(observed);ctx.waitUntil(observed);};
  let failed=false,primary;
  try{
   const response=await worker.fetch(new Request('https://router.example/v1/messages',{method:'POST',headers:{authorization:'Bearer clawrouter-live-background_b-synthetic-background-secret','content-type':'application/json'},
    body:JSON.stringify({model:'anthropic/claude-sonnet-5',max_tokens:16,messages:[]})}),e,{waitUntil:track});
   b.status=response.status;await response.text();b.delivered=true;
  }catch(error){failed=true;primary=error;}
  await Promise.all(local);b.facadeDone=true;
  if(b.backgroundFailed)throw new AggregateError(failed?[primary,Error('B background failed')]:[Error('B background failed')],'B original and background outcomes');
  if(failed)throw primary;
  const probe=await raw('https://background-fixture.example/own-b');b.ownIO=probe.ok&&(await probe.text())==='same-context';b.done=true;
  return Response.json({a,b});
 }
 return new Response(null,{status:404});
},queue:worker.queue};`;

test('actual cache-hit flush retains registration across facade expiry and rejected FIRST cleanup', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'background-registration-'));
  const gates = new Map(), released = new Set(), arrivals = new Set(), clients = [];
  let runtime, server, primary, releaseFuture = false, aMayFinish = false, bMayFinish = false;
  const abort = new AbortController();
  const release = label => { released.add(label); gates.get(label)?.end('released'); gates.delete(label); };
  const releaseAll = () => { releaseFuture = true; for (const label of gates.keys()) release(label); };
  const stop = () => { releaseAll(); abort.abort(t.signal.reason); };
  t.signal.addEventListener('abort', stop, { once: true });
  t.after(async () => {
    aMayFinish = bMayFinish = true; releaseAll(); const failures = [];
    for (const result of await Promise.allSettled(clients)) if (result.status === 'rejected' && result.reason !== primary) failures.push(result.reason);
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', stop);
    if (failures.length) throw new AggregateError(failures, 'registration fixture cleanup');
  });
  try {
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path.startsWith('/gate/')) { const label = path.slice(6); arrivals.add(label);
        if (releaseFuture || released.has(label)) response.end('released'); else gates.set(label, response); return; }
      if (path === '/fault') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end(' '.repeat(129)); return; }
      if (path === '/own-b') { response.end('same-context'); return; }
      if (path === '/provider') { request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"usage":{"input_tokens":1,"output_tokens":1}}'); return; }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);const path=u.origin==='https://background-fixture.example'?u.pathname:u.hostname==='api.anthropic.com'?'/provider':null;
      if(!path)throw Error('unexpected fixture egress');return fetch(${JSON.stringify(origin)}+path,{method:request.method,headers:request.headers,body:request.body,redirect:'manual',signal:request.signal});}};`;
    // Test-only short facade timer; all registration/actual-settlement logic and
    // REAL DO/ACK consumer code remain unchanged. Not a production 10s measurement.
    const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
    const target = resolve('worker/hot-cache.ts'), needle = 'export const DRAIN_BOUND_MS = 10_000;';
    const bundle = await build({ stdin: { contents: router, resolveDir: process.cwd(), loader: 'ts' }, write: false, bundle: true,
      format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent', plugins: [{ name: 'fixture-facade-timer', setup(build) {
        build.onLoad({ filter: /hot-cache\.ts$/ }, async args => { if (resolve(args.path) !== target) return;
          const source = await readFile(args.path, 'utf8'); assert.equal(source.split(needle).length, 2);
          return { contents: source.replace(needle, 'export const DRAIN_BOUND_MS = 40;'), loader: 'ts', resolveDir: dirname(args.path) }; });
      } }] });
    runtime = await startBundledWorkerdFixture(directory, bundle.outputFiles[0].text, upstream, { preventEviction: true, hotCache: true });
    const call = path => { const p = runtime.dispatchFetch('https://router.example' + path, { method: path === '/a' || path === '/b' ? 'POST' : 'GET',
      ...(path === '/a' || path === '/b' ? { body: 'small fixture ingress' } : {}), signal: abort.signal }).then(async r => { assert.equal(r.status, 200); return r.json(); });
      clients.push(p); void p.catch(() => {}); return p; };
    const setup = await call('/setup'); assert.equal(setup.ready, true);
    const startedB = call('/b');
    const failureB = startedB.then(() => { if (!bMayFinish) throw Error('B completed before its barrier'); return new Promise(() => {}); }); void failureB.catch(() => {});
    const wait = async (predicate, failures = []) => {
      for (let i = 0; i < 2000; i++) { const state = await Promise.race([call('/state'), ...failures]); assert.equal(state.a.rootFailures, 0); if (predicate(state)) return state;
        await Promise.race([delay(5), ...failures]); }
      assert.fail('bounded registration fixture arrival expired');
    };
    await wait(s => s.b.entered && arrivals.has('enter-b'), [failureB]);
    const startedA = call('/a');
    const failureA = startedA.then(() => { if (!aMayFinish) throw Error('A completed before original-root release'); return new Promise(() => {}); }); void failureA.catch(() => {});
    let state = await wait(s => s.a.cancelHeld && s.a.facadeDone && arrivals.has('cleanup'), [failureA, failureB]);
    assert.equal(state.a.roots, 63); assert.equal(state.a.rootsSettled, 0); assert.equal(state.a.cache, 'hit');
    assert.equal(state.a.commits, 1); assert.equal(state.a.cancels, 1); assert.equal(state.a.unlocks, 0); assert.equal(state.a.locked, true);
    assert.deepEqual(await call('/probe'), { accepted: false, starts: 0 });
    assert.equal((await call('/sql')).count, setup.baseline + 1);
    bMayFinish = true; release('enter-b');
    const resultB = await Promise.race([startedB, failureA]);
    assert.equal(resultB.b.status, 200); assert.equal(resultB.b.events, 1); assert.equal(resultB.b.ingested, true);
    assert.equal(resultB.b.ownIO, true); assert.equal(resultB.b.facadeDone, true);
    assert.equal(resultB.a.cancelHeld, true); assert.equal(resultB.a.unlocks, 0);
    assert.deepEqual(await call('/probe'), { accepted: false, starts: 0 }, 'B facade did not release A registration');
    release('cleanup');
    state = await wait(s => s.a.unlocks === 1 && s.a.cancelRejected, [failureA]);
    assert.equal(state.a.unlockAfterRoots, true); assert.equal(state.a.locked, false); assert.equal(state.a.rootsSettled, 0);
    let probe;
    for (let i = 0; i < 100; i++) { probe = await Promise.race([call('/probe'), failureA]); if (probe.accepted) break; await delay(1); }
    assert.deepEqual(probe, { accepted: true, starts: 1 }, 'only ACTUAL flush settlement frees slot 64');
    assert.deepEqual(await call('/flush-empty'), { count: setup.baseline + 1, records: 1 });
    aMayFinish = true; release('fixture-roots'); release('finish-a');
    const resultA = await startedA;
    assert.equal(resultA.a.done, true); assert.equal(resultA.a.rootsSettled, 63); assert.equal(resultA.a.after, setup.baseline + 1);
    assert.equal(resultA.a.records, 1); assert.equal(resultA.a.cancels, 1); assert.equal(resultA.a.unlocks, 1);
  } catch (error) { primary = error; throw error; }
});
