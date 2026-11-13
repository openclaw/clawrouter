import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isolatedNativeTarget } from '../scripts/deploy-native-target.mjs';
import { createApi } from '../scripts/deploy-train-api.mjs';
import { createNativeControl } from '../scripts/deploy-native-cutover.mjs';
import { qualifyNativeCutover, verifyIsolatedOwners, main } from '../scripts/qualify-native-cutover.mjs';
import { smokeNativeCutover } from '../scripts/smoke-native-cutover.mjs';
import { deploymentState } from '../scripts/deploy-train-policy.mjs';
import { uploadMessage } from '../scripts/deploy-train-secrets.mjs';
import { nativeVersion } from './helpers/deploy-native-fixture.mjs';

const account = 'a'.repeat(32), worker = 'clawrouter-native-qualification-012345abcdef';
const origin = 'https://' + worker + '.fixture.workers.dev';
const target = isolatedNativeTarget({worker,origin,account});
const blue = '11111111-1111-1111-1111-111111111111', green = '22222222-2222-2222-2222-222222222222', recovery = '33333333-3333-3333-3333-333333333333';
const sha = 'c'.repeat(40), old = 'e'.repeat(64), current = 'f'.repeat(64), fingerprint = 'a'.repeat(64);
const ids = {blue,green,recovery,run:'123'};
function fixture() {
  const versions = {[blue]:nativeVersion(blue,'b'.repeat(40)),[green]:nativeVersion(green,sha,blue),[recovery]:nativeVersion(recovery,sha,blue)};
  versions[green].annotations['workers/message'] = uploadMessage({run:'123',sha,blue,native:{schema:1,runtimeSha:current}});
  versions[recovery].annotations['workers/message'] = uploadMessage({run:'123',sha,blue,native:{schema:1,runtimeSha:old},nativeSource:'b'.repeat(40)});
  for (const v of Object.values(versions)) for (const binding of v.resources.bindings) {
    if (binding.name === 'LARGE_HTTP_ORIGIN') binding.text = origin;
    for (const key of ['namespace_id','queue_name','bucket_name']) if (binding[key]) binding[key] = 'isolated-' + binding[key];
  }
  let latest = {id:'initial',versions:[{version_id:blue,percentage:100}]}, accepting = true, revision = 0;
  const events = [];
  const snapshot = version => {
    const runtimeSha = version === green ? current : old;
    return {schema:2,accepting,phase:accepting?'serving':'closed',
      slots:Array.from({length:8},()=>({generation:1,phase:accepting?'ready':'idle',fingerprint,ids:[]})),
      pool:{grants:[],issued:0,seen:{},members:Array.from({length:8},()=>accepting?{boot:blue,quarantined:false}:null)},
      control:{schema:1,revision,runtimeSha,fingerprint},
      inspection:Array.from({length:8},(_,slot)=>({slot,qualified:accepting,protocol:1,generation:1,phase:accepting?'ready':'idle',boot:blue,fingerprint,runtimeSha,config:{fingerprint,runtimeSha}}))};
  };
  const production = nativeVersion('99999999-9999-9999-9999-999999999999','b'.repeat(40));
  const api = {version:async id=>versions[id],versions:async()=>[versions[green],versions[recovery],versions[blue]],latest:async()=>structuredClone(latest),
    cloudflare:async path=>path.endsWith('/deployments')?{deployments:[{versions:[{version_id:production.id,percentage:100}]}]}:production,
    deploy:async(distribution,message,expected)=>{assert.equal(expected,latest.id);events.push(['deploy',distribution[0].version_id]);latest={id:'d'+events.length,versions:distribution,annotations:{'workers/message':message}};return structuredClone(latest);}};
  const control = {snapshot:async version=>snapshot(version),admission:async value=>{accepting=value;revision++;events.push(['admission',value]);}};
  return {api,control,target,sha,ids,versions,events,production,smoke:async version=>events.push(['smoke',version]),wait:async ms=>events.push(['wait',ms])};
}
test('production remains locked; isolated targets require paired name, origin and account',()=>{
  for (const invalid of [
    {worker:'clawrouter-edge',origin:'https://clawrouter.openclaw.ai',account},
    {worker,origin:'https://clawrouter.openclaw.ai',account},
    {worker,origin:origin+'/',account},{worker,origin:origin+'/v1',account},
    {worker,origin:origin.replace('https:','http:'),account},{worker,origin,account:'bad'},
    {worker,origin:'https://user:pass@'+new URL(origin).host,account},
  ]) assert.throws(()=>isolatedNativeTarget(invalid));
  assert.throws(()=>createApi({env:{CLAWROUTER_WORKER_NAME:worker}}),/Worker/);
  assert.throws(()=>createApi({env:{},target:{worker,origin,account,isolated:true}}),/Unverified/);
  assert.throws(()=>createNativeControl({env:{CLAWROUTER_NATIVE_ADMIN_TOKEN:'fixture',CLAWROUTER_BASE_URL:origin}}),/origin/);
  assert.throws(()=>createApi({env:{CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32)},target}),/account/);
});
test('isolated API routes reads correctly and refuses non-target mutations before transport',async()=>{
  const calls=[];
  const api=createApi({target,env:{CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:'fixture',GH_TOKEN:'fixture'},fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json({success:true,result:{deployments:[]}});}});
  await api.latest();assert.ok(calls[0].url.endsWith('/workers/scripts/'+worker+'/deployments'));
  for(const [path,method] of [[api.workerPath+'/settings','PATCH'],['/accounts/'+account+'/workers/scripts/clawrouter-edge/deployments','POST'],[api.workerPath+'/deployments','DELETE']])
    await assert.rejects(api.cloudflare(path,{method}),/only its isolated deployments/);
  await assert.rejects(api.github('/issues',{method:'POST'}),/only its isolated deployments/);
  assert.equal(calls.length,1);
});
test('isolated control preserves authentication, redirect refusal and selected-version checking',async()=>{
  const calls=[], f=fixture();
  const control=createNativeControl({target,env:{CLOUDFLARE_ACCOUNT_ID:account,CLAWROUTER_NATIVE_ADMIN_TOKEN:'fixture',CF_ACCESS_CLIENT_ID:'fixture-id',CF_ACCESS_CLIENT_SECRET:'fixture-secret'},fetchImpl:async(url,init)=>{
    calls.push({url,init});const s=await f.control.snapshot(blue);return Response.json({status:200,state:s,control:s.control,slots:s.inspection},{headers:{'x-clawrouter-version-id':blue}});
  }});
  await control.snapshot(blue);assert.equal(calls[0].url,origin+'/v1/admin/large-http');assert.equal(calls[0].init.redirect,'error');
  assert.equal(calls[0].init.headers.authorization,'Bearer fixture');assert.equal(calls[0].init.headers['CF-Access-Client-Secret'],'fixture-secret');
  await assert.rejects(control.snapshot(green),/selected-version mismatch/);
});
test('shared production actors, KV, queue, bucket or origin refuse before admission',async()=>{
  for (const name of ['ACCESS_CONTROL','LARGE_HTTP_POOL','POLICY_KV','USAGE_QUEUE','CONTENT_ARCHIVE','LARGE_HTTP_ORIGIN']) {
    const f=fixture();const source=f.production.resources.bindings.find(b=>b.name===name);
    Object.assign(f.versions[blue].resources.bindings.find(b=>b.name===name),source);
    await assert.rejects(qualifyNativeCutover({...f,mode:'cutover'}),/shares a production/);assert.deepEqual(f.events,[]);
  }
});
test('owner read failures and foreign service bindings fail closed',async()=>{
  const f=fixture();f.versions[blue].resources.bindings.push({name:'FOREIGN',type:'service',service:'clawrouter-edge'});
  await assert.rejects(verifyIsolatedOwners(f.api,target,[f.versions[blue]]),/service bindings/);
  f.api.cloudflare=async()=>{throw Error('read denied');};
  await assert.rejects(qualifyNativeCutover({...f,mode:'cutover'}),/read denied/);assert.deepEqual(f.events,[]);
});
test('real controller completes forward but never represents controller-only receipts as qualified',async()=>{
  const f=fixture();const receipt=await qualifyNativeCutover({...f,mode:'cutover',holdSeconds:2});
  assert.equal(receipt.result,'cutover-completed');assert.equal(receipt.qualified,false);
  assert.equal(deploymentState(await f.api.latest()).status,'done');
  assert.deepEqual(f.events.filter(e=>e[0]==='smoke'),[['smoke',green]]);
  assert.ok(f.events.some(e=>e[0]==='wait'&&e[1]===2000));
  const warmed=receipt.observations.find(x=>x.phase==='green-warm');assert.equal(warmed.inspection.length,8);assert.ok(warmed.inspection.every(x=>x.runtimeSha===current));
});
test('both interruption boundaries recover using a new invocation and remote journal, without old local receipt',async()=>{
  for(const mode of ['interrupt-drain','interrupt-green']){
    const f=fixture();const first=await qualifyNativeCutover({...f,mode});assert.equal(first.result,'interrupted');
    const second=await qualifyNativeCutover({...f,mode:'recover'});assert.equal(second.result,'recovered');assert.equal(second.qualified,false);
    assert.equal(deploymentState(await f.api.latest()).status,'rolled-back');
    assert.equal((await f.api.latest()).versions[0].version_id,recovery);
    assert.ok(second.observations.some(o=>o.phase==='recovered'&&o.inspection.every(x=>x.runtimeSha===old)));
  }
});
test('deliberate smoke failure exercises ordered recovery, foreign ownership cannot be overwritten',async()=>{
  const f=fixture();assert.equal((await qualifyNativeCutover({...f,mode:'fail-smoke'})).result,'failure-recovered');
  assert.deepEqual(f.events.filter(e=>e[0]==='smoke'),[['smoke',green],['smoke',recovery]]);
  const before=f.events.length;await assert.rejects(qualifyNativeCutover({...f,ids:{...ids,run:'999'},mode:'recover'}));assert.equal(f.events.length,before);
});
test('non-inference smoke never sends a credential or provider payload, and rejects version fallback',async()=>{
  const calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url,init});const path=new URL(url).pathname;
    assert.equal(new Headers(init.headers).has('authorization'),false);
    assert.equal(new Headers(init.headers).get('Cloudflare-Workers-Version-Overrides'),worker+'="'+green+'"');
    return Response.json(path==='/health'?{versionId:green}:path==='/v1/providers'?{providers:[]}:{error:{code:'unauthorized'}},{status:path==='/v1/responses'?401:200,headers:{'x-clawrouter-version-id':green}});};
  await smokeNativeCutover({target,env:{CLOUDFLARE_ACCOUNT_ID:account},version:green,fetchImpl});
  assert.deepEqual(calls.map(x=>new URL(x.url).pathname),['/health','/v1/providers','/v1/responses']);assert.equal(calls.at(-1).init.body,'{}');
  await assert.rejects(smokeNativeCutover({target,env:{CLOUDFLARE_ACCOUNT_ID:account},version:green,fetchImpl:async()=>Response.json({versionId:green})}),/not honored/);
});
test('dispatch and workflow keep exact source and distinct recovery runner without production secrets',async()=>{
  await assert.rejects(main({GITHUB_REPOSITORY:'fork/clawrouter'}),/exact reviewed main/);
  const workflow=parse(readFileSync(new URL('../.github/workflows/qualify-native-cutover.yml',import.meta.url),'utf8'));
  assert.equal(workflow.jobs.exercise.environment,'native-qualification');assert.equal(workflow.jobs.recover.needs,'exercise');
  for(const job of Object.values(workflow.jobs)){
    assert.equal(job['runs-on'],'ubuntu-latest');
    // runner is available to steps, not jobs.<id>.env (GitHub rejects the workflow).
    assert.ok(Object.values(job.env).every(value=>!String(value).includes('runner.')));
    assert.match(job.steps.find(s=>s.run === 'node scripts/qualify-native-cutover.mjs').env.QUALIFICATION_RECEIPT,/runner.temp/);
    for(const value of Object.values(job.env).filter(x=>String(x).includes('secrets.')))assert.match(value,/secrets.NATIVE_QUALIFICATION_/);
    assert.equal(job.steps.some(s=>s.run?.includes('pnpm')),false);
  }
});
