import '../worker/test/typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {completedSse,completedTailBytes} from '../runtime/large-http/completed-sse.ts';
import {responsePump} from '../runtime/large-http/response-pump.mjs';
import {observeUsage} from '../worker/proxy-response.ts';
import {HttpOperation} from '../worker/http-operation.ts';
import {EventEmitter} from 'node:events';
const encode=s=>new TextEncoder().encode(s);
const event=(status='completed',usage=true)=>'data: '+JSON.stringify({type:'response.'+status,response:{id:'resp_control',status,output:[],...(usage?{usage:{input_tokens:10,output_tokens:2,total_tokens:12}}:{})}})+'\n\n';
const response=body=>new Response(body,{headers:{'content-type':'text/event-stream'}});

test('completion qualification uses canonical delimited metadata and rejects conflicting tails',async()=>{
 for(const split of [1,17,4096]){
  const p=completedSse(response(''),'/v1/native/openai/v1/responses'),bytes=encode(event());
  for(let n=0;n<bytes.length;n+=split){assert.equal(p.qualified(),false);await p.push(bytes.subarray(n,n+split));}
  assert.equal(p.qualified(),true);await p.push(encode(': keepalive\n\ndata: [DONE]\n\n'));await p.end();assert.equal(p.qualified(),true);p.stop();
 }
 for(const terminal of [event('failed'),event('incomplete'),event('completed',false),event().trimEnd(),event().replace('"completed","output"','"in_progress","output"')]){
  const p=completedSse(response(''),'/v1/responses');await p.push(encode(terminal));await p.end();assert.equal(p.qualified(),false);p.stop();
 }
 for(const tail of ['data: {broken}\n\n','data: {}\n\n',event(),'event: error\ndata: {}\n\n','event: future\n\n','retry: 10\n\n','data: [DONE]\n\ndata: [DONE]\n\n']){
  const p=completedSse(response(''),'/v1/responses');await assert.rejects(p.push(encode(event()+tail)),/completed_tail_invalid/);p.stop();
 }
 for(const tail of ['data: {}','event: error\n','event: future','retry: 10\n',new Uint8Array([0xff])]){
  const p=completedSse(response(''),'/v1/responses');await p.push(encode(event()));await assert.rejects(async()=>{await p.push(typeof tail==='string'?encode(tail):tail);await p.end();});p.stop();
 }
 assert.equal(completedSse(response(''),'/v1/responses/compact'),null);
});

test('a trailing write error drains after terminal write success; a terminal write error cancels',async()=>{
 for(const failAt of [1,2]){
  let index=0;const abort=new AbortController(),operation=new HttpOperation(abort.signal),delivery={profile:{mark(){}},outputBytes:0};
  const source=new ReadableStream({pull(c){if(index===0)c.enqueue(encode(event()));else if(index===1)c.enqueue(encode(': tail\n\n'));else c.close();index++;}});
  const observed=observeUsage(response(source),operation,undefined,'openai.responses');
  const res=Object.assign(new EventEmitter(),{writableFinished:false,destroyed:false,writes:0,write(chunk,cb){this.writes++;if(this.writes===failAt){this.destroyed=true;cb(Error('controlled_socket_write'));}else cb();},destroy(){this.destroyed=true;},end(){throw Error('unexpected_end');}});
  const run=responsePump({response:observed.response,path:'/v1/responses',res,abort,delivery}).run();
  if(failAt===1){await assert.rejects(run);assert.equal(delivery.completionDrain.drained,false);assert.equal((await observed.result).delivery,'canceled');}
  else{await run;assert.equal(delivery.completionDrain.drained,true);assert.equal((await observed.result).delivery,'complete');assert.equal(delivery.outputBytes,encode(event()).length);}
 }
});

// Real Node HTTP disconnect plus the canonical router usage stream. The source
// cannot EOF until explicitly released; no timer stands in for the EOF proof.
async function disconnected(t,{terminal=true,tail='',stall=false}={}){
 let release;const gate=new Promise(r=>release=r),abort=new AbortController(),delivery={profile:{mark(){}},outputBytes:0};
 const operation=new HttpOperation(abort.signal);let canceled=false;
 const source=new ReadableStream({start(c){c.enqueue(encode(terminal?event():'data: {"type":"response.created"}\n\n'));},async pull(c){await gate;if(canceled)return;try{if(tail)c.enqueue(encode(tail));c.close();}catch{}},cancel(){canceled=true;}});
 const observed=observeUsage(response(source),operation,undefined,'openai.responses');let usageSettled=false;observed.result.then(()=>{usageSettled=true;},()=>{usageSettled=true;});let done;
 const result=new Promise(r=>done=r);
 const server=createServer(async(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});try{await responsePump({response:observed.response,path:'/v1/responses',res,abort,delivery}).run();done({ok:true});}catch{res.destroy();done({ok:false});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{release();abort.abort();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const client=new AbortController(),r=await fetch('http://127.0.0.1:'+server.address().port,{signal:client.signal}),reader=r.body.getReader();
 assert.ok((await reader.read()).value.length);client.abort();await reader.cancel().catch(()=>{});
 for(let n=0;n<100&&!delivery.completionDrain?.disconnected;n++)await delay(10);
 assert.equal(delivery.completionDrain.disconnected,true);
 if(terminal){assert.equal(abort.signal.aborted,false);assert.equal(delivery.completionDrain.eof,false);assert.equal(delivery.completionDrain.drained,false);assert.equal(usageSettled,false,'canonical accounting must wait for actual EOF');}
 else{for(let n=0;n<100&&!canceled;n++)await delay(10);assert.equal(canceled,true,'pre-completion disconnect must cancel upstream before EOF');}
 if(!stall)release();
 return {result:await result,delivery,usage:await observed.result,canceled,aborted:abort.signal.aborted};
}
test('post-completion HTTP close drains actual EOF before canonical accounting completes',async t=>{
 const r=await disconnected(t,{tail:': trailing comment\n\n'});assert.equal(r.result.ok,true);assert.equal(r.delivery.outputFinished,false);assert.equal(r.delivery.completionDrain.drained,true);assert.equal(r.delivery.completionDrain.eof,true);assert.equal(r.usage.delivery,'complete');assert.equal(r.usage.tokens.total,12);assert.equal(r.canceled,false);
});
test('pre-completion close cancels upstream and keeps delivery incomplete',async t=>{
 const r=await disconnected(t,{terminal:false});assert.equal(r.result.ok,false);assert.equal(r.aborted,true);assert.equal(r.delivery.completionDrain.drained,false);assert.equal(r.usage.delivery,'canceled');
});
test('malformed tail after client completion cannot qualify owner release',async t=>{
 const r=await disconnected(t,{tail:'data: {broken}\n\n'});assert.equal(r.result.ok,false);assert.equal(r.delivery.completionDrain.drained,false);
});
test('oversized trailing comment after completion is bounded',async t=>{
 const r=await disconnected(t,{tail:':'+ 'x'.repeat(completedTailBytes+1)+'\n\n'});assert.equal(r.result.ok,false);assert.equal(r.delivery.completionDrain.drained,false);
});
test('stalled EOF after completion aborts within the fixed drain deadline',async t=>{
 const start=Date.now(),r=await disconnected(t,{stall:true});assert.equal(r.result.ok,false);assert.equal(r.delivery.completionDrain.expired,true);assert.equal(r.delivery.completionDrain.drained,false);assert.ok(Date.now()-start<7000);assert.equal(r.usage.delivery,'canceled');
});
