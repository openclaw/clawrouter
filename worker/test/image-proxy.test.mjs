import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const {default:handler}=await import("../index.ts");
const {providerById}=await import("../providers.ts");
const {grantSupports}=await import("../provider-auth.ts");
const {estimateModelCost}=await import("../pricing.ts");

const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
const routes = ["/v1/images/generations", "/v1/native/openai/v1/images/generations", "/v1/proxy/openai/images_generations"];
const prompt = "fixture image prompt";
const usage = {input_tokens: 12, input_tokens_details: {text_tokens:12,image_tokens:0}, output_tokens:100,total_tokens:112};
const provider=providerById("openai"), model=provider.models.find(m=>m.id==="openai/gpt-image-2.5-sunburst");
const reserve=estimateModelCost(model.pricing,{prompt}).reserveMicros;
function fixture(t,options={}) {
  const env=usageEnv([],{limit:20_000_000,fixedCost:null,...options}), events=[],pending=[],retained=[],ledger=sqlBudgetNamespace(t);
  env.BUDGET_LEDGER=ledger;env.OPENAI_API_KEY="fixture-upstream-key";
  env.USAGE_QUEUE={send:async e=>events.push(e)};
  env.CONTENT_ARCHIVE={put:async (_k,v)=>retained.push(JSON.parse(v))};
  const call=(path=routes[0],body={prompt},signal,key=proxyKey())=>handler.fetch(new Request("https://router.example"+path,{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},signal,body:JSON.stringify(path===routes[2]?{body:{model:model.id,...body}}:{model:path===routes[1]?model.upstream:model.id,...body})}),env,{waitUntil:p=>pending.push(p)});
  return {env,events,pending,retained,ledger,call};
}
for(const route of routes) test("image generation route "+route+" preserves large base64 bytes and settles both SQL budgets",async t=>{
  const f=fixture(t), payload=JSON.stringify({created:1,data:[{b64_json:"A".repeat(3*1024*1024)}],usage});
  let pulls=0;
  const upstream=t.mock.method(globalThis,"fetch",async(url,options)=>{
    assert.equal(String(url),"https://api.openai.com/v1/images/generations");assert.equal(options.headers.get("authorization"),"Bearer fixture-upstream-key");
    assert.deepEqual(JSON.parse(options.body),{model:model.upstream,prompt,quality:"high",size:"1536x864",n:2,output_format:"webp",output_compression:50});
    let sent=false;
    return new Response(new ReadableStream({pull(c){pulls++;if(sent)return c.close();sent=true;c.enqueue(new TextEncoder().encode(payload));}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
  });
  const body={prompt,quality:"high",size:"1536x864",n:2,output_format:"webp",output_compression:50};
  const response=await f.call(route,body);assert.equal(response.status,200);assert.equal(pulls,0);assert.equal(f.events.length,0);
  const bound=estimateModelCost(model.pricing,body).reserveMicros;
  for(const name of owners){const [row]=f.ledger.get(name).reservations();assert.equal(row.reserved_micros,bound);assert.equal(row.dispatch_started,1);assert.equal(row.settled,0);}
  assert.equal(await response.text(),payload);await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(),1);assert.equal(f.events.length,1);
  const event=f.events[0];assert.equal(event.actual_cost_micros,3060);assert.equal(event.reserved_cost_micros,bound);assert.equal(event.cost_basis,"manifest_pricing");assert.equal(event.total_tokens,112);assert.deepEqual(event.image_usage,{text_input_tokens:12,image_input_tokens:0,image_output_tokens:100});
  for(const name of owners){const [row]=f.ledger.get(name).reservations();assert.equal(row.reserved_micros,3060);assert.equal(row.settled,1);}
  assert.equal(f.retained.length,1);assert.deepEqual(f.retained[0].body,JSON.parse(upstream.mock.calls[0].arguments[1].body));
  assert.ok(!JSON.stringify(f.retained).includes("b64_json"));assert.ok(!JSON.stringify(f.events).includes(prompt));assert.equal(response.headers.get("x-clawrouter-content-retention"),"on; retention-days=30");
});
for(const route of routes) test("image "+route+" rejects unbounded/unsupported options before reservation, retention or dispatch",async t=>{
 const f=fixture(t,{fixedCost:0}),upstream=t.mock.method(globalThis,"fetch",async()=>{throw Error("unexpected dispatch");});
 for(const patch of [{stream:true},{partial_images:0},{n:11},{quality:"hd"},{size:"9999x9999"},{response_format:"url"},{image:[]},{model:"gpt-image-1"}]){
  const response=await f.call(route,{prompt,...patch});assert.ok([400,404].includes(response.status));await response.text();
 }
 await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),0);assert.equal(f.retained.length,0);
 for(const name of owners)assert.equal(f.ledger.get(name).reservations().length,0);
});
for(const scenario of ["missing","inconsistent","partial","abort","read-error","fetch-error","rejection","wrong-mime","sse","retention-error","retention-off","fixed-zero","fixed-positive"])test("image lifecycle "+scenario+" preserves conservative accounting",async t=>{
 const f=fixture(t,{retainContent:scenario!=="retention-off",fixedCost:scenario==="fixed-zero"?0:scenario==="fixed-positive"?7:null}),caller=new AbortController();
 if(scenario==="retention-error")f.env.CONTENT_ARCHIVE.put=async()=>{throw Error("fixture archive failure");};
 let cancels=0;
 const upstream=t.mock.method(globalThis,"fetch",async()=>{
  if(scenario==="fetch-error")throw Error("fixture transport failure");
  if(scenario==="rejection")return Response.json({error:{code:"image_generation_user_error"}},{status:400});
  const body=JSON.stringify({data:[{b64_json:"fixture"}],...(scenario==="missing"?{}:{usage:scenario==="inconsistent"?{...usage,total_tokens:0}:usage})});
  let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode(body));}else if(scenario==="read-error")c.error(Error("fixture read failure"));else if(!["partial","abort"].includes(scenario))c.close();},cancel(){cancels++;}},{highWaterMark:0}),{headers:{"content-type":scenario==="wrong-mime"?"text/plain":scenario==="sse"?"text/event-stream":"application/json"}});
 });
 const response=await f.call(routes[0],{prompt},caller.signal);
 if(["partial","abort"].includes(scenario)){const reader=response.body.getReader();await reader.read();if(scenario==="partial")await reader.cancel();else{const pending=reader.read();caller.abort(Error("fixture caller canceled"));await assert.rejects(pending);}}
 else if(scenario==="read-error")await assert.rejects(response.arrayBuffer(),/fixture read failure/);
 else await response.arrayBuffer();
 await Promise.all(f.pending);assert.equal(f.events.length,1);
 const free=["rejection","retention-error"].includes(scenario),qualified=["retention-off","fixed-zero","fixed-positive"].includes(scenario);
 const expected=free||scenario==="fixed-zero"?0:scenario==="fixed-positive"?7:qualified?3060:reserve;
 const event=f.events[0];assert.equal(event.actual_cost_micros,expected);assert.equal(event.cost_basis,free?"none":scenario.startsWith("fixed-")?"policy_fixed":qualified?"manifest_pricing":"manifest_reservation");
 for(const name of owners){const [row]=f.ledger.get(name).reservations();assert.equal(row.reserved_micros,expected);assert.equal(row.settled,1);}
 assert.equal(upstream.mock.callCount(),scenario==="retention-error"?0:1);
 if(["partial","abort"].includes(scenario))assert.equal(cancels,1);
 if(scenario==="retention-off"){assert.equal(f.retained.length,0);assert.equal(response.headers.get("x-clawrouter-content-retention"),"off");}
});
for(const limited of ["policy","provider","daily","weekly"])test("image "+limited+" budget requires entire auto/count envelope before dispatch",async t=>{
 const f=fixture(t,{...(limited==="policy"?{limit:reserve-1}:{}),...(limited==="provider"?{providerLimit:reserve-1}:{}),...(limited==="daily"?{dailyLimit:reserve-1}:{}),...(limited==="weekly"?{weeklyLimit:reserve-1}:{})});
 const upstream=t.mock.method(globalThis,"fetch",async()=>{throw Error("under-reserved image dispatched");});
 const response=await f.call();assert.equal(response.status,402);await response.text();await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),0);assert.equal(f.retained.length,0);
});
for(const scenario of ["bad-key","revoked","model-policy","tier-policy"])test("image preserves "+scenario+" admission",async t=>{
 const f=fixture(t,{serviceTiers:scenario==="tier-policy"?{allowed:["flex"]}:undefined});
 if(["revoked","model-policy"].includes(scenario)){
  const original=f.env.ACCESS_CONTROL.get;f.env.ACCESS_CONTROL.get=(...args)=>{const obj=original(...args);return{fetch:async url=>{const r=await obj.fetch(url),v=await r.json();if(v.credential&&scenario==="revoked")v.credential.credential.enabled=false;if(v.policy&&scenario==="model-policy")v.policy.policy.models=["openai/gpt-6-astra"];return Response.json(v);}};};
 }
 const upstream=t.mock.method(globalThis,"fetch",async()=>{throw Error("denied image dispatched");});
 const response=await f.call(routes[0],{prompt},undefined,scenario==="bad-key"?"invalid":proxyKey());assert.ok([400,401,403].includes(response.status));await response.text();await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),0);
});
test("image subscription transport is ineligible; API keys only and no websocket",()=>{
 const endpoint=provider.endpoints.find(e=>e.id==="images_generations");
 assert.equal(grantSupports({provider,endpoint,mode:"http"},{kind:"subscription"}),false);
 assert.equal(grantSupports({provider,endpoint,mode:"http"},{kind:"api_key"}),true);
 assert.equal(grantSupports({provider,endpoint,mode:"websocket"},{kind:"api_key"}),false);
});

