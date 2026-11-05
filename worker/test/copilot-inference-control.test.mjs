import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { CopilotInferenceControl, qualifiedCopilotControlHeaders, copilotControlHeaders, copilotControlReply } = await import('../copilot-inference-control.ts');
const scope={key:'oauth/policy/copilot',generation:2,lineage:'original-lineage',actor:'original-actor'},id='a'.repeat(32);
const tick=()=>Promise.resolve();

test('exclusive owner slot closes registration before joining BOTH participants',async()=>{
 const control=new CopilotInferenceControl();control.register(scope);const slot=control.claim(id,scope.key,true);slot.reserved(true);control.join(id,scope.key);
 assert.throws(()=>control.claim('b'.repeat(32),scope.key,true));assert.throws(()=>control.register(scope));
 let closed=false;const closing=control.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
 slot.ownerDone();await tick();assert.equal(closed,false);assert.throws(()=>control.claim('b'.repeat(32),scope.key,true));
 slot.frontDone();await closing;assert.equal(closed,true);slot.frontDone();slot.ownerDone();control.register(scope);await control.close();
});
test('local slot has no fictitious remote participant and cannot close another registration',async()=>{
 const control=new CopilotInferenceControl();await control.close();control.register(scope);const slot=control.claimLocal();
 let retired=false;slot.retired.then(()=>{retired=true;});await tick();assert.equal(retired,false);slot.ownerDone();await slot.retired;await control.close();
});
test('grant, actor, generation and lineage are exact; IDs cannot join another owner',async()=>{
 const a=new CopilotInferenceControl(),b=new CopilotInferenceControl();a.register(scope);b.register({...scope,key:'oauth/policy/foreign'});
 assert.throws(()=>a.claim(id,'oauth/policy/foreign',true));assert.throws(()=>a.claim('bad',scope.key,true));
 const slot=a.claim(id,scope.key,true);slot.reserved(true);assert.throws(()=>a.join('b'.repeat(32),scope.key));assert.throws(()=>b.join(id,scope.key));
 for(const patch of [{key:'foreign'},{generation:3},{lineage:'foreign'},{actor:'foreign'}])assert.throws(()=>slot.assert({...scope,...patch}));
 a.join(id,scope.key);assert.throws(()=>a.join(id,scope.key));slot.assert(scope);slot.ownerDone();slot.frontDone();await a.close();await b.close();
});
test('late execute cannot reuse a refused or retired reservation',async()=>{
 const control=new CopilotInferenceControl();control.register(scope);const slot=control.claim(id,scope.key,true);slot.reserved(false);assert.throws(()=>control.join(id,scope.key));slot.frontDone();await control.close();
});
test('record and storage representations are exclusive and join cleanup rejection',async()=>{
 const control=new CopilotInferenceControl();control.register(scope);const slot=control.claimLocal(),held=Promise.withResolvers();
 const record=slot.record(()=>slot.save(()=>held.promise));let done=false;const closing=control.close().then(()=>{done=true;});
 slot.ownerDone();await assert.rejects(slot.record(async()=>{}));await assert.rejects(slot.save(async()=>{}));await tick();assert.equal(done,false);
 held.reject(Error('synthetic persistence failure'));await assert.rejects(record);await closing;assert.equal(done,true);
});
test('reply EOF joins only control retirement, never the inference allocation waiting on it',async()=>{
 const control=new CopilotInferenceControl();control.register(scope);const slot=control.claim(id,scope.key,true);slot.reserved(true);control.join(id,scope.key);slot.ownerDone();
 const response=copilotControlReply({status:'cancelled'},200,async()=>control.retireRemote(id,scope.key));
 let closed=false;const closing=control.close().then(()=>{closed=true;});const reader=response.body.getReader();
 assert.equal((await reader.read()).done,false);assert.equal(closed,false);assert.equal((await reader.read()).done,true);reader.releaseLock();await closing;assert.equal(closed,true);
});
test('reply cancellation retains its FIRST cleanup promise',async()=>{
 const held=Promise.withResolvers();let calls=0;const response=copilotControlReply({status:'cancelled'},200,()=>{calls++;return held.promise;});
 let done=false;const cancelled=response.body.cancel().then(()=>{done=true;});await tick();assert.equal(calls,1);assert.equal(done,false);held.resolve();await cancelled;assert.equal(done,true);assert.equal(calls,1);
});
test('headers are bounded BEFORE copying; only required headers and server IDs forward',()=>{
 const source=new Headers({origin:'https://router.example','content-type':'application/json','authorization':'private-unforwarded','x-clawrouter-copilot-control-id':'caller-id','x-ignored':'ignored'});
 const copy=qualifiedCopilotControlHeaders(source,{[copilotControlHeaders.id]:id});assert.equal(copy.get('origin'),'https://router.example');assert.equal(copy.get('authorization'),null);assert.equal(copy.get('x-ignored'),null);assert.equal(copy.get(copilotControlHeaders.id),id);
 assert.throws(()=>qualifiedCopilotControlHeaders(new Headers(Array.from({length:33},(_,i)=>['x-'+i,'v']))));
 assert.throws(()=>qualifiedCopilotControlHeaders(new Headers({'x-unforwarded':'x'.repeat(16385)})));
 assert.throws(()=>qualifiedCopilotControlHeaders(new Headers({'x-a':'x'.repeat(16384),'x-b':'x'.repeat(16384)})));
 assert.throws(()=>qualifiedCopilotControlHeaders(source,{'authorization':'forged'}));
});

test('retirement during reservation authorization joins that original continuation',async()=>{
 const control=new CopilotInferenceControl();control.register(scope);const slot=control.claim(id,scope.key,true);
 let closed=false;const closing=control.close().then(()=>{closed=true;});control.retireRemote(id,scope.key);
 await tick();assert.equal(closed,false);assert.throws(()=>control.join(id,scope.key));
 slot.reserved(true);await closing;assert.equal(closed,true);assert.throws(()=>control.join(id,scope.key));
});
