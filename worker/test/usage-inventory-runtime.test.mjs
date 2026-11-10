import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startWorkerdFixture} from '../../test/helpers/workerd.mjs';
import {requireBaselineCommit} from '../../test/helpers/personal-usage-baseline.mjs';
const baseline='df8c3800fbb413fbe7db6833387a1e885d1379cb';
test('workerd: actual old authority REPLACE captures tenants; owner timers reclaim canceled pending roots without client finally',{timeout:60000},async t=>{
 if(!requireBaselineCommit(t,baseline))return;
 const scratch=resolve('.openclaw/tmp');await mkdir(scratch,{recursive:true});const temporary=await mkdtemp(join(scratch,'usage-inventory-'));let worker;
 try {
  const old=join(temporary,'old');await mkdir(old);
  const archive=execFileSync('git',['archive',baseline,'package.json','worker','shared'],{maxBuffer:32*1024*1024});execFileSync('tar',['-xf','-','-C',old],{input:archive});
  const script=`
import {PolicyBindingIndexObject as Current} from './worker/authority.ts';
import {PolicyBindingIndexObject as Old} from '`+old+`/worker/authority.ts';
export class BudgetLedgerObject {fetch(){return new Response('unused')}}
export class UsageLedgerObject {fetch(){return new Response('unused')}}
export class GrantCredentialObject {fetch(){return new Response('unused')}}
export class PolicyBindingIndexObject extends Current {
 constructor(state,env){super(state,env);this.fixture=state;this.environment=env}
 async fetch(request){
  const path=new URL(request.url).pathname,sql=this.fixture.storage.sql;
  if(path==='/exercise'){
   const old=new Old(this.fixture,this.environment);
   const call=(owner,path,body)=>owner.fetch(new Request('https://internal'+path,{method:'POST',body:JSON.stringify(body)}));
   await call(old,'/policies/initialize-all',[{policyId:'p',policy:{tenantId:'old'}}]);
   await call(old,'/policies/put',{policyId:'p',policy:{tenantId:'new'}});
   const inventory=await (await super.fetch(new Request('https://internal/usage-inventory',{method:'POST',body:'{}'}))).json();
   const base={from:1,to:100,timezone:'UTC',grain:'day',groupBy:'model',rankBy:'calls',filters:{}};
   const binding={actor:'a'.repeat(64),session:'b'.repeat(64),authority:'c'.repeat(64)};
   const reserve=()=>super.fetch(new Request('https://internal/usage-cuts/reserve',{method:'POST',body:JSON.stringify({binding,purpose:'browse',base})}));
   const a=await (await reserve()).json(),b=await (await reserve()).json();
   const busy=(await reserve()).status;
   // Keep this fixture request alive, but never call registry operations during
   // the wait. The owner's real timer must delete the abandoned allocations.
   await new Promise(resolve=>setTimeout(resolve,20100));
   const remaining=this.usageCuts.roots.size;
   return Response.json({inventory,busy,remaining,opaque:a.operation.length===43&&b.operation.length===43,triggerCount:[...sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_inventory_%'")].length});
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch(request)}};
`;
  worker=await startWorkerdFixture(temporary,script,'export default {fetch(){throw new Error("unexpected outbound")}}',{preventEviction:true});
  const response=await worker.dispatchFetch('https://fixture/exercise');assert.equal(response.status,200,await response.clone().text());const proof=await response.json();
  assert.deepEqual(proof.inventory.addresses.map(a=>a.tenantId).sort(),['new','old']);assert.equal(proof.inventory.captureAudit.captureGapObserved,false);
  assert.equal(proof.inventory.historicalLocations,'not_exhaustively_assessed');assert.equal(proof.inventory.formerLocationLateWrites,'not_bounded');
  assert.equal(proof.triggerCount,3);assert.equal(proof.busy,422);assert.equal(proof.remaining,0);assert.equal(proof.opaque,true);
 }finally{await worker?.dispose();await rm(temporary,{recursive:true,force:true})}
});
