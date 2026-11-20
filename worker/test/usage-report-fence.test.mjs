import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { usageReportFixture } from './usage-report-fixture.mjs';
import { ensureUsageReportSchema, openUsageReportCut, insertUsageReportEvent, withUsageReportPair, queryUsageEvents, queryUsageReport } from '../usage-report-store.ts';
import { maintainUsageVisibility, validateUsageVisibility, withUsageRetention } from '../usage-report-visibility.ts';
import { reportCutTtlMs, reportRetentionMs } from '../usage-report-range.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
function fixture(t) {
  t.mock.method(Date,'now',()=>now);
  const f=usageReportFixture(now); t.after(()=>f.db.close());
  const original=f.event; f.event=(i,extra={})=>original(i,{policy_id:'policy',...extra});
  return f;
}
const sql = f => f.state.storage.sql;
const state = f => f.db.prepare('SELECT * FROM usage_report_visibility').get();
const open = f => openUsageReportCut(sql(f),f.query().range.from);
const page = (f,cut,before) => queryUsageEvents(sql(f),f.query(),100,before,false,cut).events.map(e=>e.id);
const outcome = (kind,reason) => e=>e.kind===kind && e.reason===reason;
for(const projection of [false,true]) test('cut excludes late inserts ahead and behind keyset; pre-upgrade rows remain visible: '+projection,t=>{
  const f=fixture(t); f.insert(f.event(1)); f.insert(f.event(3));
  ensureUsageReportSchema(sql(f)); if(projection) f.migrate({apply:true});
  const cut=open(f); assert.deepEqual(page(f,cut),['event-1','event-3']);
  f.insert(f.event(0)); f.insert(f.event(2));
  // Old writers invalidate projection coverage: a projection cut restarts, never switches.
  if(projection) { assert.throws(()=>page(f,cut),outcome('restart','source')); return; }
  assert.deepEqual(page(f,cut),['event-1','event-3']);
  assert.deepEqual(page(f,cut,{at:f.event(1).occurred_at_ms,id:'event-1'}),['event-3']);
  assert.equal(queryUsageReport(sql(f),f.query(),cut).rows.filter(r=>r.dimension==='total').reduce((s,r)=>s+r.calls,0),2);
  assert.deepEqual(page(f,open(f)),['event-0','event-1','event-2','event-3']);
});
test('duplicate canonical insert does not stamp; UPDATE and DELETE invalidate even unchanged timestamp',t=>{
  const f=fixture(t);ensureUsageReportSchema(sql(f));f.insert(f.event(1));
  const cut=open(f), before=state(f).seq;
  f.db.prepare('INSERT INTO usage_events SELECT * FROM usage_events WHERE id = ? ON CONFLICT(id) DO NOTHING').run('event-1');
  assert.equal(state(f).seq,before); assert.deepEqual(page(f,cut),['event-1']);
  f.db.exec("UPDATE usage_events SET status = 'success' WHERE id = 'event-1'");
  assert.throws(()=>page(f,cut),outcome('restart','mutation'));
  const next=open(f);f.db.exec("DELETE FROM usage_events WHERE id = 'event-1'");
  assert.throws(()=>page(f,next),outcome('restart','mutation'));
  assert.equal(state(f).arrival_rows,0);
});
test('retention marker protects only below-marker deletion; old-writer delete is conservative',t=>{
  const f=fixture(t);f.insert(f.event(1,{occurred_at_ms:now-reportRetentionMs-1}));ensureUsageReportSchema(sql(f));
  const cut=open(f);
  f.state.storage.transactionSync(()=>withUsageRetention(sql(f),now-reportRetentionMs,()=>f.db.exec('DELETE FROM usage_events')));
  validateUsageVisibility(sql(f),cut,f.query().range.from);
  assert.equal(state(f).retention_marker,null);
  f.insert(f.event(2,{occurred_at_ms:now-reportRetentionMs-1})); const next=open(f);
  f.db.exec('DELETE FROM usage_events');
  assert.throws(()=>validateUsageVisibility(sql(f),next,f.query().range.from),outcome('restart','mutation'));
});
test('local clock never moves backward; equality expires before checkpoint pruning',t=>{
  const f=fixture(t);ensureUsageReportSchema(sql(f));f.insert(f.event(1));
  maintainUsageVisibility(sql(f),now); const cut=open(f);
  f.insert(f.event(2));
  validateUsageVisibility(sql(f),cut,f.query().range.from,now-1000);
  assert.equal(state(f).observed_clock,now);
  maintainUsageVisibility(sql(f),now+reportCutTtlMs-1);
  assert.equal(state(f).arrival_rows,2);
  assert.throws(()=>validateUsageVisibility(sql(f),cut,f.query().range.from,now+reportCutTtlMs),outcome('restart','expired'));
  maintainUsageVisibility(sql(f),now+reportCutTtlMs);
  assert.deepEqual(f.db.prepare('SELECT id FROM usage_report_arrivals').all().map(r=>r.id),['event-2']);
  const next=openUsageReportCut(sql(f),f.query().range.from,now+reportCutTtlMs);
  validateUsageVisibility(sql(f),next,f.query().range.from,now);
});
test('retention clock jumps cannot silently amend a saved floor',t=>{
  const f=fixture(t);ensureUsageReportSchema(sql(f));
  const cut=openUsageReportCut(sql(f),0,now);
  assert.equal(cut.floor,now-reportRetentionMs+reportCutTtlMs);
  assert.throws(()=>validateUsageVisibility(sql(f),cut,cut.floor-1),outcome('restart','mutation'));
  f.db.prepare('UPDATE usage_report_visibility SET retention_cutoff = ?').run(cut.floor+1);
  assert.throws(()=>validateUsageVisibility(sql(f),cut,cut.floor),outcome('restart','mutation'));
});
for(const assignment of ['arrival_rows = 100000','arrival_bytes = 16777216','seq = 9007199254740991','seq = -1','arrival_rows = NULL']) test('metadata fault disables reporting without dropping canonical insert: '+assignment,t=>{
  const f=fixture(t);ensureUsageReportSchema(sql(f));f.insert(f.event(1)); const cut=open(f);
  f.db.exec('UPDATE usage_report_visibility SET '+assignment);
  assert.doesNotThrow(()=>f.insert(f.event(2)));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n,2);
  assert.throws(()=>open(f),outcome('unavailable','capacity'));
  assert.doesNotThrow(()=>f.insert(f.event(3)));
  maintainUsageVisibility(sql(f),now);
  assert.equal(state(f).arrival_rows,0);assert.equal(state(f).arrival_bytes,0);
  assert.throws(()=>page(f,cut),outcome('restart','mutation'));
  assert.deepEqual(page(f,open(f)),['event-1','event-2','event-3']);
});
test('drain is bounded at 1000; migration and trigger continuity reject cuts',t=>{
  const f=fixture(t);ensureUsageReportSchema(sql(f));
  f.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1001) INSERT INTO usage_report_arrivals SELECT i,'a'||i FROM n");
  f.db.exec('UPDATE usage_report_visibility SET usable=0, arrival_rows=1001, arrival_bytes=4898');
  maintainUsageVisibility(sql(f),now);assert.equal(state(f).usable,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_report_arrivals').get().n,1);
  maintainUsageVisibility(sql(f),now);assert.equal(state(f).usable,1);
  f.db.exec('UPDATE usage_attribution_migration SET complete=0');
  assert.throws(()=>open(f),outcome('unavailable','migration'));
  f.db.exec('UPDATE usage_attribution_migration SET complete=1');const cut=open(f);
  f.db.exec('UPDATE usage_attribution_migration SET complete=0');
  assert.throws(()=>page(f,cut),outcome('unavailable','migration'));
  f.db.exec('UPDATE usage_attribution_migration SET complete=1');
  f.db.exec('DROP TRIGGER usage_visibility_insert_v1');
  assert.throws(()=>page(f,cut),outcome('restart','source'));
  ensureUsageReportSchema(sql(f));assert.throws(()=>open(f),outcome('unavailable','capacity'));
  maintainUsageVisibility(sql(f),now);assert.throws(()=>page(f,cut),outcome('restart','mutation'));
});

test('paired new ingestion preserves projection cut membership; retained source stays pinned after qualification',t=>{
  const f=fixture(t);f.insert(f.event(1));ensureUsageReportSchema(sql(f));
  const retained=open(f);f.migrate({apply:true});
  assert.equal(queryUsageEvents(sql(f),f.query(),10,undefined,false,retained).historySource,'retained_ledger');
  const projected=open(f);assert.equal(projected.source,'projection');
  for(const i of [0,2]) f.state.storage.transactionSync(()=>withUsageReportPair(sql(f),()=>{f.insert(f.event(i));insertUsageReportEvent(sql(f),f.event(i));}));
  assert.deepEqual(page(f,projected),['event-1']);
  assert.deepEqual(page(f,projected,{at:f.event(0).occurred_at_ms,id:'event-0'}),['event-1']);
  assert.equal(queryUsageReport(sql(f),f.query(),projected).rows.filter(r=>r.dimension==='total').reduce((n,r)=>n+r.calls,0),1);
  assert.deepEqual(page(f,open(f)),['event-0','event-1','event-2']);
});
