import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const stages=['export_resolution','https_provider','https_callback','http_deny','container_start'];
// Controlled Container API failures against an imported source OR exact packaged
// entrypoint. Does not assert Cloudflare supports these operations remotely.
export async function exerciseStartupEntrypoint(Slot){
 const worker='clawrouter-native-qualification-abcdef012345',origin='https://'+worker+'.fixture.workers.dev',sha='c'.repeat(64),secret='sensitive-fixture-native-token';
 const receipts=[],effects=[],allow={},deny={},env={LARGE_HTTP_ORIGIN:origin,CLAWROUTER_PUBLIC_ORIGIN:origin,LARGE_HTTP_CAPACITY:'8',LARGE_HTTP_TESTING:'1'};
 env.NATIVE_REHEARSAL=JSON.stringify({schema:1,worker,origin,createdAt:Date.now()-1000,expiresAt:Date.now()+600000,maxStarts:40,maxRequests:64});
 env.NATIVE_REHEARSAL_STATE={getByName:()=>({fetch:async(url,r)=>{receipts.push({op:new URL(url).pathname,...JSON.parse(r.body)});return Response.json({accepted:true});}})};
 const options={image:'cloudflare/debian-trixie',enableInternet:true,instance:'standard-1',labels:{slot:'0',generation:'1',build:sha},env:{LARGE_HTTP_SLOT:'0',LARGE_HTTP_GENERATION:'1',LARGE_HTTP_RUNTIME_SHA:sha,LARGE_HTTP_RUNTIME_TOKEN:secret},entrypoint:['node','--input-type=module','-e','/* unchanged production bootstrap */']};
 let started,fail,monitorError,monitorThrows=false;const pending=[];
 const effect=stage=>{effects.push(stage);if(fail===stage)throw Error('unsupported operation '+secret);};
 const slot=Object.create(Slot.prototype);slot.env=env;
 slot.ctx={waitUntil:p=>pending.push(p),exports:{NativeRehearsalEgress:()=>{effect('export_resolution');return allow;},NativeRehearsalDeny:()=>deny},container:{
  interceptOutboundHttps:async(host,binding)=>{assert.equal(binding,allow);effect(host==='api.openai.com'?'https_provider':'https_callback');},
  interceptAllOutboundHttp:async binding=>{assert.equal(binding,deny);effect('http_deny');},
  start:value=>{effect('container_start');started=value;},
  monitor:()=>{if(monitorThrows)throw monitorError;return monitorError?Promise.reject(monitorError):Promise.resolve();}
 }};
 await slot.startContainer(options);
 await Promise.all(pending.splice(0));
 assert.deepEqual(effects,stages);assert.equal(started.enableInternet,false);assert.equal(started.env.NODE_EXTRA_CA_CERTS,'/etc/cloudflare/certs/cloudflare-containers-ca.crt');assert.equal(started.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
 assert.deepEqual(started.labels,options.labels);assert.equal(started.env.LARGE_HTTP_RUNTIME_SHA,sha);assert.ok(started.entrypoint[3].endsWith(options.entrypoint[3]));
 // Execute the exact generated prefix, including after esbuild packaging. This
 // catches serialization/import defects before any fleet or hosted activation.
 const smoke=spawnSync(process.execPath,[...started.entrypoint.slice(1,3),'globalThis.fetch=async()=>new Response("{}");'+started.entrypoint[3]+';process.exit(0);'],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}});
 assert.equal(smoke.status,0,smoke.stderr);assert.equal(smoke.stdout,'');
 assert.deepEqual(receipts.filter(x=>x.op==='/startup').map(({stage,outcome})=>[stage,outcome]),stages.flatMap(stage=>[[stage,'started'],[stage,'completed']]));
 assert.equal(receipts.at(-1).outcome,'exited');assert.equal(receipts.at(-1).exitCode,0);
 // Capture structured native failures without error text, stack or native env.
 for(const [error,category,exitCode,sync] of [[Object.assign(Error('process failed '+secret),{exitCode:1}),'process_exit',1,false],[Error('internal error '+secret),'internal',null,false],[Error('monitor() cannot be called on a container that is not running.'),'no_container',null,true]]){
  monitorError=error;monitorThrows=sync;receipts.length=0;effects.length=0;
  await slot.startContainer(options);await Promise.all(pending.splice(0));
  assert.deepEqual(receipts.at(-1),{op:'/monitor',slot:0,generation:1,runtimeSha:sha,outcome:'rejected',category,name:'Error',exitCode});
  assert.ok(!JSON.stringify(receipts).includes(secret));
 }
 monitorError=undefined;monitorThrows=false;
 for(const stage of stages){
  fail=stage;receipts.length=0;effects.length=0;started=undefined;
  await assert.rejects(slot.startContainer(options));
  assert.deepEqual(effects,stages.slice(0,stages.indexOf(stage)+1));assert.equal(started,undefined);
  assert.deepEqual(receipts.at(-1),{op:'/startup',slot:0,generation:1,runtimeSha:sha,stage,outcome:'failed',error:'unsupported'});
  assert.ok(!JSON.stringify(receipts).includes(secret));
 }
 // Journal failure prevents the next native effect and never claims it failed.
 fail=undefined;receipts.length=0;effects.length=0;
 env.NATIVE_REHEARSAL_STATE={getByName:()=>({fetch:async(url,r)=>{const v=JSON.parse(r.body);receipts.push({op:new URL(url).pathname,...v});return new Response('{}',{status:v.stage==='https_provider'&&v.outcome==='completed'?503:200});}})};
 await assert.rejects(slot.startContainer(options),/rehearsal_startup_refused/);assert.deepEqual(effects,stages.slice(0,2));assert.equal(receipts.at(-1).outcome,'completed');
 // Pool polling may later move on to stopped; preserve an observed failure in
 // the fixture journal instead of relying on sampled logs or the public pool.
 let early=true;
 receipts.length=0;env.NATIVE_REHEARSAL_STATE={getByName:()=>({fetch:async(url,r)=>{receipts.push({op:new URL(url).pathname,...JSON.parse(r.body)});const recorded=!early;early=false;return Response.json({recorded});}})};
 const parent=Object.getPrototypeOf(Slot.prototype),original=parent.fetch;
 let state={generation:1,runtimeSha:sha,phase:'starting',reason:'none',token:secret,control:{slot:0}};
 try{
  let observed;
  parent.fetch=async r=>Response.json(new URL(r.url).pathname==='/control/state'?state:observed);
  const request=()=>new Request('https://slot/control/state',{method:'POST'});
  assert.equal((await(await slot.fetch(request())).json()).token,secret);
  await slot.fetch(request());assert.equal(receipts.length,2,'a pre-intent observation must not be cached');await slot.fetch(request());assert.equal(receipts.length,2);
  // Status observes the failure before retirement. The separate identity read
  // may already show a later generation; it must not overwrite that observation.
  observed={generation:1,phase:'failed',reason:'readiness_native_identity'};state={...state,generation:2,phase:'stopped',reason:'none'};
  await slot.fetch(new Request('https://slot/control/status',{method:'POST'}));assert.equal(receipts.at(-1).generation,1);
  await slot.fetch(request());assert.equal(receipts.at(-1).generation,2);
  assert.deepEqual(receipts.map(x=>[x.phase,x.reason]),[['starting','none'],['starting','none'],['failed','readiness_native_identity'],['stopped','none']]);
  // NativeSlot.status can report blocked/absent:false without persisting that
  // phase or including a reason. A state read may still say destroyed.
  observed={generation:1,phase:'blocked',absent:false};state={...state,generation:1,phase:'destroyed',reason:'none'};
  await slot.fetch(new Request('https://slot/control/status',{method:'POST'}));
  assert.equal(receipts.at(-1).phase,'blocked');assert.equal(receipts.at(-1).reason,'unreported');
  await slot.fetch(request());assert.equal(receipts.at(-1).phase,'destroyed');
  assert.ok(!JSON.stringify(receipts).includes(secret));
 }finally{parent.fetch=original;}
 return {startupSuccess:1,injectedStageFailures:stages.length,receiptFailureStopsEffects:true,readinessObservations:5,cloudflareContainerProof:false};
}
