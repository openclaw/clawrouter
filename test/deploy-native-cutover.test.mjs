import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { runNativeCutover, recoverNativeCutover, createNativeControl, nativeReadinessSummary, nativeWarm } from '../scripts/deploy-native-cutover.mjs';
import { deploymentMessage, deploymentState } from '../scripts/deploy-train-policy.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';
import { createApi } from '../scripts/deploy-train-api.mjs';
import { runTrain } from '../scripts/deploy-train.mjs';
import { recoverRemote } from '../scripts/deploy-train-recover.mjs';
import { assertNativeQualification, nativeControlDigest, nativeControlFiles } from '../scripts/deploy-native-qualification.mjs';
import { uploadMessage, assertSecretLineage } from '../scripts/deploy-train-secrets.mjs';
import { assertCutoverReceipt, nativeSource } from '../scripts/deploy-train-runtime.mjs';

const blue = '11111111-1111-1111-1111-111111111111', green = '22222222-2222-2222-2222-222222222222';
const recovery = '33333333-3333-3333-3333-333333333333';
const oldRuntime = 'e'.repeat(64), runtime = 'f'.repeat(64), fingerprint = 'a'.repeat(64);
function snapshot(accepting = true, ready = true) {
  return { schema: 2, accepting, phase: accepting ? 'serving' : ready ? 'draining' : 'closed',
    slots: Array.from({length:8}, () => ({generation:1, phase:ready?'ready':'idle',fingerprint,ids:[]})),
    pool: {grants:[],members:Array.from({length:8},()=>ready?{boot:blue,quarantined:false}:null),issued:0,seen:{}} };
}
function attested(s,version=blue,revision=0) {
  const runtimeSha=version===green?runtime:oldRuntime;
  return {...s,control:{schema:1,artifactProtocol:1,revision,runtimeSha,fingerprint:s.slots[0].fingerprint},inspection:s.slots.map((m,i)=>({slot:i,qualified:m.phase==='ready',protocol:1,artifactProtocol:1,phase:m.phase,generation:m.generation,boot:s.pool.members[i]?.boot??'',fingerprint:m.fingerprint,runtimeSha,config:{runtimeSha,fingerprint:m.fingerprint}}))};
}
function fixture() {
  const state = {run:'123',sha:'c'.repeat(40),blue,green,status:'rolling',unsafe:false,exposed:false,deploymentId:'initial',
    native:{schema:1,runtimeSha:runtime},cutover:{schema:1,blueRuntimeSha:oldRuntime,nativeSource:'b'.repeat(40),recovery,phase:'prepared'}};
  const versions = {[blue]:nativeVersion(blue,'b'.repeat(40)),[green]:nativeVersion(green,state.sha,blue),[recovery]:nativeVersion(recovery,state.sha,blue)};
  versions[green].annotations['workers/message']=uploadMessage(state);
  versions[recovery].annotations['workers/message']=uploadMessage({...state,native:{schema:1,runtimeSha:oldRuntime},nativeSource:state.cutover.nativeSource});
  let latest={id:'initial',versions:[{version_id:blue,percentage:100}]}, pool=snapshot(), clock=0;
  const events=[];
  const api={version:async id=>versions[id],versions:async()=>[versions[green],versions[recovery],versions[blue]],latest:async()=>structuredClone(latest),
    deploy:async(distribution,message,expected)=>{
      assert.equal(expected,latest.id); const journal=deploymentState({versions:distribution,annotations:{'workers/message':message}});
      events.push(['deploy',distribution[0].version_id,journal.cutover.phase]);
      assert.equal(distribution.length,1); assert.equal(distribution[0].percentage,100);
      if(distribution[0].version_id!==latest.versions[0].version_id){assert.equal(pool.accepting,false);assert.equal(pool.slots.every(s=>s.phase==='idle'),true);}
      latest={id:'d'+events.length,versions:distribution,annotations:{'workers/message':message}};return structuredClone(latest);
    }};
  const control={snapshot:async(version)=>attested(structuredClone(pool),version),admission:async accepting=>{events.push(['admission',accepting]);pool=snapshot(accepting,accepting);}};
  const smoke=async id=>events.push(['smoke',id]);
  return {state,api,control,events,smoke,now:()=>clock,wait:async ms=>{clock+=ms;},get latest(){return latest;},set pool(v){pool=v;}};
}
test('cross-digest replacement closes admission, proves absence, selects only green and warms before smoke',async()=>{
  const f=fixture();await runNativeCutover(f);
  assert.equal(f.state.status,'done');
  assert.deepEqual(f.events.map(e=>e[0]),['deploy','admission','deploy','admission','smoke','deploy']);
  assert.equal(f.events[0][1],blue);assert.equal(f.events[2][1],green);
  assert.equal(deploymentState(f.latest).status,'done');
});
test('control adoption requires equal bytes, preserves native source and survives remote recovery',async()=>{
  const f=fixture();f.state.cutover.kind='control';f.state.native.runtimeSha=oldRuntime;
  const greenVersion=await f.api.version(green);greenVersion.annotations['workers/message']=uploadMessage(f.state);
  assert.equal(nativeSource(greenVersion),f.state.cutover.nativeSource);
  const snapshot=f.control.snapshot;
  f.control.snapshot=async version=>snapshot(version===green?blue:version);
  await runTrain({...f,mode:'native-control',upload:async()=>green,uploadRecovery:async()=>recovery});
  assert.equal(deploymentState(f.latest).cutover.kind,'control');assert.equal(f.state.status,'done');
  f.state.status='rolling';await f.api.deploy([{version_id:green,percentage:100}],deploymentMessage(f.state),f.latest.id);
  assert.equal(await recoverRemote(f.api,'123',{control:f.control,now:f.now,wait:f.wait}),'recovery: compatible native payload restored with fenced control at 100%');
  assert.equal(deploymentState(f.latest).cutover.kind,'control');assert.equal(f.latest.versions[0].version_id,recovery);
  delete f.state.cutover.kind;assert.throws(()=>assertCutoverReceipt(f.state),/receipt/);
  f.state.cutover.kind='control';f.state.native.runtimeSha=runtime;assert.throws(()=>assertCutoverReceipt(f.state),/receipt/);
});
test('pool or one old slot capability cannot authorize reopen; pending evidence is sanitized',async()=>{
  const legacy=attested(snapshot());delete legacy.control.artifactProtocol;for(const o of legacy.inspection)delete o.artifactProtocol;
  assert.equal(nativeWarm(legacy,oldRuntime),true,'pre-adoption clients still attest actual old runtime');
  assert.equal(nativeWarm(legacy,oldRuntime,{requireArtifactControl:true}),false);
  for(const missing of ['pool','slot']){
    const f=fixture(),snapshot=f.control.snapshot;
    f.control.snapshot=async version=>{const s=await snapshot(version);if(version===green){
      if(missing==='pool')delete s.control.artifactProtocol;else delete s.inspection[3].artifactProtocol;
    }return s;};
    await assert.rejects(runNativeCutover({...f,timeoutMs:10}),/control.*deadline/);
    assert.deepEqual(f.events.filter(e=>e[0]==='admission'),[['admission',false]]);
  }
  const s=attested(snapshot());s.secret='must not leak';s.slots[0].ids=['sensitive-id'];s.inspection[0].token='must not leak';
  const summary=nativeReadinessSummary(s);
  assert.equal(summary.slots[0].owners,1);assert.doesNotMatch(JSON.stringify(summary),/must not leak|sensitive-id/);
});
test('delayed actual slot adoption is observed before the single reopen mutation',async()=>{
  const f=fixture(),snapshot=f.control.snapshot;let pending=0;
  f.control.snapshot=async version=>{const s=await snapshot(version);if(version===green&&pending++<2){
    assert.equal(s.accepting,false);delete s.inspection[3].artifactProtocol;
  }return s;};
  await runNativeCutover({...f,timeoutMs:10_000});
  assert.equal(f.state.status,'done');assert.ok(pending>=3);
  assert.deepEqual(f.events.filter(e=>e[0]==='admission'),[['admission',false],['admission',true]]);
});
test('fresh-runner recovery drains first and restores the compatible recovery version with warm readback',async()=>{
  const f=fixture();await runNativeCutover(f);
  f.state.status='rolling'; f.state.cutover.phase='warming';
  await f.api.deploy([{version_id:green,percentage:100}],deploymentMessage(f.state),f.latest.id);
  const remote=deploymentState(f.latest);const start=f.events.length;
  await recoverNativeCutover({...f,state:remote});
  assert.deepEqual(f.events.slice(start).map(e=>e[0]),['deploy','admission','deploy','admission','deploy']);
  assert.equal(f.latest.versions[0].version_id,recovery);assert.equal(deploymentState(f.latest).status,'rolled-back');
});
test('pending owners prevent the incompatible switch and a bounded timeout never clears custody',async()=>{
  const f=fixture();const pending=snapshot(false,true);pending.pool.grants=[{id:'uncertain'}];
  f.control.admission=async()=>{f.pool=pending;};
  await assert.rejects(runNativeCutover({...f,timeoutMs:10}),/drain.*deadline/);
  assert.equal(f.events.filter(e=>e[0]==='deploy'&&e[1]===green).length,0);
  assert.equal((await f.control.snapshot()).pool.grants[0].id,'uncertain');
});
test('blocked or merely stopped-without-absence slots cannot authorize a switch',async()=>{
  for(const phase of ['blocked','stopping','stopped']){
    const f=fixture(); f.control.admission=async()=>{const s=snapshot(false,false);s.slots[0].phase=phase;f.pool=s;};
    await assert.rejects(runNativeCutover({...f,timeoutMs:10}));
    assert.equal(f.events.some(e=>e[0]==='deploy'&&e[1]===green),false);
  }
});
test('foreign deployment stops recovery before admission or a deployment mutation',async()=>{
  const f=fixture();await assert.rejects(recoverNativeCutover(f),/owned/);assert.deepEqual(f.events,[]);
});
test('owner mismatch and rollback-unsafe candidates fail before admission closes',async()=>{
  for(const mutate of [f=>{f.state.unsafe=true;},async f=>{(await f.api.version(green)).resources.bindings.find(b=>b.name==='POLICY_KV').namespace_id='foreign';}]){
    const f=fixture();await mutate(f);await assert.rejects(runNativeCutover(f));assert.deepEqual(f.events,[]);
  }
});
test('ambiguous admission responses are reconciled by readback, never POST replay',async()=>{
 for(const response of ['lost','http500']){
  let posts=0,accepting=true,revision=0;
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},fetchImpl:async(url,init)=>{
    const headers={'x-clawrouter-version-id':blue};
    if(init.method==='POST'){
      posts++;const body=JSON.parse(init.body);assert.equal(body.expectedRevision,0);assert.ok(body.operationId);accepting=body.accepting;revision++;
      if(response==='lost')throw Error('response lost');
      return new Response(null,{status:500,headers});
    }
    const s=attested(snapshot(accepting,accepting),blue,revision);return Response.json({status:200,state:s,control:s.control,slots:s.inspection},{headers});
  }});
  await control.admission(false,blue);assert.equal(posts,1);
 }
});
test('control requires credentials, refuses redirects and never exposes response bodies',async()=>{
  assert.throws(()=>createNativeControl({env:{}}),/credential/);
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},fetchImpl:async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(new URL(url).origin,'https://clawrouter.openclaw.ai');
    return new Response('sensitive body',{status:403});
  }});
  await assert.rejects(control.snapshot(),e=>/403/.test(e.message)&&!e.message.includes('sensitive'));
});

