import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createNativeControl, NativeControlHttpError, NativeControlVersionMismatch, nativeDrained, observeNativeControl } from '../scripts/deploy-native-cutover.mjs';

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

test('only selected or explicitly allowed previous-version GET500 is pending; other failures remain terminal',async t=>{
  const failures = [
    new NativeControlHttpError('POST',500,version,version),
    new NativeControlHttpError('POST',500,version,previous),
    ...[401,403,404,429,502,503].flatMap(status=>[version,previous].map(actual=>new NativeControlHttpError('GET',status,version,actual))),
    ...[null,'invalid header','33333333-3333-3333-3333-333333333333'].map(actual=>new NativeControlHttpError('GET',500,version,actual)),
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

test('known previous-version GET500 remains pending with its safe version metadata',async()=>{
  const f=fixture([new NativeControlHttpError('GET',500,version,previous),{ready:false},{ready:true}]);
  assert.deepEqual(await observeNativeControl(f.options),{ready:true});
  assert.equal(f.reads,3);assert.equal(f.owners,3);assert.equal(f.clock,4);
  assert.deepEqual(f.pending,[{kind:'http',status:500,actual:previous}]);
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

test('loopback HTTP proves owned previous-version GET500 convergence and terminal boundaries',async t=>{
  const unknown='33333333-3333-3333-3333-333333333333';
  const state={schema:2,accepting:false,phase:'closed',slots:Array.from({length:8},()=>({generation:2,phase:'idle',fingerprint:'a'.repeat(64),ids:[]})),pool:{grants:[],members:Array(8).fill(null),issued:0,seen:{}}};
  const response=(status,actual,body=JSON.stringify({status:200,state,control:{schema:1},slots:[]}))=>({status,actual,body});
  let active;
  const server=createServer((req,res)=>{
    active.requests.push({method:req.method,path:req.url});
    const row=active.responses[Math.min(active.requests.length-1,active.responses.length-1)];
    res.writeHead(row.status,{'content-type':'application/json',...(row.actual===null?{}:{'x-clawrouter-version-id':row.actual})});res.end(row.body);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    const cases=[
      {name:'known old and selected HTTP500 require successful selected readiness',responses:[response(500,previous),response(200,previous),response(500,version),response(200,version)],reads:4,pending:3,timeoutMs:8},
      {name:'unknown version stays terminal',responses:[response(500,unknown)],error:NativeControlHttpError,reads:1},
      {name:'missing version cannot be allowed by a null previous entry',responses:[response(500,null)],previousVersions:[previous,null],error:NativeControlHttpError,reads:1},
      {name:'malformed version cannot be allowed by a malformed previous entry',responses:[response(500,'invalid')],previousVersions:[previous,'invalid'],error:NativeControlHttpError,reads:1},
      {name:'unlisted previous version stays terminal',responses:[response(500,previous)],previousVersions:[],error:NativeControlHttpError,reads:1},
      {name:'other HTTP failures from known previous stay terminal',responses:[response(503,previous)],error:NativeControlHttpError,reads:1},
      {name:'ownership drift stops before another GET',responses:[response(500,previous),response(200,version)],drift:true,error:/ownership changed/,reads:1},
      {name:'persistent previous HTTP500 cannot extend the deadline',responses:[response(500,previous)],error:/deadline/,reads:3,pending:3},
      {name:'malformed selected success after pending stays terminal',responses:[response(500,previous),response(200,version,'{')],error:SyntaxError,reads:2,pending:1},
      {name:'selected state validation remains required after pending',responses:[response(500,previous),response(200,version)],invalidState:true,error:/runtime mismatch/,reads:2,pending:1},
    ];
    for(const row of cases)await t.test(row.name,async()=>{
      active={responses:row.responses,requests:[]};let clock=0,owners=0,validated=0;const pending=[];
      const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},fetchImpl:(url,options)=>fetch(origin+new URL(url).pathname,options)});
      const observing=observeNativeControl({control,version,previousVersions:row.previousVersions??[previous],
        assertOwnership:async()=>{if(++owners===2&&row.drift)throw Error('ownership changed');},
        validate:()=>{validated++;if(row.invalidState)throw Error('runtime mismatch');},isReady:nativeDrained,
        now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:row.timeoutMs??6,pollMs:2,onPending:x=>pending.push(x)});
      if(row.error)await assert.rejects(observing,row.error);else{assert(nativeDrained(await observing));assert.equal(validated,1);}
      assert.equal(active.requests.length,row.reads);assert.equal(pending.length,row.pending??(row.drift?1:0));
      assert.equal(owners,row.reads+(row.drift?1:0));
      assert(active.requests.every(x=>x.method==='GET'&&x.path==='/v1/admin/large-http'),'observation never replays a control mutation');
      if(row.name.startsWith('persistent'))assert.equal(clock,6);
      if(!row.invalidState&&row.error)assert.equal(validated,0);
    });
  }finally{
    server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
