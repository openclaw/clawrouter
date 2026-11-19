// Unattended isolated release proof. The production mutation happens only after
// the caller validates the complete release-bound result, including cleanup.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { assertDeploymentAction, assertActivationAllowed } from './deploy-authorization.mjs';
import { qualificationIdentity, createIsolatedResources, observeResource, saveReceipt } from './deploy-release-resources.mjs';
import { createApi } from './deploy-train-api.mjs';
import { createNativeControl, observeNativeControl, nativeWarm } from './deploy-native-cutover.mjs';
import { nativeReceipt } from './deploy-train-runtime.mjs';
import { stableVersion } from './deploy-train-policy.mjs';
import { uploadMessage } from './deploy-train-secrets.mjs';
import { nativeControlDigest } from './deploy-native-qualification.mjs';
import { verifyLargeHttpRelease } from './prepare-large-http-release.mjs';
import { prepareNativeRehearsal } from './prepare-native-rehearsal.mjs';
import { until } from './native-rehearsal-client.mjs';
import { qualifyNativeCutover, verifyIsolatedOwners } from './qualify-native-cutover.mjs';
import { command } from './deploy-command.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');

// Project a rendered production configuration, replacing EVERY persistent owner
// and public/admin origin. Never copy provider/Access credentials into the canary.
export async function isolatedReleaseConfig({ configPath, path, identity, target, kvId, adminSha }) {
  const {getStaticTOMLValue,parseTOML} = createRequire(resolve('package.json'))('toml-eslint-parser');
  let text = await readFile(configPath,'utf8');
  const config = getStaticTOMLValue(parseTOML(text));
  if (config.name !== 'clawrouter-edge' || config.account_id !== identity.account || config.routes?.length || config.services?.length ||
      config.kv_namespaces?.length !== 1 || config.kv_namespaces[0].binding !== 'POLICY_KV' || config.r2_buckets?.length !== 1 ||
      config.r2_buckets[0].binding !== 'CONTENT_ARCHIVE' || config.queues?.producers?.length !== 1 || config.queues.producers[0].binding !== 'USAGE_QUEUE' ||
      config.containers?.length !== 1 || config.durable_objects?.bindings?.some(x => x.script_name)) throw new Error('Unsupported isolated owner projection; implement and test this deployment transition');
  const vars = Object.fromEntries(Object.entries(config.vars ?? {}).filter(([name]) => name.startsWith('LARGE_HTTP_')));
  Object.assign(vars,{LARGE_HTTP_ORIGIN:target.origin,LARGE_HTTP_TESTING:'1',CLAWROUTER_PUBLIC_ORIGIN:target.origin,CLAWROUTER_ADMIN_TOKEN_SHA256:adminSha,CLAWROUTER_CONTENT_RETENTION_DEFAULT:'false'});
  text = text.replace(/^name\s*=\s*"clawrouter-edge"\s*$/m,'name = '+JSON.stringify(identity.worker))
    .replace(/^name\s*=\s*"clawrouter-edge-large-http"\s*$/m,'name = '+JSON.stringify(identity.container))
    .replace(/^workers_dev\s*=.*$/m,'workers_dev = true').replace(/^preview_urls\s*=.*$/m,'preview_urls = false')
    .replace(/^main\s*=.*$/m,'main = '+JSON.stringify(resolve(dirname(configPath),config.main)))
    .replace(/^directory\s*=.*$/m,'directory = '+JSON.stringify(resolve(dirname(configPath),config.assets.directory)))
    .replace(/^queue\s*=.*$/gm,'queue = '+JSON.stringify(identity.usage)).replace(/^dead_letter_queue\s*=.*$/gm,'dead_letter_queue = '+JSON.stringify(identity.dlq))
    .replace(/^bucket_name\s*=.*$/gm,'bucket_name = '+JSON.stringify(identity.bucket))
    .replace(/^(?:id|preview_id)\s*=.*$/gm, line => line.split('=')[0].trim()+' = '+JSON.stringify(kvId))
    .replace(/^\[vars\][\s\S]*?(?=^\[|$(?![\s\S]))/m,'');
  if (!/^workers_dev\s*=/m.test(text)) text='workers_dev = true\n'+text;
  if (!/^preview_urls\s*=/m.test(text)) text='preview_urls = false\n'+text;
  text+='\n[vars]\n'+Object.entries(vars).map(([k,v])=>k+' = '+JSON.stringify(v)).join('\n')+'\n';
  await writeFile(path,text,{flag:'wx',mode:0o600});
  return path;
}
async function upload({api,config,state,env,execute,record}) {
  const before = new Set((await api.versions()).map(x => x.id)), message = uploadMessage(state);
  await record({operation:'upload',state:'pending',runtimeSha:state.native.runtimeSha});
  try { await execute(['exec','wrangler','versions','upload','--config',config,'--tag',state.sha,'--message',message],{env,timeout:5*60_000}); }
  catch { /* Reconcile, never repeat an uncertain upload. */ }
  return observeResource(async () => {
    const history = await api.versions(), rows = history.filter(x => !before.has(x.id) && x.annotations?.['workers/tag'] === state.sha && x.annotations?.['workers/message'] === message);
    if (!rows.length) return false;
    if (rows.length !== 1 || history[0].id !== rows[0].id) throw new Error('Isolated upload ownership changed');
    let version; try { version = await api.version(rows[0].id); } catch (error) { if (error.status === 404) return false; throw error; }
    if (version.annotations?.['workers/message'] !== message || nativeReceipt(version).runtimeSha !== state.native.runtimeSha) throw new Error('Isolated upload attestation differs');
    return version;
  });
}
export async function qualifyRelease({ state, stage = 'release', env = process.env, execute = command, resources: suppliedResources, prepare = prepareNativeRehearsal, client, exercise = qualifyNativeCutover }) {
  const directory = resolve(env.TRAIN_EVIDENCE_DIRECTORY || 'release-evidence'), root = join(directory,'private',stage), publicPath = join(directory,'public','qualification-'+stage+'.json');
  await mkdir(root,{recursive:true,mode:0o700});
  const identity = qualificationIdentity(env,stage), operations = [];
  const receipt = {schema:2,source:state.sha,controlSha256:nativeControlDigest(),kind:state.cutover.kind??'payload',
    blueRuntimeSha:state.cutover.blueRuntimeSha,greenRuntimeSha:state.native.runtimeSha,nativeSource:state.cutover.nativeSource,productionBlue:state.blue,
    releaseSha256:state.releaseManifestSha256,recoverySha256:state.recoveryReleaseManifestSha256,worker:identity.worker,qualified:false,startedAt:Date.now(),cases:{},
    planned:{syntheticRequests:9,maximumProviderAttempts:8,maximumNativeStarts:40,maximumFixtureRequests:64,realProviderInference:0,automaticRetries:0},operations};
  let writes=Promise.resolve();
  const save = () => {const snapshot=structuredClone(receipt);writes=writes.then(()=>saveReceipt(publicPath,snapshot));return writes;};
  const record = async value => {operations.push({...value,at:Date.now()});await save();};
  const resources = suppliedResources ?? createIsolatedResources({env,identity,save:record});
  let failure, target, isolatedEnv, preparation, clientDirectory, controller, api, overlap;
  const clients=new AbortController(), children=new Set();
  client??=((cmd,path,directory,args,clientEnv)=>{
    const child=execute(['exec','node','scripts/native-rehearsal-client.mjs',cmd,path,directory,...args],{env:clientEnv,timeout:20*60_000,signal:clients.signal,quiet:true}).then(output=>JSON.parse(output));
    children.add(child);child.then(()=>children.delete(child),()=>children.delete(child));return child;
  });
  const outcome = async (name, action) => {
    receipt.cases[name]={outcome:'running',startedAt:Date.now()};await save();
    try { const result=await action();receipt.cases[name]={...receipt.cases[name],outcome:'passed',finishedAt:Date.now(),...result};await save();return result; }
    catch (error) {receipt.cases[name]={...receipt.cases[name],outcome:'failed',finishedAt:Date.now()};await save();throw error;}
  };
  try {
    await outcome('setup',async () => {
      target = await resources.target(); const owners=await resources.provision();
      const admin=randomBytes(32).toString('hex');
      isolatedEnv={...env,CLAWROUTER_WORKER_NAME:target.worker,CLAWROUTER_BASE_URL:target.origin,CLAWROUTER_NATIVE_ADMIN_TOKEN:admin,CF_ACCESS_CLIENT_ID:'',CF_ACCESS_CLIENT_SECRET:''};
      const rendered = await isolatedReleaseConfig({configPath:'.wrangler.generated.toml',path:join(root,'source.toml'),identity,target,kvId:owners.kvId,adminSha:hash(admin)});
      preparation=await prepare({configPath:rendered,directory:join(root,'package'),nativeSource:state.cutover.nativeSource,blueRuntimeSha:state.cutover.blueRuntimeSha,controlSource:state.deployedSha,baselineSettings:state.baselineSettings});
      if (stage==='bridge' || state.cutover.kind==='control') preparation={...preparation,greenRuntimeSha:preparation.blueRuntimeSha,green:preparation.old};
      assert.equal(preparation.greenRuntimeSha,state.native.runtimeSha);
      const path=join(root,'preparation.json');await writeFile(path,JSON.stringify(preparation),{flag:'wx',mode:0o600});
      api=createApi({env:isolatedEnv,target});controller=createNativeControl({env:isolatedEnv,target});
      await record({operation:'bootstrap',state:'pending'});
      try {await execute(['exec','wrangler','deploy','--config',preparation.bootstrap,'--tag',state.sha],{env:isolatedEnv,timeout:5*60_000});}catch{/* Read-only reconciliation follows. */}
      await observeResource(async () => {
        let latest;try{latest=await api.latest();}catch(error){if(error.status===404)return false;throw error;}
        if(!latest)return false;
        const version=await api.version(stableVersion(latest)),bindings=version.resources?.bindings??[];
        return bindings.find(b=>b.name==='CLAWROUTER_ADMIN_TOKEN_SHA256')?.text===hash(admin)&&bindings.find(b=>b.name==='LARGE_HTTP_ENABLED')?.text==='0'&&bindings.find(b=>b.name==='LARGE_HTTP_INGRESS_ENABLED')?.text==='0';
      });
      await resources.installSecret(randomBytes(32).toString('hex'));
      const disabled=await observeResource(async()=>{
        const d=await api.latest(),v=await api.version(stableVersion(d));return v.resources.bindings.some(b=>b.name==='LARGE_HTTP_TOKEN'&&b.type==='secret_text')&&{deployment:d,version:v};
      });
      const versions={},run=String(env.GITHUB_RUN_ID),base={run,sha:state.sha,blue:disabled.version.id,nativeSource:state.cutover.nativeSource,native:{schema:1,runtimeSha:state.cutover.blueRuntimeSha}};
      versions.blue=await upload({api,config:preparation.blue,state:base,env:isolatedEnv,execute,record});
      for(const name of ['green','recovery']){
        const config=name==='green'?(await verifyLargeHttpRelease(preparation.green)).stages.green.path:preparation.recovery;
        const s={...base,blue:versions.blue.id,native:{schema:1,runtimeSha:name==='green'?state.native.runtimeSha:state.cutover.blueRuntimeSha}};
        if(name==='green'&&state.cutover.kind!=='control')delete s.nativeSource;
        versions[name]=await upload({api,config,state:s,env:isolatedEnv,execute,record});
      }
      await verifyIsolatedOwners(api,target,Object.values(versions));
      receipt.ids={run,blue:versions.blue.id,green:versions.green.id,recovery:versions.recovery.id};
      clientDirectory=join(root,'client');
      const clientEnv={PATH:env.PATH,NATIVE_REHEARSAL_ACCOUNT_ID:identity.account,NATIVE_REHEARSAL_ADMIN_TOKEN:admin,CLAWROUTER_CODEX_BINARY:env.CLAWROUTER_CODEX_BINARY};
      const runClientCommand=(cmd,args=[])=>client(cmd,path,clientDirectory,args,clientEnv);
      receipt.origin=target.origin;
      await runClientCommand('setup');
      const deployment=await api.deploy([{version_id:versions.blue.id,percentage:100}],'clawrouter-qualification-start:'+run,disabled.deployment.id,{immediate:true});
      await observeNativeControl({control:controller,version:versions.blue.id,previousVersions:[disabled.version.id],assertOwnership:async()=>assert.equal((await api.latest()).id,deployment.id),isReady:s=>nativeWarm(s,state.cutover.blueRuntimeSha)});
      await runClientCommand('seed',[versions.blue.id]);
      receipt.client={initialized:true};
      // No Cloudflare/account credentials enter the saved Codex subprocess.
      preparation={...preparation,runClientCommand};
      return {oldControlSource:state.deployedSha,syntheticOnly:true};
    });
    const ids=receipt.ids;
    const overlapOutcome=outcome('continuity',async()=>{
      await preparation.runClientCommand('overlap',['forward',ids.blue,ids.green]);
      const evidence=JSON.parse(await readFile(join(clientDirectory,'evidence.json'),'utf8'));
      const step=evidence.steps.find(x=>x.kind==='overlap'&&x.direction==='forward');
      assert.ok(step?.resumedAppServer&&step.followup?.answerSha256);
      return {threadId:step.threadId,interruptedStatus:step.status,retryNotifications:step.retryNotifications,recoveryMs:step.followup.finishedAt-step.closed.at,manualIntervention:'none'};
    });
    // Handle rejection immediately while the rendezvous/engine is still running.
    overlap=overlapOutcome.then(value=>({value}),error=>({error}));
    await until(async()=>{const x=await preparation.runClientCommand('inspect');return x.snapshot.cases.some(c=>c.mode==='hold'&&c.outcome==='active');});
    const controllerReceipt=await exercise({api,control:controller,target,sha:state.sha,ids,mode:'fail-smoke',kind:state.cutover.kind,save:value=>{receipt.controller=value;},smoke:async version=>{
      if(version===ids.green){
        receipt.cases.deployment={outcome:'passed',version,at:Date.now()};await save();
        const result=await overlap;failure??=result.error;
        try{await outcome('payload',async()=>{
          try{await preparation.runClientCommand('workloads',[version]);}
          catch(error){receipt.cases.accounting={outcome:'failed'};throw error;}
          receipt.cases.accounting={outcome:'passed',deterministic:true};
          return {cases:['success','rejection','64MiB','64MiB+1','delivery-unknown'],providerReplays:0};
        });}catch(error){failure??=error;}
      }
    }});
    assert.equal(controllerReceipt.result,'failure-recovered');
    await outcome('recovery',async()=>{
      await preparation.runClientCommand('followup',['recovery',ids.recovery]);
      return {selected:stableVersion(await api.latest()),contextDependentFollowup:true};
    });
    const evidence=JSON.parse(await readFile(join(clientDirectory,'evidence.json'),'utf8'));
    receipt.functionalEvidence=evidence;
    const final=await preparation.runClientCommand('inspect');
    assert.equal(final.snapshot.replays,0);
    assert.equal(final.snapshot.requests,final.snapshot.cases.length);
    assert.ok(final.snapshot.requests<=receipt.planned.maximumProviderAttempts,'synthetic provider attempt ceiling');
    assert.ok(final.snapshot.starts.length<=receipt.planned.maximumNativeStarts,'synthetic native start ceiling');
    assert.equal(final.snapshot.accounting.events.length,final.snapshot.cases.length);
    const expected=final.snapshot.cases.reduce((sum,x)=>sum+(x.mode==='reject'?0:7),0);
    assert.equal(final.snapshot.accounting.policySpentMicros,expected);
    assert.equal(final.snapshot.accounting.providerSpentMicros,expected);
    receipt.actual={providerAttempts:final.snapshot.requests,nativeStarts:final.snapshot.starts.length,spentMicros:expected,replays:0};
  } catch(error) {failure=error;}
  finally {
    clients.abort();await Promise.allSettled([...children]);
    // Preserve content-free evidence even after a client failure. Never upload
    // private state, credentials, config, Codex home, transcripts or raw logs.
    if(clientDirectory)try{receipt.functionalEvidence=JSON.parse(await readFile(join(clientDirectory,'evidence.json'),'utf8'));}catch{}
    try{await outcome('cleanup',async()=>{
      const result=await resources.cleanup();if(!result.complete)throw new Error('Isolated resource cleanup incomplete');return result;
    });}catch(error){failure??=error;}
    await rm(root,{recursive:true,force:true});
    receipt.finishedAt=Date.now();receipt.qualified=!failure&&['deployment','continuity','payload','accounting','recovery','cleanup'].every(k=>receipt.cases[k]?.outcome==='passed');await save();
  }
  if(failure)throw failure;
  return receipt;
}
export async function main(env=process.env){
  assertDeploymentAction(env);assertActivationAllowed(env);
  const state=JSON.parse(await readFile(env.QUALIFICATION_PLAN_PATH,'utf8'));
  assert.equal(state.sha,env.GITHUB_SHA);
  await qualifyRelease({state,stage:env.QUALIFICATION_STAGE,env});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
