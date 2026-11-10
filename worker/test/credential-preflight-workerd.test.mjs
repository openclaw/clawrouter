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
const digest='ab'.repeat(32),other='cd'.repeat(32);
const check=(ok,label)=>{if(!ok)throw Error(label);};
const value=()=>({enabled:true,secretSha256:digest,policyId:'fixture-policy',policyGeneration:'legacy',principalId:null});
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
  const trace={queries:[],writes:0,kv:[]};let mode='healthy',kid='';
  const kv=new Proxy(native,{get(target,key){if(key==='get')return async(name,type)=>{
   const body=await get(name,type);
   if(type==='stream'&&body){const row={byob:false,reads:0,eof:false,unlocked:false,backing:0};trace.kv.push(row);observe(body,row);
    if(mode==='winner')sql.exec('INSERT OR REPLACE INTO proxy_credentials(credential_id,credential_json) VALUES(?,?)',kid,JSON.stringify({...value(),secretSha256:other}));
   }return body;
  };const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  const wrapped=new Proxy(state.storage,{get(target,key){if(key==='sql')return {exec(query,...args){trace.queries.push(query);if(/^(INSERT|UPDATE|DELETE)/.test(query))trace.writes++;return sql.exec(query,...args);}};
   const result=Reflect.get(target,key,target);return typeof result==='function'?result.bind(target):result;}});
  super({storage:wrapped},new Proxy(env,{get(target,key,receiver){return key==='POLICY_KV'?kv:Reflect.get(target,key,receiver);}}));
  this.trace=trace;this.nativeSql=sql;this.configure=(m,id)=>{mode=m;kid=id;trace.queries=[];trace.writes=0;trace.kv=[];};
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture/configure'){const input=await request.json();this.configure(input.mode,input.kid);return new Response('ok');}
  if(path==='/fixture/result')return Response.json({trace:this.trace,rows:[...this.nativeSql.exec('SELECT credential_id,credential_json FROM proxy_credentials')],markers:[...this.nativeSql.exec('SELECT meta_key FROM policy_binding_meta')]});
  return super.fetch(request);
 }
}
export default {async fetch(request,env){
 const mode=new URL(request.url).pathname.slice(1),kid='native'+mode,stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings'));
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
  let runtime, directory, primary, hasPrimary = false;
  const roots = [];
  const own = promise => { const root = promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })); roots.push(root); return root; };
  t.after(async () => {
    const failures = [];
    for (const root of roots) { const result = await root; if (result.failed && !result.observed) failures.push(result.error); }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'fixture cleanup');
  });
  try {
    directory = await mkdtemp(join(tmpdir(), 'credential-preflight-workerd-'));
    const started = await own(startWorkerdFixture(directory, router, upstream, { preventEviction: true }));
    started.observed = true; if (started.failed) throw started.error; runtime = started.value;
    for (const mode of ['healthy', 'disabled', 'winner', 'near', 'unicode']) {
      const operation = await own((async () => {
        const response = await runtime.dispatchFetch('https://fixture/' + mode);
        const text = await response.text(); assert.equal(response.status, 200); return JSON.parse(text);
      })());
      operation.observed = true; if (operation.failed) throw operation.error;
      const result = operation.value;
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
