import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const origin = "https://router.example", issuer = "https://device-workerd.cloudflareaccess.com";
const email = "device-admin@example.invalid", key = "oauth/fixture/minimax";
const path = "/v1/admin/upstream-grants/policies/fixture/minimax/authorize";
async function access() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "device-workerd-key" };
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "device-workerd", email, sub: "device-workerd-admin", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return { jwk, jwt: `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}` };
}
async function heldVendor(t) {
  const entered = Promise.withResolvers();
  let held;
  const metrics = { requests: 0, released: false, closes: 0 };
  const server = createServer((request, response) => {
    if (request.url !== "/token" || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    metrics.requests++; held = response; entered.resolve();
    response.on("close", () => { metrics.closes++; });
    // No headers or completion until the test releases the valid late success.
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  return { url: `http://127.0.0.1:${server.address().port}/token`, metrics, entered: entered.promise,
    release() {
      metrics.released = true;
      held.writeHead(200, { "content-type": "application/json" });
      held.end(JSON.stringify({ status: "success", access_token: "synthetic-workerd-device-access", refresh_token: "synthetic-workerd-device-refresh", expired_in: 3600, resource_url: "https://api.minimax.io/anthropic" }));
    } };
}
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {putGrantCredentials,inspectGrantCredentials} from './worker/grant-credentials.ts';
const key=${JSON.stringify(key)};
function projection(grant){return {generation:grant.credentialGeneration,lineage:grant.credentialLineage,hasCredential:grant.hasCredential,hasAccessToken:grant.hasAccessToken,hasRefreshToken:grant.hasRefreshToken,binding:grant.minimaxAnthropicBinding};}
export default {async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  const grant=await putGrantCredentials(env,key,{provider:'minimax',kind:'api_key',enabled:true,credential:'synthetic-original-device-key'});
  return Response.json(projection(grant));
 }
 // Fixture wrapper only: existing owner inspection, never a production endpoint
 // or exposure of the private attempt, assertion, verifier or credentials.
 if(path==='/fixture/owner')return Response.json(projection(await inspectGrantCredentials(env,key)));
 return worker.fetch(request,env,context);
},queue:worker.queue};
`;
async function bounded(pending, label) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " did not settle while vendor remained held")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function projected(response) {
  const text = await response.text(); assert.equal(response.status, 200, text);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(text, /synthetic-(?:original-device-key|workerd-device-access|workerd-device-refresh)|verifier|ownerBinding|session|credentialGeneration/);
  return JSON.parse(text);
}

test("MiniMax actual workerd admin/DO cancellation settles across requests before held token completion", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "minimax-device-workerd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const io = await heldVendor(t), signed = await access();
  const upstream = `export default {async fetch(request){
   if(request.url===${JSON.stringify(issuer + "/cdn-cgi/access/certs")})return Response.json({keys:[${JSON.stringify(signed.jwk)}]});
   if(request.url==='https://account.minimax.io/oauth2/device/code'){
    const body=new URLSearchParams(await request.text());
    if(request.method!=='POST'||body.get('code_challenge_method')!=='S256'||!body.get('code_challenge'))return new Response(null,{status:400});
    return Response.json({state:body.get('state'),user_code:'SYNTHETIC-WORKERD-CODE',verification_uri:'https://platform.minimax.io/approve',expired_in:Date.now()+60000,interval:2000});
   }
   if(request.url==='https://account.minimax.io/oauth2/token'){
    const body=new URLSearchParams(await request.text());
    if(request.method!=='POST'||body.get('grant_type')!=='urn:ietf:params:oauth:grant-type:user_code'||!body.get('code_verifier'))return new Response(null,{status:400});
    return fetch(${JSON.stringify(io.url)},{signal:request.signal});
   }
   return new Response(null,{status:400});
  }};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true,
    bindings: { CLAWROUTER_ACCESS_TEAM_DOMAIN: issuer, CLAWROUTER_ACCESS_AUD: "device-workerd", CLAWROUTER_ACCESS_ADMIN_EMAILS: email } });
  t.after(() => runtime.dispose());
  const setup = await runtime.dispatchFetch(origin + "/fixture/setup"); assert.equal(setup.status, 200); const original = await setup.json();
  const run = body => runtime.dispatchFetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": signed.jwt },
    body: JSON.stringify({ flow: "minimax-device.v1", provider: "minimax", ...body }) });
  const begin = await projected(await run({ operation: "begin", region: "global", intentId: "synthetic-workerd-intent", expectedGeneration: original.generation }));
  assert.equal(begin.status, "pending"); assert.equal(begin.verificationUri, "https://platform.minimax.io/approve");
  const admitted = await (await runtime.dispatchFetch(origin + "/fixture/owner")).json();
  assert.equal(admitted.generation, original.generation + 1); assert.notEqual(admitted.lineage, original.lineage);
  assert.equal(admitted.hasAccessToken, false); assert.equal(admitted.hasCredential, false);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, begin.nextPollAt - Date.now()) + 10));
  const poll = run({ operation: "poll", attemptId: begin.attemptId });
  await bounded(io.entered, "physical token fetch"); assert.equal(io.metrics.requests, 1);
  const during = await projected(await bounded(run({ operation: "status", attemptId: begin.attemptId }), "separate status request"));
  assert.equal(during.status, "polling"); assert.equal(during.attemptId, begin.attemptId);
  const cancelled = await projected(await bounded(run({ operation: "cancel", attemptId: begin.attemptId }), "separate cancellation request"));
  assert.equal(cancelled.status, "cancelled"); assert.equal(io.metrics.released, false);
  const withheld = await projected(await bounded(poll, "original poll cancellation")); assert.equal(withheld.status, "cancelled");
  io.release();
  const status = await projected(await run({ operation: "status", attemptId: begin.attemptId })); assert.equal(status.status, "cancelled");
  const after = await (await runtime.dispatchFetch(origin + "/fixture/owner")).json();
  assert.deepEqual(after, admitted); assert.equal(after.hasAccessToken, false); assert.equal(after.hasRefreshToken, false); assert.equal(after.binding, null);
  assert.equal((await projected(await run({ operation: "poll", attemptId: begin.attemptId }))).status, "cancelled");
  assert.equal(io.metrics.requests, 1); assert.equal(io.metrics.released, true);
});
