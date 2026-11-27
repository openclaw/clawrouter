import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { usageReportFixture } from "./usage-report-fixture.mjs";
import { eventsCsv, reportCsv } from "../../admin/src/personal-usage.ts";
const { anthropicHardBudgetGuardReceipt, softHostedToolReceipt } = await import("./usage-report-cost-fixture.mjs");
function records(csv) {
  // All generated fields in this fixture lack embedded quotes/newlines; parse
  // quoted CSV cells without converting empty amounts to numeric zero.
  const rows = csv.split(String.fromCharCode(13, 10)).map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"')));
  return rows.slice(1).map(values=>Object.fromEntries(rows[0].map((key,i)=>[key,values[i]])));
}
test("real Anthropic guard reservation and soft tool component keep honest costs through ingestion, old history, migration and exports",async()=>{
 const {event:guard,reservation}=await anthropicHardBudgetGuardReceipt();
 const soft=await softHostedToolReceipt();
 const now=Math.max(guard.occurred_at_ms,soft.occurred_at_ms)+1000;
 const f=usageReportFixture(now);
 f.insert(guard);f.insert(soft);
 const original=f.db.prepare("SELECT id, actual_cost_micros, event_json FROM usage_events ORDER BY id").all();
 f.open();
 const check=fixture=>{
  const report=fixture.report(),page=fixture.events(fixture.query(),100).events;
  assert.equal(report.metrics.calls,2);
  assert.deepEqual(report.costs.find(c=>c.costClass==="unknown"),{lane:"api",costClass:"unknown",calls:1,amountMicros:0});
  assert.equal(report.costs.find(c=>c.costClass==="partial").amountMicros,56);
  const retained=page.find(e=>e.id===guard.id),partial=page.find(e=>e.id===soft.id);
  assert.equal(retained.costClass,"unknown");assert.equal(retained.reportingCostMicros,null);assert.equal(retained.recordedChargeMicros,reservation.reservedMicros);
  assert.equal(partial.costClass,"partial");assert.equal(partial.reportingCostMicros,56);assert.equal(partial.recordedChargeMicros,56);
  const eventRows=records(eventsCsv(page));
  const unknownExport=eventRows.find(e=>e.id===guard.id),partialExport=eventRows.find(e=>e.id===soft.id);
  assert.equal(unknownExport.reportingCostMicros,"");assert.equal(unknownExport.recordedChargeMicros,String(reservation.reservedMicros));
  assert.equal(partialExport.reportingCostMicros,"56");assert.equal(partialExport.recordedChargeMicros,"56");
  const groups=records(reportCsv(report));
  assert.equal(groups.find(g=>g.group===guard.model).api_unknown_reporting_amount_usd,"");
  assert.equal(groups.find(g=>g.group===soft.model).api_partial_reporting_amount_usd,String(56/1000000));
  assert.ok(!eventsCsv(page).includes("private-fixture-handle"));
  return {report,page};
 };
 const before=check(f);assert.equal(before.report.historySource,"retained_ledger");
 const preview=f.migrate({batchSize:1});assert.equal(preview.dryRun,true);
 assert.deepEqual(f.db.prepare("SELECT id, actual_cost_micros, event_json FROM usage_events ORDER BY id").all(),original);
 while(!f.migrate({apply:true,batchSize:1}).complete) {check(f);}
 const after=check(f);assert.equal(after.report.historySource,"projection");assert.deepEqual(after.page,before.page);
 assert.deepEqual(f.db.prepare("SELECT id, actual_cost_micros, event_json FROM usage_events ORDER BY id").all(),original);
 const g=usageReportFixture(now),ledger=g.open();
 await g.ingest(ledger,guard);await g.ingest(ledger,soft);
 assert.equal(check(g).report.historySource,"projection");
 assert.deepEqual(g.db.prepare("SELECT actual_cost_micros FROM usage_events ORDER BY id").all().map(r=>r.actual_cost_micros).sort((a,b)=>a-b),[56,reservation.reservedMicros].sort((a,b)=>a-b));
});
