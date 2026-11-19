import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeControlDigest} from '../scripts/deploy-native-qualification.mjs';
const exec=promisify(execFile),hash=x=>createHash('sha256').update(x).digest('hex');
const version='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',runtime='c'.repeat(64),fingerprint='d'.repeat(64);
const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev',unsafe='fixture-private-error-not-for-diagnostics';

async function fixture(t,mode){
 const directory=await mkdtemp(join(tmpdir(),'native-workload-cli-')),client=join(directory,'client');
 const state={phase:'ready',requests:0,cases:[],callbacks:[],replays:0,accounting:{events:[],policySpentMicros:0,providerSpentMicros:0}};
 const slots=Array.from({length:8},(_,slot)=>({slot,generation:1,phase:'ready',fingerprint,ids:[]}));
 const pool={members:slots.map(()=>({boot:version,quarantined:false})),grants:[],issued:0,seen:{}};
 let closed=false;const calls=[],controls=[];
 const server=createServer(async(r,s)=>{
  let bytes=0,prefix='';for await(const chunk of r){bytes+=chunk.length;if(prefix.length<2048)prefix+=chunk.toString('utf8',0,2048-prefix.length);}
  s.setHeader('content-type','application/json');s.setHeader('x-clawrouter-version-id',version);
  if(r.url==='/__native_rehearsal/setup')return s.end('{}');
  if(r.url==='/__native_rehearsal/close'){closed=true;state.phase='closed';return s.end('{}');}
  if(r.url==='/__native_rehearsal/snapshot')return s.end(JSON.stringify(state));
  if(r.url==='/v1/admin/large-http'){
   controls.push('snapshot');
   const members=slots.map(x=>({...x,phase:closed?'idle':x.phase,ids:closed?[]:x.ids}));
   return s.end(JSON.stringify({status:200,state:{schema:2,accepting:!closed,phase:closed?'closed':'serving',slots:members,pool:closed?{members:Array(8).fill(null),grants:[],issued:0,seen:{}}:pool},control:{schema:1,revision:0,runtimeSha:runtime,fingerprint},slots:members.map(x=>({...x,qualified:!closed,protocol:1,boot:version,runtimeSha:runtime,config:{runtimeSha:runtime,fingerprint}}))}));
  }
  if(r.url!=='/v1/responses'){s.statusCode=404;return s.end('{}');}
  const match=/NATIVE_REHEARSAL_CASE:([a-f0-9]{32}):([a-z]+):baseline/.exec(prefix);assert(match);
  const [,id,kind]=match,workload=bytes>64*1024**2?'overflow':kind,trace=r.headers['x-canary-trace-id'];
  calls.push({mode:workload,bytes});
  // A journal must identify the CURRENT case before even the first byte is sent.
  const local=JSON.parse(await readFile(join(client,'session.json'),'utf8'));
  assert.equal(local.workloadPending.caseId,id);assert.equal(local.workloadPending.workloadMode,workload);assert.equal(local.workloadPending.traceHash,hash(trace));
  const diagnostic=JSON.parse(await readFile(join(client,'workload-'+workload+'-diagnostic.json'),'utf8'));assert.equal(diagnostic.stage,'request');assert.equal(diagnostic.caseId,id);
  if(workload==='overflow'){s.statusCode=413;return s.end('{}');}
  const slot=state.requests++,lost=kind==='lost',cost=kind==='reject'?0:7;
  state.cases.push({id,mode:kind,slot,generation:1,runtimeSha:runtime,outcome:lost?'delivery_unknown':kind==='reject'?'rejected':'completed'});
  pool.issued++;pool.seen[trace]=lost?'quarantined':'complete';slots[slot].ids.push(trace);
  if(lost){pool.members[slot].quarantined=true;slots[slot].phase='draining';pool.grants.push({id:trace,slot,generation:mode==='wrong-generation'?2:1,stage:'intent'});}
  if(lost&&mode==='other-quarantine')pool.members[7].quarantined=true;
  state.callbacks.push({op:'finish',idHash:hash(trace),slot,generation:lost&&mode==='wrong-finish'?2:1,runtimeSha:runtime,status:200,clean:!lost});
  const charged=lost&&mode==='wrong-accounting'?8:cost;
  state.accounting.events.push({idHash:hash(id),actualCostMicros:charged,reservedCostMicros:7,contentRetained:false,status:lost?'provider_error':kind==='reject'?'client_error':'success'});
  state.accounting.policySpentMicros+=charged;state.accounting.providerSpentMicros+=charged;
  if(mode==='wrong-version')s.setHeader('x-clawrouter-version-id',other);
  if(kind==='reject')s.statusCode=400;
  if(lost){
   if(mode==='pre-header'){s.statusCode=424;return s.end('{}');}
   if(mode==='complete-200')return s.end('{}');
   if(mode==='json-truncated')return s.end('{"id":');
   if(mode==='unexpected-status'){s.statusCode=500;return s.end('{}');}
   if(mode==='timeout'){s.setHeader('x-fixture-body-fault','timeout');return s.end('{}');}
   s.writeHead(200);s.flushHeaders();s.write('{"id":');setTimeout(()=>s.destroy(),100);return;
  }
  s.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
 const bridge='http://127.0.0.1:'+server.address().port,preload=join(directory,'bridge.mjs');
 // Exact CLI, unchanged target guards. Only the origin is remapped to loopback;
 // any unrelated network target is rejected. Timeout injection is local only.
 await writeFile(preload,`const real=globalThis.fetch;globalThis.fetch=async(input,init)=>{const r=new Request(input,init),u=new URL(r.url);if(u.origin!==${JSON.stringify(origin)})throw Error('unexpected egress');const response=await real(${JSON.stringify(bridge)}+u.pathname,{method:r.method,headers:r.headers,body:r.body,duplex:'half',redirect:'error',signal:r.signal});if(response.headers.get('x-fixture-body-fault')==='timeout'){await response.body.cancel();return new Response(new ReadableStream({start(c){c.error(new DOMException(${JSON.stringify(unsafe)},'TimeoutError'));}}),{status:response.status,headers:response.headers});}return response;};\n`);
 const preparation=join(directory,'preparation.json');await writeFile(preparation,JSON.stringify({schema:1,qualified:false,source:'a'.repeat(40),controlSha256:nativeControlDigest(),worker,origin,blueRuntimeSha:runtime,greenRuntimeSha:runtime}));
 const env={PATH:process.env.PATH,HOME:directory,NODE_OPTIONS:'--import='+preload,NATIVE_REHEARSAL_ACCOUNT_ID:'a'.repeat(32),NATIVE_REHEARSAL_ADMIN_TOKEN:'synthetic-admin',CLAWROUTER_CODEX_BINARY:'not-used-by-workloads'};
 const run=async command=>{try{return {code:0,...await exec(process.execPath,[resolve('scripts/native-rehearsal-client.mjs'),command,preparation,client,...(command==='workloads'?[version]:[])],{env,timeout:20000,maxBuffer:1024*1024})};}catch(e){return {code:e.code,stdout:e.stdout??'',stderr:e.stderr??''};}};
 assert.equal((await run('setup')).code,0);
 return {directory,client,calls,controls,state,run};
}

for(const mode of ['pre-header','partial','json-truncated','complete-200','unexpected-status','wrong-version','wrong-generation','wrong-finish','other-quarantine','wrong-accounting','timeout'])test('actual workload CLI: '+mode,{timeout:30000},async t=>{
 const f=await fixture(t,mode),result=await f.run('workloads'),passed=['pre-header','partial','json-truncated'].includes(mode),failedCase=mode==='wrong-version'?'success':'lost';
 assert.equal(result.code,passed?0:1,result.stderr);
 const modes=mode==='wrong-version'?['success']:['success','reject','max','overflow','lost'];assert.deepEqual(f.calls.map(x=>x.mode),modes);
 if(mode!=='wrong-version'){assert.equal(f.calls[2].bytes,64*1024**2);assert.equal(f.calls[3].bytes,64*1024**2+1);}
 assert.equal(f.state.requests,mode==='wrong-version'?1:4);assert.equal(f.state.replays,0);
 const local=JSON.parse(await readFile(join(f.client,'session.json'),'utf8')),evidence=JSON.parse(await readFile(join(f.client,'evidence.json'),'utf8'));
 const paths=modes.map(x=>join(f.client,'workload-'+x+'-diagnostic.json')),original=await Promise.all(paths.map(p=>readFile(p,'utf8')));
 for(let i=0;i<paths.length;i++){
  const receipt=JSON.parse(original[i]);assert.equal(receipt.mode,modes[i]);assert.equal(receipt.outcome,!passed&&modes[i]===failedCase?'failed':'completed');assert.equal((await stat(paths[i])).mode&0o777,0o600);
  for(const secret of [unsafe,local.seed,local.secret,'synthetic-admin']){assert(!original[i].includes(secret));assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));}
 }
 if(passed){
  assert.equal(local.pending,null);assert.deepEqual(evidence.steps.filter(s=>s.kind==='workload-case').map(s=>s.mode),modes);assert.equal(evidence.steps.at(-1).kind,'workloads');
  const lost=JSON.parse(original.at(-1));assert.equal(lost.response.status,mode==='pre-header'?424:200);assert.equal(lost.response.bodyComplete,mode!=='partial');
  if(mode==='partial')assert.equal(lost.response.failure.kind,'transport');
  if(mode==='json-truncated')assert.equal(lost.response.jsonValid,false);
 }else{
  assert.equal(local.workloadPending.workloadMode,failedCase);assert.equal(evidence.steps.filter(s=>s.kind==='workloads').length,0);assert.equal(evidence.steps.filter(s=>s.kind==='workload-case').length,modes.length-1);
  const diagnostic=JSON.parse(original.at(-1));if(mode==='timeout')assert.deepEqual(diagnostic.failure,{kind:'timeout'});
  const count=f.calls.length,controlReads=f.controls.length;assert.equal((await f.run('workloads')).code,1);assert.equal(f.calls.length,count);assert.equal(f.controls.length,controlReads,'pending work is refused before any network request');
 }
 await assert.rejects(access(join(f.client,'owner')));
 assert.equal((await f.run('cleanup')).code,0);await assert.rejects(access(join(f.client,'session.json')));await assert.rejects(access(join(f.client,'codex')));
 assert.deepEqual(await Promise.all(paths.map(p=>readFile(p,'utf8'))),original,'cleanup preserves every original per-case diagnostic');
 t.diagnostic(JSON.stringify({mode,passed,cases:f.calls,providerAttempts:f.state.requests,replays:0,priorCasesPreserved:true,cleanup:true,limits:'Exact CLI and loopback HTTP with controlled allocator/accounting; timeout uses child-only injection; no hosted qualification'}));
});
