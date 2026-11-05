import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { musicAccessFixture } from "./minimax-music-admin-fixture.mjs";

const router = String.raw`
export {PolicyBindingIndexObject,BudgetLedgerObject,UsageLedgerObject} from './worker/index.ts';
import {GrantCredentialObject as OriginalOwner} from './worker/grant-credentials.ts';
import worker from './worker/index.ts';
import {authorityCall} from './worker/authority.ts';
import {sha256Hex} from './worker/utils.ts';
const email='music-admin@example.invalid';
export class GrantCredentialObject extends OriginalOwner {
 constructor(state,env){
  const held={mode:null},authority=env.ACCESS_CONTROL;
  super(state,{...env,ACCESS_CONTROL:{idFromName:n=>authority.idFromName(n),get:id=>{const stub=authority.get(id);return {async fetch(input,init){
   const response=await stub.fetch(input,init);
   if(held.mode&&new URL(input).pathname==='/grant-pools/admit'){
    const mode=held.mode;held.mode=null;
    const gate=await fetch('https://music-admin-gate.example/'+mode,{redirect:'manual'});
    if(!gate.ok)throw new Error('fixture gate');await gate.text();
   }
   return response;
  }}}}});
  this.fixtureState=state;this.fixtureHeld=held;
 }
 async fetch(request){
  const u=new URL(request.url);
  if(u.pathname==='/fixture/arm'){this.fixtureHeld.mode=u.searchParams.get('mode');return Response.json({armed:true});}
  if(u.pathname==='/fixture/pin'){
   const r=await this.fixtureState.storage.get('credential');
   return Response.json(r?{generation:r.generation,lineage:r.lineage,binding:r.nativeMediaBinding??null,
    credentialSha256:await sha256Hex(r.credential??''),account:r.accountId,provider:r.providerId,kind:r.kind,enabled:r.enabled,
    pending:r.poolSyncPending??false,revision:r.poolAdmissionRevision,revokedAt:r.revokedAt??null}:null);
  }
  return super.fetch(request);
 }
}
let initialized;
export default {async fetch(request,bindings,context){
 const env={...bindings,...ACCESS_ENV},u=new URL(request.url);
 initialized??=authorityCall(env,'/users/initialize-all',[{email,record:{role:'admin',enabled:true,tenantId:'fixture',groups:[],contentRetentionDisabled:false}}]);
 await initialized;
 if(u.pathname==='/fixture/user'){
  await authorityCall(env,'/users/put',{email,record:{role:u.searchParams.get('role')??'admin',enabled:u.searchParams.get('enabled')!=='false',tenantId:'fixture',groups:[],contentRetentionDisabled:false}});
  return Response.json({updated:true});
 }
 if(u.pathname==='/fixture/arm'||u.pathname==='/fixture/pin'){
  const key='oauth/fixture/music-'+u.searchParams.get('mode');
  return env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch('https://owner'+u.pathname+'?mode='+u.searchParams.get('mode'));
 }
 return worker.fetch(request,env,context);
},queue:worker.queue};`;

test("Music actual isolated admin -> owner -> SQL rejects demotion/disable during held pool ACK without changing the original grant", { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "music-admin-workerd-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const held = new Map(), entered = new Map(), released = new Set();
  const server = createServer((request, response) => {
    if (!/^\/(demote|disable)$/.test(request.url) || request.headers.authorization) { response.writeHead(400); response.end(); return; }
    entered.get(request.url)?.resolve();
    if (released.has(request.url)) response.end("released"); else held.set(request.url, response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const release = mode => { released.add("/" + mode); held.get("/" + mode)?.end("released"); held.delete("/" + mode); };
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const access = await musicAccessFixture();
  const upstream = `export default {fetch(request){const u=new URL(request.url);
    if(u.href==='https://music-admin-fixture.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[${JSON.stringify(access.jwk)}]});
    if(u.hostname==='music-admin-gate.example')return fetch(${JSON.stringify("http://127.0.0.1:" + server.address().port)}+u.pathname,{redirect:'manual'});
    throw new Error('fixture forbids provider egress');}};`;
  const runtime = await startWorkerdFixture(temporary, router.replace("ACCESS_ENV", JSON.stringify(access.env)), upstream, { preventEviction: true });
  t.after(async () => { release("demote"); release("disable"); await runtime.dispose(); });
  const call = async path => { const r = await runtime.dispatchFetch("https://router.example" + path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const put = (mode, body) => runtime.dispatchFetch("https://router.example/v1/admin/upstream-grants/policies/fixture/music-" + mode, {
    method: "PUT", headers: { ...access.headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (const mode of ["demote", "disable"]) {
    await call("/fixture/user");
    const created = await put(mode, { provider: "minimax", kind: "api_key", enabled: true, accountId: "synthetic-account",
      credential: "synthetic-old-music-key", nativeMediaAuthorization: "minimax-global-music" });
    assert.equal(created.status, 200, await created.clone().text()); assert.doesNotMatch(await created.text(), /synthetic-old-music-key/);
    const before = await call("/fixture/pin?mode=" + mode); assert.equal(before.binding.operation, "minimax.music");
    await call("/fixture/arm?mode=" + mode);
    const barrier = Promise.withResolvers(); entered.set("/" + mode, barrier);
    const changed = put(mode, { credential: "synthetic-new-music-key", accountId: "synthetic-new-account", nativeMediaAuthorization: "minimax-global-music" });
    await barrier.promise;
    // A separate actual HTTP request changes the SQL actor while the owner is
    // waiting on its real authority ACK. No shared-isolate role mocks.
    await call(mode === "demote" ? "/fixture/user?role=user" : "/fixture/user?enabled=false");
    release(mode);
    const denied = await changed, text = await denied.text(); assert.equal(denied.status, 403, text);
    assert.doesNotMatch(text, /synthetic-(?:old|new)-music-key/);
    assert.deepEqual(await call("/fixture/pin?mode=" + mode), before);
    await call("/fixture/user");
    const retry = await put(mode, { label: "retry must not repair" }); assert.equal(retry.status, 403, await retry.clone().text()); await retry.text();
    assert.deepEqual(await call("/fixture/pin?mode=" + mode), before);
  }
});
