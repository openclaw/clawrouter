// Exact qualification CLI with real packaging and saved official Codex sessions.
// Cloudflare, placement and accounting are CONTROLLED loopback services here;
// this proves coordinator integration, not hosted runtime/Container behavior.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareNativeUpload } from './deploy-train-artifacts.mjs';
import { qualificationIdentity } from './deploy-release-resources.mjs';
import { nativeControlDigest } from './deploy-native-qualification.mjs';
import { nativeReceipt } from './deploy-train-runtime.mjs';
import { nativeVersion } from '../test/helpers/deploy-native-fixture.mjs';
import { uploadMessage } from './deploy-train-secrets.mjs';
import { inspectSyntheticInput } from '../worker/native-rehearsal/input.ts';
import { nativeProviderSnapshotPlugin } from './large-http-provider-snapshot.mjs';
import { archiveDeploymentSource } from './archive-deployment-source.mjs';

const out=resolve(process.argv[2]), binary=resolve(process.env.CLAWROUTER_CODEX_BINARY??'');
assert(process.argv[2]&&process.env.CLAWROUTER_CODEX_BINARY,'Usage: CLAWROUTER_CODEX_BINARY=<official binary> node scripts/proof-deploy-release.mjs <new outside directory>');
assert.equal(execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),'codex-cli 0.164.0');
await mkdir(out,{mode:0o700});
const hash=x=>createHash('sha256').update(x).digest('hex'),sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const parse=text=>{const {getStaticTOMLValue,parseTOML}=createRequire(resolve('package.json'))('toml-eslint-parser');return getStaticTOMLValue(parseTOML(text));};
const env={PATH:process.env.PATH,GITHUB_REPOSITORY:'openclaw/clawrouter',GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'openclaw/clawrouter/.github/workflows/deploy-cloudflare.yml@refs/heads/main',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'loopback-only',CLAWROUTER_POLICY_KV_ID:'b'.repeat(32),CLAWROUTER_OMIT_ROUTES:'1',TRAIN_EVIDENCE_DIRECTORY:join(out,'evidence')};
const identity=qualificationIdentity(env),origin='https://'+identity.worker+'.fixture.workers.dev';
async function child(args,childEnv=env){
  return new Promise((ok,no)=>{
    const p=spawn(process.execPath,args,{env:childEnv,stdio:['ignore','pipe','pipe']}),chunks=[];
    p.stdout.on('data',x=>chunks.push(x));p.stderr.on('data',x=>chunks.push(x));
    const timer=setTimeout(()=>p.kill('SIGKILL'),180_000);
    p.on('error',no);p.on('close',code=>{clearTimeout(timer);const output=Buffer.concat(chunks).toString();code===0?ok(output):no(new Error('Proof subprocess failed: '+output));});
  });
}
await child(['scripts/render-wrangler-config.mjs']);
await child(['scripts/build-default-worker.mjs']);
const rendered=parse(await readFile('.wrangler.generated.toml','utf8'));
const baseline='741e18c16200c57c009ac402f58053a77294f5b9',oldSource=resolve('.wrangler/proof-release-old-'+Date.now());
await mkdir(oldSource,{mode:0o700});
let oldRuntime;
try{
  archiveDeploymentSource(baseline,oldSource,['worker','runtime','shared','package.json','packages/provider-plugin-contract']);
  const {build}=createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
  const result=await build({absWorkingDir:oldSource,entryPoints:['runtime/large-http/main.ts'],bundle:true,write:false,minify:true,keepNames:true,format:'esm',platform:'node',target:'node24',define:{__CLAWROUTER_LARGE_RUNTIME__:'true'},plugins:[nativeProviderSnapshotPlugin()],logLevel:'silent'});
  oldRuntime=hash(result.outputFiles[0].contents);
}finally{await rm(oldSource,{recursive:true,force:true});}
const blueId=randomUUID(),production=nativeVersion(blueId,baseline);
production.annotations['workers/message']=uploadMessage({run:'1',blue:randomUUID(),sha:baseline,native:{schema:1,runtimeSha:oldRuntime}});
production.resources.bindings=production.resources.bindings.filter(b=>b.type!=='plain_text').map(b=>b.name==='POLICY_KV'?{...b,namespace_id:env.CLAWROUTER_POLICY_KV_ID}:b);
production.resources.bindings.push(...Object.entries(rendered.vars).map(([name,text])=>({type:'plain_text',name,text})));
const state={sha,run:env.GITHUB_RUN_ID,blue:blueId,deployedSha:baseline,deploymentId:'production-blue',nativeControlChanged:true};
await prepareNativeUpload({state,blue:production,directory:join(out,'release'),mode:'auto'});
assert.equal(state.mode,'native-cutover');
const plan=join(out,'plan.json');await writeFile(plan,JSON.stringify(state));
let kv,owner,bucket,worker,app,versions=[],deployment,priorDeployment,staleDeployment=0,previousVersion,staleControl=0,accepting=true,revision=0,seedHash,credentialHash,queueConsumer=false;
const queues=[],requests=[],deployments=[],accounting={events:[],policySpentMicros:0,providerSpentMicros:0},cases=[],callbacks=[],starts=[],seen={},grants=[];
let lossQueue=true,lossDeploy=true,lossAdmission=true,peakConnections=0,connections=0;
const boot=randomUUID(),fingerprint='d'.repeat(64);
const selected=()=>deployment?.versions.find(v=>v.percentage===100)?.version_id;
const runtime=()=>nativeReceipt(versions.find(v=>v.id===selected())).runtimeSha;
function snapshot(){
  const active=cases.filter(x=>x.outcome==='active'),drained=!accepting&&!active.length;
  const slots=Array.from({length:8},(_,slot)=>({generation:1,phase:drained?'idle':'ready',fingerprint,ids:active.filter(x=>x.slot===slot).map(x=>x.id)}));
  const uncertain=slot=>grants.some(g=>g.slot===slot&&seen[g.id]==='quarantined');
  const pool=drained?{grants:[],members:Array(8).fill(null),issued:0,seen:{}}:{grants:[...grants],members:slots.map((_,i)=>({boot,quarantined:uncertain(i)})),issued:Object.keys(seen).length,seen:{...seen}};
  if(!drained)for(let i=0;i<8;i++)if(uncertain(i))slots[i].phase='draining';
  const control={schema:1,artifactProtocol:1,revision,runtimeSha:runtime(),fingerprint};
  return {status:200,state:{schema:2,accepting,phase:accepting?'serving':drained?'closed':'draining',slots,pool},control,slots:slots.map((x,slot)=>({...x,slot,qualified:!drained,protocol:1,artifactProtocol:1,boot:drained?'':boot,runtimeSha:runtime(),config:{runtimeSha:runtime(),fingerprint}}))};
}
const fixture=()=>({phase:'ready',cases,requests:cases.length,replays:0,callbacks,starts,accounting});
const json=(s,value,status=200)=>{s.writeHead(status,{'content-type':'application/json'});s.end(JSON.stringify(value));};
const server=createServer(async(r,s)=>{
 try{
  const u=new URL(r.url,'http://local'),path=u.pathname;
  let raw=Buffer.alloc(0);const chunks=[];for await(const c of r)chunks.push(c);raw=Buffer.concat(chunks);
  const body=raw.length?JSON.parse(raw):undefined;
  requests.push({method:r.method,path,bytes:raw.length});
  if(path==='/proof/upload'){
    const c=parse(await readFile(body.config,'utf8')),id=randomUUID();
    assert.equal(c.name,identity.worker);assert.equal(c.account_id,identity.account);assert.equal(c.vars.LARGE_HTTP_ORIGIN,origin);assert(!c.routes?.length);
    const bindings=[...c.durable_objects.bindings.map(b=>({type:'durable_object_namespace',name:b.name,class_name:b.class_name,namespace_id:'isolated-'+b.name})),...Object.entries(c.vars).map(([name,text])=>({type:'plain_text',name,text})),{type:'assets',name:'ASSETS'},{type:'kv_namespace',name:'POLICY_KV',namespace_id:c.kv_namespaces[0].id},{type:'r2_bucket',name:'CONTENT_ARCHIVE',bucket_name:c.r2_buckets[0].bucket_name},{type:'queue',name:'USAGE_QUEUE',queue_name:c.queues.producers[0].queue}];
    if(worker?.bindings.some(b=>b.name==='LARGE_HTTP_TOKEN'))bindings.push({type:'secret_text',name:'LARGE_HTTP_TOKEN'});
    const v={id,annotations:{'workers/tag':body.tag,...(body.message?{'workers/message':body.message}:{})},resources:{bindings}};
    versions.unshift(v);worker={bindings};app={name:identity.container,id:'app'};
    if(body.bootstrap){queueConsumer=true;deployment={id:randomUUID(),versions:[{version_id:id,percentage:100}]};}
    return json(s,{id});
  }
  if(path.startsWith('/client/v4/accounts/')){
   assert.equal(r.headers.authorization,'Bearer loopback-only');
   const p=path.split('/accounts/'+identity.account)[1],ok=value=>json(s,{success:true,result:value});
   if(p==='/workers/subdomain')return ok({subdomain:'fixture'});
   if(p==='/storage/kv/namespaces'){if(r.method==='POST')kv={id:'c'.repeat(32),title:body.title};return ok(r.method==='POST'?kv:kv?[kv]:[]);}
   if(p.endsWith('/values/release-owner')){if(r.method==='PUT'){owner=JSON.stringify(body);return ok(null);}if(!owner)return json(s,{},404);s.end(owner);return;}
   if(p==='/storage/kv/namespaces/'+'c'.repeat(32)&&r.method==='DELETE'){kv=null;return ok(null);}
   if(p==='/queues'){if(r.method==='POST'){queues.push({queue_name:body.queue_name,queue_id:randomUUID()});if(lossQueue){lossQueue=false;r.socket.destroy();return;}}return ok(r.method==='POST'?queues.at(-1):queues);}
   const queue=queues.find(q=>p==='/queues/'+q.queue_id||p.startsWith('/queues/'+q.queue_id+'/'));
   if(queue){
    const qp='/queues/'+queue.queue_id,usage=queue.queue_name===identity.usage;
    const consumer={consumer_id:'proof-consumer',type:'worker',script:identity.worker,dead_letter_queue:identity.dlq};
    if(p===qp+'/metrics')return ok({backlog_count:0,backlog_bytes:0});
    if(p===qp+'/consumers/proof-consumer'){
     if(!usage||!queueConsumer)return json(s,{},404);
     if(r.method==='DELETE'){queueConsumer=false;return ok(null);}
     return ok({...consumer,queue_id:queue.queue_id,queue_name:queue.queue_name});
    }
    if(p===qp){
     if(r.method==='DELETE'){if(queueConsumer||usage&&worker)return json(s,{},400);queues.splice(queues.indexOf(queue),1);return ok(null);}
     return ok({...queue,producers:usage&&worker?[{type:'worker',script:identity.worker}]:[],consumers:usage&&queueConsumer?[consumer]:[]});
    }
   }
   if(p==='/r2/buckets'&&r.method==='POST'){bucket={name:body.name};return ok(bucket);}
   if(p==='/r2/buckets/'+identity.bucket){if(r.method==='DELETE'){bucket=null;return ok(null);}return bucket?ok(bucket):json(s,{},404);}
   if(p==='/containers/applications')return ok(app?[app]:[]);
   if(p==='/containers/applications/app'&&r.method==='DELETE'){app=null;return ok({message:'Application deletion started'});}
   const w='/workers/scripts/'+identity.worker;
   if(p===w&&r.method==='DELETE'){if(queueConsumer)return json(s,{},400);worker=null;return ok(null);}
   if(p===w+'/settings')return worker?ok(worker):json(s,{},404);
   if(p===w+'/secrets'&&r.method==='PUT'){
    assert.equal(body.name,'LARGE_HTTP_TOKEN');worker.bindings.push({type:'secret_text',name:body.name});
    const v={...versions[0],id:randomUUID(),resources:{bindings:structuredClone(worker.bindings)}};versions.unshift(v);deployment={id:randomUUID(),versions:[{version_id:v.id,percentage:100}]};return ok(null);
   }
   if(p==='/workers/scripts/clawrouter-edge/deployments')return ok({deployments:[{id:'production-blue',versions:[{version_id:blueId,percentage:100}]}]});
   if(p==='/workers/scripts/clawrouter-edge/versions/'+blueId)return ok(production);
   if(p===w+'/versions')return ok({items:versions});
   if(p.startsWith(w+'/versions/'))return ok(versions.find(x=>p.endsWith(x.id)));
   if(p===w+'/deployments'){
    if(r.method==='POST'){
      priorDeployment=deployment;previousVersion=selected();deployment={id:randomUUID(),versions:body.versions,annotations:body.annotations};
      deployments.push(structuredClone(deployment));staleDeployment=1;
      if(previousVersion!==selected()){staleControl=1;for(const k of Object.keys(seen))delete seen[k];grants.length=0;}
      if(lossDeploy){lossDeploy=false;r.socket.destroy();return;}return ok(deployment);
    }
    return ok({deployments:[staleDeployment-->0?priorDeployment:deployment]});
   }
   throw Error('Unexpected Cloudflare proof operation '+p);
  }
  s.setHeader('x-clawrouter-version-id',selected());
  if(path==='/v1/admin/large-http'){
    assert.equal(hash(r.headers.authorization.slice(7)),worker.bindings.find(b=>b.name==='CLAWROUTER_ADMIN_TOKEN_SHA256').text);
    if(r.method==='POST'){
      assert.equal(body.expectedRevision,revision);revision++;accepting=body.accepting;
      if(accepting)for(let i=0;i<8;i++)starts.push({slot:i,generation:1,runtimeSha:runtime()});
      if(lossAdmission){lossAdmission=false;r.socket.destroy();return;}
      return json(s,{status:200,accepting,revision});
    }
    if(staleControl-->0)s.setHeader('x-clawrouter-version-id',previousVersion);
    return json(s,snapshot());
  }
  if(path==='/__native_rehearsal/setup'){seedHash=body.seedHash;credentialHash=body.credentialHash;return json(s,{});}
  if(path==='/__native_rehearsal/snapshot')return json(s,fixture());
  if(path==='/__native_rehearsal/release'){cases.find(x=>x.id===body.id).releasedAt=Date.now();return json(s,{});}
  if(path==='/v1/catalog')return json(s,{version:'clawrouter.client-catalog.v1',scope:{authType:'proxy_key',credentialId:'fixture'},providers:[{id:'openai',allowed:true,nativeBaseUrl:'/v1/native/openai',policies:['fixture'],models:[{id:'openai/gpt-6-astra',upstream:'gpt-6-astra',capabilities:['llm.responses']}],routes:[{endpoint:'responses',path:'/v1/responses',methods:['POST'],requestFormat:'openai.responses',responseFormat:'openai.responses',streaming:'sse'}],offers:[{eligible:true,routeKind:'native',policyId:'fixture',policyGeneration:'1',affordability:'exact-covered',modelId:'openai/gpt-6-astra',endpoint:'responses',route:'/v1/native/openai/v1/responses',transport:'http'}]}]});
  assert(['/v1/responses','/v1/native/openai/v1/responses'].includes(path));
  assert.equal(hash(r.headers.authorization.replace('Bearer clawrouter-live-rehearsal-','')),credentialHash);
  if(raw.length>64*1024**2)return json(s,{},413);
  body.model='gpt-6-astra';
  const input=await inspectSyntheticInput(new Request('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)}));
  assert.equal(hash(input.seed),seedHash);assert(!cases.some(x=>x.id===input.id),'no provider replay');
  const x={id:input.id,mode:input.mode,direction:input.direction,slot:0,generation:1,runtimeSha:runtime(),outcome:'active',startedAt:Date.now()};cases.push(x);
  const trace=r.headers['x-canary-trace-id']??'prf_'+input.id;
  grants.push({id:trace,slot:0,generation:1,stage:'intent'});seen[trace]='granted';
  if(x.mode==='hold')while(!x.releasedAt)await new Promise(ok=>setTimeout(ok,10));
  x.outcome=x.mode==='reject'?'rejected':x.mode==='lost'?'delivery_unknown':'completed';
  const cost=x.mode==='reject'?0:7;
  accounting.events.push({idHash:hash(trace),actualCostMicros:cost,reservedCostMicros:7,contentRetained:false,status:x.mode==='lost'?'provider_error':x.mode==='reject'?'client_error':'success'});accounting.policySpentMicros+=cost;accounting.providerSpentMicros+=cost;
  callbacks.push({op:'finish',idHash:hash(trace),slot:0,generation:1,runtimeSha:x.runtimeSha,status:200,clean:x.mode!=='lost',at:Date.now()});
  seen[trace]=x.mode==='lost'?'quarantined':'complete';if(x.mode!=='lost')grants.splice(grants.findIndex(g=>g.id===trace),1);
  if(x.mode==='lost'){s.writeHead(200,{'content-type':'application/json'});s.end('{"id":');return;}
  if(x.mode==='reject')return json(s,{},400);
  // Exercise the accepted session-continuity requirement with an actually
  // FAILED interrupted Codex turn, followed by a distinct saved-thread answer.
  if(x.mode==='hold')return json(s,{error:{message:'Synthetic deployment interruption',type:'server_error'}},503);
  const answer=hash(input.seed+':'+input.direction+':'+input.id),message={id:'msg_'+x.id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const result={id:'resp_'+x.id,object:'response',status:'completed',model:input.model,service_tier:'default',output:[message],usage:{input_tokens:10,input_tokens_details:{cached_tokens:0},output_tokens:2,total_tokens:12}};
  if(!input.stream)return json(s,result);
  const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response:result}];
  s.writeHead(200,{'content-type':'text/event-stream'});s.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
 }catch(error){console.error(error);json(s,{error:'controlled proof failed'},500);}
});
server.on('connection',socket=>{peakConnections=Math.max(peakConnections,++connections);socket.on('close',()=>connections--);});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const local='http://127.0.0.1:'+server.address().port,preload=join(out,'redirect.mjs');
await writeFile(preload,`const original=fetch;globalThis.fetch=(input,init)=>{const r=new Request(input,init),u=new URL(r.url);if(!['https://api.cloudflare.com',${JSON.stringify(origin)},${JSON.stringify(local)}].includes(u.origin))throw Error('External egress refused');return original(${JSON.stringify(local)}+u.pathname+u.search,{method:r.method,headers:r.headers,body:r.body,duplex:'half',redirect:'error',signal:r.signal});};`);
await mkdir(join(out,'bin'));
await writeFile(join(out,'bin','pnpm'),`#!${process.execPath}
import{spawn}from'node:child_process';import{readFileSync}from'node:fs';
const a=process.argv.slice(2);if(a[0]==='exec'&&a[1]==='node'){const p=spawn(process.execPath,a.slice(2),{stdio:'inherit',env:{...process.env,NODE_OPTIONS:${JSON.stringify('--import='+preload)}}});p.on('close',c=>process.exit(c??1));}else{
if(a[0]!=='exec'||a[1]!=='wrangler')throw Error('Unexpected proof CLI');const r=await fetch(${JSON.stringify(local+'/proof/upload')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:a[a.indexOf('--config')+1],tag:a[a.indexOf('--tag')+1],message:a.includes('--message')?a[a.indexOf('--message')+1]:undefined,bootstrap:a[2]==='deploy'})});if(!r.ok)throw Error('Controlled upload failed');console.log(JSON.stringify(await r.json()));}` ,{mode:0o700});
const wrapper=join(out,'bin','codex');
await writeFile(wrapper,`#!${process.execPath}
import{spawnSync,spawn}from'node:child_process';import{readFileSync,writeFileSync,existsSync}from'node:fs';
const config=process.env.CODEX_HOME+'/config.toml';if(existsSync(config)){const t=readFileSync(config,'utf8');writeFileSync(config,t.replace(${JSON.stringify(origin)},${JSON.stringify(local)}));}
const a=process.argv.slice(2);if(a[0]!=='app-server'){const r=spawnSync(${JSON.stringify(binary)},a,{stdio:'inherit'});process.exit(r.status??1);}const p=spawn(${JSON.stringify(binary)},a,{stdio:'inherit'});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>p.kill(signal));p.on('close',c=>process.exit(c??1));`,{mode:0o700});
try{
 const output=await child(['scripts/deploy-release-qualification.mjs'],{...env,PATH:join(out,'bin')+':'+env.PATH,NODE_OPTIONS:'--import='+preload,QUALIFICATION_PLAN_PATH:plan,CLAWROUTER_CODEX_BINARY:wrapper});
 await writeFile(join(out,'entrypoint.log'),output);
 const receipt=JSON.parse(await readFile(join(env.TRAIN_EVIDENCE_DIRECTORY,'public/qualification-release.json'),'utf8'));
 assert.equal(receipt.qualified,true);assert.equal(receipt.controlSha256,nativeControlDigest());
 assert.equal(receipt.actual.providerAttempts,8);assert.equal(receipt.actual.replays,0);
 const lost=receipt.clientDiagnostics.find(x=>x.name==='workload-lost-diagnostic.json');
 assert.equal(lost.response.status,200);assert.equal(lost.response.bodyComplete,true);assert.equal(lost.response.jsonValid,false);assert.equal(lost.outcome,'completed');
 assert.equal(receipt.finalObservation.accountingEvents,8);
 assert.equal(receipt.cases.continuity.interruptedStatus,'failed');
 assert.equal(new Set(receipt.functionalEvidence.steps.filter(x=>x.threadId).map(x=>x.threadId)).size,1);
 assert.equal(kv,null);assert.equal(bucket,null);assert.equal(worker,null);assert.equal(app,null);assert.equal(queues.length,0);
 await assert.rejects(access(join(env.TRAIN_EVIDENCE_DIRECTORY,'private/release/client/session.json')));
 assert.equal(deployments.length,6);
 const proof={passed:true,head:sha,node:process.version,provider:'local controlled HTTP APIs; official Codex 0.164.0',cases:receipt.cases,providerAttempts:cases.length,deployments:deployments.length,readRequests:requests.filter(x=>x.method==='GET').length,peakConnections,delayedDeploymentRead:true,previousControlRead:true,lostQueueAck:true,lostDeploymentAck:true,lostAdmissionAck:true,lostBodyJsonInvalid:true,diagnosticsPreserved:true,queueConsumerDetached:!queueConsumer,productionMutations:0,limits:['Cloudflare APIs, allocator, accounting and upload CLI are controlled; no hosted Cloudflare proof.','Actual release packaging, coordinator and native client CLI entrypoints; real Codex saved thread with synthetic-only Responses.','Independent real Worker/DO/accounting coverage remains in native-rehearsal tests.']};
 await writeFile(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}finally{
 await writeFile(join(out,'requests.json'),JSON.stringify(requests,null,2));
 server.closeAllConnections();await new Promise(ok=>server.close(ok));
}
