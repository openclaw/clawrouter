import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {runtimeConfig} from '../worker/large-http/config.ts';
import {createNativeControl,runNativeCutover,nativeDrained,nativeWarm} from '../scripts/deploy-native-cutover.mjs';
import {recoverRemote} from '../scripts/deploy-train-recover.mjs';
import {deploymentState,deploymentMessage} from '../scripts/deploy-train-policy.mjs';
import {uploadMessage} from '../scripts/deploy-train-secrets.mjs';
import {nativeVersion} from './helpers/deploy-native-fixture.mjs';

// Only the host boundary is substituted. The controller, native journal,
// lifecycle handlers, identity checks and transaction callbacks are real.
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='cloudflare:workers')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}')};
 return next(specifier,context);
}});
const {LargeHttpPool,LargeHttpSlot}=await import('../worker/large-http/lifecycle.ts');
hooks.deregister();
const hash=n=>n.toString(16).padStart(64,'0'),id=n=>'prf_'+n.toString(16).padStart(32,'0');
const boot=(slot,generation)=>'00000000-0000-4000-8000-'+String(slot+generation*8).padStart(12,'0');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function storage(){
 let data=new Map(),alarm=null,tail=Promise.resolve();
 return {
  failReceipt:false,
  get value(){return structuredClone(data);},
  seed(key,value){data.set(key,structuredClone(value));},
  async setAlarm(at){alarm=at;},
  transaction(fn){
   const work=tail.then(async()=>{
    const next=structuredClone(data);let nextAlarm=alarm;
    const result=await fn({get:async key=>structuredClone(next.get(key)),put:async(key,value)=>{
     if(this.failReceipt&&key.startsWith('admission:'))throw Error('storage failure');
     next.set(key,structuredClone(value));
    },getAlarm:async()=>nextAlarm,setAlarm:async at=>{nextAlarm=at;}});
    data=next;alarm=nextAlarm;return result;
   });
   tail=work.catch(()=>{});return work;
  }
 };
}
async function fixture(t,{poolSha=hash(10),slotSha=poolSha}={}){
 const pending=[],slots=[],effects=[],reads=[],monitors=[];
 const env={LARGE_HTTP_ORIGIN:'https://cutover.example.invalid',LARGE_HTTP_RUNTIME_SHA:poolSha,LARGE_HTTP_RUNTIME_BYTES:'1000',LARGE_HTTP_TOKEN:hash(99)};
 const namespace={
  idFromName:name=>({toString:()=>name}),
  getByName(name){const i=Number(name.split('-').at(-1));return {fetch:async(input,init)=>{
   const request=new Request(input,init);reads.push([i,new URL(request.url).pathname]);
   const response=await slots[i].actor.fetch(request);
   if(new URL(request.url).pathname==='/control/state'&&slots[i].transform)return slots[i].transform(response);
   return response;
  }};}
 };
 env.LARGE_HTTP_SLOTS=namespace;
 const poolStorage=storage(),poolCtx={storage:poolStorage},f={env,slots,effects,reads,poolStorage};
 f.pool=new LargeHttpPool(poolCtx,env);
 env.LARGE_HTTP_POOL={getByName:()=>({fetch:(input,init)=>f.pool.fetch(new Request(input,init))})};
 for(let i=0;i<8;i++){
  const journal=storage();let info=null,watch=null;
  const slotEnv={...env,LARGE_HTTP_RUNTIME_SHA:slotSha};
  const native={
   get running(){return info!==null;},
   inspect:async()=>info,
   start(options){effects.push(['start',i,options.labels.generation]);info=options;watch=deferred();monitors.push(watch);},
   monitor:()=>watch.promise,
   setInactivityTimeout:async()=>{},
   destroy:async()=>{effects.push(['destroy',i]);if(slots[i].destroyUnknown)throw Error('ack lost');info=null;watch?.resolve();},
   getTcpPort:()=>({fetch:async(input,init)=>{
    const request=new Request(input,init);
    assert.equal(request.headers.get('x-container-token'),info.env.LARGE_HTTP_RUNTIME_TOKEN);
    if(new URL(request.url).pathname==='/startup-health')return Response.json({ready:true,slot:i,generation:Number(info.labels.generation),build:info.labels.build,boot:boot(i,Number(info.labels.generation))});
    effects.push(['inference',i]);return Response.json({ok:true});
   }})
  };
  const ctx={storage:journal,id:namespace.idFromName('large-http-slot-'+i),container:native,waitUntil:p=>pending.push(p)};
  slots.push({storage:journal,ctx,env:slotEnv,actor:new LargeHttpSlot(ctx,slotEnv)});
 }
 f.config=await runtimeConfig(env);f.slotConfig=await runtimeConfig(slots[0].env);
 f.request=(op,value={},token=env.LARGE_HTTP_TOKEN)=>new Request('https://pool/'+op,{method:'POST',headers:{'x-container-token':token},body:JSON.stringify(value)});
 f.call=async(op,value={})=>{const response=await f.pool.fetch(f.request(op,value));const body=await response.json();assert.equal(body.status,response.status);return body;};
 f.snapshot=()=>f.call('snapshot');
 f.reconstruct=()=>{f.pool=new LargeHttpPool(poolCtx,env);};
 f.warm=async()=>{
  // Each alarm may start only one slot. Await actual control work through
  // subsequent observations; no timers, arbitrary sleeps, or fabricated ready.
  for(let n=0;n<16;n++){
   await f.pool.alarm();const s=await f.snapshot();
   if(s.state.slots.every(m=>m.phase==='ready'))return s;
  }
  assert.fail('native slots did not become ready');
 };
 t.after(async()=>{
  for(const watch of monitors)watch.resolve();await Promise.all(pending);
  // Drain journal writes scheduled by the native monitor callbacks as well.
  await Promise.all(slots.map(s=>s.actor.fetch(new Request('https://slot/control/state',{method:'POST',headers:{'x-container-token':env.LARGE_HTTP_TOKEN},body:'{}'}))));
 });
 return f;
}
const managed=(accepting,expectedRevision,operationId)=>({accepting,expectedRevision,operationId});