test('normal rollout cannot consume a cutover receipt, and smoke failure takes the ordered recovery path',async()=>{
  const f=fixture();let uploads=0;
  await assert.rejects(runTrain({...f,upload:async()=>{uploads++;return green;}}),/percentage rollout/);
  assert.equal(uploads,0);assert.deepEqual(f.events,[]);
  await assert.rejects(runTrain({...f,mode:'native-cutover',upload:async()=>green,uploadRecovery:async()=>recovery,smoke:async()=>{throw Error('synthetic breach');}}),/synthetic breach/);
  assert.equal(f.latest.versions[0].version_id,recovery);assert.equal(deploymentState(f.latest).status,'rolled-back');
});
test('fresh recovery resumes warming compatible recovery without another drain or restart',async()=>{
  const f=fixture(); f.state.cutover.phase='recover-warming';f.state.exposed=true;
  f.pool=snapshot(false,false);
  await f.api.deploy([{version_id:recovery,percentage:100}],deploymentMessage(f.state),f.latest.id);
  f.pool=snapshot();
  const start=f.events.length;
  assert.equal(await recoverRemote(f.api,'123',{control:f.control,now:f.now,wait:f.wait}),'recovery: compatible native payload restored with fenced control at 100%');
  assert.equal(f.events.slice(start).some(e=>e[0]==='admission'&&e[1]===false),false);
  assert.equal(deploymentState(f.latest).status,'rolled-back');
});
test('cross-digest journals refuse splits, unbound receipts and mismatched terminal phases',()=>{
  const f=fixture();f.state.cutover.phase='warming';
  const deployment={annotations:{'workers/message':deploymentMessage(f.state)},versions:[{version_id:green,percentage:50},{version_id:blue,percentage:50}]};
  assert.throws(()=>deploymentState(deployment),/full-traffic/);
  deployment.versions=[{version_id:green,percentage:100}];
  f.state.status='rolled-back';deployment.annotations['workers/message']=deploymentMessage(f.state);
  assert.throws(()=>deploymentState(deployment),/full-traffic/);
  f.state.status='rolling';f.state.cutover.blueRuntimeSha=runtime;deployment.annotations['workers/message']=deploymentMessage(f.state);
  assert.throws(()=>deploymentState(deployment),/cutover receipt/);
});
test('automatic evidence is exact-release bound; missing cases and source registries cannot authorize deployment',()=>{
  const f=fixture();f.state.releaseManifestSha256='1'.repeat(64);f.state.recoveryReleaseManifestSha256='2'.repeat(64);
  const receipt={schema:2,qualified:true,source:f.state.sha,controlSha256:nativeControlDigest(),kind:'payload',blueRuntimeSha:oldRuntime,greenRuntimeSha:runtime,
    nativeSource:f.state.cutover.nativeSource,productionBlue:f.state.blue,releaseSha256:f.state.releaseManifestSha256,recoverySha256:f.state.recoveryReleaseManifestSha256,
    cases:Object.fromEntries(['deployment','continuity','payload','accounting','recovery','cleanup'].map(name=>[name,{outcome:'passed'}]))};
  assert.deepEqual(assertNativeQualification(f.state,receipt),receipt);
  for(const patch of [{source:'0'.repeat(40)},{controlSha256:'0'.repeat(64)},{blueRuntimeSha:runtime},{greenRuntimeSha:oldRuntime},{kind:'control'},
    {productionBlue:green},{nativeSource:'0'.repeat(40)},{releaseSha256:'0'.repeat(64)},{recoverySha256:'0'.repeat(64)},{qualified:false}])
    assert.throws(()=>assertNativeQualification(f.state,{...receipt,...patch}),/lacks automatic/);
  for(const name of Object.keys(receipt.cases))assert.throws(()=>assertNativeQualification(f.state,{...receipt,cases:{...receipt.cases,[name]:{outcome:'running'}}}),/lacks automatic/);
  for(const value of [undefined,{schema:1,qualified:[]},{schema:2,qualified:true}])assert.throws(()=>assertNativeQualification(f.state,value),/lacks automatic/);
});
test('drained cutover requests immediate DO adoption and reconciles its readback without POST replay',async()=>{
  for(const acknowledgeStrategy of [true,false]) {
    let posts=0,latest={id:'d0',versions:[{version_id:blue,percentage:100}]};
    const api=createApi({env:{CLOUDFLARE_API_TOKEN:'synthetic',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)},wait:async()=>{},fetchImpl:async(url,init)=>{
      if(init.method==='POST'){
        posts++;const body=JSON.parse(init.body);assert.deepEqual(body.code_update_strategy,{mode:'immediate'});
        latest={id:'d1',...body};if(!acknowledgeStrategy)delete latest.code_update_strategy;
        throw Error('lost response');
      }
      return Response.json({success:true,result:{deployments:[latest]}});
    }});
    const operation=api.deploy([{version_id:green,percentage:100}],'cutover','d0',{immediate:true});
    assert.equal((await operation).id,'d1');
    assert.equal(posts,1);
  }
});
test('actual HTTP reconciles write-only strategy and lost acknowledgement, but refuses foreign journals or allocations',async t=>{
  for(const scenario of ['acknowledged','lost-ack','foreign-journal','wrong-allocation'])await t.test(scenario,async t=>{
    let posts=0,latest={id:'d0',versions:[{version_id:blue,percentage:100}]};
    const server=createServer(async(req,res)=>{
      if(req.method==='POST'){
        posts++;let raw='';for await(const chunk of req)raw+=chunk;
        const body=JSON.parse(raw);assert.deepEqual(body.code_update_strategy,{mode:'immediate'});
        latest={id:'d1',versions:body.versions,annotations:body.annotations};
        if(scenario==='foreign-journal')latest.annotations={'workers/message':'foreign'};
        if(scenario==='wrong-allocation')latest.versions=[{version_id:blue,percentage:100}];
        if(scenario==='lost-ack'){req.socket.destroy();return;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,result:latest}));return;
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,result:{deployments:[latest]}}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
    const origin='http://127.0.0.1:'+server.address().port;
    const api=createApi({env:{CLOUDFLARE_API_TOKEN:'synthetic',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)},wait:async()=>{},fetchImpl:(url,init)=>fetch(origin+new URL(url).pathname,init)});
    const operation=api.deploy([{version_id:green,percentage:100}],'cutover','d0',{immediate:true});
    if(['acknowledged','lost-ack'].includes(scenario))assert.equal((await operation).id,'d1');
    else await assert.rejects(operation,/readback differs/);
    assert.equal(posts,1);assert.equal(Object.hasOwn(latest,'code_update_strategy'),false);
    t.diagnostic(JSON.stringify({provider:'controlled loopback HTTP',scenario,posts,strategyReturned:false}));
  });
});
test('cutover recovery journal fits the deployment annotation byte limit',()=>{
  const f=fixture();f.state.run='99999999999999999999';f.state.cutover.phase='recover-draining-recovery';
  assert.ok(Buffer.byteLength(deploymentMessage(f.state))<=1000);
  f.state.cutover.kind='control';f.state.native.runtimeSha=oldRuntime;
  assert.ok(Buffer.byteLength(deploymentMessage(f.state))<=1000);
});