for(const scenario of ["measured","missing","cancel","rejection","denied"])test("soft-budget image "+scenario+" retains actual or conservative charge",async t=>{
 const f=fixture(t,{limit:scenario==="denied"?0:20_000_000});
 const original=f.env.ACCESS_CONTROL.get;f.env.ACCESS_CONTROL.get=(...args)=>{const obj=original(...args);return{fetch:async url=>{const v=await(await obj.fetch(url)).json();if(v.policy)v.policy.policy.budgetMode="soft";return Response.json(v);}};};
 let cancels=0;
 const upstream=t.mock.method(globalThis,"fetch",async()=>{
  if(scenario==="rejection")return Response.json({error:"fixture"},{status:400});
  const body=JSON.stringify({data:[{b64_json:"fixture"}],...(scenario==="missing"?{}:{usage})});let sent=false;
  return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode(body));}else if(scenario!=="cancel")c.close();},cancel(){cancels++;}},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
 });
 const response=await f.call();if(scenario==="cancel"){const reader=response.body.getReader();await reader.read();await reader.cancel();}else await response.text();await Promise.all(f.pending);
 const expected=["rejection","denied"].includes(scenario)?0:scenario==="measured"?3060:reserve;
 assert.equal(f.events.length,1);assert.equal(f.events[0].actual_cost_micros,expected);assert.equal(upstream.mock.callCount(),1);
 if(scenario==="denied")assert.equal(response.status,402);
 for(const name of owners){const rows=f.ledger.get(name).reservations();if(expected>0)assert.equal(rows.length,1);for(const row of rows){assert.equal(row.reserved_micros,expected);assert.equal(row.settled,1);}}
 if(scenario==="cancel")assert.equal(cancels,1);
});

