import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,rm,access,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeControlDigest} from '../scripts/deploy-native-qualification.mjs';
const exec=promisify(execFile),version='11111111-1111-4111-8111-111111111111',runtime='c'.repeat(64),fingerprint='d'.repeat(64);
const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev';
const unsafe='fixture-private-text-never-in-diagnostics';
function snapshot(closed=false){
 const slots=Array.from({length:8},(_,slot)=>({slot,generation:1,phase:closed?'idle':'ready',fingerprint,ids:[]}));
 const members=slots.map(()=>closed?null:{boot:version,quarantined:false});
 return {status:200,state:{schema:2,accepting:!closed,phase:closed?'closed':'serving',slots,pool:{members,grants:[],issued:0,seen:{}}},
  control:{schema:1,revision:0,runtimeSha:runtime,fingerprint},slots:slots.map(s=>({...s,qualified:!closed,protocol:1,boot:version,runtimeSha:runtime,config:{runtimeSha:runtime,fingerprint}}))};
}
const catalog={version:'clawrouter.client-catalog.v1',scope:{authType:'proxy_key',credentialId:'fixture'},providers:[{id:'openai',allowed:true,nativeBaseUrl:'/v1/native/openai',policies:['fixture'],routes:[{endpoint:'responses',path:'/v1/responses',methods:['POST'],requestFormat:'openai.responses',responseFormat:'openai.responses',streaming:'sse'}],models:[{id:'openai/gpt-6-astra',upstream:'gpt-6-astra',capabilities:['llm.responses']}],offers:[{eligible:true,routeKind:'native',policyId:'fixture',policyGeneration:'1',affordability:'request-dependent',modelId:'openai/gpt-6-astra',endpoint:'responses',route:'/v1/native/openai/v1/responses',transport:'http'}]}]};
// The server and app-server child read the same state concurrently. Publish
// complete JSON atomically; truncating the shared file can crash either reader.
async function publishFixtureState(path,state){
 const next=path+'.server-'+randomUUID();await writeFile(next,JSON.stringify(state),{flag:'wx',mode:0o600});await rename(next,path);
}
async function entrypoint(t,mode){
 const directory=await mkdtemp(join(tmpdir(),'native-client-cli-'));let server;const requests=[];let closed=false;
 const modeFile=join(directory,'mode.json'),stateFile=join(directory,'fixture-state.json');await writeFile(modeFile,JSON.stringify(mode));await publishFixtureState(stateFile,{phase:'ready',cases:[],callbacks:[],replays:0,accounting:{events:[]}});
 t.after(async()=>{await new Promise(resolve=>server?.close(resolve)??resolve());await rm(directory,{recursive:true,force:true});});
 server=createServer(async(r,s)=>{
  requests.push(r.method+' '+r.url);let body='';for await(const chunk of r)body+=chunk;
  const state=JSON.parse(await readFile(stateFile,'utf8'));
  s.setHeader('content-type','application/json');s.setHeader('x-clawrouter-version-id',version);
  if(r.url==='/__native_rehearsal/snapshot')return s.end(JSON.stringify(state));
  if(r.url==='/__native_rehearsal/release'){const c=state.cases.find(c=>c.id===JSON.parse(body).id);c.outcome='completed';c.releasedAt=Date.now();state.accounting.events.push({});state.callbacks.push({op:'finish',runtimeSha:runtime,at:Date.now(),status:200,clean:true});await publishFixtureState(stateFile,state);return s.end('{}');}
  if(r.url==='/__native_rehearsal/setup')return s.end('{}');
  if(r.url==='/__native_rehearsal/close'){closed=true;return s.end('{}');}
  if(r.url==='/v1/admin/large-http'){
   if(mode==='readiness-not-warm'&&!closed){const value=snapshot();value.state.slots[3].phase='starting';value.slots[3].qualified=false;return s.end(JSON.stringify(value));}
   if(mode==='readiness-http'&&!closed){s.statusCode=500;return s.end(JSON.stringify({error:unsafe}));}
   const value=snapshot(closed),held=state.cases.find(c=>c.outcome==='active');
   if(held&&!closed){value.state.accepting=false;value.state.phase='draining';value.state.pool.grants=[{id:held.id,slot:held.slot,generation:held.generation,stage:'intent'}];}
   return s.end(JSON.stringify(value));
  }
  if(r.url==='/v1/catalog'){
   if(mode==='catalog-http'){s.statusCode=403;return s.end(JSON.stringify({error:unsafe}));}
   if(mode==='catalog-decode')return s.end('{');
   return s.end(JSON.stringify(mode==='catalog-projection'?{...catalog,providers:[]}:catalog));
  }
  s.statusCode=404;s.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const bridge='http://127.0.0.1:'+server.address().port;
 // Transport substitution stays in this child-only test preload. Production
 // identity/target guards and the CLI entrypoint remain unchanged; external
 // network is rejected. The app-server below is a protocol fixture, not Codex.
 const preload=join(directory,'bridge.mjs');await writeFile(preload,`const real=globalThis.fetch;globalThis.fetch=(input,init)=>{const r=new Request(input,init),u=new URL(r.url);if(u.origin!==${JSON.stringify(origin)})throw Error('unexpected egress');return real(${JSON.stringify(bridge)}+u.pathname+u.search,{method:r.method,headers:r.headers,body:r.body,duplex:'half',redirect:'error',signal:r.signal});};\n`);
 const binary=join(directory,'codex-fixture.mjs');
 await writeFile(binary,`#!/usr/bin/env node
import{createInterface}from'node:readline';import{createHash,randomUUID}from'node:crypto';import{writeFileSync,readFileSync,appendFileSync,renameSync}from'node:fs';
const mode=JSON.parse(readFileSync(${JSON.stringify(modeFile)},'utf8')),unsafe=${JSON.stringify(unsafe)};
if(process.argv.includes('--version')){console.log('codex-cli 0.167.1');process.exit(0);}
if(process.argv.includes('--bundled')){if(mode==='native-export')process.exit(1);console.log(JSON.stringify({models:[{slug:'gpt-6-astra',base_instructions:'Synthetic instructions'}]}));process.exit(0);}
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(join(directory,'native-closed'))},'closed');process.exit(0);});
const send=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.id==null)return;appendFileSync(${JSON.stringify(join(directory,'rpc.log'))},v.method+'\\n');
if(v.method==='initialize'){send(mode==='initialize-error'?{id:v.id,error:{code:-32603,message:unsafe}}:{id:v.id,result:{}});return;}
if(v.method==='thread/start'||v.method==='thread/resume'){if(mode==='session-save-error')writeFileSync(${JSON.stringify(join(directory,'client/session.json.next'))},'fixture');send(mode==='thread-error'?{id:v.id,error:{code:-32603,message:unsafe}}:{id:v.id,result:{thread:{id:'fixture-thread'}}});return;}
if(v.method==='turn/start'){
 if(mode==='turn-error'){send({id:v.id,error:{code:-32603,message:unsafe}});return;}
 const text=v.params.input[0].text,match=/NATIVE_REHEARSAL_SEED:([a-f0-9]+)/.exec(text),parts=/NATIVE_REHEARSAL_CASE:([a-f0-9]+):([a-z]+):([a-z]+)/.exec(text),[,id,kind,direction]=parts;
 send({id:v.id,result:{turn:{id}}});
 const seedFile=${JSON.stringify(join(directory,'fixture-seed'))};if(match)writeFileSync(seedFile,match[1]);const seed=readFileSync(seedFile,'utf8');
 const stateFile=${JSON.stringify(stateFile)},state=JSON.parse(readFileSync(stateFile,'utf8'));
 state.cases.push({id,mode:kind,direction,slot:0,generation:1,runtimeSha:${JSON.stringify(runtime)},outcome:kind==='hold'?'active':'completed'});if(kind!=='hold')state.accounting.events.push({});const nextState=stateFile+'.child-'+randomUUID();writeFileSync(nextState,JSON.stringify(state),{flag:'wx',mode:0o600});renameSync(nextState,stateFile);
 const answer=createHash('sha256').update(seed+':'+direction+':'+id).digest('hex');
 const finish=()=>{send({method:'item/completed',params:{turnId:id,item:{type:'agentMessage',text:answer}}});send({method:'turn/completed',params:{turn:{id,status:mode==='failed-turn'?'failed':'completed'}}});};
 if(kind==='hold'){const timer=setInterval(()=>{if(JSON.parse(readFileSync(stateFile,'utf8')).cases.find(c=>c.id===id).outcome==='completed'){clearInterval(timer);finish();}},10);}else finish();return;
}throw Error('unexpected fixture method');});
`,{mode:0o700});
 const preparation=join(directory,'preparation.json'),client=join(directory,'client');
 await writeFile(preparation,JSON.stringify({schema:1,qualified:false,source:'a'.repeat(40),controlSha256:nativeControlDigest(),worker,origin,blueRuntimeSha:runtime,greenRuntimeSha:runtime}));
 const env={PATH:process.env.PATH,HOME:directory,NODE_OPTIONS:'--import='+preload,NATIVE_REHEARSAL_ACCOUNT_ID:'a'.repeat(32),NATIVE_REHEARSAL_ADMIN_TOKEN:'synthetic-admin',CLAWROUTER_CODEX_BINARY:binary};
 const run=async(command,...args)=>{try{return {code:0,...await exec(process.execPath,[resolve('scripts/native-rehearsal-client.mjs'),command,preparation,client,...(args.length?args:command==='seed'?[version]:[])],{cwd:process.cwd(),env,timeout:20000})};}catch(e){return {code:e.code,stdout:e.stdout??'',stderr:e.stderr??''};}};
 assert.equal((await run('setup')).code,0);
 return {directory,client,requests,run,async setMode(value){mode=value;await writeFile(modeFile,JSON.stringify(value));}};
}
for(const [mode,stage,failure] of [
 ['readiness-http','native_readiness',{kind:'http',status:500}],
 ['catalog-http','catalog_request',{kind:'http',status:403}],
 ['native-export','catalog_native_export',{kind:'unexpected'}],
 ['catalog-decode','catalog_decode',{kind:'unexpected'}],
 ['catalog-projection','catalog_projection',{kind:'unexpected'}],
 ['initialize-error','codex_initialize',{kind:'unexpected'}],
 ['thread-error','codex_thread',{kind:'unexpected'}],
 ['session-save-error','session_save',{kind:'filesystem',code:'EEXIST'}],
 ['turn-error','turn_start',{kind:'unexpected'}],
 ['failed-turn','turn_complete',{kind:'assertion'}],
])test('actual CLI retains bounded seed diagnostics: '+mode,{timeout:30000},async t=>{
 const f=await entrypoint(t,mode),result=await f.run('seed');assert.equal(result.code,1);
 const path=join(f.client,'seed-diagnostic.json'),text=await readFile(path,'utf8'),receipt=JSON.parse(text);
 assert.equal(receipt.stage,stage);assert.equal(receipt.outcome,'failed');assert.deepEqual(receipt.failure,failure);
 assert.deepEqual(Object.keys(receipt).sort(),['command','failure','outcome','schema','stage','startedAt','updatedAt']);
 assert(!text.includes(unsafe));assert(!result.stdout.includes(unsafe));assert(!result.stderr.includes(unsafe));
 const local=JSON.parse(await readFile(join(f.client,'session.json'),'utf8'));assert(!text.includes(local.secret));assert(!text.includes(local.seed));
 assert.equal((await stat(path)).mode&0o777,0o600);await assert.rejects(access(join(f.client,'owner')));
 const count=f.requests.length;assert.equal((await f.run('seed')).code,1);assert.equal(f.requests.length,count,'failed seed is not replayed');assert.equal(await readFile(path,'utf8'),text,'first failure evidence is preserved');
 if(['initialize-error','thread-error','session-save-error','turn-error','failed-turn'].includes(mode))assert.equal(await readFile(join(f.directory,'native-closed'),'utf8'),'closed');
 assert.equal((await f.run('cleanup')).code,0);assert.equal(await readFile(path,'utf8'),text,'cleanup retains diagnostics');await assert.rejects(access(join(f.client,'session.json')));
 t.diagnostic(JSON.stringify({kind:'seed-cli-smoke',mode,stage,failure,clientExit:result.code,replayed:false,cleanup:true,rawErrorRetained:false,limits:'Loopback control/catalog and app-server protocol fixture; not hosted native or official-Codex inference proof'}));
});
test('actual CLI completes the seed and preserves normal cleanup with diagnostics',{timeout:30000},async t=>{
 const f=await entrypoint(t,'success');assert.equal((await f.run('seed')).code,0);
 const receipt=JSON.parse(await readFile(join(f.client,'seed-diagnostic.json'),'utf8'));assert.equal(receipt.outcome,'completed');assert.equal(receipt.failure,undefined);
 const evidence=JSON.parse(await readFile(join(f.client,'evidence.json'),'utf8'));assert.equal(evidence.steps[0].kind,'seed');assert.equal(evidence.steps[0].threadId,'fixture-thread');
 assert.equal(await readFile(join(f.directory,'native-closed'),'utf8'),'closed');assert.equal((await f.run('cleanup')).code,0);
});

for(const command of ['overlap','followup'])for(const direction of ['forward','recovery'])for(const [mode,stage,failure] of [
 ['readiness-http','native_readiness',{kind:'http',status:500}],
 ['readiness-not-warm','native_readiness',{kind:'assertion'}],
 ['initialize-error','codex_initialize',{kind:'unexpected'}],
 ['thread-error','codex_thread',{kind:'unexpected'}],
 ['session-save-error','session_save',{kind:'filesystem',code:'EEXIST'}],
 ['turn-error','turn_start',{kind:'unexpected'}],
])test('resumed CLI failure boundary: '+command+' '+direction+' '+mode,{timeout:30000},async t=>{
 const f=await entrypoint(t,'success');assert.equal((await f.run('seed')).code,0);await f.setMode(mode);await rm(join(f.directory,'native-closed'));
 const args=command==='overlap'?[direction,version,version]:[direction,version];
 const result=await f.run(command,...args);assert.equal(result.code,1);
 const path=join(f.client,command+'-'+direction+'-diagnostic.json'),text=await readFile(path,'utf8'),receipt=JSON.parse(text);
 assert.equal(receipt.command,command);assert.equal(receipt.direction,direction);assert.equal(receipt.stage,stage);assert.equal(receipt.outcome,'failed');assert.deepEqual(receipt.failure,failure);
 assert.deepEqual(Object.keys(receipt).sort(),['command','direction','failure','outcome','schema','stage','startedAt','updatedAt']);
 assert.equal((await stat(path)).mode&0o777,0o600);
 const local=JSON.parse(await readFile(join(f.client,'session.json'),'utf8'));
 for(const secret of [unsafe,local.seed,local.secret]){assert(!text.includes(secret));assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));}
 assert.equal(local.pending===null,mode!=='turn-error');
 const rpc=await readFile(join(f.directory,'rpc.log'),'utf8');
 assert.equal(rpc.split('turn/start').length-1,mode==='turn-error'?2:1);
 assert.equal(JSON.parse(await readFile(join(f.client,'evidence.json'),'utf8')).steps.length,1);
 await assert.rejects(access(join(f.client,'owner')));
 if(!mode.startsWith('readiness'))assert.equal(await readFile(join(f.directory,'native-closed'),'utf8'),'closed');
 const count=f.requests.length;assert.equal((await f.run(command,...args)).code,1);assert.equal(f.requests.length,count);assert.equal(await readFile(path,'utf8'),text);assert.equal(await readFile(join(f.directory,'rpc.log'),'utf8'),rpc);
 assert.equal((await f.run('cleanup')).code,0);assert.equal(await readFile(path,'utf8'),text);await assert.rejects(access(join(f.client,'session.json')));
 t.diagnostic(JSON.stringify({command,direction,mode,stage,failure,clientExit:result.code,pending:local.pending!==null,turnStarts:rpc.split('turn/start').length-1,replayed:false,cleanup:true,limits:'Controlled local boundary; historical cause unknown'}));
});
for(const command of ['overlap','followup'])test('actual resumed CLI succeeds in both directions: '+command,{timeout:30000},async t=>{
 const f=await entrypoint(t,'success');assert.equal((await f.run('seed')).code,0);
 for(const direction of ['forward','recovery']){
  const args=command==='overlap'?[direction,version,version]:[direction,version];
  assert.equal((await f.run(command,...args)).code,0);
  const receipt=JSON.parse(await readFile(join(f.client,command+'-'+direction+'-diagnostic.json'),'utf8'));assert.equal(receipt.outcome,'completed');assert.equal(receipt.failure,undefined);
 }
 const evidence=JSON.parse(await readFile(join(f.client,'evidence.json'),'utf8'));assert.deepEqual(evidence.steps.map(x=>x.kind),['seed',command,command]);assert(evidence.steps.every(x=>x.threadId==='fixture-thread'));
 assert.equal((await f.run('cleanup')).code,0);
 t.diagnostic(JSON.stringify({command,directions:['forward','recovery'],sameSavedThread:true,cleanup:true,limits:'Loopback protocol fixture, no hosted deployment or real Codex'}));
});