test('pool readiness cannot stand in for actual slot runtime adoption',async()=>{
  const f=fixture();const original=f.control.snapshot;
  f.control.snapshot=async version=>{const s=await original(version);if(version===green){s.inspection[0].runtimeSha=oldRuntime;s.inspection[0].qualified=false;}return s;};
  await assert.rejects(runNativeCutover({...f,timeoutMs:10}),/warm.*deadline/);
  assert.equal(f.events.some(e=>e[0]==='smoke'),false);
});
test('legacy admission may only close and cannot reopen an unfenced recovery target',async()=>{
  let posts=0,accepting=true;
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},fetchImpl:async(url,init)=>{
    if(init.method==='POST'){posts++;accepting=JSON.parse(init.body).accepting;return Response.json({status:200,accepting});}
    return Response.json({status:200,state:snapshot(accepting,accepting)});
  }});
  await control.admission(false,undefined,{allowLegacy:true});assert.equal(posts,1);
  await assert.rejects(control.admission(true,undefined,{allowLegacy:true}),/protocol/);assert.equal(posts,1);
});


test('logging drift after drain blocks native candidate exposure without undoing the ownership journal',async()=>{
 const f=fixture();f.state.observabilityReconciliation='retained-diagnostics-v1';let reads=0;
 f.api.workerPath='/worker';f.api.cloudflare=async()=>{reads++;return {observability:reads===1?{enabled:true,logs:{enabled:true,invocation_logs:false}}:{enabled:false}};};
 await assert.rejects(runNativeCutover(f),/Live observability/);
 assert.equal(reads,2);assert.equal(f.latest.versions[0].version_id,blue);
 assert.equal(deploymentState(f.latest).cutover.phase,'draining');
 assert.equal((await f.control.snapshot(blue)).accepting,false);
 assert.equal(f.events.some(e=>e[0]==='deploy'&&e[1]===green),false);
});


