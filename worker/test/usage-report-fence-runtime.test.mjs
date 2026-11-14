import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { requireBaselineCommit } from '../../test/helpers/personal-usage-baseline.mjs';

const baseline='6fceb88d4d165ba66281c931b74c3047772a2ef5';
test('workerd SQLite: current/actual old ledger preserves stamps, monotone read writes and conservative deletes', {timeout:60000},async t=>{
  if(!requireBaselineCommit(t,baseline)) return;
  const scratch=resolve('.openclaw/tmp'); await mkdir(scratch,{recursive:true});
  const temporary=await mkdtemp(join(scratch,'usage-fence-'));let worker;
  try {
    const old=join(temporary,'old');await mkdir(old);
    const archive=execFileSync('git',['archive',baseline,'package.json','worker','shared'],{maxBuffer:32*1024*1024});
    execFileSync('tar',['-xf','-','-C',old],{input:archive});
    const script=`
export { BudgetLedgerObject } from './worker/ledgers.ts';
export class PolicyBindingIndexObject {fetch(){return new Response('unused')}}
export class GrantCredentialObject {fetch(){return new Response('unused')}}
import {UsageLedgerObject as Current} from './worker/ledgers.ts';
import {UsageLedgerObject as Old} from '${old}/worker/ledgers.ts';
import {openUsageReportCut, queryUsageEvents} from './worker/usage-report-store.ts';
import {validateUsageVisibility} from './worker/usage-report-visibility.ts';
import {parseUsageReportRange, reportRetentionMs} from './worker/usage-report-range.ts';
export class UsageLedgerObject extends Current {
 constructor(state){super(state);this.fixture=state;}
 async fetch(){
  const state=this.fixture,sql=state.storage.sql,now=Date.now();
  const old=new Old(state);
  const event=id=>({type:'clawrouter.usage.v1',id,occurred_at_ms:now-1000,tenant_id:'tenant',policy_id:'policy',key_id:'policy',principal_id:'alice@example.com',provider:'openai',status:'success',input_tokens:1,output_tokens:1,total_tokens:2,actual_cost_micros:0,cost_basis:'unpriced_usage'});
  const ingest=(ledger,e)=>ledger.fetch(new Request('https://ledger/ingest',{method:'POST',body:JSON.stringify(e)}));
  await ingest(old,event('old-first'));
  const query={tenantId:'tenant',policyId:'policy',principal:'alice@example.com',range:parseUsageReportRange(new URLSearchParams(),now),groupBy:'model',filters:{}};
  const cut=state.storage.transactionSync(()=>openUsageReportCut(sql,query.range.from));
  const seq=()=>[...sql.exec('SELECT seq FROM usage_report_visibility')][0].seq;
  const beforeLate=seq();await ingest(old,event('old-late'));const afterLate=seq();
  await ingest(old,event('old-late'));const duplicateSeq=seq();
  const ids=state.storage.transactionSync(()=>queryUsageEvents(sql,query,10,undefined,false,cut)).events.map(e=>e.id);
  // Old cleanup has no transaction marker; inject an expired retained row, then
  // exercise the historical class's real cleanup through its snapshot endpoint.
  await ingest(old,event('old-expiring'));
  sql.exec('UPDATE usage_events SET occurred_at_ms = ? WHERE id = ?',now-reportRetentionMs-1,'old-expiring');
  const deleting=state.storage.transactionSync(()=>openUsageReportCut(sql,query.range.from));
  await old.fetch(new Request('https://ledger/snapshot?events=admin&policy_id=policy'));
  let oldDelete;try{validateUsageVisibility(sql,deleting,query.range.from)}catch(e){oldDelete=e.reason}
  const futureClock=now+100;
  state.storage.transactionSync(()=>openUsageReportCut(sql,query.range.from,futureClock));
  state.storage.transactionSync(()=>openUsageReportCut(sql,query.range.from,now-100));
  const savedClock=[...sql.exec('SELECT observed_clock FROM usage_report_visibility')][0].observed_clock;
  const sqlClockNumeric=typeof [...sql.exec("SELECT CAST(strftime('%s','now') AS INTEGER) AS now")][0].now==='number';
  sql.exec('UPDATE usage_report_visibility SET arrival_rows = 100000');
  const response=await super.fetch(new Request('https://ledger/ingest',{method:'POST',body:JSON.stringify(event('overflow'))}));
  const receipt=await response.json();let overflow;try{openUsageReportCut(sql,query.range.from)}catch(e){overflow=e.reason}
  const triggerCount=[...sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_visibility_%'")].length;
  return Response.json({ids,beforeLate,afterLate,duplicateSeq,oldDelete,futureClock,savedClock,sqlClockNumeric,canonicalOverflowStored:receipt.outcome==='stored',overflow,triggerCount});
 }
}
export default {fetch(request,env){return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName('isolated')).fetch(request)}};
`;
    worker=await startWorkerdFixture(temporary,script,'export default {fetch(){throw new Error("unexpected outbound")}}');
    const response=await worker.dispatchFetch('https://fixture/');
    assert.equal(response.status,200,await response.clone().text());const proof=await response.json();
    assert.deepEqual(proof.ids,['old-first']);
    assert.equal(proof.afterLate,proof.beforeLate+1);
    assert.equal(proof.duplicateSeq,proof.afterLate);
    assert.equal(proof.oldDelete,'mutation');
    assert.equal(proof.futureClock,proof.savedClock);
    assert.equal(proof.sqlClockNumeric,true);
    assert.equal(proof.canonicalOverflowStored,true);
    assert.equal(proof.overflow,'capacity');
    assert.equal(proof.triggerCount,3);
  } finally {await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});
