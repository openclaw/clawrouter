import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {health} from '../worker/large-http/health.ts';
test('cold HTTP headers may remain pending, then a fresh read proves readiness',async t=>{
 let slow=true,requests=0,closed=0;
 const server=createServer((req,res)=>{requests++;res.on('close',()=>{closed++;});if(!slow)res.end(JSON.stringify({ready:true}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const probe=signal=>fetch('http://127.0.0.1:'+server.address().port+'/startup-health',{signal});
 const at=Date.now();assert.deepEqual(await health(probe,{pendingStartupHeaders:true}),{kind:'unavailable'});assert.ok(Date.now()-at<2000);
 await new Promise(r=>setTimeout(r,25));assert.equal(closed,1);assert.equal(requests,1);
 slow=false;const ready=await health(probe,{pendingStartupHeaders:true});assert.equal(ready.status,200);assert.equal(ready.value.ready,true);assert.equal(requests,2);
});
test('pre-header expiry remains terminal unless startup behavior is explicitly selected',async()=>{
 await assert.rejects(health(()=>new Promise(()=>{})),/health_deadline/);
});
test('startup option does not forgive malformed or stalled response bodies',async()=>{
 await assert.rejects(health(async()=>new Response('{'),{pendingStartupHeaders:true}));
 await assert.rejects(health(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}})),{pendingStartupHeaders:true}),/health_deadline|effect_deadline/);
});
test('a response arriving after header cancellation is discarded, never readiness',async()=>{
 let resolve,canceled=false;const pending=health(()=>new Promise(r=>{resolve=r;}),{pendingStartupHeaders:true});assert.deepEqual(await pending,{kind:'unavailable'});
 resolve(new Response(new ReadableStream({cancel(){canceled=true;}})));await new Promise(r=>setTimeout(r,1));assert.equal(canceled,true);
});