test('a train after compatible recovery reaches upload without trusting unrelated or incomplete secret history',async()=>{
 const f=fixture();await runNativeCutover(f);f.state.status='rolling';
 await f.api.deploy([{version_id:green,percentage:100}],deploymentMessage(f.state),f.latest.id);
 await recoverNativeCutover(f);
 const history=await f.api.versions();assert.equal(assertSecretLineage(history,recovery),green);
 const next={run:'124',sha:'d'.repeat(40),blue:recovery,deploymentId:f.latest.id,native:{schema:1,runtimeSha:oldRuntime},unsafe:false,migration:false};
 let uploads=0;
 await assert.rejects(runTrain({api:f.api,state:next,upload:async()=>{uploads++;throw Error('synthetic upload boundary');},smoke:async()=>{},now:f.now,wait:f.wait}),/synthetic upload boundary/);
 assert.equal(uploads,1);assert.equal(f.latest.versions[0].version_id,recovery);
 const foreign={id:'44444444-4444-4444-4444-444444444444',annotations:{'workers/message':'secret bulk'}};
 for(const bad of [[history[0],foreign,...history.slice(1)],[...history.slice(0,2),foreign,history[2]],history.slice(0,2)])
  assert.throws(()=>assertSecretLineage(bad,recovery),/Unproven/);
 const cyclic=structuredClone(history);cyclic[1].annotations['workers/message']=uploadMessage({...f.state,blue:green,nativeSource:f.state.cutover.nativeSource});
 assert.throws(()=>assertSecretLineage(cyclic,recovery),/Unproven/);
 assert.throws(()=>assertSecretLineage([history[0],...history],recovery),/Duplicate/);
});


