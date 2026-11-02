import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { startWorkerdFixture } from "./workerd.mjs";
import { personalUsageBaseline, router, upstream } from "./personal-usage-upgrade.mjs";

const oldCandidate = "3cb032679669ff263d4099eafd485ad4f96e0f00";
const cookie = "clawrouter_session=" + "a".repeat(64);
/** Persisted old candidate -> original writer -> repaired candidate, then repeat
 * after the repaired schema has installed rollback-safe coverage tracking. */
export async function provePersonalUsageRollback({ artifactPath } = {}) {
 const scratch=resolve(".openclaw/tmp");await mkdir(scratch,{recursive:true});const temporary=await mkdtemp(join(scratch,"rollback-upgrade-"));
 const sources={baseline:join(temporary,"baseline"),old:join(temporary,"old"),current:resolve(".")};
 for(const [kind,sha]of[["baseline",personalUsageBaseline],["old",oldCandidate]]){await mkdir(sources[kind]);const bytes=execFileSync("git",["archive",sha,"package.json","worker","shared"],{maxBuffer:32*1024*1024});execFileSync("tar",["-xf","-","-C",sources[kind]],{input:bytes});}
 const now=Date.now(),d=new Date(now),offset=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),12)-now;
 const cases=[];let worker;
 try{
  for(const historical of [0,3]){
   const options={persistencePath:join(temporary,"state-"+historical),preventEviction:true};
   const start=async kind=>{await worker?.dispose();worker=null;worker=await startWorkerdFixture(temporary,router(sources[kind],kind!=="baseline",offset),upstream,options);};
   const read=(path,init={})=>worker.dispatchFetch("https://router.example"+path,{...init,headers:{cookie,...init.headers}});
   const json=async path=>{const r=await read(path),text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);};
   const state=()=>json("/_proof/state");
   const send=async()=>{const r=await read("/v1/responses",{method:"POST",headers:{authorization:"Bearer clawrouter-live-owner-synthetic-key","content-type":"application/json"},body:JSON.stringify({model:"openai/gpt-6.1-sol",input:"synthetic rollback fixture",max_output_tokens:32})});assert.equal(r.status,200,await r.clone().text());await r.arrayBuffer();};
   const until=async count=>{const end=Date.now()+20000;for(;;){const s=await state();if(s.rawCount===count&&s.budget.spentMicros===count*17)return s;assert.ok(Date.now()<end,"baseline queue/debit did not converge");await new Promise(r=>setTimeout(r,20));}};
   const migrate=async apply=>{const r=await read("/_proof/migrate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(apply?{apply:true,batchSize:2}:{batchSize:2})});assert.equal(r.status,200,await r.clone().text());return r.json();};
   const repair=async()=>{const batches=[];for(let n=0;n<20;n++){const b=await migrate(true);batches.push({examined:b.examined,lastRowid:b.lastRowid,upperRowid:b.upperRowid,complete:b.complete});if(b.complete)return batches;}throw new Error("bounded explicit migration did not complete");};
   const assertUnchanged=(a,b)=>{assert.equal(b.rawCount,a.rawCount);assert.equal(b.rawDigest,a.rawDigest);assert.equal(b.budget.spentMicros,a.budget.spentMicros);assert.equal(b.settingsDigest,a.settingsDigest);assert.deepEqual(b.config,a.config);};
   const owned=async expected=>{const report=await json("/v1/session/usage/report?days=7");const q=new URLSearchParams({from:new Date(report.range.from).toISOString(),to:new Date(report.range.to).toISOString(),timezone:report.range.timezone});const events=await json("/v1/session/usage/events?"+q);assert.equal(report.metrics.calls,expected);assert.equal(events.events.length,expected);assert.equal(report.historyComplete,true);assert.equal(events.historyComplete,true);assert.equal(events.events.reduce((sum,e)=>sum+e.recordedChargeMicros,0),expected*17);return{report,events};};
   await start(historical?"baseline":"old");assert.equal((await read("/_proof/setup")).status,200);
   for(let n=0;n<historical;n++)await send();await until(historical);
   if(historical)await start("old");
   if(historical)await repair();
   const initial=await owned(historical);assert.equal(initial.report.projectionComplete,true);const initialState=await state();assert.equal(initialState.projection,historical);
   const cycles=[];
   for(let cycle=0;cycle<2;cycle++){
    const expected=historical+cycle+1;
    await start("baseline");await send();const before=await until(expected);assert.equal(before.projection,expected-1);
    let oldOmission;
    if(cycle===0){await start("old");const wrong=await json("/v1/session/usage/report?days=7");assert.equal(wrong.metrics.calls,expected-1);assert.equal(wrong.historyComplete,true);assert.equal(wrong.projectionComplete,true);oldOmission={calls:wrong.metrics.calls,historyComplete:wrong.historyComplete,projectionComplete:wrong.projectionComplete};assertUnchanged(before,await state());}
    await start("current");
    const fallback=await owned(expected);assert.equal(fallback.report.projectionComplete,false);assert.equal(fallback.report.historySource,"retained_ledger");assert.equal(fallback.events.projectionComplete,false);assert.equal(fallback.events.historySource,"retained_ledger");
    const afterRead=await state();assertUnchanged(before,afterRead);assert.equal(afterRead.projection,before.projection,"reads must not backfill");
    const preview=await migrate(false);assert.equal(preview.dryRun,true);const afterPreview=await state();assertUnchanged(before,afterPreview);assert.equal(afterPreview.projection,before.projection);
    const batches=await repair();const indexed=await owned(expected);assert.equal(indexed.report.projectionComplete,true);assert.equal(indexed.report.historySource,"projection");assert.equal(indexed.events.projectionComplete,true);
    const afterApply=await state();assertUnchanged(before,afterApply);assert.equal(afterApply.projection,expected);assert.deepEqual(indexed.events.events.map(e=>e.id).sort(),fallback.events.events.map(e=>e.id).sort());
    cycles.push({phase:cycle===0?"pre-tracking old candidate gap":"rollback after repaired coverage tracking",oldCandidateOmission:oldOmission,canonicalCalls:expected,projectionBeforeRead:before.projection,reportCallsBeforeApply:fallback.report.metrics.calls,eventCallsBeforeApply:fallback.events.events.length,historyComplete:fallback.report.historyComplete,sourceBeforeApply:fallback.report.historySource,projectionCompleteBeforeApply:fallback.report.projectionComplete,previewReadOnly:true,applyBatches:batches,projectionAfterApply:afterApply.projection,sourceAfterApply:indexed.report.historySource,rawDigestUnchanged:true,settingsUnchanged:true,budgetMicros:afterApply.budget.spentMicros,recordedChargesUnchanged:true});
   }
   cases.push({initialState:historical?"completed historical projection":"initially empty complete projection",initialCalls:historical,initialProjection:initialState.projection,cycles});
   await worker.dispose();worker=null;
  }
  const files=["worker/index.ts","worker/ledgers.ts","worker/usage-report-store.ts","worker/usage-report.ts","worker/usage-report-session.ts","test/helpers/personal-usage-rollback-runtime.mjs","test/helpers/personal-usage-upgrade.mjs","test/helpers/workerd.mjs","worker/test/usage-report-rollback-runtime.test.mjs"];
  const sourceHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash("sha256").update(await readFile(f)).digest("hex")])));
  const proof={baseline:personalUsageBaseline,oldCandidate,synthetic:true,productionTrafficOrCredentials:false,actualShippedProxyQueueAndSessionRoutes:true,persistedRestarts:true,noAutomaticBackfill:true,cases,sourceHashes,limits:["Synthetic provider/session setup only; not real billing or Cloudflare JWT verification","Old 3cb omission is an intentional exact-source red control; repaired source executes after it on the same persisted resources","UTC-noon offset keeps all runtime versions in the same live calendar window"]};
  if(artifactPath)await writeFile(artifactPath,JSON.stringify(proof,null,2)+"\n");return proof;
 }finally{await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
}
