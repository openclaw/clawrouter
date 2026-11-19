import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const hooks=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.endsWith('.ts')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);if(s==='cloudflare:workers')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}')};return next(s,c);}});
let LargeHttpPool,runtimeConfig;
try{({LargeHttpPool}=await import('../worker/large-http/lifecycle.ts'));({runtimeConfig}=await import('../worker/large-http/config.ts'));}finally{hooks.deregister();}

function fixture(){
 const values=new Map(),prepares=[];let alarm=null;
 const storage={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>{values.set(k,structuredClone(v));},getAlarm:async()=>alarm,setAlarm:async at=>{alarm=at;}};
 storage.transaction=async fn=>fn(storage);
 const ctx={storage},env={LARGE_HTTP_ORIGIN:'https://clawrouter-native-qualification-abcdef012345.fixture.workers.dev',LARGE_HTTP_TOKEN:'d'.repeat(64),LARGE_HTTP_RUNTIME_SHA:'c'.repeat(64),LARGE_HTTP_RUNTIME_BYTES:'1234',LARGE_HTTP_CAPACITY:'8',LARGE_HTTP_TESTING:'1',LARGE_HTTP_ENABLED:'0'};
 env.LARGE_HTTP_SLOTS={getByName:name=>({fetch:async(url,init)=>{
  const slot=Number(name.split('-').at(-1)),op=new URL(url).pathname;
  if(op==='/control/prepare'){const {generation}=JSON.parse(init.body);prepares.push({slot,generation});return Response.json({generation,phase:'starting'});}
  assert.equal(op,'/control/state');const config=await runtimeConfig(env);
  return Response.json({schema:1,phase:'idle',generation:0,boot:'',fingerprint:config.fingerprint,control:{slot,runtimeSha:config.runtimeSha,fingerprint:config.fingerprint}});
 }})};
 const call=async(pool,op='snapshot',value={})=>{
  const response=await pool.fetch(new Request('https://pool/'+op,{method:'POST',headers:{'x-container-token':env.LARGE_HTTP_TOKEN},body:JSON.stringify(value)}));assert.equal(response.status,200);return response.json();
 };
 return {ctx,env,prepares,call,get alarm(){return alarm;}};
}

test('actual pool retains disabled configuration until actor adoption, then ordinary alarms prepare serially',async t=>{
 const f=fixture(),old=new LargeHttpPool(f.ctx,{...f.env});
 const disabled=await f.call(old);assert.equal(disabled.state.phase,'closed');assert.equal(disabled.state.accepting,true);assert.equal(f.alarm,null);
 // A new front-end binding does not replace a still-running actor's env.
 const enabledEnv={...f.env,LARGE_HTTP_ENABLED:'1'};
 const unchanged=await f.call(old);assert.equal(unchanged.state.phase,'closed');assert.equal(f.alarm,null);assert.deepEqual(f.prepares,[]);
 const adopted=new LargeHttpPool(f.ctx,enabledEnv),enabled=await f.call(adopted);
 assert.equal(enabled.control.fingerprint,disabled.control.fingerprint,'fingerprint excludes enabled, so it cannot attest this adoption');
 assert.equal(enabled.control.runtimeSha,disabled.control.runtimeSha,'native digest alone cannot attest adoption either');
 assert.equal(enabled.state.phase,'serving');assert.equal(enabled.state.accepting,true);assert.ok(Number.isSafeInteger(f.alarm)&&f.alarm>0);
 assert.deepEqual(f.prepares,[],'snapshot schedules ordinary lifecycle without direct native start');
 await adopted.alarm();assert.deepEqual(f.prepares,[{slot:0,generation:1}]);
 const after=await f.call(adopted);assert.equal(after.state.slots.filter(x=>x.phase==='starting').length,1);assert.equal(after.state.slots.filter(x=>x.phase==='idle').length,7);
 t.diagnostic(JSON.stringify({surface:'actual LargeHttpPool with controlled durable storage/slot port',before:'closed, accepting=true, no alarm/prepare',after:'serving, ordinary alarm, one serial prepare',sameFingerprint:true,sameNativeDigest:true,limits:'models actor reconstruction, not hosted deployment scheduling or container startup'}));
});

test('adoption preserves a durable closed admission gate rather than reopening it',async()=>{
 const f=fixture(),old=new LargeHttpPool(f.ctx,{...f.env});await f.call(old);
 const closed=await f.call(old,'admission',{accepting:false,expectedRevision:0,operationId:'local-close'});assert.equal(closed.revision,1);
 const adopted=new LargeHttpPool(f.ctx,{...f.env,LARGE_HTTP_ENABLED:'1'}),snapshot=await f.call(adopted);
 assert.equal(snapshot.state.accepting,false);assert.equal(snapshot.state.phase,'closed');assert.equal(snapshot.control.revision,1);assert.equal(f.alarm,null);assert.deepEqual(f.prepares,[]);
});