test('native cutover follows the actual ordinary terminal distribution and removes compatible zero-percent history first',async()=>{
 const f=fixture(),prior='99999999-9999-9999-9999-999999999999';
 const getVersion=f.api.version,getVersions=f.api.versions,deploy=f.api.deploy;
 const priorVersion=nativeVersion(prior,'9'.repeat(40));
 f.api.version=async id=>id===prior?priorVersion:getVersion(id);
 let uploaded=false,sequence=0;
 f.api.versions=async()=>uploaded?[await getVersion(blue),priorVersion]:[priorVersion];
 f.latest.versions=[{version_id:prior,percentage:100}];
 f.api.deploy=async(versions,message,expected)=>{
  assert.equal(expected,f.latest.id);Object.assign(f.latest,{id:'ordinary'+(++sequence),versions,annotations:{'workers/message':message}});return structuredClone(f.latest);
 };
 const ordinary={run:'123',sha:'b'.repeat(40),blue:prior,deploymentId:f.latest.id,unsafe:false,migration:false,native:{schema:1,runtimeSha:oldRuntime}};
 await runTrain({state:ordinary,api:f.api,upload:async()=>{uploaded=true;return blue;},smoke:async()=>{},now:f.now,wait:f.wait,analytics:async()=>({disabled:'fixture'})});
 assert.deepEqual(f.latest.versions,[{version_id:blue,percentage:100},{version_id:prior,percentage:0}]);
 f.api.deploy=deploy;f.api.versions=async()=>[...await getVersions(),priorVersion];f.state.deploymentId=f.latest.id;
 await runNativeCutover(f);
 assert.equal(f.events[0][0],'deploy');assert.equal(f.events[0][1],blue);assert.equal(f.events[1][0],'admission');assert.equal(f.state.status,'done');
});

