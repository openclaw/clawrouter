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
