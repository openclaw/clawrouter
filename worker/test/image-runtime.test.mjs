import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const router = [
 'import worker from "./worker/index.ts";',
 'export * from "./worker/index.ts";',
 'import { BudgetLedgerObject as Budget, usageStub, ingestUsage } from "./worker/ledgers.ts";',
 'import { sha256Hex } from "./worker/utils.ts";',
 'export class BudgetLedgerObject extends Budget { constructor(state) { super(state); this.sql=state.storage.sql; } async fetch(request) { if(new URL(request.url).pathname==="/rows") return Response.json([...this.sql.exec("SELECT * FROM budget_reservations")]); return super.fetch(request); } }',
 'export default {...worker, async fetch(request,env,context) {',
 ' const path=new URL(request.url).pathname;',
 ' if(path==="/fixture/setup") {',
 '  const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));',
 '  for(const [path,body] of [["/policies/initialize-all",[{policyId:"fixture",policy:{enabled:true,generation:"g1",providers:["openai"],tenantId:"tenant",monthlyBudgetMicros:20000000,retainRequestContent:false}}]],["/credentials/initialize-all",[{credentialId:"fixture",credential:{enabled:true,secretSha256:await sha256Hex("fixture-key"),policyId:"fixture",policyGeneration:"g1"}}]],["/connections/initialize-all",[{providerId:"openai",enabled:true,monthlyBudgetMicros:20000000}]]]) {const r=await stub.fetch("https://owner"+path,{method:"POST",body:JSON.stringify(body)});if(!r.ok)return r;}',
 '  return Response.json({ok:true});',
 ' }',
 ' if(path==="/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(new URL(request.url).searchParams.get("name"))).fetch("https://budget/rows");',
 ' if(path==="/fixture/usage") return usageStub(env,"tenant","fixture").fetch("https://usage/snapshot?events=admin");',
 // Make settlement publication directly acknowledged, not an eventual queue race.
 ' return worker.fetch(request,{...env,USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);',
 '}};',
].join("\n");
const upstream = [
 'export default { async fetch(request) {',
 ' if(request.url!=="https://api.openai.com/v1/images/generations")throw Error("unexpected fixture upstream");',
 ' const body=await request.json();if(body.model!=="gpt-image-2.5-flare"||body.stream===true)throw Error("unexpected image contract");',
 ' const prefix=JSON.stringify({created:1,data:[{b64_json:"A".repeat(3*1024*1024)}]}).slice(0,-1);',
 ' const suffix=",\\"usage\\":"+JSON.stringify({input_tokens:12,input_tokens_details:{text_tokens:12,image_tokens:0},output_tokens:100,total_tokens:112})+"}";',
 ' const bytes=new TextEncoder().encode(prefix+suffix);let offset=0;',
 ' return new Response(new ReadableStream({pull(c){if(offset===bytes.length)return c.close();const end=Math.min(bytes.length,offset+4096);c.enqueue(bytes.subarray(offset,end));offset=end;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});',
 '}};',
].join("\n");

test("real workerd image routes deliver multi-megabyte base64 and settle both durable SQL ledgers",{timeout:60000},async()=>{
 // Fresh checkouts do not contain the ignored evidence directory. Own its setup.
 const scratch=join(process.cwd(),".artifacts");
 await mkdir(scratch,{recursive:true});
 const temporary=await mkdtemp(join(scratch,"image-runtime-"));let worker;
 try{
  worker=await startWorkerdFixture(temporary,router,upstream);
  assert.equal((await worker.dispatchFetch("https://router.example/fixture/setup")).status,200);
  for(const path of ["/v1/images/generations","/v1/native/openai/v1/images/generations","/v1/proxy/openai/images_generations"]){
   const body={model:path.includes("/native/")?"gpt-image-2.5-flare":"openai/gpt-image-2.5-flare",prompt:"synthetic fixture",n:1,size:"1024x1024",quality:"low"};
   const response=await worker.dispatchFetch("https://router.example"+path,{method:"POST",headers:{authorization:"Bearer clawrouter-live-fixture-fixture-key","content-type":"application/json"},body:JSON.stringify(path.includes("/proxy/")?{body}:body)});
   assert.equal(response.status,200,await errorBody(response));
   const result=await response.json();assert.equal(result.data[0].b64_json,"A".repeat(3*1024*1024));assert.equal(result.usage.total_tokens,112);
  }
  const snapshot=await(await worker.dispatchFetch("https://router.example/fixture/usage")).json();
  assert.equal(snapshot.summary.requestCount,3);assert.equal(snapshot.summary.actualCostMicros,9180);
  for(const e of snapshot.events){assert.equal(e.actual_cost_micros,3060);assert.deepEqual(e.image_usage,{text_input_tokens:12,image_input_tokens:0,image_output_tokens:100});assert.equal(e.content_ref,null);}
  for(const name of ["tenant:fixture","provider:openai"]){
   const rows=await(await worker.dispatchFetch("https://router.example/fixture/rows?name="+name)).json();
   assert.equal(rows.length,3);for(const row of rows){assert.equal(row.settled,1);assert.equal(row.reserved_micros,3060);}
  }
 }finally{await worker?.dispose();await rm(temporary,{recursive:true,force:true});}
});
async function errorBody(response){return response.ok?"":await response.clone().text();}
