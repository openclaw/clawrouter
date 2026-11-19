import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const router = String.raw`
import {PolicyBindingIndexObject as Base} from './worker/authority.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import {preflightCredential,consumeCredentialPreflight,releaseCredentialPreflight,releaseCredentialPreflightContinuation} from './worker/credential-preflight.ts';
import {bodyBudgetCharged} from './worker/body-budget.ts';
import {identitySourceBudget,isIdentityFailure} from './worker/identity-admission.ts';
import {credentialPreflightHeader,credentialPreflightPath,credentialPreflightVersion} from './worker/credential-preflight-protocol.ts';
const digest='ab'.repeat(32),other='cd'.repeat(32);
const check=(ok,label)=>{if(!ok)throw Error(label);};
const value=()=>({enabled:true,secretSha256:digest,policyId:'fixture-policy',policyGeneration:'legacy',principalId:null});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function observe(body,row){
 const get=body.getReader.bind(body);
 body.getReader=options=>{row.byob=options?.mode==='byob';const reader=get(options),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);
  reader.read=(...args)=>{row.reads++;const actual=read(...args);void actual.then(part=>{if(part.done)row.eof=true;if(part.value)row.backing=Math.max(row.backing,part.value.buffer.byteLength);},()=>{});return actual;};
  reader.releaseLock=()=>{unlock();row.unlocked=!body.locked;};return reader;
 };return body;
}
export class PolicyBindingIndexObject extends Base {
 constructor(state,env){
  const native=env.POLICY_KV,get=native.get.bind(native),sql=state.storage.sql;
  const trace={queries:[],writes:0,kv:[],intakes:0,kvAttempts:0};let mode='healthy',kid='',released=false;
  const gates=[],arrivals=[];
  const wake=()=>{for(const resolve of arrivals.splice(0))resolve();};
  const release=()=>{if(released)return;released=true;for(const gate of gates)gate.resolve();wake();};
  const kv=new Proxy(native,{get(target,key){if(key==='get')return async(name,type)=>{
   trace.kvAttempts++;
   if(mode==='saturation'&&type==='stream'&&/^credentials\/nativesaturation-[012]$/.test(name)){
    // Each gate is created in THIS invocation, before its ORIGINAL native KV
    // acquisition. Other fixture requests only signal pure gates; no I/O moves.
    const gate=deferred();gates.push(gate);if(released)gate.resolve();if(gates.length===3)wake();await gate.promise;
   }
   const body=await get(name,type);
   if(type==='stream'&&body){const row={byob:false,reads:0,eof:false,unlocked:false,backing:0};trace.kv.push(row);observe(body,row);
    if(mode==='winner')sql.exec('INSERT OR REPLACE INTO proxy_credentials(credential_id,credential_json) VALUES(?,?)',kid,JSON.stringify({...value(),secretSha256:other}));
   }return body;
  };const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  const wrapped=new Proxy(state.storage,{get(target,key){if(key==='sql')return {exec(query,...args){trace.queries.push(query);if(/^(INSERT|UPDATE|DELETE)/.test(query))trace.writes++;return sql.exec(query,...args);}};
   const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  super({storage:wrapped},new Proxy(env,{get(target,key,receiver){return key==='POLICY_KV'?kv:Reflect.get(target,key,receiver);}}));
  const intake=this.credentialPreflight;
  this.credentialPreflight=(...args)=>{trace.intakes++;return Reflect.apply(intake,this,args);};
  this.trace=trace;this.nativeSql=sql;this.releaseHeld=release;
  this.waitHeld=()=>gates.length===3||released?Promise.resolve():new Promise(resolve=>arrivals.push(resolve));
  this.heldState=()=>({gates:gates.length,released,charged:this.preflightArena?.charged??0});
  this.configure=(m,id)=>{mode=m;kid=id;trace.queries=[];trace.writes=0;trace.kv=[];trace.intakes=0;trace.kvAttempts=0;released=false;gates.length=0;};
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/configure'){const input=await request.json();if(input.release)this.releaseHeld();else this.configure(input.mode,input.kid);return new Response('ok');}
  if(path==='/fixture/result'){
   if(new URL(request.url).searchParams.has('held'))await this.waitHeld();
   return Response.json({trace:this.trace,held:this.heldState(),rows:[...this.nativeSql.exec('SELECT credential_id,credential_json FROM proxy_credentials')],markers:[...this.nativeSql.exec('SELECT meta_key FROM policy_binding_meta')]});
  }
  return super.fetch(request);
 }
}
async function saturation(env,stub){
 const roots=[],operations=[];let hasPrimary=false,primary,open,closed=false,cleanupPromise;
 const own=original=>{const root={outcome:original.then(value=>({failed:false,value}),error=>({failed:true,error})),used:false};roots.push(root);return root;};
 const take=async root=>{const result=await root.outcome;root.used=true;if(result.failed)throw result.error;return result.value;};
 const rpc=async(path,init)=>{
  const response=await take(own(stub.fetch('https://authority'+path,init)));
  const text=await take(own(response.text()));return {status:response.status,text};
 };
 const configure=input=>rpc('/fixture/configure',{method:'POST',body:JSON.stringify(input)});
 const snapshot=async held=>{const reply=await rpc('/fixture/result'+(held?'?held=1':''),{method:'POST'});check(reply.status===200,'fixture snapshot status');return JSON.parse(reply.text);};
 // The cleanup owner exists BEFORE any operation. It releases first, observes
 // every original outcome, then releases every returned proof, even on failure.
 const cleanup=()=>cleanupPromise??=(async()=>{
  const failures=[];
  if(open&&!closed)try{closed=true;open.close();}catch(error){failures.push(error);}
  try{const reply=await take(own(configure({release:true})));check(reply.status===200,'fixture release status');}catch(error){failures.push(error);}
  for(const root of operations){
   const result=await root.outcome;
   if(!result.failed&&result.value.outcome==='matched')try{releaseCredentialPreflight(result.value.proof);}catch(error){failures.push(error);}
  }
  // Parents can enroll transport/body children until they settle. Classify
  // failures only after ALL roots join, so propagated origins count once.
  for(let i=0;i<roots.length;i++)await roots[i].outcome;
  for(const root of roots){const result=await root.outcome;if(result.failed&&!root.used){root.used=true;failures.push(result.error);}}
  return failures;
 })();
 const baseline=bodyBudgetCharged();let before,after,denied;
 try{
  for(let i=0;i<3;i++)await take(own(env.POLICY_KV.put('credentials/nativesaturation-'+i,JSON.stringify(value()))));
  const configured=await take(own(configure({mode:'saturation',kid:''})));check(configured.status===200,'fixture configure status');
  for(let i=0;i<3;i++)operations.push(own(preflightCredential(env,'nativesaturation-'+i,digest)));
  const arrival=own(snapshot(true));
  const first=await Promise.race([arrival.outcome.then(result=>({arrival:true,root:arrival,result})),...operations.map(root=>root.outcome.then(result=>({arrival:false,root,result})))]);
  if(first.result.failed){first.root.used=true;throw first.result.error;}
  check(first.arrival,'preflight fulfilled before all KV gates');before=await take(arrival);
  check(before.held.gates===3&&!before.held.released&&before.held.charged===96*1024*1024,'three genuinely admitted DO tickets');
  check(bodyBudgetCharged()-baseline===96*1024*1024,'three Worker tickets remain funded');
  check(before.trace.intakes===3&&before.trace.kvAttempts===3&&before.trace.kv.length===0&&before.trace.writes===0,'held before original KV acquisition');
  // This is a NEW fixture-owned open producer through the real native DO stub,
  // not a replacement for a healthy platform body or the Worker helper's RPC.
  const body=new ReadableStream({type:'bytes',start(controller){open=controller;controller.enqueue(new TextEncoder().encode(JSON.stringify({credentialId:'nativesaturation-fourth',secretSha256:digest,source:identitySourceBudget()})));},cancel(){closed=true;}});
  denied=await take(own(rpc(credentialPreflightPath,{method:'POST',headers:{[credentialPreflightHeader]:credentialPreflightVersion},body})));
  const error=JSON.parse(denied.text);
  check(denied.status===503&&error.error?.code==='identity_admission_unavailable'&&error.error?.message==='Identity admission failed (limit)','native no-intake capacity denial');
  after=await take(own(snapshot(false)));
  check(after.held.charged===before.held.charged&&!after.held.released,'denial retains all admitted DO charges');
  check(after.trace.intakes===before.trace.intakes&&after.trace.kvAttempts===before.trace.kvAttempts&&after.trace.kv.length===0,'fourth has zero application intake/read/parse/KV');
  check(after.trace.queries.length===before.trace.queries.length&&after.trace.writes===0&&after.rows.length===0&&after.markers.length===0,'fourth has zero credential SQL/seed');
  check(bodyBudgetCharged()-baseline===96*1024*1024,'fourth bypasses Worker capacity without releasing prior tickets');
 }catch(error){hasPrimary=true;primary=error;}
 const failures=await cleanup();
 if(hasPrimary||failures.length){if(hasPrimary&&!failures.length)throw primary;throw new AggregateError(hasPrimary?[primary,...failures]:failures,'saturation fixture cleanup');}
 for(const root of operations){const result=await take(root);check(result.outcome==='matched','released preflight matched');}
 const final=await take(own(snapshot(false)));
 check(final.held.charged===0&&bodyBudgetCharged()===baseline,'all original operations and proofs released');
 check(final.trace.intakes===3&&final.trace.kv.length===3&&final.trace.writes===3,'only admitted operations complete');
 for(const row of final.trace.kv)check(row.byob&&row.eof&&row.unlocked&&row.backing<=16384,'original native KV completion');
 return {status:denied.status,held:before.held.charged,afterDenied:after.held.charged,final:final.held.charged,intakes:final.trace.intakes,kv:final.trace.kv.length,writes:final.trace.writes,workerCharged:bodyBudgetCharged()-baseline};
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),kid='native'+mode,stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
 if(mode==='saturation'&&request.method==='DELETE'){
  const response=await stub.fetch('https://authority/fixture/configure',{method:'POST',body:JSON.stringify({release:true})});
  await response.text();check(response.status===200,'host release status');return new Response('released');
 }
 if(mode==='saturation')return Response.json(await saturation(env,stub));
 if(mode==='unicode'){
  let points=0,cased=0,ignored=0,space=0;
  for(let cp=0;cp<=0x10ffff;cp++){
   const text=String.fromCodePoint(cp),wire=new TextEncoder().encode(text).length,lower=text.toLowerCase();
   check(lower.length<=wire,'whole lowercase coupling');check(text.trim().length<=text.length,'whole trim coupling');
   const isCased=/\p{Cased}/u.test(text),isIgnored=/\p{Case_Ignorable}/u.test(text);
   check(('A'+text+'Σ').toLowerCase().endsWith(isCased||isIgnored?'ς':'σ'),'whole preceding context');
   check(('AΣ'+text).toLowerCase().charCodeAt(1)===(!isCased||isIgnored?0x3c2:0x3c3),'whole following context');
   const escaped=JSON.stringify(text);check(JSON.parse(escaped).toLowerCase().length<=new TextEncoder().encode(escaped).length,'source escape coupling');
   if(isCased)cased++;if(isIgnored)ignored++;if(/\p{White_Space}/u.test(text))space++;points++;
  }
  check('ΟΣ'.toLowerCase()==='ος'&&'ΟΣΑ'.toLowerCase()==='οσα','default final sigma');
  const dotted=String.fromCodePoint(0x69,0x307);check(dotted.length===2&&dotted.charCodeAt(1)===0x307,'actual combining dot');
  check('İ'.toLowerCase()===dotted,'default expansion');
  // Build ONE JSON backslash explicitly; String.raw preserves the inner source.
  const escaped=JSON.parse(String.fromCharCode(34,92)+'ud800'+String.fromCharCode(34));
  check(escaped.length===1&&escaped.charCodeAt(0)===0xd800&&new TextEncoder().encode(escaped).length===3,'lone surrogate');
  const invalid=new Uint8Array([0xff]),replacement=new TextDecoder().decode(invalid);
  check(replacement===String.fromCodePoint(0xfffd)&&replacement.charCodeAt(0)===0xfffd&&replacement.toLowerCase().length<=invalid.byteLength,'invalid utf8');
  for(const text of [String.fromCharCode(0xd800),String.fromCharCode(0xdfff),'  İΣ'+String.fromCodePoint(0x307)+'  ',String.fromCharCode(0xfeff)+'A'+String.fromCharCode(0xfeff)]){
   const wire=new TextEncoder().encode(text).length,lower=text.toLowerCase(),trimmed=text.trim();
   check(lower.length<=wire&&trimmed.length<=wire,'single transform source coupling');
   check(lower.length+trimmed.length<=2*wire+64,'separate two-transform allowance');
  }
  return Response.json({points,cased,ignored,space,ok:true});
 }
 let raw=JSON.stringify({...value(),...(mode==='disabled'?{enabled:false}:{})});
 if(mode==='near'){const record=value();record.policyId='';record.policyId='x'.repeat(1048576-new TextEncoder().encode(JSON.stringify(record)).length);raw=JSON.stringify(record);check(new TextEncoder().encode(raw).length===1048576,'record R');}
 await env.POLICY_KV.put('credentials/'+kid,raw);
 await (await stub.fetch('https://authority/fixture/configure',{method:'POST',body:JSON.stringify({mode,kid})})).text();
 const baseline=bodyBudgetCharged();let result,proof,continuation,failure=false;
 try {
  result=await preflightCredential(env,kid,digest);
  if(result.outcome==='matched'){
   proof=result.proof;check(bodyBudgetCharged()>baseline&&bodyBudgetCharged()-baseline<1048576,'funded scalar proof');
   let rejected=false;try{consumeCredentialPreflight(structuredClone(proof),env,kid,digest);}catch(error){rejected=isIdentityFailure(error);}check(rejected,'clone cannot mint');
   continuation=consumeCredentialPreflight(proof,env,kid,digest);proof=undefined;
   check(bodyBudgetCharged()-baseline===32*1024*1024,'atomic full transfer');
  }
 }catch(error){failure=isIdentityFailure(error);if(!failure)throw error;}
 finally{if(continuation)releaseCredentialPreflightContinuation(continuation);else if(proof)releaseCredentialPreflight(proof);}
 const sql=await (await stub.fetch('https://authority/fixture/result',{method:'POST'})).json();
 check(bodyBudgetCharged()===baseline,'original operations retired');
 return Response.json({outcome:result?.outcome??null,failure,charged:bodyBudgetCharged()-baseline,sql});
}};
`;
const upstream = `export default {fetch(){throw Error('preflight must not dispatch a provider');}}`;

