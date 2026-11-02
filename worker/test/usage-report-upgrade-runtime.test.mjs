import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { personalUsageBaseline, provePersonalUsageUpgrade } from "../../test/helpers/personal-usage-upgrade.mjs";
test("workerd baseline upgrade preserves authenticated personal history, settings/debits and revocation without backfill", {timeout:120000},async t=>{
 try{execFileSync("git",["cat-file","-e",personalUsageBaseline+"^{commit}"],{stdio:"ignore"});}catch{t.skip("Fetch exact baseline "+personalUsageBaseline+" to run native upgrade proof");return;}
 const proof=await provePersonalUsageUpgrade();assert.equal(proof.actualShippedSessionAuthorization,true);assert.equal(proof.originalUsageSettingsAndDebitsPreserved,true);
});
