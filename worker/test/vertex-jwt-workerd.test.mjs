import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { syntheticVertexKey, signingBinding, tokenBody, bounded } from "./vertex-jwt-fixture.mjs";

const origin = "https://router.example", issuer = "https://vertex-workerd.cloudflareaccess.com", email = "vertex-admin@example.invalid";
async function access() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "vertex-workerd-key" };
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "vertex-workerd", email, sub: "vertex-workerd-admin", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return { jwk, jwt: `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}` };
}
async function vendor(t) {
  const pending = [], waiters = [];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/token"); assert.equal(request.headers.authorization, undefined);
    pending.push(response); waiters.shift()?.();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  return { url: `http://127.0.0.1:${server.address().port}/token`, count: () => pending.length,
    entered: count => pending.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push(resolve)),
    release(index) { pending[index].writeHead(200, { "content-type": "application/json" }); pending[index].end(JSON.stringify(tokenBody())); } };
}
const router = `
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {inspectGrantCredentials} from './worker/grant-credentials.ts';
import {snapshot} from './worker/providers.ts';
import {configureVertex} from './worker/test/vertex-runtime-fixture.mjs';
const provider=structuredClone(snapshot.providers.find(p=>p.id==='anthropic')); configureVertex(provider);
snapshot.providers=snapshot.providers.filter(p=>p.id!=='anthropic-vertex'); snapshot.providers.push(provider);
const controllers=new Map();
export default {async fetch(request,env,context){
 const url=new URL(request.url), id=url.searchParams.get('id');
 if(url.pathname==='/fixture/setup'){
  await authorityCall(env,'/users/initialize-all',[{email:${JSON.stringify(email)},record:{role:'admin',tenantId:'default',enabled:true,groups:[],contentRetentionDisabled:false}}]);
  return Response.json({ready:true});
 }
 if(url.pathname==='/fixture/owner'){
  const g=await inspectGrantCredentials(env,'oauth/fixture/'+id);
  return Response.json({generation:g.credentialGeneration,lineage:g.credentialLineage,enabled:g.enabled,hasAccessToken:g.hasAccessToken,
   hasRefreshToken:g.hasRefreshToken,binding:g.vertexAnthropicBinding,blocked:g.credentialRefreshBlockedUntil,diagnosis:g.refreshDiagnosis});
 }
 if(url.pathname==='/fixture/cancel'){controllers.get(id)?.abort();return Response.json({cancelled:controllers.get(id)?.signal.aborted===true});}
 // Controlled signal inside workerd. This does not claim physical host-disconnect support.
 if(url.pathname.endsWith('/refresh')){
  const name=url.pathname.split('/').at(-2), controller=new AbortController(); controllers.set(name,controller);
  try{return await worker.fetch(new Request(request,{signal:controller.signal}),env,context);}
  finally{controllers.delete(name);}
 }
 return worker.fetch(request,env,context);
},queue:worker.queue};`;

test("Vertex actual workerd owner releases ordering during token I/O and fences cancel/revoke/replacement", { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "vertex-jwt-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const io = await vendor(t), signed = await access(), key = await syntheticVertexKey(), replacement = await syntheticVertexKey();
  const upstream = `export default {async fetch(request){
   if(request.url===${JSON.stringify(issuer + "/cdn-cgi/access/certs")})return Response.json({keys:[${JSON.stringify(signed.jwk)}]});
   if(request.url==='https://oauth2.googleapis.com/token'){
    const form=new URLSearchParams(await request.text());
    if(request.method!=='POST'||request.headers.has('authorization')||form.get('grant_type')!=='urn:ietf:params:oauth:grant-type:jwt-bearer'||!form.get('assertion'))return new Response(null,{status:400});
    return fetch(${JSON.stringify(io.url)},{signal:request.signal});
   }
   return new Response(null,{status:400});
  }};`;
  const runtime = await startWorkerdFixture(temporary, router, upstream, { preventEviction: true,
    bindings: { CLAWROUTER_ACCESS_TEAM_DOMAIN: issuer, CLAWROUTER_ACCESS_AUD: "vertex-workerd", CLAWROUTER_ACCESS_ADMIN_EMAILS: email } });
  t.after(() => runtime.dispose()); assert.equal((await runtime.dispatchFetch(origin + "/fixture/setup")).status, 200);
  const headers = { origin, "content-type": "application/json", "cf-access-jwt-assertion": signed.jwt };
  const admin = (name, action = "", body, method = "POST") => runtime.dispatchFetch(`${origin}/v1/admin/upstream-grants/policies/fixture/${name}${action ? '/' + action : ''}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const view = async response => {
    const text = await response.text(); assert.equal(response.status, 200, text);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.doesNotMatch(text, /PRIVATE KEY|synthetic-jwt-access|vertexPrivateKey|vertexServiceAccountPrivateKey|assertion/); return JSON.parse(text);
  };
  const owner = async name => (await runtime.dispatchFetch(`${origin}/fixture/owner?id=${name}`)).json();
  let index = 0;
  for (const action of ["cancel", "revoke", "replace", "binding", "generation"]) {
    const name = `vertex-${action}`;
    await view(await admin(name, "", { provider: "anthropic-vertex", kind: "oauth", enabled: true, tokenType: "Bearer",
      vertexAnthropicAuthorization: signingBinding(), vertexServiceAccountPrivateKey: key.pem }, "PUT"));
    const original = await owner(name), exchange = admin(name, "refresh");
    await bounded(io.entered(index + 1), "actual token exchange"); assert.equal(io.count(), index + 1);
    const during = await bounded(owner(name), "separate owner inspection");
    assert.equal(during.generation, original.generation); assert.equal(during.blocked, null); assert.equal(during.hasAccessToken, false);
    if (action === "cancel") assert.deepEqual(await (await runtime.dispatchFetch(`${origin}/fixture/cancel?id=${name}`)).json(), { cancelled: true });
    else if (action === "revoke") await view(await bounded(admin(name, "revoke", {}), "revocation"));
    else await view(await bounded(admin(name, "", action === "replace"
      ? { vertexAnthropicAuthorization: signingBinding(), vertexServiceAccountPrivateKey: replacement.pem }
      : action === "binding" ? { vertexAnthropicAuthorization: signingBinding({ location: "eu" }), vertexServiceAccountPrivateKey: key.pem }
      : { label: "changed generation" }, "PUT"), "owner replacement"));
    const withheld = await bounded(exchange, "exchange cancellation before vendor completion");
    assert.notEqual(withheld.status, 200); assert.doesNotMatch(await withheld.text(), /PRIVATE KEY|synthetic-jwt-access|assertion/);
    io.release(index++);
    const after = await owner(name); assert.equal(after.hasAccessToken, false); assert.equal(after.hasRefreshToken, false);
    if (action === "cancel") { assert.equal(after.generation, original.generation); assert.equal(after.blocked, null); }
    else assert.ok(after.generation > original.generation);
    assert.equal(io.count(), index);
  }
});