test('authenticated snapshots add safe identities; unauthenticated inspection has no slot effects',async t=>{
 const f=await fixture(t);
 assert.equal((await f.pool.fetch(f.request('snapshot',{},'wrong'))).status,403);
 assert.equal((await f.pool.fetch(new Request('https://pool/snapshot',{headers:{'x-container-token':f.env.LARGE_HTTP_TOKEN}}))).status,405);
 assert.equal(f.reads.length,0);
 const s=await f.warm();
 assert.deepEqual(s.control,{schema:1,revision:0,fenced:false,runtimeSha:f.config.runtimeSha,fingerprint:f.config.fingerprint});
 assert.equal(s.state.schema,2);assert.equal(s.state.control,undefined);
 assert.equal(s.slots.length,8);assert.ok(s.slots.every(o=>o.qualified));
 for(const o of s.slots){
  assert.equal(o.runtimeSha,f.config.runtimeSha);assert.equal(o.fingerprint,f.config.fingerprint);
  assert.equal(o.boot,s.state.pool.members[o.slot].boot);assert.equal(o.generation,s.state.slots[o.slot].generation);
  assert.deepEqual(o.config,{runtimeSha:f.config.runtimeSha,fingerprint:f.config.fingerprint});
 }
 const encoded=JSON.stringify(s);
 assert.ok(!encoded.includes(f.env.LARGE_HTTP_TOKEN));
 for(const slot of f.slots){assert.ok(!encoded.includes(slot.storage.value.get('native').token));}
 assert.equal(f.effects.filter(e=>e[0]==='start').length,8);
});

