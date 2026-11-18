import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeControl, NativeControlHttpError, NativeControlVersionMismatch, observeNativeControl } from '../scripts/deploy-native-cutover.mjs';

const version = '11111111-1111-1111-1111-111111111111', previous = '22222222-2222-2222-2222-222222222222';
const reset = () => new NativeControlHttpError('GET',500,version,version);
function fixture(sequence) {
  let clock = 0, reads = 0, owners = 0;
  const pending = [];
  const options = {control:{snapshot:async expected=>{
    assert.equal(expected,version); const value = sequence[Math.min(reads++,sequence.length-1)];
    if (value instanceof Error) throw value; return value;
  }},version,previousVersions:[previous],assertOwnership:async()=>{owners++;},isReady:s=>s.ready === true,
  now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:10,pollMs:2,onPending:o=>pending.push(o)};
  return {options,pending,get clock(){return clock;},get reads(){return reads;},get owners(){return owners;},advance:ms=>{clock+=ms;}};
}

test('owned snapshot reset remains pending until validated readiness, without extending the deadline',async()=>{
  const f=fixture([reset(),{ready:false},{ready:true}]);
  assert.deepEqual(await observeNativeControl(f.options),{ready:true});
  assert.equal(f.reads,3);assert.equal(f.owners,3);assert.equal(f.clock,4);
  assert.deepEqual(f.pending,[{kind:'http',status:500}]);
  const persistent=fixture([reset()]);
  await assert.rejects(observeNativeControl(persistent.options),/deadline/);
  assert.equal(persistent.clock,10);assert.equal(persistent.reads,5);assert.equal(persistent.owners,5);
});

test('snapshot observation never accepts late success or starts a read after a slow ownership check',async()=>{
  const late=fixture([{ready:true}]);
  const read=late.options.control.snapshot;
  late.options.control.snapshot=async v=>{late.advance(10);return read(v);};
  await assert.rejects(observeNativeControl(late.options),/deadline/);
  const ownership=fixture([{ready:true}]);
  ownership.options.assertOwnership=async()=>ownership.advance(10);
  await assert.rejects(observeNativeControl(ownership.options),/deadline/);
  assert.equal(ownership.reads,0);
});

test('only selected-version GET500 is pending; all other failures retain terminal meaning',async t=>{
  const failures = [
    new NativeControlHttpError('POST',500,version,version),
    ...[401,403,404,429,502,503].map(status=>new NativeControlHttpError('GET',status,version,version)),
    ...[null,'invalid header',previous].map(actual=>new NativeControlHttpError('GET',500,version,actual)),
    new NativeControlHttpError('GET',500,previous,version),
    new NativeControlVersionMismatch(version,'33333333-3333-3333-3333-333333333333'),
    new Error('Native control request failed; delivery may be unknown'),
    new SyntaxError('malformed successful response'),
  ];
  for(const [index,error] of failures.entries())await t.test(String(index),async()=>{
    const f=fixture([error,{ready:true}]);
    await assert.rejects(observeNativeControl(f.options),e=>e===error);
    assert.equal(f.reads,1);assert.equal(f.clock,0);assert.equal(f.pending.length,0);
  });
  assert.equal(new NativeControlHttpError('GET',500,version,'arbitrary header').actual,null);
});

test('known previous version stays pending; ownership and startup state guards remain terminal after reset',async()=>{
  const lag=fixture([new NativeControlVersionMismatch(version,previous),{ready:true}]);
  await observeNativeControl(lag.options);assert.deepEqual(lag.pending,[{kind:'version',actual:previous}]);
  const owner=fixture([reset(),{ready:true}]);let checks=0;
  owner.options.assertOwnership=async()=>{if(++checks===2)throw Error('ownership changed');};
  await assert.rejects(observeNativeControl(owner.options),/ownership/);assert.equal(owner.reads,1);
  for(const reason of ['admission closed','blocked slot','runtime mismatch']){
    const f=fixture([reset(),{ready:true}]);
    f.options.validate=()=>{throw Error(reason);};
    await assert.rejects(observeNativeControl(f.options),e=>e.message===reason);
    assert.equal(f.reads,2);
  }
});

test('HTTP client exposes safe error metadata without retrying or retaining response data',async()=>{
  let reads=0;
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},fetchImpl:async()=>{
    reads++;return new Response('private error body',{status:500,headers:{'x-clawrouter-version-id':version}});
  }});
  await assert.rejects(control.snapshot(version),e=>e instanceof NativeControlHttpError && e.status===500 &&
    e.method==='GET' && e.expected===version && e.actual===version && !JSON.stringify(e).includes('private'));
  assert.equal(reads,1);
});
