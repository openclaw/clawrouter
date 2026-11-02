import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { provePersonalUsageRollback } from "../../test/helpers/personal-usage-rollback-runtime.mjs";
test("persisted candidate/baseline/candidate keeps empty and completed projection history after old-writer gaps",{timeout:120000},async t=>{
 for(const sha of["6fceb88d4d165ba66281c931b74c3047772a2ef5","3cb032679669ff263d4099eafd485ad4f96e0f00"]){try{execFileSync("git",["cat-file","-e",sha+"^{commit}"],{stdio:"ignore"});}catch{t.skip("Fetch exact rollback source "+sha);return;}}
 const p=await provePersonalUsageRollback();assert.equal(p.cases.length,2);for(const c of p.cases){assert.equal(c.cycles.length,2);for(const row of c.cycles){assert.equal(row.reportCallsBeforeApply,row.canonicalCalls);assert.equal(row.eventCallsBeforeApply,row.canonicalCalls);assert.equal(row.sourceBeforeApply,"retained_ledger");assert.equal(row.sourceAfterApply,"projection");assert.equal(row.rawDigestUnchanged,true);assert.equal(row.recordedChargesUnchanged,true);}}
});