test('first CAS adopts old state without losing owners; atomic revision and receipt survive a lost response',async t=>{
 const f=await fixture(t);await f.warm();
 assert.equal((await f.call('admission',{accepting:true})).status,200);
 const g=(await f.call('admit',{id:id(1),tenant:hash(1)})).grant;assert.ok(g);
 const before=(await f.snapshot()).state;
 const operation=managed(false,0,'cutover:stop');
 // Commit but discard the response, as with a lost HTTP acknowledgement.
 const response=await f.pool.fetch(f.request('admission',operation));assert.equal(response.status,200);await response.body.cancel();
 f.reconstruct();const retry=await f.call('admission',operation);
 assert.deepEqual(retry,{status:200,...operation,revision:1});
 const after=await f.snapshot();assert.equal(after.control.revision,1);assert.equal(after.control.fenced,true);assert.equal(after.state.accepting,false);
 assert.deepEqual(after.state.pool,before.pool);assert.deepEqual(after.state.slots.map(s=>s.ids),before.slots.map(s=>s.ids));
 assert.equal((await f.call('admit',{id:id(2),tenant:hash(2)})).status,503);
 for(const op of ['claim','dispatch'])assert.equal((await f.call(op,g)).status,200);
 assert.equal((await f.call('finish',{...g,clean:true})).status,200);
 assert.equal((await f.snapshot()).state.pool.seen[g.id],'complete');
 assert.equal(f.effects.filter(e=>e[0]==='destroy').length,0);
});

test('recovery stop fences delayed enable, legacy writes and incompatible operation reuse without replaying old success',async t=>{
 const f=await fixture(t);
 const stop=managed(false,0,'stop'),enable=managed(true,1,'enable'),recover=managed(false,2,'recover');
 assert.equal((await f.call('admission',stop)).revision,1);
 const enabled=await f.call('admission',enable);assert.equal(enabled.revision,2);
 assert.equal((await f.call('admission',recover)).revision,3);f.reconstruct();
 assert.deepEqual(await f.call('admission',enable),enabled); // historical receipt, not current admission
 assert.equal((await f.call('admission',managed(true,1,'delayed-enable'))).status,409);
 assert.equal((await f.call('admission',managed(true,3,'stop'))).status,409);
 assert.equal((await f.call('admission',{...recover,accepting:true})).status,409);
 assert.equal((await f.call('admission',{accepting:true})).status,409);
 assert.equal((await f.call('admission',{accepting:false})).status,409);
 const s=await f.snapshot();assert.equal(s.state.accepting,false);assert.equal(s.control.revision,3);
 assert.equal(f.poolStorage.value.size,4); // one continuous state plus three immutable receipts
 assert.equal(f.effects.length,0);
});

test('competing CAS calls produce exactly one transition and storage failure cannot split receipt from revision',async t=>{
 const f=await fixture(t);
 const results=await Promise.all([f.call('admission',managed(false,0,'a')),f.call('admission',managed(true,0,'b'))]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await f.snapshot()).control.revision,1);
 const winner=results.find(r=>r.status===200);
 assert.deepEqual(await f.call('admission',managed(winner.accepting,0,winner.operationId)),winner);
 f.poolStorage.failReceipt=true;
 await assert.rejects(f.call('admission',managed(true,1,'storage-retry')),/storage failure/);
 let s=await f.snapshot();assert.equal(s.control.revision,1);assert.equal(s.state.accepting,winner.accepting);
 assert.equal(f.poolStorage.value.has('admission:storage-retry'),false);
 f.poolStorage.failReceipt=false;assert.equal((await f.call('admission',managed(true,1,'storage-retry'))).revision,2);
 s=await f.snapshot();assert.equal(s.control.revision,2);assert.equal(s.state.accepting,true);
});

test('invalid managed requests never acquire a fence; ordinary legacy operators remain compatible before adoption',async t=>{
 const f=await fixture(t);
 const invalid=[{accepting:'false'},{accepting:false,expectedRevision:0},{accepting:false,operationId:'x'},
  ...[-1,0.5,Number.MAX_SAFE_INTEGER+1,null,'0'].map(r=>managed(false,r,'x')),
  ...['','x'.repeat(129),'line\nbreak',null,3].map(o=>managed(false,0,o))];
 for(const input of invalid)assert.equal((await f.call('admission',input)).status,400,JSON.stringify(input));
 assert.equal((await f.snapshot()).control.fenced,false);
 for(const accepting of [false,true])assert.deepEqual(await f.call('admission',{accepting}),{status:200,accepting});
 assert.equal((await f.call('admission',managed(true,0,'x'.repeat(128)))).revision,1);
});