test('inactive private preflight: actual Workerd original KV/RPC bytes + SQLite winner/zero-write denial + runtime mapping qualifier', { timeout: 120000 }, async t => {
  let runtime, directory, primary, hasPrimary = false, saturationPending = false;
  const roots = [];
  const own = promise => { const root = promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })); roots.push(root); return root; };
  t.after(async () => {
    const failures = [];
    // Registered before startup: release the SAME pure fixture gates before
    // joining an unfinished originating request. No foreign request I/O is used.
    if (runtime && saturationPending) try {
      const response = await runtime.dispatchFetch('https://fixture/saturation', { method: 'DELETE' });
      await response.text(); assert.equal(response.status, 200);
    } catch (error) { failures.push(error); }
    for (const root of roots) { const result = await root; if (result.failed && !result.observed) failures.push(result.error); }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'fixture cleanup');
  });
  try {
    directory = await mkdtemp(join(tmpdir(), 'credential-preflight-workerd-'));
    const started = await own(startWorkerdFixture(directory, router, upstream, { preventEviction: true }));
    started.observed = true; if (started.failed) throw started.error; runtime = started.value;
    for (const mode of ['saturation', 'healthy', 'disabled', 'winner', 'near', 'unicode']) {
      if (mode === 'saturation') saturationPending = true;
      const operation = await own((async () => {
        const response = await runtime.dispatchFetch('https://fixture/' + mode);
        const text = await response.text(); assert.equal(response.status, 200); return JSON.parse(text);
      })());
      operation.observed = true; if (operation.failed) throw operation.error;
      const result = operation.value;
      if (mode === 'saturation') {
        saturationPending = false;
        assert.deepEqual(result, { status: 503, held: 96 * 1024 * 1024, afterDenied: 96 * 1024 * 1024, final: 0, intakes: 3, kv: 3, writes: 3, workerCharged: 0 });
        continue;
      }
      if (mode === 'unicode') { assert.equal(result.ok, true); assert.equal(result.points, 0x110000); assert.ok(result.cased > 0 && result.ignored > 0 && result.space > 0); continue; }
      assert.equal(result.charged, 0); assert.equal(result.failure, mode === 'near');
      assert.equal(result.outcome, mode === 'healthy' || mode === 'disabled' ? 'matched' : mode === 'winner' ? 'invalid' : null);
      assert.equal(result.sql.trace.writes, mode === 'healthy' || mode === 'disabled' ? 1 : 0);
      const queries = result.sql.trace.queries;
      assert.equal(queries.some(query => /access_policies|access_users|provider_connections|grant_pools/.test(query)), false);
      for (let i = 0; i < queries.length; i++) if (queries[i].startsWith('SELECT credential_json')) assert.ok(queries[i - 1].startsWith('SELECT length'));
      assert.equal(result.sql.trace.kv.length, 1);
      for (const row of result.sql.trace.kv) { assert.equal(row.byob, true); assert.equal(row.eof, true); assert.equal(row.unlocked, true); assert.ok(row.reads > 0 && row.backing > 0 && row.backing <= 16384); }
      if (mode === 'near') { assert.equal(result.sql.rows.some(row => row.credential_id === 'nativenear'), false); assert.equal(result.sql.markers.length, 0); }
    }
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});
