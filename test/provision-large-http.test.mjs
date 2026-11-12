import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionLargeHttp} from '../scripts/provision-large-http.mjs';
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-only',CLAWROUTER_WORKER_NAME:'isolated-test'};
test('normal deployment provisions only a missing random control secret without rotating existing state',async()=>{
 const calls=[];let existing=false;
 const fetchImpl=async(url,options)=>{calls.push({url,...options});if(options.method==='PUT'){const v=JSON.parse(options.body);assert.equal(v.name,'LARGE_HTTP_TOKEN');assert.match(v.text,/^[a-f0-9]{64}$/);existing=true;return Response.json({success:true});}return Response.json({success:true,result:existing?[{name:'LARGE_HTTP_TOKEN'}]:[]});};
 assert.deepEqual(await provisionLargeHttp({env,fetchImpl}),{created:true});assert.deepEqual(await provisionLargeHttp({env,fetchImpl}),{created:false});assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.ok(calls.every(c=>c.url.endsWith('/workers/scripts/isolated-test/secrets')));
});
test('inspection failure never creates or rotates a secret',async()=>{
 let calls=0;await assert.rejects(provisionLargeHttp({env,fetchImpl:async()=>{calls++;return Response.json({success:false},{status:403});}}),/inspection_failed/);assert.equal(calls,1);
});
test('ambiguous creation is not retried',async()=>{
 let writes=0;await assert.rejects(provisionLargeHttp({env,fetchImpl:async(_url,init)=>{if(init.method==='PUT'){writes++;return Response.json({success:false},{status:500});}return Response.json({success:true,result:[]});}}),/unknown_do_not_retry/);assert.equal(writes,1);
});
