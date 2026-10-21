import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// A real workerd multipart -> upstream Worker -> SQL Durable Object boundary.
test("multipart transcription traverses workerd with exact bytes, authority and durable fixed accounting", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-stt-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.sqlFixture = state.storage.sql; }
  async fetch(request) {
    if(new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.sqlFixture.exec("SELECT settled, dispatch_started, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
export default handler;`, `
export class Calls {
  constructor(state) { this.state=state; }
  async fetch(request) {
    const key=new URL(request.url).pathname;
    const calls=(await this.state.storage.get(key)) ?? 0;
    if(request.method === "POST") await this.state.storage.put(key,calls+1);
    return Response.json({calls:request.method === "POST" ? calls+1 : calls});
  }
}
export default { async fetch(request,env) {
  const counter=env.CALLS.get(env.CALLS.idFromName("calls"));
  if(new URL(request.url).pathname !== "/v1/audio/transcriptions") throw new Error("wrong endpoint");
  const credential=request.headers.get("authorization");
  if(!["Bearer fixture-upstream-key","Bearer fixture-pool-upstream-key"].includes(credential) || request.headers.has("x-api-key")) throw new Error("wrong credential provenance");
  const form = await request.formData(); const file = form.get("file");
  if(form.get("model") !== "gpt-4o-transcribe" || form.get("language") !== "en" || !["synthetic prompt é","synthetic prompt é delayed","synthetic prompt é soft"].includes(form.get("prompt"))) throw new Error("wrong fields");
  if(!(file instanceof File) || !({"sample.wav":["audio/wav","application/octet-stream"],"voice.ogg":["audio/ogg"],"voice.flac":["audio/flac"]}[file.name] ?? []).includes(file.type) || JSON.stringify([...new Uint8Array(await file.arrayBuffer())]) !== "[0,255,128,42]") throw new Error("file corrupted");
  // Separate the racing soft request from the confirmed-disconnect receipt.
  await counter.fetch("https://fixture/"+(form.get("prompt") === "synthetic prompt é soft" ? "soft-calls" : "calls"),{method:"POST"});
  if(form.get("prompt") === "synthetic prompt é delayed") await new Promise(resolve=>setTimeout(resolve,500));
  return Response.json({text:"synthetic transcript",credentialSource:credential === "Bearer fixture-pool-upstream-key" ? "pool" : "environment",usage:{type:"tokens",input_tokens:14,input_token_details:{audio_tokens:12,text_tokens:2},output_tokens:45,total_tokens:59}});
} };`, {upstreamDurableObjects:{CALLS:{className:"Calls",useSQLite:true}}});
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const secret = "stt-fixture-secret";
    await kv.put("policies/fixture", JSON.stringify({ enabled:true, generation:"g1", providers:["openai"], monthlyBudgetMicros:1_000_000, requestCostMicros:200, retainRequestContent:false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled:true, secretSha256:createHash("sha256").update(secret).digest("hex"), policyId:"fixture", policyGeneration:"g1" }));
    await kv.put("connections/openai", JSON.stringify({ providerId:"openai", enabled:true, monthlyBudgetMicros:1_000_000 }));
    await kv.put("policies/hard",JSON.stringify({enabled:true,generation:"g1",providers:["openai"],monthlyBudgetMicros:1_000_000,requestCostMicros:null,retainRequestContent:false}));
    await kv.put("credentials/hard",JSON.stringify({enabled:true,secretSha256:createHash("sha256").update(secret).digest("hex"),policyId:"hard",policyGeneration:"g1"}));
    for(const id of ["pool","subscription"]) {
      await kv.put("policies/"+id,JSON.stringify({enabled:true,generation:"g1",providers:["openai"],monthlyBudgetMicros:1_000_000,requestCostMicros:200,retainRequestContent:false}));
      await kv.put("credentials/"+id,JSON.stringify({enabled:true,secretSha256:createHash("sha256").update(secret).digest("hex"),policyId:id,policyGeneration:"g1"}));
    }
    await kv.put("oauth/pool/openai",JSON.stringify({provider:"openai",kind:"api_key",enabled:true,credential:"fixture-pool-upstream-key"}));
    await kv.put("oauth/subscription/openai",JSON.stringify({provider:"openai",kind:"subscription",enabled:true,accessToken:"fixture-subscription-token",accountId:"fixture-account"}));
    const hardHeaders={authorization:"Bearer clawrouter-live-hard-"+secret};
    const headers = { authorization: "Bearer clawrouter-live-fixture-" + secret };
    const origin = await mf.ready;
    for (const path of ["/v1/audio/transcriptions", "/v1/native/openai/v1/audio/transcriptions", "/v1/proxy/openai/transcriptions"]) {
      const body = new FormData();
      body.set("file", new File([new Uint8Array([0,255,128,42])], "sample.wav", {type:"audio/wav"}));
      body.set("model", path.includes("/native/") ? "gpt-4o-transcribe" : "openai/gpt-4o-transcribe");
      body.set("language", "en"); body.set("prompt", "synthetic prompt é");
      const response = await fetch(new URL(path, origin), {method:"POST",headers,body,signal:AbortSignal.timeout(10_000)});
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("x-clawrouter-content-retention"), "off");
      assert.equal((await response.json()).text, "synthetic transcript");
    }
    const calls = await mf.getDurableObjectNamespace("CALLS","upstream");
    const count = async () => (await (await calls.get(calls.idFromName("calls")).fetch("https://fixture/calls")).json()).calls;
    assert.equal(await count(),3);
    const makeForm = () => {
      const body=new FormData(); body.set("model","openai/gpt-4o-transcribe");
      body.set("file",new File([new Uint8Array([0,255,128,42])],"sample.wav",{type:"audio/wav"}));
      body.set("language","en");body.set("prompt","synthetic prompt é");return body;
    };
    for(const [filename,type] of [["sample.wav","application/octet-stream"],["voice.ogg","audio/ogg"],["voice.flac","audio/flac"]]) {
      const body=makeForm();body.set("file",new File([new Uint8Array([0,255,128,42])],filename,{type}));
      const response=await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers,body});
      assert.equal(response.status,200,await response.clone().text());
    }
    assert.equal(await count(),6);
    const pooled=await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers:{authorization:"Bearer clawrouter-live-pool-"+secret},body:makeForm()});
    assert.equal(pooled.status,200,await pooled.clone().text());assert.equal((await pooled.json()).credentialSource,"pool");assert.equal(pooled.headers.get("x-clawrouter-grant-lane"),"api_key");
    const incompatible=await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers:{authorization:"Bearer clawrouter-live-subscription-"+secret},body:makeForm()});
    assert.equal(incompatible.status,503);assert.equal((await incompatible.json()).error.code,"upstream_grant_pool_unavailable");
    assert.equal(await count(),7,"scoped subscription cannot borrow environment auth");
    for(const option of ["stream","chunking_strategy","known_speaker_names[]","timestamp_granularities[]"]) {
      const body=makeForm();body.set(option,"true");
      assert.equal((await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers,body})).status,400);
    }
    const duplicate=makeForm();duplicate.append("file",new File(["duplicate"],"second.wav",{type:"audio/wav"}));
    assert.equal((await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers,body:duplicate})).status,400);
    assert.equal((await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",body:makeForm()})).status,401);
    // A separate isolated policy: hard reserve must not turn a one-context
    // model card into an arbitrary-file ceiling. No mutable live/KV authority.
    const blocked=await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers:hardHeaders,body:makeForm()});
    assert.equal(blocked.status,400);assert.equal((await blocked.json()).error.code,"pricing_required");
    assert.equal(await count(),7,"invalid/hard-unqualified requests never reached real upstream Worker");
    const usageResponse = await fetch(new URL("/v1/usage",origin),{headers});
    assert.equal(usageResponse.status,200);
    const usage = await usageResponse.json();
    assert.equal(usage.usage.events.length,6);
    for(const event of usage.usage.events) {
      assert.equal(event.status_code,200);assert.equal(event.status,"success");
      assert.equal(event.actual_cost_micros,200); assert.equal(event.cost_basis,"policy_fixed");
      assert.equal(event.total_tokens,59); assert.equal(event.content_retained,false);
      assert.equal(event.model,"openai/gpt-4o-transcribe");
      assert.ok(!JSON.stringify(event).includes("synthetic"));
    }
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER","router");
    for(const name of ["default:fixture","provider:openai"]) {
      const stub=budgets.get(budgets.idFromName(name));
      assert.deepEqual(await (await stub.fetch("https://budget/fixture-reservations")).json(),Array.from({length:name === "provider:openai" ? 7 : 6},()=>({settled:1,dispatch_started:1,reserved_micros:200})));
    }
    // Explicit soft admission may dispatch before its observation, but a
    // denial must publish nonbillable usage without a zero/fixed SQL charge.
    await kv.put("policies/soft",JSON.stringify({enabled:true,generation:"g1",providers:["openai"],monthlyBudgetMicros:0,requestCostMicros:200,budgetMode:"soft",retainRequestContent:false}));
    await kv.put("credentials/soft",JSON.stringify({enabled:true,secretSha256:createHash("sha256").update(secret).digest("hex"),policyId:"soft",policyGeneration:"g1"}));
    const softHeaders={authorization:"Bearer clawrouter-live-soft-"+secret};
    const softForm=makeForm();softForm.set("prompt","synthetic prompt é soft");
    const denied=await fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers:softHeaders,body:softForm});
    assert.equal(denied.status,402);assert.equal((await denied.json()).error.code,"budget_exhausted");
    const softCount=async()=>(await (await calls.get(calls.idFromName("calls")).fetch("https://fixture/soft-calls")).json()).calls;
    assert.ok(await softCount()<=1,"soft cancellation may beat upstream receipt but cannot replay the upload");
    assert.equal(await count(),7,"soft receipts cannot satisfy the later disconnect dispatch gate");
    const softEvents=(await (await fetch(new URL("/v1/usage",origin),{headers:softHeaders})).json()).usage.events;
    assert.equal(softEvents.length,1);assert.equal(softEvents[0].actual_cost_micros,0);assert.equal(softEvents[0].cost_basis,"none");
    assert.equal(softEvents[0].status,"denied");assert.equal(softEvents[0].status_code,402);assert.equal(softEvents[0].content_retained,false);
    for(const [name,length] of [["default:soft",0],["provider:openai",7]]) {
      const stub=budgets.get(budgets.idFromName(name));
      assert.equal((await (await stub.fetch("https://budget/fixture-reservations")).json()).length,length,"soft denial creates no monetary row");
    }
    // Real TCP caller disconnect after confirmed upstream egress. The owned
    // lifetime must still finish durable accounting without replaying upload.
    const caller=new AbortController(), slow=makeForm();slow.set("prompt","synthetic prompt é delayed");
    const disconnected=fetch(new URL("/v1/audio/transcriptions",origin),{method:"POST",headers,body:slow,signal:caller.signal});
    const rejection=assert.rejects(disconnected,error=>error.name === "AbortError");
    for(let i=0;i<100 && await count()<8;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(await count(),8);caller.abort();await rejection;
    let events=[];
    for(let i=0;i<100;i++) {
      events=(await (await fetch(new URL("/v1/usage",origin),{headers})).json()).usage.events;
      if(events.length===7) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(events.length,7,"disconnect must not abandon usage publication");
    assert.ok(events.every(event=>event.actual_cost_micros===200 && event.cost_basis==="policy_fixed"));
    const policyStub=budgets.get(budgets.idFromName("default:fixture"));
    const rows=await (await policyStub.fetch("https://budget/fixture-reservations")).json();
    assert.equal(rows.length,7);assert.ok(rows.every(row=>row.settled===1 && row.dispatch_started===1 && row.reserved_micros===200));
    assert.equal(await count(),8,"disconnect never replays the upload");
    assert.ok(await softCount()<=1,"denied soft upload is not replayed after terminal cleanup");
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive:true, force:true });
  }
});
