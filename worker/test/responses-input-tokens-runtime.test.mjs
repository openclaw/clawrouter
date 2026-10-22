import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

// Only fixture setup/inspection is added. Real routing, admission, delivery,
// queue publication and SQLite authority/ledger code run unchanged in workerd.
const router = [
  'import worker from "./worker/index.ts";',
  'export * from "./worker/index.ts";',
  'import { BudgetLedgerObject as Budget, usageStub, ingestUsage } from "./worker/ledgers.ts";',
  'import { sha256Hex } from "./worker/utils.ts";',
  'export class BudgetLedgerObject extends Budget { constructor(state) { super(state); this.sql=state.storage.sql; } async fetch(request) { if(new URL(request.url).pathname==="/rows") return Response.json([...this.sql.exec("SELECT * FROM budget_reservations")]); return super.fetch(request); } }',
  'export default {...worker, async fetch(request,env,context) {',
  ' const path=new URL(request.url).pathname;',
  ' const authority=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName("policy-bindings"));',
  ' if(path==="/fixture/setup") {',
  '  for(const [path,body] of [["/policies/initialize-all",[{policyId:"fixture",policy:{enabled:true,generation:"g1",providers:["openai"],tenantId:"tenant",monthlyBudgetMicros:100,requestCostMicros:7,retainRequestContent:false}}]],["/credentials/initialize-all",[{credentialId:"fixture",credential:{enabled:true,secretSha256:await sha256Hex("fixture-key"),policyId:"fixture",policyGeneration:"g1"}}]],["/connections/initialize-all",[{providerId:"openai",enabled:true,monthlyBudgetMicros:100}]]]) {const r=await authority.fetch("https://owner"+path,{method:"POST",body:JSON.stringify(body)});if(!r.ok)return r;}',
  '  return Response.json({ok:true});',
  ' }',
  ' if(path==="/fixture/revoke") return authority.fetch("https://owner/credentials/mutate",{method:"POST",body:JSON.stringify({operation:"revoke",credentialId:"fixture",scope:"admin",actor:{auth:"admin_token",email:"fixture@example.com",role:"admin"}})});',
  ' if(path==="/fixture/rows") return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(new URL(request.url).searchParams.get("name"))).fetch("https://budget/rows");',
  ' if(path==="/fixture/usage") return usageStub(env,"tenant","fixture").fetch("https://usage/snapshot?events=admin");',
  ' if(path.startsWith("/fixture/upstream/")) return fetch("https://fixture.example"+path,{method:request.method,body:request.body});',
  ' return worker.fetch(request,{...env,USAGE_QUEUE:{send:event=>ingestUsage(env,event)}},context);',
  '}};',
].join("\n");
const upstream = [
  'export class Upstream { constructor(state) { this.storage=state.storage; } async fetch(request) {',
  ' const path=new URL(request.url).pathname;',
  ' if(path==="/fixture/upstream/config") { await this.storage.put("mode",await request.text());return new Response("ok"); }',
  ' if(path==="/fixture/upstream/calls") return Response.json(await this.storage.get("calls")??[]);',
  ' const calls=await this.storage.get("calls")??[]; const body=await request.json();',
  ' calls.push({url:request.url,method:request.method,authorization:request.headers.get("authorization"),body});await this.storage.put("calls",calls);',
  ' if(request.url!=="https://api.openai.com/v1/responses/input_tokens"||request.method!=="POST"||body.model!=="gpt-6-astra"||request.headers.get("authorization")!=="Bearer fixture-upstream-key") return new Response("wrong wire",{status:500});',
  ' const mode=await this.storage.get("mode");',
  ' if(mode==="429")return Response.json({error:{message:"synthetic rate limit"}},{status:429,headers:{"retry-after":"11"}});',
  ' return new Response(mode==="malformed"?"{ truncated":\'{ "object": "response.input_tokens", "input_tokens": 37 }\\n\',{headers:{"content-type":"application/json"}});',
  '}}',
  'export default {fetch(request,env){return env.UPSTREAM.get(env.UPSTREAM.idFromName("fixture")).fetch(request);}};',
].join("\n");

