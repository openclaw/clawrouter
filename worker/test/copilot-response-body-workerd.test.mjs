import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {HttpOperation} from './worker/http-operation.ts';
import {readCopilotResponseText} from './worker/copilot-response-body.ts';
const check=(value,message)=>{if(!value)throw new Error(message);};
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
export default {async fetch(request){
 const mode=new URL(request.url).searchParams.get('case');
 const profile=mode.startsWith('device')?'device':'catalog';
 const cap=profile==='device'?8192:2097152;
 const operation=new HttpOperation();
 const url='https://copilot-fixture.example/'+mode+'?cap='+cap;
 const response=await fetch(url,{redirect:mode==='followed'?'follow':'manual'});
 check(response.url.length>0,'actual Response URL');
 if(['length','unsafe-length','fractional-length'].includes(mode)){
  const headers=new Headers(response.headers);headers.set('content-length',mode==='length'?'-1':mode==='unsafe-length'?'9007199254740992':'2.5');
  Object.defineProperty(response,'headers',{value:headers});
 }
 let expectedUrl=mode==='wrong-url'?url+'/foreign':response.url;
 let reads=0,maximumBacking=0,maximumWindow=0,settled=false,released=false;
 const original=response.body.getReader.bind(response.body);
 const pending=gate(),cancelStarted=gate(),cleanup=gate();
 // Observe the real fetched byte reader. Fault cases are explicitly separate.
 response.body.getReader=options=>{
  const native=original(options);
  return {
   read:async view=>{
    reads++;maximumWindow=Math.max(maximumWindow,view.byteLength);
    if(mode==='empty-bound'&&reads<=8191)return{done:false,value:view.subarray(0,0)};
    if(mode==='backing')return{done:false,value:new Uint8Array(new ArrayBuffer(16385),0,1)};
    const actual=native.read(view);if(mode==='cancel'&&reads===2)pending.resolve();
    const part=await actual;maximumBacking=Math.max(maximumBacking,part.value?.buffer.byteLength??0);return part;
   },
   cancel:async reason=>{const actual=native.cancel(reason);cancelStarted.resolve();await actual;if(mode==='cancel')await cleanup.promise;},
   releaseLock:()=>{released=true;native.releaseLock();},
  };
 };
 let result,error;
 try{
  const reading=readCopilotResponseText(response,{operation,expectedUrl,profile});
  const observed=reading.then(text=>{settled=true;return text;},failure=>{settled=true;throw failure;});
  if(mode==='cancel'){
   await pending.promise;operation.cancel('synthetic-private');await cancelStarted.promise;
   await Promise.resolve();check(!settled&&!released&&response.body.locked,'cleanup retains body ownership');cleanup.resolve();
  }
  result=await observed;
 }catch(failure){error=failure.message;}
 finally{operation.stop('complete');}
 check(!response.body.locked,'reader lock retired');
 if(['exact','device-exact','fragmented','raw','device-created'].includes(mode)){
  check(error===undefined,'valid response accepted');
  if(mode==='fragmented')check(result==='"'+'a'.repeat(16382)+'é🦊'+'"','complete fragmented UTF-8');
  else check(result.length===(mode==='device-created'?2:mode==='raw'?4:cap),'exact complete bytes');
  check(reads>0&&maximumWindow<=16384&&maximumBacking<=16384,'bounded actual read windows');
 }else check(error==='invalid_copilot_response_body','content-free terminal rejection');
 if(mode==='empty-bound')check(reads===8192,'EOF counts toward all-read bound');
 if(mode==='cancel')check(released&&settled,'cancellation completed before publication');
 return Response.json({mode,reads,maximumWindow,maximumBacking,bytes:result?.length,error,unlocked:!response.body.locked});
}};`;

const upstream = `export default {async fetch(request){
 const url=new URL(request.url),mode=url.pathname.slice(1),cap=Number(url.searchParams.get('cap'));
 const headers={'content-type':'application/json; charset=utf-8'};
 if(mode==='redirect'||mode==='followed')return new Response('{}',{status:302,headers:{...headers,location:'https://copilot-fixture.example/raw'}});
 if(mode==='status')return new Response('{}',{status:403,headers});
 if(mode==='catalog-created'||mode==='device-created')return new Response('{}',{status:201,headers});
 if(mode==='mime')headers['content-type']='application/json;charset=latin1';
 if(mode==='encoding')headers['content-encoding']='fixture-unsupported';
 if(mode==='range')headers['content-range']='bytes 0-1/2';
 if(mode==='cancel')return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([32]));}}),{headers});
 if(mode==='utf8')return new Response(new Uint8Array([0xc3,0x28]),{headers});
 const text=mode==='fragmented'?'"'+'a'.repeat(16382)+'é🦊'+'"':mode==='raw'?'xxxx':
  mode==='exact'||mode==='device-exact'?'x'.repeat(cap):mode==='over'||mode==='device-over'?'x'.repeat(cap+1):'{}';
 // A real service fetch wraps these upstream chunks in workerd's native body.
 let offset=0;const bytes=new TextEncoder().encode(text);
 return new Response(new ReadableStream({pull(controller){
  if(offset===bytes.length){controller.close();return;}
  const end=Math.min(offset+8191,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;
 }}),{headers});
}};`;

test("Copilot reader consumes actual workerd fetch bodies with bounded transport ownership", { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "copilot-response-"));
  let runtime;
  try {
    runtime = await startWorkerdFixture(temporary, router, upstream);
    for (const mode of ["exact", "device-exact", "fragmented", "raw", "device-created", "over", "device-over", "wrong-url",
      "redirect", "followed", "status", "catalog-created", "mime", "encoding", "range", "utf8", "length", "unsafe-length",
      "fractional-length", "empty-bound", "backing", "cancel"]) await t.test(mode, async () => {
      const response = await runtime.dispatchFetch(`https://router.example/check?case=${mode}`);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json(); assert.equal(result.mode, mode); assert.equal(result.unlocked, true);
    });
  } finally { await runtime?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