test('unproven zero-percent runtime or owner changes refuse normalization before admission writes',async()=>{
 const prior='99999999-9999-9999-9999-999999999999';
 for(const kind of ['runtime','owners','percentage','duplicate']){
  const f=fixture(),original=f.api.version,old=nativeVersion(prior,'9'.repeat(40));
  f.latest.versions.push({version_id:kind==='duplicate'?blue:prior,percentage:kind==='percentage'?-1:0});
  if(kind==='runtime')old.annotations['workers/message']=uploadMessage({run:'1',blue,sha:'9'.repeat(40),native:{schema:1,runtimeSha:runtime}});
  if(kind==='owners')old.resources.bindings.find(b=>b.name==='POLICY_KV').namespace_id='foreign';
  f.api.version=async id=>id===prior?old:original(id);
  await assert.rejects(runNativeCutover(f));assert.deepEqual(f.events,[]);
 }
});

// Real HTTP control responses model the API/edge visibility gap: the owned
// deployment is committed before one GET reports its selected Worker version.
test('owned cutovers converge across previous-version GETs and snapshot resets without replaying admission',async t=>{
 for(const scenario of ['known-lag','snapshot-reset','foreign-version','missing-version','http-error','persistent-lag','persistent-reset','owner-drift','reset-owner-drift','reset-deployment-drift'])await t.test(scenario,async t=>{
  const f=fixture(),wire=f.control,deploy=f.api.deploy,foreign='99999999-9999-9999-9999-999999999999';
  let revision=0,posts=0,pending,lagged=0,reads=0;
  f.api.deploy=async(...args)=>{
   const previous=f.latest.versions[0].version_id,result=await deploy(...args),next=result.versions[0].version_id;
   if(next!==previous)pending={previous,next};return result;
  };
  const server=createServer(async(req,res)=>{
   const selected=f.latest.versions[0].version_id;
   if(req.method==='POST'){
    posts++;let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    assert.equal(body.expectedRevision,revision);await wire.admission(body.accepting);revision++;
    res.setHeader('x-clawrouter-version-id',selected);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({status:200,accepting:body.accepting,revision}));return;
   }
   reads++;let actual=selected,status=200;
   if(pending){
    lagged++;actual=scenario==='foreign-version'?foreign:pending.previous;
    if(scenario==='missing-version')actual=null;
    if(scenario==='http-error')status=503;
    if(['snapshot-reset','persistent-reset','reset-owner-drift','reset-deployment-drift'].includes(scenario)){actual=selected;status=500;}
    if(['owner-drift','reset-owner-drift'].includes(scenario))f.latest.annotations={'workers/message':'foreign'};
    if(scenario==='reset-deployment-drift')f.latest.id='new-deployment';
    if(!['persistent-lag','persistent-reset'].includes(scenario))pending=null;
   }
   const s=await wire.snapshot(selected);s.control.revision=revision;
   if(actual)res.setHeader('x-clawrouter-version-id',actual);
   res.statusCode=status;res.setHeader('content-type','application/json');
   res.end(JSON.stringify({status:200,state:s,control:s.control,slots:s.inspection}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port;
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},wait:f.wait,fetchImpl:(url,init)=>{
   assert.equal(new Headers(init.headers).has('Cloudflare-Workers-Version-Overrides'),false,'normal edge selection remains observable');
   return fetch(origin+new URL(url).pathname,init);
  }});
  if(['known-lag','snapshot-reset'].includes(scenario)){
   // The fresh recovery controller gets only the owned remote journal.
   await assert.rejects(runNativeCutover({...f,control,smoke:async()=>{throw Error('planned runner stop');}}),/planned runner stop/);
   await recoverNativeCutover({...f,control,state:deploymentState(f.latest)});
   assert.equal(deploymentState(f.latest).status,'rolled-back');assert.equal(f.latest.versions[0].version_id,recovery);
   assert.equal(lagged,2);assert.equal(posts,4,'one POST for each fenced admission change');
  }else{
   const ownerDrift=['owner-drift','reset-owner-drift'].includes(scenario),deploymentDrift=scenario==='reset-deployment-drift';
   const failure=['persistent-lag','persistent-reset'].includes(scenario)?/control.*deadline/:ownerDrift?/not owned/:deploymentDrift?/deployment changed/:scenario==='http-error'?/HTTP 503/:/selected-version mismatch/;
   await assert.rejects(runNativeCutover({...f,control,timeoutMs:ownerDrift||deploymentDrift?5000:10}),failure);
   assert.equal(posts,1,'candidate admission never opens after rejected observation');
   assert.equal((await wire.snapshot(green)).accepting,false);
   assert.equal(deploymentState(f.latest)?.cutover.phase,ownerDrift?undefined:'warming');
   assert.equal(lagged,1,'never start another snapshot after the deadline or ownership loss');
  }
  t.diagnostic(JSON.stringify({provider:'controlled loopback HTTP',scenario,posts,reads,lagged,mutationReplay:false}));
 });
});