test('pool-ready candidate B with all native journals A is explicitly unqualified',async t=>{
 const f=await fixture(t,{poolSha:hash(11),slotSha:hash(10)});const s=await f.warm();
 assert.ok(s.state.slots.every(m=>m.phase==='ready'&&m.fingerprint===f.config.fingerprint));
 assert.equal(s.control.runtimeSha,hash(11));
 assert.ok(s.slots.every(o=>o.phase==='ready'&&o.fingerprint===f.slotConfig.fingerprint&&o.runtimeSha===hash(10)&&!o.qualified));
 assert.notEqual(s.control.fingerprint,f.slotConfig.fingerprint);
});

test('qualification cross-checks journal, configured identity, owner boot and protocol rather than a claimed ready bit',async t=>{
 const f=await fixture(t);assert.ok((await f.warm()).slots[0].qualified);
 const transformations=[
  s=>({...s,fingerprint:hash(91)}),s=>({...s,runtimeSha:hash(92)}),
  s=>({...s,control:{...s.control,slot:1}}),s=>({...s,control:{...s.control,fingerprint:hash(93)}}),s=>({...s,control:{...s.control,runtimeSha:hash(94)}}),
  s=>({...s,boot:boot(7,9)}),s=>({...s,generation:s.generation+1}),s=>({...s,phase:'failed'}),
  s=>({...s,control:undefined}),s=>({...s,control:{...s.control,schema:2}}),s=>({...s,runtimeSha:undefined}),
 ];
 for(const change of transformations){
  f.slots[0].transform=async response=>Response.json({...change(await response.json()),token:'must-not-leak',extra:{token:'also-private'}});
  const s=await f.snapshot();assert.equal(s.slots[0].qualified,false);assert.equal(s.slots[1].qualified,true);
  assert.ok(!JSON.stringify(s).includes('must-not-leak'));assert.ok(!JSON.stringify(s).includes('also-private'));
 }
 f.slots[0].transform=async()=>new Response(null,{status:404});
 let s=await f.snapshot();assert.equal(s.slots[0].phase,'unknown');assert.equal(s.slots[0].runtimeSha,null);assert.equal(s.slots[0].qualified,false);
 f.slots[0].transform=async()=>{throw Error('slot unreachable');};s=await f.snapshot();assert.equal(s.slots[0].qualified,false);
 f.slots[0].transform=undefined;assert.equal((await f.snapshot()).slots[0].qualified,true);
});

test('slot reconstruction preserves the original start digest, and legacy journals never synthesize one from config',async t=>{
 const f=await fixture(t);await f.warm();const original=f.slots[0].storage.value.get('native');
 const slot=f.slots[0];slot.env={...slot.env,LARGE_HTTP_RUNTIME_SHA:hash(11)};slot.actor=new LargeHttpSlot(slot.ctx,slot.env);
 let s=await f.snapshot();assert.equal(s.slots[0].runtimeSha,hash(10));assert.equal(s.slots[0].fingerprint,original.fingerprint);
 assert.equal(s.slots[0].config.runtimeSha,hash(11));assert.equal(s.slots[0].phase,'failed');assert.equal(s.slots[0].qualified,false);
 const old={...original};delete old.runtimeSha;slot.storage.seed('native',old);slot.actor=new LargeHttpSlot(slot.ctx,slot.env);
 s=await f.snapshot();assert.equal(s.slots[0].runtimeSha,null);assert.equal(s.slots[0].qualified,false);
 assert.equal(f.effects.filter(e=>e[0]==='start'&&e[1]===0).length,1);
});