for(const path of ["/v1/images/generations?stream=true","/v1/native/openai/v1/images/generations?n=10"])test("image rejects query options "+path,async t=>{
 const f=fixture(t),upstream=t.mock.method(globalThis,"fetch",async()=>{throw Error("query dispatched");});
 const response=await f.call(path,{prompt,model:model.id});assert.equal(response.status,400);assert.equal((await response.json()).error.code,"invalid_image_generation");await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),0);
});
test("manifest image rejects query options in the envelope",async t=>{
 const f=fixture(t),upstream=t.mock.method(globalThis,"fetch",async()=>{throw Error("query dispatched");});
 const response=await handler.fetch(new Request("https://router.example/v1/proxy/openai/images_generations",{method:"POST",headers:{authorization:"Bearer "+proxyKey(),"content-type":"application/json"},body:JSON.stringify({query:{n:10},body:{model:model.id,prompt}})}),f.env,{waitUntil:p=>f.pending.push(p)});
 assert.equal(response.status,400);assert.equal((await response.json()).error.code,"invalid_image_generation");await Promise.all(f.pending);assert.equal(upstream.mock.callCount(),0);
});

for (const route of routes) test("image route " + route + " returns corrective prompt and n messages", async t => {
  const f = fixture(t), limits = model.pricing.generation;
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw Error("invalid image dispatched"); });
  for (const [body, message] of [
    [{ prompt: "" }, "image prompt must be a nonempty string of at most " + limits.maxPromptCharacters + " Unicode code points"],
    [{ prompt, n: limits.maxImages + 1 }, "image n must be an integer from 1 to " + limits.maxImages],
  ]) {
    const response = await f.call(route, body);
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).error, { code: "invalid_image_generation", message });
  }
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(f.retained.length, 0);
  for (const name of owners) assert.equal(f.ledger.get(name).reservations().length, 0);
});
