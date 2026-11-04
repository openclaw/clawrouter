import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Same original-request I/O barrier pattern as qualified input-retirement tests.
// No resolver is stored for invocation from a later Worker request.
async function barriers(t) {
  const pending=new Map(),released=new Set(),counts=new Map();
  const server=createServer((request,response)=>{
    const key=request.url;
    if(request.method==="GET"&&!request.headers.authorization&&/^\/body\/(cancel|cancel-error|deadline|header)$/.test(key)){
      counts.set(key,(counts.get(key)??0)+1);
      response.setHeader("content-type",key.endsWith("/header")?"text/plain":"application/json; charset=utf-8");
      response.write(" ");return; // A real socket owns the pending body until cancellation.
    }
    if(request.method!=="GET"||request.headers.authorization||!/^\/(cancel|cancel-error|header)\/(abort|read|cleanup)$/.test(key)){response.writeHead(400);response.end();return;}
    counts.set(key,(counts.get(key)??0)+1);
    if(counts.get(key)!==1){response.writeHead(409);response.end();return;}
    if(released.has(key))response.end("released");else pending.set(key,response);
  });
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,
    release(mode,phase){const key=`/${mode}/${phase}`;released.add(key);pending.get(key)?.end("released");pending.delete(key);},
    count(mode,phase){return counts.get(`/${mode}/${phase}`)??0;},bodyCount(mode){return counts.get(`/body/${mode}`)??0;}};
}

const router=`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {readCopilotAccountResponse} from './worker/copilot-account-response.ts';
const check=(value,message)=>{if(!value)throw new Error(message);};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
let active;
const state=()=>active?{mode:active.mode,reads:active.reads,cancels:active.cancels,cleanup:active.cleanup,settled:active.settled,
 error:active.error,locked:active.body.locked,released:active.released,listeners:active.listeners,readRetired:active.readRetired}:{};
export default {async fetch(request,env,ctx){
 const requested=new URL(request.url);
 if(requested.pathname==='/state')return Response.json(state());
 const mode=requested.searchParams.get('case'),held=['cancel','cancel-error','header'].includes(mode);
 const url='https://copilot-account-fixture.example/'+mode;
 const response=await fetch(url,{redirect:mode==='followed'?'follow':'manual'});
 check(response.url.length>0,'real fetched URL');
 const operation=new HttpOperation(undefined,mode==='deadline'?30:undefined),ready=deferred();
 const a={mode,body:response.body,reads:0,cancels:0,cleanup:false,settled:false,released:false,listeners:0,readRetired:false,error:undefined};
 if(held)active=a;
 const add=operation.signal.addEventListener.bind(operation.signal),remove=operation.signal.removeEventListener.bind(operation.signal),listeners=new Set();
 operation.signal.addEventListener=(type,callback,options)=>{if(type==='abort'){listeners.add(callback);a.listeners=listeners.size;}return add(type,callback,options);};
 operation.signal.removeEventListener=(type,callback,options)=>{if(type==='abort'){listeners.delete(callback);a.listeners=listeners.size;}return remove(type,callback,options);};
 const gate=phase=>fetch('https://copilot-account-fixture.example/gate/'+mode+'/'+phase,{redirect:'manual'}).then(async response=>{check(response.ok,'barrier');await response.text();});
 if(['length','unsafe-length'].includes(mode)){
  const headers=new Headers(response.headers);headers.set('content-length',mode==='length'?'1':'9007199254740992');Object.defineProperty(response,'headers',{value:headers});
 }
 let previous,emptyBacking,maximumWindow=0,maximumBacking=0,native;
 const getReader=response.body.getReader.bind(response.body);
 response.body.getReader=options=>{
  native=getReader(options);
  return {
   async read(view){
    a.reads++;maximumWindow=Math.max(maximumWindow,view.byteLength);
    if(mode==='reuse'&&previous){check(view.buffer===previous.buffer,'returned backing reused');previous.fill(255);}
    if((mode==='empty-exact'||mode==='empty-over')&&a.reads<=(mode==='empty-exact'?8190:8191)){
     emptyBacking??=view.buffer;check(view.buffer===emptyBacking,'empty backing reused');return{done:false,value:view.subarray(0,0)};
    }
    if(mode==='backing')return{done:false,value:new Uint8Array(new ArrayBuffer(16385),0,1)};
    const reading=native.read(view);
    if(held&&a.reads===2){ready.resolve();const part=await reading;await gate('read');a.readRetired=true;return part;}
    const part=await reading;if(part.value){maximumBacking=Math.max(maximumBacking,part.value.buffer.byteLength);previous=part.value;}return part;
   },
   async cancel(reason){a.cancels++;await native.cancel(reason);if(held){await gate('cleanup');a.cleanup=true;}if(mode==='cancel-error')throw new Error('synthetic cleanup failure');},
   releaseLock(){
    native.releaseLock();a.released=true;
    if(mode==='unlock-error')throw new Error('synthetic unlock failure');
    if(mode==='late-abort')operation.cancel('late');
    if(mode==='post-abort')queueMicrotask(()=>operation.cancel('late'));
   },
  };
 };
 if(mode==='header'){
  const cancel=response.body.cancel.bind(response.body);
  response.body.cancel=async reason=>{a.cancels++;await cancel(reason);ready.resolve();await gate('cleanup');a.cleanup=true;};
 }
 if(held&&mode!=='header')ctx.waitUntil(gate('abort').then(()=>operation.cancel('synthetic cancellation')));
 const reading=readCopilotAccountResponse(response,{operation,expectedUrl:mode==='wrong-url'?url+'/foreign':response.url});
 const completed=reading.then(result=>{a.settled=true;return result;},error=>{a.settled=true;a.error=error.message;throw error;});
 if(held){ctx.waitUntil(completed.catch(()=>{}).finally(()=>operation.stop('complete')));await ready.promise;return Response.json(state());}
 let result;
 try{result=await completed;}catch{}
 check(a.listeners===0,'abort listeners retired');check(!response.body.locked,'lock retired');
 if(['exact','created','accepted','partial-no-range','reuse','empty-exact','json'].includes(mode)){
  check(a.error===undefined,'valid account accepted');
  check(result.endpoints.api===(mode==='reuse'?'é🦊/\\ud800':'original'),'exact unqualified projection');
  check(Object.isFrozen(result)&&Object.isFrozen(result.endpoints),'frozen projection');
  check(operation.delivery===undefined&&!operation.signal.aborted,'caller deadline ownership');
  check(maximumWindow<=16384&&maximumBacking<=16384,'bounded actual windows');
 }else check(a.error==='invalid_copilot_response_body','content-free failure');
 if(mode==='empty-exact'||mode==='empty-over')check(a.reads===8192,'ALL reads include EOF');
 if(mode==='deadline')check(operation.status==='timeout','original deadline');
 operation.stop('complete');
 return Response.json({mode,error:a.error,reads:a.reads,maximumWindow,maximumBacking,unlocked:!response.body.locked});
}};`;

