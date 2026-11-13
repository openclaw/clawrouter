import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { usageReportFixture } from './usage-report-fixture.mjs';
import { projectUsageEvent, ensureUsageReportSchema, queryUsageReport, queryUsageEvents } from '../usage-report-store.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
test('recorded accounting is explicit nullable field evidence, independent from price classification', t => {
  const f = usageReportFixture(now); t.after(() => f.db.close());
  const cases = [[undefined,null], [null,null], ['12',null], [-1,null], [0.5,null], [Number.MAX_SAFE_INTEGER+1,null], [0,0], [12,12]];
  for (const [i,[amount,expected]] of cases.entries()) {
    const event = f.event(i, { policy_id: "policy", actual_cost_micros: amount, cost_basis: 'unpriced_usage' });
    assert.equal(projectUsageEvent(event).recordedChargeMicros, expected);
    // Canonical NOT NULL and JSON evidence intentionally disagree.
    f.insert({ ...event, actual_cost_micros: 0 });
    f.db.prepare('UPDATE usage_events SET event_json = ? WHERE id = ?').run(JSON.stringify(event), event.id);
  }
  ensureUsageReportSchema(f.state.storage.sql);
  const retained = queryUsageEvents(f.state.storage.sql, f.query(), 100);
  assert.deepEqual(retained.events.map(e => e.recordedChargeMicros), cases.map(c => c[1]));
  const retainedRows = queryUsageReport(f.state.storage.sql, f.query()).rows;
  const total = retainedRows.filter(r => r.dimension === 'total');
  assert.equal(total.reduce((s,r) => s+r.recordedChargeMicros,0),12);
  assert.equal(total.reduce((s,r) => s+r.chargeReportedCalls,0),2);
  f.migrate({apply:true});
  const projected = queryUsageEvents(f.state.storage.sql, f.query(),100);
  assert.equal(projected.historySource,'projection');
  assert.deepEqual(projected.events, retained.events);
  assert.deepEqual(queryUsageReport(f.state.storage.sql,f.query()).rows,retainedRows);
});
test('pre-v2 projection forces full retained source rather than old detail missing-to-zero', t => {
  const f=usageReportFixture(now);t.after(()=>f.db.close());
  const event=f.event(0, {policy_id:"policy"}); f.insert(event); f.migrate({apply:true});
  f.db.exec('UPDATE usage_report_events SET report_format_version = 0');
  const result=queryUsageEvents(f.state.storage.sql,f.query(),10);
  assert.equal(result.historySource,'retained_ledger');
  assert.equal(result.events[0].id,event.id);
});

test('unsafe combined recorded amount is unavailable rather than rounded success',t=>{
  const f=usageReportFixture(now);t.after(()=>f.db.close());
  for(let i=1;i<=2;i++) f.insert(f.event(i,{actual_cost_micros:Number.MAX_SAFE_INTEGER,cost_basis:'unpriced_usage'}));
  ensureUsageReportSchema(f.state.storage.sql);
  assert.throws(()=>queryUsageReport(f.state.storage.sql,f.query()),e=>e.kind==='unavailable'&&e.reason==='capacity');
  f.migrate({apply:true,batchSize:1});f.migrate({apply:true,batchSize:1});
  assert.throws(()=>queryUsageReport(f.state.storage.sql,f.query()),e=>e.kind==='unavailable'&&e.reason==='capacity');
});

for(const format of ['missing',0,null])test('completed obsolete projection '+format+' reopens only on explicit bounded apply',t=>{
 const f=usageReportFixture(now);t.after(()=>f.db.close());
 for(let i=1;i<=5;i++)f.insert(f.event(i));f.migrate({apply:true});
 // A completed older writer has unchanged coverage and saved watermark, but
 // historical detail no longer qualifies for the current reader.
 if(format==='missing')f.db.exec('DROP INDEX usage_report_old_format; ALTER TABLE usage_report_events DROP COLUMN report_format_version; ALTER TABLE usage_report_events DROP COLUMN recorded_charge_micros');
 else f.db.prepare('UPDATE usage_report_events SET report_format_version = ?').run(format);
 f.db.exec("UPDATE usage_report_events SET detail_json = json_remove(detail_json, '$.recordedChargeMicros')");
 const snapshot=()=>JSON.stringify({schema:f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),ledger:f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all(),projection:f.db.prepare('SELECT * FROM usage_report_events ORDER BY id').all(),migration:f.db.prepare('SELECT * FROM usage_report_migration').all(),coverage:f.db.prepare('SELECT * FROM usage_report_coverage').all()});
 const before=snapshot(),canonical=f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all();
 const preview=f.migrate({batchSize:2});assert.equal(preview.previouslyComplete,false);assert.equal(preview.examined,2);assert.equal(preview.lastRowid,2);assert.equal(preview.complete,false);assert.equal(snapshot(),before,'dry-run changes neither schema nor metadata');
 ensureUsageReportSchema(f.state.storage.sql);const retained=f.events().events;assert.equal(f.events().historySource,'retained_ledger');
 const old=f.db.prepare('SELECT COUNT(*) AS n FROM usage_report_events WHERE report_format_version IS NULL OR report_format_version != 2').get().n;assert.equal(old,5);
 assert.throws(()=>f.migrate({apply:true,afterRowid:2}),/persisted watermark/);
 // A failed replacement must restore both projection data and progress.
 f.db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON usage_report_events WHEN NEW.id = 'event-2' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
 const interrupted=snapshot();assert.throws(()=>f.migrate({apply:true,batchSize:2}),/fixture interruption/);assert.equal(snapshot(),interrupted);f.db.exec('DROP TRIGGER fixture_abort');
 for(const [last,examined,complete] of [[2,2,false],[4,2,false],[5,1,true]]){
  const step=f.migrate({apply:true,batchSize:2});assert.equal(step.previouslyComplete,false);assert.equal(step.lastRowid,last);assert.equal(step.examined,examined);assert.equal(step.complete,complete);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all(),canonical);
  assert.equal(f.events().historySource,complete?'projection':'retained_ledger');assert.deepEqual(f.events().events,retained);
 }
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_report_events WHERE report_format_version = 2').get().n,5);
 const finished=snapshot(),again=f.migrate({apply:true,batchSize:2});assert.equal(again.previouslyComplete,true);assert.equal(again.examined,0);assert.equal(again.complete,true);assert.equal(snapshot(),finished);
});
