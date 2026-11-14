import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { usageReportFixture } from './usage-report-fixture.mjs';
import { projectUsageEvent, ensureUsageReportSchema, queryUsageReport, queryUsageEvents } from '../usage-report-store.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
test('captured old partial round rebuilds its passed prefix before claiming complete',async t=>{
 const f=usageReportFixture(now);t.after(()=>f.db.close());
 for(const [offset,amount] of [undefined,0,null,4,5].entries()){
  const event=f.event(offset+1,{policy_id:'policy',actual_cost_micros:amount,cost_basis:'unpriced_usage',metadata:''});
  f.insert({...event,actual_cost_micros:amount??0});f.db.prepare('UPDATE usage_events SET event_json=? WHERE id=?').run(JSON.stringify(event),event.id);
 }
 f.db.exec(oldPartialSql);
 assert.deepEqual({...f.db.prepare('SELECT * FROM usage_report_migration').get()},{id:1,last_rowid:2,upper_rowid:5,complete:0});
 assert.deepEqual({...f.db.prepare('SELECT * FROM usage_report_coverage').get()},{id:1,generation:0,verified_generation:-1,round_generation:0});
 const snapshot=()=>JSON.stringify(['sqlite_master','usage_events','usage_report_events','usage_report_migration','usage_report_coverage'].map(table=>f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
 const original=f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all(),before=snapshot();
 const preview=f.migrate({batchSize:2});assert.equal(preview.lastRowid,2);assert.equal(preview.upperRowid,5);assert.equal(preview.examined,2);assert.equal(preview.complete,false);assert.equal(snapshot(),before);
 f.db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON usage_report_events WHEN NEW.id='event-2' BEGIN SELECT RAISE(ABORT, 'old round interruption'); END");
 const interrupted=snapshot();assert.throws(()=>f.migrate({apply:true,batchSize:2}),/old round interruption/);assert.equal(snapshot(),interrupted,'failed old-prefix replacement also rolls back schema admission');f.db.exec('DROP TRIGGER fixture_abort');
 ensureUsageReportSchema(f.state.storage.sql);const retained=f.events().events,totals=queryUsageReport(f.state.storage.sql,f.query()).rows;
 assert.deepEqual(retained.map(e=>e.recordedChargeMicros),[null,0,null,4,5]);assert.equal(f.events().historySource,'retained_ledger');
 const progress=[];
 for(let i=0;i<4;i++){
  const step=f.migrate({apply:true,batchSize:2});progress.push([step.lastRowid,step.examined,step.complete]);assert.equal(step.upperRowid,5);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM usage_events WHERE rowid<=5 ORDER BY rowid').all(),original);
  if(step.complete){assert.equal(f.events().historySource,'projection');break;}
  assert.equal(f.events().historySource,'retained_ledger');
  if(i===0){const response=await f.ingest(f.open(),f.event(6,{actual_cost_micros:13}));assert.equal(response.status,200);}
 }
 assert.deepEqual(progress,[[2,2,false],[4,2,false],[5,1,true]],'reopen once; paired current ingestion neither resets nor widens the round');
 assert.deepEqual(f.events().events.filter(e=>e.id!=='event-6'),retained);
 assert.deepEqual(queryUsageReport(f.state.storage.sql,{...f.query(),range:{...f.query().range,from:f.event(5).occurred_at_ms}}).rows,totals);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_report_events WHERE report_format_version IS NULL OR report_format_version!=2').get().n,0);
 const finished=snapshot(),again=f.migrate({apply:true,batchSize:2});assert.equal(again.previouslyComplete,true);assert.equal(again.examined,0);assert.equal(again.complete,true);assert.equal(snapshot(),finished);
});
test('old-format paired tail outside the pinned round cannot be acknowledged complete',async t=>{
 const f=usageReportFixture(now);t.after(()=>f.db.close());for(let i=1;i<=5;i++)f.insert(f.event(i));
 assert.equal(f.migrate({apply:true,batchSize:2}).lastRowid,2);
 const response=await f.ingest(f.open(),f.event(6));assert.equal(response.status,200);
 // An old paired writer acknowledges the generation but omits the format
 // column on INSERT, leaving its post-bound projection at DEFAULT 0.
 f.db.exec("UPDATE usage_report_events SET report_format_version=0 WHERE id='event-6'");
 const canonical=f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all(),retained=f.events().events;
 const preview=f.migrate({batchSize:2});assert.equal(preview.lastRowid,2);assert.equal(preview.upperRowid,6);assert.equal(preview.complete,false);
 const progress=[];for(let i=0;i<4;i++){const step=f.migrate({apply:true,batchSize:2});progress.push([step.lastRowid,step.upperRowid,step.complete]);if(step.complete)break;}
 assert.deepEqual(progress,[[2,6,false],[4,6,false],[6,6,true]]);assert.equal(f.events().historySource,'projection');assert.deepEqual(f.events().events,retained);
 assert.deepEqual(f.db.prepare('SELECT rowid,* FROM usage_events ORDER BY rowid').all(),canonical);
});
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

// Exact reporting schema/state emitted by old 2d5762efdcb8, one batchSize2 over five rows.
const oldPartialSql = `CREATE TRIGGER usage_report_canonical_delete AFTER DELETE ON usage_events BEGIN DELETE FROM usage_report_events WHERE id = OLD.id; UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER usage_report_canonical_insert AFTER INSERT ON usage_events BEGIN UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER usage_report_canonical_update AFTER UPDATE ON usage_events BEGIN DELETE FROM usage_report_events WHERE id = OLD.id; UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END;
CREATE TABLE usage_report_coverage (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991), verified_generation INTEGER NOT NULL, round_generation INTEGER NOT NULL);
CREATE TABLE usage_report_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, principal_key TEXT, provider TEXT NOT NULL, model TEXT, key_id TEXT, status TEXT NOT NULL, call_kind TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER, reasoning_output_tokens INTEGER, lane TEXT NOT NULL, cost_class TEXT NOT NULL, reporting_cost_micros INTEGER, detail_json TEXT NOT NULL);
CREATE TABLE usage_report_migration (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL, upper_rowid INTEGER NOT NULL, complete INTEGER NOT NULL);
CREATE INDEX usage_report_owner_range ON usage_report_events (tenant_id, policy_id, principal_key, occurred_at_ms DESC, id DESC);
CREATE INDEX usage_report_retention ON usage_report_events (occurred_at_ms);
INSERT INTO usage_report_events VALUES ('event-1',1794311976000,'tenant','policy','alice@example.com','anthropic','synthetic-model','key-a','success','generation',1,1,NULL,NULL,NULL,'unattributed','unknown',NULL,'{"id":"event-1","occurredAt":1794311976000,"provider":"anthropic","model":"synthetic-model","keyId":"key-a","capability":"llm.responses","callKind":"generation","status":"success","statusCode":200,"durationMs":null,"inputTokens":1,"outputTokens":1,"cachedInputTokens":null,"cacheWriteInputTokens":null,"reasoningOutputTokens":null,"lane":"unattributed","costClass":"unknown","reportingCostMicros":null,"estimateReason":null,"recordedChargeMicros":0,"costBasis":"unpriced_usage","pricingRef":null,"requestedTier":null,"servedTier":null,"compoundRequestId":null,"compoundStage":null}');
INSERT INTO usage_report_events VALUES ('event-2',1794311953000,'tenant','policy','alice@example.com','google','synthetic-model','key-a','success','generation',2,2,NULL,NULL,NULL,'unattributed','unknown',NULL,'{"id":"event-2","occurredAt":1794311953000,"provider":"google","model":"synthetic-model","keyId":"key-a","capability":"llm.responses","callKind":"generation","status":"success","statusCode":200,"durationMs":null,"inputTokens":2,"outputTokens":2,"cachedInputTokens":null,"cacheWriteInputTokens":null,"reasoningOutputTokens":null,"lane":"unattributed","costClass":"unknown","reportingCostMicros":null,"estimateReason":null,"recordedChargeMicros":0,"costBasis":"unpriced_usage","pricingRef":null,"requestedTier":null,"servedTier":null,"compoundRequestId":null,"compoundStage":null}');
INSERT INTO usage_report_migration VALUES (1,2,5,0);
INSERT INTO usage_report_coverage VALUES (1,0,-1,0);`;
