import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";

const origin = "https://router.example", issuer = "https://device-workerd.cloudflareaccess.com";
const email = "device-admin@example.invalid", key = "oauth/fixture/copilot";
const path = "/v1/admin/upstream-grants/policies/fixture/copilot/authorize";
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
      held.end(JSON.stringify({ access_token: "synthetic-original-github-token", token_type: "bearer", scope: "read:user" }));
    } };
}
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials} from './worker/grant-credentials.ts';
const key=${JSON.stringify(key)};
function projection(grant){return {generation:grant.credentialGeneration,lineage:grant.credentialLineage,hasCredential:grant.hasCredential,hasAccessToken:grant.hasAccessToken,hasRefreshToken:grant.hasRefreshToken,status:grant.credentialStatus};}
export default {async fetch(request,env,context){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  return Response.json({generation:0});
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
  assert.doesNotMatch(text, /synthetic-original-github-token|synthetic-private-device-code|copilotDeviceCredential|ownerBinding|credentialGeneration/);
  return JSON.parse(text);
}

test("Copilot actual workerd admin/DO cancellation settles across requests before held token completion", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "copilot-device-workerd-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const io = await heldVendor(t), signed = await access();
  const upstream = `export default {async fetch(request){
   if(request.url===${JSON.stringify(issuer + "/cdn-cgi/access/certs")})return Response.json({keys:[${JSON.stringify(signed.jwk)}]});
   if(request.url==='https://github.com/login/device/code'){
    const body=new URLSearchParams(await request.text());
    if(request.method!=='POST'||body.get('client_id')!=='Iv1.b507a08c87ecfe98'||body.get('scope')!=='read:user')return new Response(null,{status:400});
    return Response.json({device_code:'synthetic-private-device-code',user_code:'SYNTHETIC-WORKERD-CODE',verification_uri:'https://github.com/login/device',expires_in:900,interval:1});
   }
   if(request.url==='https://github.com/login/oauth/access_token'){
    const body=new URLSearchParams(await request.text());
    if(request.method!=='POST'||body.get('grant_type')!=='urn:ietf:params:oauth:grant-type:device_code'||body.get('device_code')!=='synthetic-private-device-code')return new Response(null,{status:400});
    return fetch(${JSON.stringify(io.url)},{signal:request.signal});
   }
   return new Response(null,{status:400});
  }};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true,
    bindings: { CLAWROUTER_ACCESS_TEAM_DOMAIN: issuer, CLAWROUTER_ACCESS_AUD: "device-workerd", CLAWROUTER_ACCESS_ADMIN_EMAILS: email } });
  t.after(() => runtime.dispose());
  const setup = await runtime.dispatchFetch(origin + "/fixture/setup"); assert.equal(setup.status, 200); const original = await setup.json();
  const run = body => runtime.dispatchFetch(origin + path + "?flow=copilot-device.v1", { method: "POST", headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": signed.jwt },
    body: JSON.stringify({ flow: "copilot-device.v1", provider: "github-copilot", ...body }) });
  const begin = await projected(await run({ operation: "begin", githubDomain: "github.com", intentId: "synthetic-workerd-intent", expectedGeneration: original.generation }));
  assert.equal(begin.status, "pending"); assert.equal(begin.verificationUri, "https://github.com/login/device");
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
  assert.deepEqual(after, admitted); assert.equal(after.hasAccessToken, false); assert.equal(after.hasRefreshToken, false); assert.equal(after.status, "reauth_required");
  assert.equal((await projected(await run({ operation: "poll", attemptId: begin.attemptId }))).status, "cancelled");
  assert.equal(io.metrics.requests, 1); assert.equal(io.metrics.released, true);
});
