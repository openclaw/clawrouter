import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, cp, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { assertDeploymentAction } from '../scripts/deploy-authorization.mjs';
import { executeRelease } from '../scripts/deploy-release-plan.mjs';
import { qualificationIdentity, createIsolatedResources } from '../scripts/deploy-release-resources.mjs';
import { nativeControlDigest } from '../scripts/deploy-native-qualification.mjs';
import { assertNativeOwners } from '../scripts/deploy-train-runtime.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';
import { observeInterruptedTurn, assertContextAnswer } from '../scripts/native-session-continuity.mjs';
const exec=promisify(execFile),sha='a'.repeat(40),source='b'.repeat(40),old='c'.repeat(64),current='d'.repeat(64);
const blue='11111111-1111-4111-8111-111111111111',green='22222222-2222-4222-8222-222222222222',bridge='33333333-3333-4333-8333-333333333333';
export const actionEnv={GITHUB_REPOSITORY:'openclaw/clawrouter',GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'openclaw/clawrouter/.github/workflows/deploy-cloudflare.yml@refs/heads/main',CLOUDFLARE_ACCOUNT_ID:'e'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-api-credential'};
function state(){return {sha,run:'123',blue,deployedSha:source,deploymentId:'initial',mode:'native-cutover',native:{schema:1,runtimeSha:current},migration:false,unsafe:false,
  cutover:{schema:1,phase:'prepared',nativeSource:source,blueRuntimeSha:old},releaseManifest:'candidate.json',recoveryReleaseManifest:'recovery.json',releaseManifestSha256:'1'.repeat(64),recoveryReleaseManifestSha256:'2'.repeat(64)};}
function proof(s){return {schema:2,qualified:true,source:s.sha,controlSha256:nativeControlDigest(),kind:s.cutover.kind??'payload',blueRuntimeSha:s.cutover.blueRuntimeSha,greenRuntimeSha:s.native.runtimeSha,nativeSource:s.cutover.nativeSource,productionBlue:s.blue,releaseSha256:s.releaseManifestSha256,recoverySha256:s.recoveryReleaseManifestSha256,cases:Object.fromEntries(['deployment','continuity','payload','accounting','recovery','cleanup'].map(k=>[k,{outcome:'passed'}]))};}

test('one input-free canonical Action retains concurrency, recovery and independent cleanup',async()=>{
  const workflow=parse(await readFile('.github/workflows/deploy-cloudflare.yml','utf8'));
  assert.equal(workflow.name,'Deploy ClawRouter');assert.equal(workflow.on.workflow_dispatch,null);
  assert.equal(workflow.concurrency.group,'clawrouter-production-deploy');
  assert.equal(workflow.concurrency['cancel-in-progress'],false);
  assert.deepEqual(workflow.on.schedule,[{cron:'7 10 * * 1-5',timezone:'America/Edmonton'}]);
  assert(workflow.jobs['recover-and-alert']);assert(workflow.jobs['clean-qualification']);
  assert.equal(workflow.jobs['clean-qualification'].if,'always()');
  assert.equal(JSON.parse(await readFile('package.json','utf8')).scripts['cf:deploy'],'node scripts/deploy-action.mjs');
  assert.doesNotMatch(await readFile('scripts/deploy-action.mjs','utf8'),/wrangler|CLOUDFLARE_API_TOKEN/);
});
test('canonical identity rejects alternate workflows, sources and branches before credentials',async t=>{
  assert.doesNotThrow(()=>assertDeploymentAction(actionEnv));
  assert.doesNotThrow(()=>assertDeploymentAction({...actionEnv,GITHUB_EVENT_NAME:'schedule'}));
  for(const patch of [{GITHUB_WORKFLOW_REF:'other'},{GITHUB_REF:'refs/heads/topic'},{GITHUB_REPOSITORY:'fork/clawrouter'},{GITHUB_SHA:'main'},{GITHUB_EVENT_NAME:'push'}])assert.throws(()=>assertDeploymentAction({...actionEnv,...patch}));
  assert.throws(()=>assertDeploymentAction(actionEnv,source));
  const directory=await mkdtemp(join(tmpdir(),'release-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const path of ['scripts/deploy-train-select.mjs','scripts/deploy-train.mjs','scripts/deploy-release-qualification.mjs']){
    await assert.rejects(exec(process.execPath,[resolve(path)],{cwd:directory,env:{...actionEnv,PATH:process.env.PATH,GITHUB_WORKFLOW_REF:'other',CLOUDFLARE_API_TOKEN:'',GH_TOKEN:''}}),error=>{assert.match(error.stderr,/Production deployment must run through Deploy ClawRouter on main/);assert.doesNotMatch(error.stderr,/token missing|ENOENT/);return true;});
  }
});
test('frozen control checkout imports without an install; qualification runs in the installed candidate',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'release-control-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp('scripts',join(directory,'scripts'),{recursive:true});
  const entrypoint=await realpath(join(directory,'scripts/deploy-train.mjs'));
  await assert.rejects(exec(process.execPath,[entrypoint],{cwd:process.cwd(),env:{...actionEnv,PATH:process.env.PATH,GITHUB_WORKFLOW_REF:'other'}}),error=>{assert.match(error.stderr,/Production deployment must run through Deploy ClawRouter on main/);assert.doesNotMatch(error.stderr,/ERR_MODULE_NOT_FOUND/);return true;});
  const source=await readFile('scripts/deploy-train.mjs','utf8');
  assert.match(source,/resolve\('scripts\/deploy-release-qualification\.mjs'\)/);
});
test('ordinary release reuses unchanged behavior evidence; no isolated fleet or operator stage',async()=>{
  const s={...state(),mode:'rollout'};delete s.cutover;let qualified=false;
  await executeRelease({state:s,qualify:async()=>{qualified=true;},run:async value=>{value.status='done';}});
  assert.equal(qualified,false);assert.equal(s.qualification.reused,true);assert.equal(s.status,'done');
});
for(const needsBridge of [false,true])test('native path automatically sequences qualification, optional bridge and payload: '+needsBridge,async()=>{
  const s=state(),events=[];
  await executeRelease({state:s,control:{snapshot:async()=>({control:{artifactProtocol:needsBridge?0:1},inspection:Array(8).fill({artifactProtocol:1})})},
    qualify:async(value,stage)=>{events.push(['qualify',stage,value.blue,value.native.runtimeSha]);return proof(value);},
    run:async value=>{events.push(['run',value.mode,value.blue,value.native.runtimeSha]);value.green=value.mode==='native-control'?bridge:green;value.deploymentId='next';value.status='done';}});
  assert.deepEqual(events.map(x=>x.slice(0,2)),needsBridge?[['qualify','bridge'],['run','native-control'],['qualify','release'],['run','native-cutover']]:[['qualify','release'],['run','native-cutover']]);
  assert.equal(s.blue,needsBridge?bridge:blue);assert.equal(s.green,green);
  if(needsBridge){assert.equal(events[0][3],old);assert.equal(events[2][2],bridge);}
});
test('failed qualification, wrong release evidence or destructive transition cannot reach production engine',async()=>{
  for(const fail of ['setup','wrong-evidence','unsafe']){
    const s=state();if(fail==='unsafe')s.unsafe=true;
    let writes=0;
    await assert.rejects(executeRelease({state:s,control:{snapshot:async()=>({control:{artifactProtocol:1},inspection:Array(8).fill({artifactProtocol:1})})},qualify:async value=>{if(fail==='setup')throw Error('setup failed');return {...proof(value),source};},run:async()=>{writes++;}}));
    assert.equal(writes,0);
  }
});
test('only qualified bounded versioned limits can differ; owners and credentials remain invariant',()=>{
  const a=nativeVersion(blue,source),b=structuredClone(a);
  const limit=v=>v.resources.bindings.find(x=>x.name==='LARGE_HTTP_TENANT_LIMIT');limit(b).text='3';
  assert.throws(()=>assertNativeOwners(a,b));assert.doesNotThrow(()=>assertNativeOwners(a,b,{allowVersionedSettings:true}));
  limit(b).text='9';assert.throws(()=>assertNativeOwners(a,b,{allowVersionedSettings:true}));
  limit(b).text='3';b.resources.bindings.find(x=>x.name==='LARGE_HTTP_TOKEN').name='DIFFERENT_SECRET';assert.throws(()=>assertNativeOwners(a,b,{allowVersionedSettings:true}));
});
test('interrupted turn may fail or retry; only a successful distinct context answer proves saved-session recovery',async()=>{
  const started={turn:{id:'old'}},client={errors:[],notifications:[{method:'error',params:{turnId:'old',willRetry:true}},{method:'turn/completed',params:{turn:{id:'old',status:'failed'}}}]};
  const interrupted=await observeInterruptedTurn(client,started);assert.equal(interrupted.status,'failed');assert.equal(interrupted.retryNotifications,1);
  assert.throws(()=>assertContextAnswer(client,started,'expected'));
  client.notifications.push({method:'turn/completed',params:{turn:{id:'new',status:'completed'}}},{method:'item/completed',params:{turnId:'new',item:{type:'agentMessage',text:'expected'}}});
  assert.equal(assertContextAnswer(client,{turn:{id:'new'}},'expected').answerSha256,'expected');
});

function resourceFixture({loseCreate=false,foreign=false,failContainerDelete=false,containerResponse,containerDeleteReads=0,foreignConsumer=false,nonemptyDlq=false,usageBacklogReads=0,changeConsumerWhileDraining=false}={}){
  const identity=qualificationIdentity(actionEnv),calls=[],operations=[],queues=[];let kv=foreign?{id:'f'.repeat(32),title:identity.kv}:null,owner=null,bucket=null,worker=null,app=null,time=0,pendingContainerDeleteReads=null,consumer=false;
  const consumerValue=q=>({consumer_id:'fixture-consumer',type:'worker',script:foreignConsumer?'foreign-worker':identity.worker,dead_letter_queue:identity.dlq,...(q?{queue_id:q.queue_id,queue_name:q.queue_name}: {})});
  const response=value=>Response.json({success:true,result:value});
  const fetchImpl=async(url,init)=>{
    const u=new URL(url),p=u.pathname.split('/accounts/'+identity.account)[1],body=init.body&&JSON.parse(init.body);calls.push({path:p,method:init.method});
    if(p==='/workers/subdomain')return response({subdomain:'fixture'});
    if(p==='/storage/kv/namespaces'){
      if(init.method==='POST'){kv={id:'f'.repeat(32),title:body.title};if(loseCreate){loseCreate=false;throw TypeError('lost ack');}return response(kv);}
      return response(kv?[kv]:[]);
    }
    if(p.includes('/values/release-owner')){
      if(init.method==='PUT'){owner=JSON.stringify(body);return response(null);}
      return owner===null?new Response('',{status:404}):new Response(owner);
    }
    if(p==='/storage/kv/namespaces/'+'f'.repeat(32)&&init.method==='DELETE'){kv=null;return response(null);}
    if(p==='/queues'){
      if(init.method==='POST'){queues.push({queue_name:body.queue_name,queue_id:String(queues.length+1)});return response(queues.at(-1));}
      return response(queues);
    }
    const item=queues.find(q=>p==='/queues/'+q.queue_id||p.startsWith('/queues/'+q.queue_id+'/'));
    if(item){
      const path='/queues/'+item.queue_id,usage=item.queue_name===identity.usage;
      if(p===path+'/metrics'){
        const pending=usage&&usageBacklogReads-->0||!usage&&nonemptyDlq;
        if(pending&&changeConsumerWhileDraining)foreignConsumer=true;
        return response({backlog_count:pending?1:0,backlog_bytes:pending?128:0});
      }
      if(p===path+'/consumers/fixture-consumer'){
        if(!usage||!consumer)return new Response('',{status:404});
        if(init.method==='DELETE'){consumer=false;return response(null);}
        return response(consumerValue(item));
      }
      if(p===path){
        if(init.method==='DELETE'){if(consumer||usage&&worker)return new Response('',{status:400});queues.splice(queues.indexOf(item),1);return response(null);}
        return response({...item,producers:usage&&worker?[{type:'worker',script:identity.worker}]:[],consumers:usage&&consumer?[consumerValue()]:[]});
      }
    }
    if(p==='/r2/buckets'&&init.method==='POST'){bucket={name:body.name};return response(bucket);}
    if(p==='/r2/buckets/'+identity.bucket){if(init.method==='DELETE'){bucket=null;return response(null);}return bucket?response(bucket):new Response('',{status:404});}
    if(p==='/workers/scripts/'+identity.worker+'/settings')return worker?response(worker):new Response('',{status:404});
    if(p==='/workers/scripts/'+identity.worker&&init.method==='DELETE'){if(consumer)return new Response('',{status:400});worker=null;return response(null);}
    if(p==='/containers/applications'){
      if(containerResponse!==undefined)return Response.json(containerResponse);
      const items=app?[app]:[];
      if(pendingContainerDeleteReads!==null&&--pendingContainerDeleteReads===0)app=null;
      return response(items);
    }
    if(p==='/containers/applications/owned-app'&&init.method==='DELETE'){if(failContainerDelete)return new Response('',{status:403});if(containerDeleteReads===0)app=null;else pendingContainerDeleteReads=containerDeleteReads;return response({message:'Application deletion started'});}
    throw Error('Unexpected test resource path '+p);
  };
  const create=()=>createIsolatedResources({env:actionEnv,identity,fetchImpl,now:()=>time,wait:async ms=>{time+=ms;},save:async operation=>operations.push(operation)});
  return {identity,calls,operations,create,get kv(){return kv;},addWorker(){worker={bindings:[]};app={id:'owned-app',name:identity.container};consumer=true;}};
}
test('isolated resource writes reconcile lost acknowledgments without retry; fresh-runner cleanup proves ownership',async()=>{
  const f=resourceFixture({loseCreate:true}),resources=f.create();assert.equal((await resources.target()).isolated,true);
  await resources.provision();f.addWorker();assert.equal((await f.create().cleanup()).complete,true);
  assert.equal(f.calls.filter(x=>x.path==='/storage/kv/namespaces'&&x.method==='POST').length,1);
  assert.equal(f.operations.find(x=>x.operation==='create-policy'&&x.state==='observed').acknowledgementLost,true);
  assert(f.calls.every(x=>!x.path.includes('clawrouter-edge')));assert.equal(f.kv,null);
  const deleted=f.calls.filter(x=>x.method==='DELETE').map(x=>x.path);
  assert(deleted.findIndex(x=>x.includes('/consumers/'))<deleted.indexOf('/workers/scripts/'+f.identity.worker));
});
test('foreign queue consumers or pending DLQ work stop cleanup before any deletion',async()=>{
  for(const options of [{foreignConsumer:true},{nonemptyDlq:true}]){
    const f=resourceFixture(options);await f.create().provision();f.addWorker();
    assert.equal((await f.create().cleanup()).complete,false);
    assert.equal(f.calls.filter(x=>x.method==='DELETE').length,0);
    assert(f.kv);
  }
});
test('cleanup waits for asynchronous usage drain before detaching an owned consumer',async()=>{
  const f=resourceFixture({usageBacklogReads:2});await f.create().provision();f.addWorker();
  assert.equal((await f.create().cleanup()).complete,true);
  const detached=f.calls.findIndex(x=>x.method==='DELETE');
  assert.equal(f.calls.slice(0,detached).filter(x=>x.path.endsWith('/metrics')).length,4);
  assert.equal(f.operations.filter(x=>x.operation==='drain-usage'&&x.state==='waiting').length,2);
  assert.equal(f.kv,null);
});
test('queue ownership changes during drain stop cleanup before any delete',async()=>{
  const f=resourceFixture({usageBacklogReads:2,changeConsumerWhileDraining:true});await f.create().provision();f.addWorker();
  assert.equal((await f.create().cleanup()).complete,false);
  assert.equal(f.calls.filter(x=>x.method==='DELETE').length,0);assert(f.kv);
});
test('container inventory requires a successful envelope and array before any write',async()=>{
  for(const containerResponse of [[],null,{success:false,result:[]},{success:true},{success:true,result:{}}]){
    const f=resourceFixture({containerResponse});
    await assert.rejects(f.create().provision(),/envelope failed|Incomplete isolated container inventory/);
    assert(f.calls.every(x=>x.method==='GET'));
  }
});
test('enveloped asynchronous container deletion is observed without replay',async()=>{
  // The delete acknowledgement is not proof of disappearance. Return the old
  // application twice after DELETE before the readback converges.
  const delayed=resourceFixture({containerDeleteReads:2});
  await delayed.create().provision();delayed.addWorker();
  assert.equal((await delayed.create().cleanup()).complete,true);
  assert.equal(delayed.calls.filter(x=>x.path==='/containers/applications/owned-app'&&x.method==='DELETE').length,1);
});
test('colliding resources are neither adopted nor deleted; partial cleanup retains durable custody',async()=>{
  const foreign=resourceFixture({foreign:true});await assert.rejects(foreign.create().provision(),/already exists/);assert.equal((await foreign.create().cleanup()).complete,false);assert.equal(foreign.calls.filter(x=>x.method==='DELETE').length,0);
  const f=resourceFixture({failContainerDelete:true});await f.create().provision();f.addWorker();const result=await f.create().cleanup();assert.equal(result.complete,false);assert(f.kv,'owner marker must survive failed app deletion');
  assert.equal(f.calls.filter(x=>x.path==='/containers/applications/owned-app'&&x.method==='DELETE').length,1,'uncertain/failed delete is observed, never blindly retried');
  assert.throws(()=>createIsolatedResources({env:actionEnv,identity:{...f.identity,worker:'clawrouter-edge'}}),/Unowned/);
});