test('fenced stops preserve uncertain owners and native replay history; reopening cannot bypass blocked destruction',async t=>{
 const f=await fixture(t);await f.warm();
 const g=(await f.call('admit',{id:id(1),tenant:hash(1)})).grant;
 const request=()=>new Request('https://slot/v1/responses',{method:'POST',headers:{'x-container-token':f.env.LARGE_HTTP_TOKEN,'x-large-http-grant':JSON.stringify(g)},body:'{}'});
 assert.equal((await f.slots[g.slot].actor.fetch(request())).status,200);
 assert.equal((await f.call('dispatch',g)).status,200);
 assert.equal((await f.slots[g.slot].actor.fetch(request())).status,409);
 assert.equal((await f.call('admission',managed(false,0,'stop'))).status,200);
 assert.equal((await f.call('finish',{...g,clean:false})).status,200);
 const before=(await f.snapshot()).state;assert.equal(before.pool.seen[g.id],'quarantined');
 // Advance only the persisted drain deadline, not a global test clock; the
 // existing native retire path must still obtain the destruction ACK.
 const pending=f.poolStorage.value.get('continuous');pending.slots[g.slot].drainUntil=0;f.poolStorage.seed('continuous',pending);
 f.slots[g.slot].destroyUnknown=true;await f.pool.alarm();
 assert.equal((await f.snapshot()).slots[g.slot].phase,'blocked');
 // The first retire response acknowledges intent; the next alarm observes
 // the persisted failed ACK rather than issuing another native destruction.
 await f.pool.alarm();assert.equal((await f.snapshot()).state.slots[g.slot].phase,'blocked');
 assert.equal((await f.call('admission',managed(true,1,'resume'))).status,200);await f.pool.alarm();
 const s=await f.snapshot();assert.equal(s.state.slots[g.slot].phase,'blocked');assert.equal(s.slots[g.slot].phase,'blocked');assert.equal(s.slots[g.slot].qualified,false);
 assert.deepEqual(s.state.pool.grants.filter(x=>x.id===g.id),before.pool.grants.filter(x=>x.id===g.id));
 assert.equal(s.state.pool.seen[g.id],'quarantined');assert.ok(s.state.slots[g.slot].ids.includes(g.id));
 assert.equal((await f.call('dispatch',g)).status,409);assert.equal((await f.slots[g.slot].actor.fetch(request())).status,409);
 assert.equal(f.effects.filter(e=>e[0]==='inference').length,1);
 assert.equal(f.effects.filter(e=>e[0]==='destroy'&&e[1]===g.slot).length,1);
 assert.equal(f.effects.filter(e=>e[0]==='start'&&e[1]===g.slot).length,1);
});