test("real workerd count wire, zero settlement, rejections and revocation", { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-input-tokens-")); let worker;
  try {
    worker = await startWorkerdFixture(temporary, router, upstream, { upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } });
    const get = path => worker.dispatchFetch("https://router.example" + path);
    const control = (path, body) => worker.dispatchFetch("https://router.example/fixture/upstream/" + path, { method: "POST", body });
    const send = (path = "/v1/responses/input_tokens", extra = {}) => {
      const body = { model: path.includes("/native/") ? "gpt-6-astra" : "openai/gpt-6-astra", input: "synthetic inline", ...extra };
      return worker.dispatchFetch("https://router.example" + path, { method: "POST", headers: { authorization: "Bearer clawrouter-live-fixture-fixture-key", "content-type": "application/json" }, body: JSON.stringify(path.includes("/proxy/") ? { body } : body) });
    };
    assert.equal((await get("/fixture/setup")).status, 200);
    for (const path of ["/v1/responses/input_tokens", "/v1/native/openai/v1/responses/input_tokens", "/v1/proxy/openai/responses_input_tokens"]) {
      const response = await send(path); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await response.text(), '{ "object": "response.input_tokens", "input_tokens": 37 }\n');
    }
    for (const path of ["/v1/responses/input_tokens", "/v1/native/openai/v1/responses/input_tokens", "/v1/proxy/openai/responses_input_tokens"]) {
      const response = await send(path + "?trace=a&trace=b&empty=");
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "input_tokens_stateless_required");
    }
    assert.equal((await (await get("/fixture/upstream/calls")).json()).length, 3, "all query refusals are known-unsent");
    await control("config", "malformed");
    assert.equal(await (await send()).text(), "{ truncated");
    await control("config", "429");
    const rejected = await send(); assert.equal(rejected.status, 429); assert.equal(rejected.headers.get("retry-after"), "11");
    assert.deepEqual(await rejected.json(), { error: { message: "synthetic rate limit" } });
    const stateful = await send(undefined, { previous_response_id: "resp_foreign" });
    assert.equal(stateful.status, 400); assert.equal((await stateful.json()).error.code, "input_tokens_stateless_required");
    const revoked = await get("/fixture/revoke"); assert.equal((await revoked.json()).outcome, "updated");
    const denied = await send(); assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, "proxy_key_revoked");
    const calls = await (await get("/fixture/upstream/calls")).json();
    assert.equal(calls.length, 5, "neither custody rejection nor revoked auth may reach upstream");
    assert.ok(calls.every(call => call.url === "https://api.openai.com/v1/responses/input_tokens" && call.method === "POST" && call.body.model === "gpt-6-astra"));
    const snapshot = await (await get("/fixture/usage")).json();
    assert.equal(snapshot.summary.requestCount, 8); assert.equal(snapshot.summary.actualCostMicros, 0);
    assert.equal(snapshot.events.length, 8);
    assert.equal(snapshot.events.filter(event => event.status === "client_error" && event.status_code === 400).length, 3, "query refusals own one zero audit receipt each");
    assert.equal(snapshot.events.filter(event => event.status_code !== 400).length, 5, "only the five sent calls have upstream outcomes");
    for (const event of snapshot.events) { assert.equal(event.capability, "llm.count_tokens"); assert.equal(event.actual_cost_micros, 0); assert.equal(event.reserved_cost_micros, 0); assert.equal(event.cost_basis, "none"); assert.equal(event.pricing_ref, null); }
    for (const name of ["tenant:fixture", "provider:openai"]) assert.deepEqual(await (await get("/fixture/rows?name=" + name)).json(), []);
  } finally { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