const upstream=origin=>`export default {fetch(request){
 const url=new URL(request.url),mode=url.pathname.slice(1);
 if(request.method!=='GET'||request.headers.has('authorization'))throw new Error('unexpected fixture request');
 if(url.pathname.startsWith('/gate/'))return fetch(${JSON.stringify(origin)}+url.pathname.slice(5),{redirect:'manual',signal:request.signal});
 const headers={'content-type':'application/json; charset=utf-8'};
 if(mode==='redirect'||mode==='followed')return new Response('{}',{status:302,headers:{...headers,location:'https://copilot-account-fixture.example/json'}});
 if(mode==='status')return new Response('{}',{status:403,headers});
 if(mode==='range')headers['content-range']='bytes 0-1/2';
 if(mode==='header')headers['content-type']='text/plain';
 if(mode==='mime')headers['content-type']='application/json;charset=latin1';
 if(mode==='encoding')headers['content-encoding']='fixture-unsupported';
 if(['cancel','cancel-error','deadline','header'].includes(mode))return fetch(${JSON.stringify(origin)}+'/body/'+mode,{redirect:'manual',signal:request.signal});
 if(mode==='utf8')return new Response(new Uint8Array([123,34,120,34,58,34,0xed,0xa0,0x80,34,125]),{headers});
 const prefix='{"endpoints":{"api":"original"},"ignored":"',suffix='"}';
 const text=mode==='exact'||mode==='over'?prefix+'x'.repeat(16777216+(mode==='over'?1:0)-prefix.length-suffix.length)+suffix:
  mode==='reuse'?'{"endpoints":{"api":"é🦊/\\\\ud800"},"ignored":"'+'x'.repeat(40000)+'"}':
  mode==='malformed'?'{"endpoints":{"api":"original"},"tail":[':mode==='empty'?'':'{"endpoints":{"api":"original"}}';
 const bytes=new TextEncoder().encode(text);let offset=0;
 const body=new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+8191,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end;}});
 return new Response(body,{status:mode==='created'?201:mode==='accepted'?202:mode==='partial-no-range'||mode==='range'?206:200,headers});
}};`;

test("actual workerd account fetch, header, EOF, window and cancellation contracts", {timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"copilot-account-response-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const io=await barriers(t),runtime=await startWorkerdFixture(directory,router,upstream(io.origin),{preventEviction:true});t.after(()=>runtime.dispose());
  const call=async path=>{const response=await runtime.dispatchFetch('https://router.example'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
  const until=async predicate=>{let value;for(let i=0;i<100;i++){value=await call('/state');if(predicate(value))return value;await delay(10);}assert.fail(JSON.stringify(value));};
  for(const mode of ['json','created','accepted','partial-no-range','exact','over','reuse','empty-exact','empty-over','backing','wrong-url','redirect','followed','status','range','mime','encoding','length','unsafe-length','utf8','malformed','empty','unlock-error','late-abort','post-abort','deadline'])await t.test(mode,async()=>{
    const result=await call('/check?case='+mode);assert.equal(result.mode,mode);assert.equal(result.unlocked,true);
    if(mode==='deadline')assert.equal(io.bodyCount(mode),1);
  });
  for(const mode of ['cancel','cancel-error','header'])await t.test(mode,async()=>{
    let state=await call('/start?case='+mode);assert.equal(state.settled,false);
    if(mode!=='header'){
      assert.equal(state.reads,2);io.release(mode,'abort');state=await until(s=>s.cancels===1);
      assert.equal(state.locked,true);assert.equal(state.settled,false);
      io.release(mode,'cleanup');state=await until(s=>s.cleanup);
      assert.equal(state.settled,false);assert.equal(state.locked,true);assert.equal(state.readRetired,false);
      io.release(mode,'read');
    }else{assert.equal(state.reads,0);assert.equal(state.cancels,1);io.release(mode,'cleanup');}
    state=await until(s=>s.settled);assert.equal(state.error,'invalid_copilot_response_body');assert.equal(state.locked,false);assert.equal(state.listeners,0);assert.equal(state.cancels,1);assert.equal(state.cleanup,true);
    assert.equal(io.bodyCount(mode),1);
    assert.equal(io.count(mode,'cleanup'),1);assert.equal(io.count(mode,'read'),mode==='header'?0:1);assert.equal(io.count(mode,'abort'),mode==='header'?0:1);
  });
});
