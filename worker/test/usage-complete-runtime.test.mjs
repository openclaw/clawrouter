import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startWorkerdFixture} from '../../test/helpers/workerd.mjs';

test('workerd actual private DO path: complete ranks, equal-ID pages, retained export and final source validation',{timeout:60000},async t=>{
 const scratch=resolve('.openclaw/tmp');await mkdir(scratch,{recursive:true});const temporary=await mkdtemp(join(scratch,'usage-complete-'));let worker;
 try{
  worker=await startWorkerdFixture(temporary,
  `import {UsageLedgerObject as Current} from './worker/ledgers.ts';
  export {BudgetLedgerObject} from './worker/ledgers.ts';
  export {PolicyBindingIndexObject} from './worker/authority.ts';
  export class GrantCredentialObject {fetch(){return new Response('unused')}}
  import {readCompleteUsage,exportCompleteUsage} from './worker/usage-report.ts';
  import {usageStub} from './worker/ledgers.ts';
  import {authorityCall} from './worker/authority.ts';
  export class UsageLedgerObject extends Current {
   constructor(state){super(state);this.fixture=state;}
   async fetch(request){const path=new URL(request.url).pathname;
    if(path==='/seed'){
     const {now,policyId}=await request.json();
     for(let i=0;i<260;i++)await super.fetch(new Request('https://private/ingest',{method:'POST',body:JSON.stringify({type:'clawrouter.usage.v1',id:'e'+String(i).padStart(3,'0'),occurred_at_ms:now-1000,tenant_id:'tenant',policy_id:policyId,principal_id:'alice@example.com',provider:'openai',status:'success',model:'model'+i,input_tokens:1,output_tokens:2,total_tokens:3,actual_cost_micros:7,cost_basis:'manifest_pricing',grant_lane:'api_key'})}));
     if(policyId==='p1')this.fixture.storage.sql.exec('UPDATE usage_report_events SET report_format_version=1');
     return Response.json({seeded:true});
    }
    if(path==='/mutate'){this.fixture.storage.sql.exec("UPDATE usage_events SET status='denied' WHERE id='e000'");return new Response('done');}
    if(path==='/plan')return Response.json([...this.fixture.storage.sql.exec("EXPLAIN QUERY PLAN SELECT id,occurred_at_ms FROM usage_events INDEXED BY usage_events_report_scope WHERE tenant_id=? AND policy_id=? AND occurred_at_ms>=? AND occurred_at_ms<? AND NOT EXISTS(SELECT 1 FROM usage_report_arrivals a WHERE a.id=usage_events.id AND a.seq>?) ORDER BY occurred_at_ms DESC,id COLLATE BINARY DESC LIMIT 101",'tenant','p1',0,Date.now(),999)]);
    return super.fetch(request);
   }
  }
  export default {async fetch(_request,env){
   const now=Date.now(),query={from:now-3600000,to:now,timezone:'UTC',grain:'day',groupBy:'model',rankBy:'calls',filters:{}};
   await authorityCall(env,'/policies/initialize-all',[{policyId:'p0',policy:{tenantId:'tenant',enabled:true}},{policyId:'p1',policy:{tenantId:'tenant',enabled:true}}]);
   for(const policyId of ['p0','p1'])await usageStub(env,'tenant',policyId).fetch('https://private/seed',{method:'POST',body:JSON.stringify({now,policyId})});
   const verify=async()=>({actor:'a'.repeat(64),sessionBinding:'b'.repeat(64),audience:'admin',session:{authenticated:true,auth:'local',role:'admin',email:'fixture@example.com',groups:[],tenantId:'tenant',subject:null,contentRetentionDisabled:false}});
   const summary=await readCompleteUsage(env,verify,{kind:'report',intent:'summary',query});
   const opened=await readCompleteUsage(env,verify,{kind:'report',intent:'browse',query});
   if(opened.kind!=='complete')return Response.json({summary,opened});
   const report=opened.value,one=await readCompleteUsage(env,verify,{kind:'events',cut:report.cut,query:report.query,pageSize:1});
   const two=one.kind==='complete'?await readCompleteUsage(env,verify,{kind:'events',cut:report.cut,query:report.query,pageSize:1,cursor:one.value.nextCursor}):one;
   const exported=await exportCompleteUsage(env,verify,report.query);
   await usageStub(env,'tenant','p1').fetch('https://private/mutate');
   const invalid=await readCompleteUsage(env,verify,{kind:'validate',cut:report.cut,query:report.query});
   const plan=await (await usageStub(env,'tenant','p1').fetch('https://private/plan')).json();
   await readCompleteUsage(env,verify,{kind:'release',cut:report.cut,query:report.query});
   return Response.json({summary,report,one,two,exportKind:exported.kind,exportRows:exported.kind==='complete'?exported.value.events.length:null,invalid,plan});
  }}`,'export default {fetch(){throw Error("unexpected outbound")}}');
  const at=performance.now(),response=await worker.dispatchFetch('https://fixture/');assert.equal(response.status,200,await response.clone().text());const proof=await response.json();
  assert.equal(proof.summary.kind,'complete',JSON.stringify(proof));assert.equal(proof.summary.value.cut,null);assert.equal(proof.report.metrics.calls,520);assert.equal(proof.report.rank.distinctGroups,260);assert.equal(proof.report.remainder.metrics.calls,320);
  assert.equal(proof.one.kind,'complete');assert.equal(proof.two.kind,'complete');assert.equal(proof.one.value.events[0].id,'e259');assert.equal(proof.two.value.events[0].id,'e259');assert.notEqual(proof.one.value.nextCursor,proof.two.value.nextCursor);
  assert.equal(proof.exportKind,'complete');assert.equal(proof.exportRows,520);assert.equal(proof.invalid.kind,'restart');assert.equal(proof.invalid.reason,'mutation');
  assert.ok(proof.plan.some(p=>/usage_events_report_scope/.test(p.detail)));assert.ok(proof.plan.some(p=>/SEARCH a USING.*INDEX/.test(p.detail)));
  t.diagnostic(JSON.stringify({qualification:'local workerd SQLite, not deployed capacity/auth',rows:520,shards:2,elapsedMs:Math.round(performance.now()-at),plan:proof.plan}));
 }finally{await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});