test('admission observes selected-version lag after convergence and after a single POST',async t=>{
 for(const scenario of ['pre-lag','pre-reset','post-lag','post-reset','lost-ack-lag','recovery-pre-lag','recovery-post-lag','recovery-lost-ack-lag','foreign-version','owner-drift','persistent-lag'])await t.test(scenario,async t=>{
  const f=fixture(),wire=f.control,foreign='99999999-9999-9999-9999-999999999999';
  const target=scenario.startsWith('recovery-')?recovery:green,fault=scenario.replace(/^recovery-/,'');
  const prior=target===green?blue:green;
  let revision=0,posts=0,readsOnTarget=0,lagged=0,postFault=false;
  const server=createServer(async(req,res)=>{
   const selected=f.latest.versions[0].version_id;
   if(req.method==='POST'){
    posts++;let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    assert.equal(body.expectedRevision,revision);await wire.admission(body.accepting);revision++;
    postFault=selected===target&&body.accepting&&['post-lag','post-reset','lost-ack-lag'].includes(fault);
    if(postFault&&fault==='lost-ack-lag'){req.socket.destroy();return;}
    res.setHeader('x-clawrouter-version-id',selected);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({status:200,accepting:body.accepting,revision}));return;
   }
   if(selected===target)readsOnTarget++;
   // First green GET is valid. A later GET may still hit the preceding Worker.
   const pre=selected===target&&posts===(target===green?1:3)&&readsOnTarget>=2&&(!lagged||fault==='persistent-lag')&&!['post-lag','post-reset','lost-ack-lag'].includes(fault);
   let actual=selected,status=200;
   if(pre||postFault){
    lagged++;actual=fault==='foreign-version'?foreign:prior;
    if(['pre-reset','post-reset'].includes(fault)){actual=target;status=500;}
    if(fault==='owner-drift')f.latest.annotations={'workers/message':'foreign'};
    postFault=false;
   }
   const s=await wire.snapshot(selected);s.control.revision=revision;
   res.setHeader('x-clawrouter-version-id',actual);res.statusCode=status;res.setHeader('content-type','application/json');
   res.end(JSON.stringify({status:200,state:s,control:s.control,slots:s.inspection}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port;
  const control=createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'synthetic'},wait:f.wait,fetchImpl:(url,init)=>fetch(origin+new URL(url).pathname,init)});
  if(['pre-lag','pre-reset','post-lag','post-reset','lost-ack-lag'].includes(fault)){
   await assert.rejects(runNativeCutover({...f,control,smoke:async()=>{throw Error('planned runner stop');}}),/planned runner stop/);
   await recoverNativeCutover({...f,control,state:deploymentState(f.latest)});
   assert.equal(deploymentState(f.latest).status,'rolled-back');assert.equal(posts,4,'one POST per admission transition');
   assert.equal(lagged,1);
  }else{
   const failure=scenario==='persistent-lag'?/deadline/:scenario==='owner-drift'?/not owned/:/selected-version mismatch/;
   await assert.rejects(runNativeCutover({...f,control,timeoutMs:scenario==='owner-drift'?5000:10}),failure);
   assert.equal(posts,1,'refused pre-read cannot open candidate admission');
   assert.equal((await wire.snapshot(green)).accepting,false);
  }
  t.diagnostic(JSON.stringify({provider:'controlled loopback HTTP',scenario,posts,lagged,mutationReplay:false}));
 });
});