test('HTTP coordinator replaces and recovers real native journals with fenced admission and no owner replay',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_800_000_000_000});
 const f=await fixture(t);await f.warm();
 const blue='11111111-1111-1111-1111-111111111111',green='22222222-2222-2222-2222-222222222222',recovery='33333333-3333-3333-3333-333333333333';
 const source='b'.repeat(40),sha='c'.repeat(40),oldRuntime=hash(10),runtime=hash(11);
 const state={run:'123',sha,blue,green,status:'rolling',unsafe:false,exposed:false,deploymentId:'initial',native:{schema:1,runtimeSha:runtime},cutover:{schema:1,blueRuntimeSha:oldRuntime,nativeSource:source,recovery,phase:'prepared'}};
 const versions={[blue]:nativeVersion(blue,source),[green]:nativeVersion(green,sha,blue),[recovery]:nativeVersion(recovery,sha,blue)};
 versions[blue].annotations['workers/message']=uploadMessage({run:'123',sha:source,blue:'9'.repeat(8)+'-9999-9999-9999-999999999999',native:{schema:1,runtimeSha:oldRuntime}});
 versions[green].annotations['workers/message']=uploadMessage(state);
 versions[recovery].annotations['workers/message']=uploadMessage({...state,native:{schema:1,runtimeSha:oldRuntime},nativeSource:source});
 let active=blue,latest={id:'initial',versions:[{version_id:blue,percentage:100}]},sequence=0,settled=false,lost=false,enable;
 const posts=[],switches=[];
 const adapt=s=>({...s.state,control:s.control,inspection:s.slots});
 const grant=(await f.call('admit',{id:id(20),tenant:hash(20)})).grant;assert.ok(grant);
 const api={latest:async()=>structuredClone(latest),version:async v=>versions[v],versions:async()=>[versions[green],versions[recovery],versions[blue]],
  deploy:async(distribution,message,expected,{immediate}={})=>{
   assert.equal(expected,latest.id);assert.equal(distribution.length,1);assert.equal(distribution[0].percentage,100);
   const target=distribution[0].version_id;
   if(target!==active){
    assert.equal(immediate,true);assert.ok(nativeDrained(adapt(await f.snapshot())));
    if(target===recovery){
     // A delayed duplicate of the old enable cannot reopen this newer drain.
     const before=await f.snapshot();assert.equal(before.state.accepting,false);
     assert.equal((await f.call('admission',enable)).accepting,true);
     const after=await f.snapshot();assert.equal(after.state.accepting,false);assert.equal(after.control.revision,before.control.revision);
    }
    switches.push(target);active=target;f.env.LARGE_HTTP_RUNTIME_SHA=target===green?runtime:oldRuntime;
    for(const slot of f.slots){slot.env={...slot.env,LARGE_HTTP_RUNTIME_SHA:f.env.LARGE_HTTP_RUNTIME_SHA};slot.actor=new LargeHttpSlot(slot.ctx,slot.env);}
    f.reconstruct();
   }
   latest={id:'d'+(++sequence),versions:distribution,annotations:{'workers/message':message}};
   deploymentState(latest);return structuredClone(latest);
  }};
 const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},wait:async()=>{},fetchImpl:async(_url,init)=>{
  const body=init.method==='POST'?JSON.parse(init.body):{};
  const response=await f.pool.fetch(f.request(init.method==='POST'?'admission':'snapshot',body));
  response.headers.set('x-clawrouter-version-id',active);
  if(init.method==='POST'){
   posts.push(body);
   if(body.accepting&&!lost){enable=body;lost=true;await response.body.cancel();throw Error('lost after commit');}
  }
  return response;
 }});
 const wait=async ms=>{
  t.mock.timers.tick(ms);
  if(!(await f.snapshot()).state.accepting&&!settled){
   assert.equal((await f.call('admit',{id:id(21),tenant:hash(21)})).status,503);
   for(const op of ['claim','dispatch'])assert.equal((await f.call(op,grant)).status,200);
   assert.equal((await f.call('finish',{...grant,clean:true})).status,200);settled=true;
  }
  await f.pool.alarm();
 };
 let smokes=0;
 await runNativeCutover({api,state,control,wait,smoke:async version=>{assert.equal(version,green);assert.ok(nativeWarm(adapt(await f.snapshot()),runtime));smokes++;}});
 assert.equal(settled,true);assert.equal(smokes,1);assert.equal(posts.length,2);assert.equal(f.effects.filter(e=>e[0]==='destroy').length,8);
 assert.ok((await f.snapshot()).slots.every(o=>o.qualified&&o.runtimeSha===runtime&&o.generation===2));
 // Fresh runner has only the remote journal; deliberately interrupt before the
 // terminal success receipt to exercise recovery, not a second forward run.
 state.status='rolling';await api.deploy([{version_id:green,percentage:100}],deploymentMessage(state),latest.id);
 const result=await recoverRemote(api,'123',{control,wait});
 assert.equal(result,'recovery: compatible native payload restored with fenced control at 100%');
 assert.deepEqual(switches,[green,recovery]);assert.equal(posts.length,4);
 const recovered=await f.snapshot();assert.ok(nativeWarm(adapt(recovered),oldRuntime));
 assert.ok(recovered.slots.every(o=>o.qualified&&o.generation===3));assert.equal(recovered.control.revision,4);
 assert.equal(f.effects.filter(e=>e[0]==='destroy').length,16);assert.equal(f.effects.filter(e=>e[0]==='start').length,24);
 assert.equal((await f.call('dispatch',grant)).status,409);
 assert.equal((await f.call('admission',{accepting:true})).status,409);
 const previousPosts=posts.length;assert.equal(await recoverRemote(api,'123',{control,wait}),result);assert.equal(posts.length,previousPosts);
});
