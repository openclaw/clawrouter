// Finite coordinator-run client. Never deploys, dispatches Actions, reads Cloudflare
// credentials, changes production or turns these observations into qualification.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rm,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {nativeCodexClient} from '../test/helpers/native-codex.mjs';
import {readCodexCatalog} from './codex-catalog.mjs';
import {isolatedNativeTarget} from './deploy-native-target.mjs';
import {createNativeControl,nativeWarm,nativeDrained} from './deploy-native-cutover.mjs';
import {nativeControlDigest} from './deploy-native-qualification.mjs';
import {versionId} from './deploy-train-policy.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),id=()=>randomBytes(16).toString('hex');
const caseText=(caseId,mode,direction)=>'NATIVE_REHEARSAL_CASE:'+caseId+':'+mode+':'+direction;
export function workloadBody({caseId,mode,seed}){
 const text='NATIVE_REHEARSAL_SEED:'+seed+'\n'+caseText(caseId,mode==='overflow'?'max':mode,'baseline');
 let body=JSON.stringify({model:'openai/gpt-6-astra',stream:false,max_output_tokens:32,input:[{role:'user',content:[{type:'input_text',text},{type:'input_text',text:''}]}]});
 if(['max','overflow'].includes(mode)){const size=64*1024*1024+(mode==='overflow'?1:0),at=body.lastIndexOf('"}');body=body.slice(0,at)+'x'.repeat(size-Buffer.byteLength(body))+body.slice(at);}
 return body;
}
export async function until(fn,ms=120000){const deadline=Date.now()+ms;do{const value=await fn();if(value)return value;await sleep(500);}while(Date.now()<deadline);throw Error('Rehearsal observation deadline; do not replay uncertain work');}
export function projectPool(s){return {accepting:s.accepting,phase:s.phase,control:s.control&&{schema:s.control.schema,revision:s.control.revision,runtimeSha:s.control.runtimeSha,fingerprint:s.control.fingerprint},grants:s.pool.grants.map(g=>({idHash:hash(g.id),slot:g.slot,generation:g.generation,stage:g.stage})),slots:s.slots.map((m,slot)=>({slot,phase:m.phase,generation:m.generation,ids:m.ids.length})),inspection:s.inspection?.map(x=>({slot:x.slot,qualified:x.qualified,protocol:x.protocol,phase:x.phase,generation:x.generation,boot:x.boot,fingerprint:x.fingerprint,runtimeSha:x.runtimeSha}))};}
export async function openSavedCodex({binary,home,key,threadId,env={}}){
 const client=nativeCodexClient({signal:AbortSignal.timeout(20*60000)},binary,home,{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,RUST_LOG:'off',CLAWROUTER_API_KEY:key,...env});
 try{
  await client.rpc('initialize',{clientInfo:{name:'native_rehearsal',version:'1'},capabilities:{experimentalApi:true}});client.child.stdin.write('{"method":"initialized"}\n');
  const {thread}=await client.rpc(threadId?'thread/resume':'thread/start',threadId?{threadId,model:'gpt-6-astra',modelProvider:'rehearsal',cwd:home,approvalPolicy:'never',sandbox:'read-only'}:{model:'gpt-6-astra',modelProvider:'rehearsal',cwd:home,ephemeral:false,approvalPolicy:'never',sandbox:'read-only'});
  if(threadId)assert.equal(thread.id,threadId,'resumption must retain the saved thread');
  return {client,threadId:thread.id};
 }catch(error){await client.close();throw error;}
}
export async function finishTurn(client,started,expected){
 const completed=await until(()=>{if(client.errors.length)throw Error('Native client transport failed');return client.notifications.find(n=>n.method==='turn/completed'&&n.params.turn.id===started.turn.id);});
 assert.equal(completed.params.turn.status,'completed','native saved turn failed');
 const messages=client.notifications.filter(n=>n.method==='item/completed'&&n.params.turnId===started.turn.id&&n.params.item?.type==='agentMessage');
 assert.ok(messages.some(n=>n.params.item.text===expected),'synthetic answer must derive from prior context');
 assert.equal(client.notifications.filter(n=>n.method==='error'&&n.params.turnId===started.turn.id&&n.params.willRetry).length,0,'no native retry');
 return {turnId:started.turn.id,finishedAt:Date.now(),answerSha256:expected};
}
export async function runClient(command,preparation,directory,args=[],env=process.env){
 const root=resolve(directory);if(command==='setup')await mkdir(root,{mode:0o700});
 if(command==='inspect')return runClientOwned(command,preparation,root,args,env);
 const lock=join(root,'owner');await mkdir(lock,{mode:0o700});
 try{return await runClientOwned(command,preparation,root,args,env);}finally{await rm(lock,{recursive:true});}
}
async function runClientOwned(command,preparation,directory,args,env){
 const p=JSON.parse(await readFile(preparation,'utf8'));
 if(p.schema!==1||p.qualified!==false||p.controlSha256!==nativeControlDigest())throw Error('Preparation/control source mismatch');
 const target=isolatedNativeTarget({worker:p.worker,origin:p.origin,account:env.NATIVE_REHEARSAL_ACCOUNT_ID});
 const root=resolve(directory),localPath=join(root,'session.json'),evidencePath=join(root,'evidence.json');
 const headers={authorization:'Bearer '+env.NATIVE_REHEARSAL_ADMIN_TOKEN,'content-type':'application/json'};
 if(!env.NATIVE_REHEARSAL_ADMIN_TOKEN)throw Error('Scoped fixture admin token is required');
 if(Boolean(env.CF_ACCESS_CLIENT_ID)!==Boolean(env.CF_ACCESS_CLIENT_SECRET))throw Error('Incomplete Access pair');
 if(env.CF_ACCESS_CLIENT_ID)Object.assign(headers,{'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET});
 const api=async(op,body={})=>{
  const r=await fetch(target.origin+'/__native_rehearsal/'+op,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok){await r.body?.cancel();throw Error('Fixture '+op+' HTTP '+r.status+'; do not replay a mutation');}return r.json();
 };
 const control=createNativeControl({target,env:{CLOUDFLARE_ACCOUNT_ID:target.account,CLAWROUTER_NATIVE_ADMIN_TOKEN:env.NATIVE_REHEARSAL_ADMIN_TOKEN,CF_ACCESS_CLIENT_ID:env.CF_ACCESS_CLIENT_ID,CF_ACCESS_CLIENT_SECRET:env.CF_ACCESS_CLIENT_SECRET}});
 let local,evidence;
 const atomic=async(path,value)=>{const next=path+'.next';await writeFile(next,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(next,path);};
 const save=async()=>{await atomic(localPath,local);await atomic(evidencePath,evidence);};
 if(command==='setup'){
  await mkdir(join(root,'codex'),{mode:0o700});
  local={schema:1,origin:target.origin,seed:randomBytes(32).toString('hex'),secret:randomBytes(32).toString('hex'),pending:'setup',threadId:null,producer:null};
  evidence={schema:1,qualified:false,source:p.source,controlSha256:p.controlSha256,blueRuntimeSha:p.blueRuntimeSha,greenRuntimeSha:p.greenRuntimeSha,origin:p.origin,steps:[]};
  await save();await api('setup',{seedHash:hash(local.seed),credentialHash:hash(local.secret)});local.pending=null;await save();return {initialized:true,qualified:false};
 }
 local=JSON.parse(await readFile(localPath,'utf8'));evidence=JSON.parse(await readFile(evidencePath,'utf8'));
 if(local.schema!==1||local.origin!==target.origin||evidence.controlSha256!==p.controlSha256)throw Error('Foreign client directory');
 if(command==='inspect'){const snapshot=await api('snapshot');return {qualified:false,pending:local.pending,threadId:local.threadId,snapshot,pool:projectPool(await control.snapshot())};}
 if(command==='cleanup'){
  await api('close');await until(async()=>nativeDrained(await control.snapshot()),10*60000);
  evidence.cleanup={at:Date.now(),nativeAbsent:true,hostedResourcesDeleted:false};await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  await rm(join(root,'codex'),{recursive:true,force:true});await rm(localPath);return {qualified:false,nativeAbsent:true,clientRemoved:true,hostedResourcesDeleted:false};
 }
 if(local.pending)throw Error('Prior client mutation is uncertain; inspect, do not replay');
 const key='clawrouter-live-rehearsal-'+local.secret,home=join(root,'codex'),binary=env.CLAWROUTER_CODEX_BINARY;
 const accessHeaders=env.CF_ACCESS_CLIENT_ID?{'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET}:{};
 const clientEnv=env.CF_ACCESS_CLIENT_ID?{CF_ACCESS_CLIENT_ID:env.CF_ACCESS_CLIENT_ID,CF_ACCESS_CLIENT_SECRET:env.CF_ACCESS_CLIENT_SECRET}:{};
 if(!binary)throw Error('Explicit official Codex binary required');
 const turn=async(client,text)=>client.rpc('turn/start',{threadId:local.threadId,input:[{type:'text',text}],serviceTier:'default'});
 if(command==='seed'){
  const [version]=args;versionId(version);if(local.threadId)throw Error('Saved thread already exists');
  assert.ok(nativeWarm(await control.snapshot(version),p.blueRuntimeSha),'old native must be attested');
  const {catalog,producer}=await readCodexCatalog({routerUrl:target.origin,providerId:'openai',codex:binary,headers:accessHeaders,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,CLAWROUTER_API_KEY:key}});
  await writeFile(join(home,'models.json'),JSON.stringify(catalog),{mode:0o600,flag:'wx'});
  await writeFile(join(home,'config.toml'),['model = "gpt-6-astra"','model_provider = "rehearsal"','model_catalog_json = '+JSON.stringify(join(home,'models.json')),'web_search = "disabled"','approval_policy = "never"','sandbox_mode = "read-only"','cli_auth_credentials_store = "file"','[model_providers.rehearsal]','name = "Synthetic native rehearsal"','base_url = '+JSON.stringify(target.origin+'/v1/native/openai/v1'),'env_key = "CLAWROUTER_API_KEY"','wire_api = "responses"','requires_openai_auth = false','supports_websockets = false','request_max_retries = 0','stream_max_retries = 0','stream_idle_timeout_ms = 180000',...(env.CF_ACCESS_CLIENT_ID?['env_http_headers = { \"CF-Access-Client-Id\" = \"CF_ACCESS_CLIENT_ID\", \"CF-Access-Client-Secret\" = \"CF_ACCESS_CLIENT_SECRET\" }']:[])].join('\n')+'\n',{mode:0o600,flag:'wx'});
  const opened=await openSavedCodex({binary,home,key,env:clientEnv});local.threadId=opened.threadId;local.producer=producer;local.pending={id:id(),mode:'seed'};await save();
  try{const started=await turn(opened.client,'NATIVE_REHEARSAL_SEED:'+local.seed+'\n'+caseText(local.pending.id,'seed','baseline'));
   evidence.steps.push({kind:'seed',threadId:local.threadId,producer,...await finishTurn(opened.client,started,hash(local.seed+':baseline:'+local.pending.id))});local.pending=null;await save();
  }finally{await opened.client.close();}return {seeded:true,threadId:local.threadId,qualified:false};
 }
 if(command==='followup'){
  const [direction,version]=args;if(!['forward','recovery'].includes(direction)||!local.threadId)throw Error('Expected saved thread and direction');versionId(version);
  const runtime=direction==='forward'?p.greenRuntimeSha:p.blueRuntimeSha,snapshot=await control.snapshot(version);assert.ok(nativeWarm(snapshot,runtime));
  const {client}=await openSavedCodex({binary,home,key,threadId:local.threadId,env:clientEnv});local.pending={id:id(),mode:'followup',direction};await save();
  try{const started=await turn(client,caseText(local.pending.id,'recall',direction));evidence.steps.push({kind:'followup',direction,version,threadId:local.threadId,pool:projectPool(snapshot),...await finishTurn(client,started,hash(local.seed+':'+direction+':'+local.pending.id))});local.pending=null;await save();return {resumed:true,qualified:false};}finally{await client.close();}
 }
 if(command==='overlap'){
  const [direction,beforeVersion,afterVersion]=args;if(!['forward','recovery'].includes(direction)||!local.threadId)throw Error('Expected saved thread and direction');versionId(beforeVersion);versionId(afterVersion);
  if(evidence.steps.some(s=>s.kind==='overlap'&&s.direction===direction))throw Error('Direction already observed');
  const beforeRuntime=direction==='forward'?p.blueRuntimeSha:p.greenRuntimeSha,afterRuntime=direction==='forward'?p.greenRuntimeSha:p.blueRuntimeSha;
  assert.ok(nativeWarm(await control.snapshot(beforeVersion),beforeRuntime));
  const {client}=await openSavedCodex({binary,home,key,threadId:local.threadId,env:clientEnv});
  const held=id();local.pending={id:held,mode:'overlap',direction};await save();
  try{
   const startedAt=Date.now(),started=await turn(client,caseText(held,'hold',direction));
   const active=await until(async()=>{const s=await api('snapshot');return s.cases.find(x=>x.id===held&&x.outcome==='active');});
   const closed=await until(async()=>{const s=await control.snapshot(beforeVersion);if(s.accepting)return false;
    assert.ok(s.pool.grants.some(g=>g.slot===active.slot&&g.generation===active.generation&&g.stage==='intent'),'held request must still own dispatched capacity');
    assert.equal(client.notifications.some(n=>n.method==='turn/completed'&&n.params.turn.id===started.turn.id),false,'native turn must be active at admission close');return {at:Date.now(),pool:projectPool(s)};});
   await api('release',{id:held});const completed=await finishTurn(client,started,hash(local.seed+':'+direction+':'+held));
   const after=await until(async()=>{try{const s=await control.snapshot(afterVersion);return nativeWarm(s,afterRuntime)&&s;}catch{return false;}},10*60000);
   // A DISTINCT follow-up, without repeating the seed, in the SAME saved thread.
   const followup=id(),followupStartedAt=Date.now(),followupTurn=await turn(client,caseText(followup,'recall',direction));
   const recalled=await finishTurn(client,followupTurn,hash(local.seed+':'+direction+':'+followup));
   const snap=await api('snapshot');assert.equal(snap.cases.filter(x=>[held,followup].includes(x.id)).length,2);assert.equal(snap.replays,0);
   assert.equal(active.runtimeSha,beforeRuntime);assert.equal(snap.cases.find(x=>x.id===followup).runtimeSha,afterRuntime);
   assert.ok(snap.callbacks.some(x=>x.op==='finish'&&x.runtimeSha===beforeRuntime&&x.at>=closed.at&&x.status===200&&x.clean===true),'old callback must settle after admission closes');
   evidence.steps.push({kind:'overlap',direction,threadId:local.threadId,beforeVersion,afterVersion,heldCaseId:held,followupCaseId:followup,startedAt,closed,after:projectPool(after),...completed,followupStartedAt,followup:recalled});
   local.pending=null;await save();return {observed:direction,qualified:false};
  }finally{await client.close();}
 }
 if(command==='workloads'){
  const [version]=args;versionId(version);const initial=await control.snapshot(version);assert.ok([p.blueRuntimeSha,p.greenRuntimeSha].includes(initial.control.runtimeSha)&&nativeWarm(initial,initial.control.runtimeSha));
  local.pending={id:id(),mode:'workloads'};await save();const outcomes=[];
  for(const mode of ['success','reject','lost','max','overflow']){
   const caseId=id(),trace='prf_'+id();
   const body=workloadBody({caseId,mode,seed:local.seed});
   const r=await fetch(target.origin+'/v1/responses',{method:'POST',headers:{...accessHeaders,authorization:'Bearer '+key,'content-type':'application/json','x-canary-trace-id':trace},body,redirect:'error',signal:AbortSignal.timeout(180000)});
   const status=r.status;await r.arrayBuffer();assert.equal(r.headers.get('x-clawrouter-version-id'),version,'workload response selected version');assert.equal(status,mode==='reject'?400:mode==='lost'?424:mode==='overflow'?413:200);
   local.pending={...local.pending,caseId,completedMode:mode};
   const pool=await until(async()=>{const s=await control.snapshot(version);return (mode==='overflow'?s.pool.seen[trace]===undefined:s.pool.seen[trace]===(mode==='lost'?'quarantined':'complete'))&&s;});
   if(mode==='lost'){const s=await api('snapshot'),x=s.cases.find(x=>x.id===caseId);assert.ok(x);assert.ok(pool.pool.members[x.slot]?.quarantined);assert.equal(pool.slots.filter((m,i)=>i!==x.slot&&m.phase==='ready').length,7,'uncertainty must not evict unaffected members');}
   if(mode==='overflow'){const s=await api('snapshot');assert.equal(s.cases.some(x=>x.id===caseId),false,'overflow must not reach provider');}
   outcomes.push({mode,caseId,traceHash:hash(trace),status,bytes:Buffer.byteLength(body),at:Date.now(),pool:projectPool(pool)});await save();
  }
  const snapshot=await until(async()=>{const s=await api('snapshot');return s.cases.every(x=>x.outcome!=='active')&&s.accounting.events.length>=s.cases.length?s:false;});
  assert.equal(snapshot.replays,0);assert.ok(snapshot.callbacks.some(x=>x.op==='finish'&&x.clean===false),'uncertain attempt must remain quarantined');
  const expected=snapshot.cases.reduce((sum,x)=>sum+(x.mode==='reject'?0:7),0);
  assert.equal(snapshot.accounting.policySpentMicros,expected);assert.equal(snapshot.accounting.providerSpentMicros,expected);
  assert.equal(snapshot.accounting.events.reduce((sum,x)=>sum+x.actualCostMicros,0),expected);
  assert.ok(snapshot.accounting.events.every(x=>x.contentRetained===false));
  evidence.steps.push({kind:'workloads',version,outcomes,snapshot});local.pending=null;await save();return {outcomes,qualified:false};
 }
 throw Error('Commands: setup, seed <blue-version>, overlap <forward|recovery> <before-version> <after-version>, followup <forward|recovery> <version>, workloads <version>, inspect, cleanup');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [command,preparation,directory,...args]=process.argv.slice(2);
 try{console.log(JSON.stringify(await runClient(command,preparation,directory,args)));}catch{console.error('Native rehearsal client failed; inspect its retained intent and content-free evidence. No inference was retried.');process.exitCode=1;}
}
