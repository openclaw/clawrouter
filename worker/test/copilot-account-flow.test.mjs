import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";
import { createGrantAuthority } from "./grant-authority-fixture.mjs";
const { adminApi } = await import("../admin.ts");
const { GrantCredentialObject, inspectGrantCredentials, revokeGrantCredentials, putGrantCredentials, materializeGrantCredentials } = await import("../grant-credentials.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const { assertCopilotAccountRecord } = await import("../copilot-account-flow.ts");
const { sha256Hex } = await import("../utils.ts");

const origin = "https://console.example.invalid";
const issuer = "https://device-fixture.cloudflareaccess.com";
const email = "admin@example.invalid", otherEmail = "other@example.invalid", key = "oauth/fixture/copilot";
const path = "/v1/admin/upstream-grants/policies/fixture/copilot/authorize";
let keys, jwk;
test.before(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "device-test-key" };
});
async function jwt(actor = email, patch = {}) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", kid: jwk.kid })}.${enc({ iss: issuer, aud: "device-fixture", email: actor, sub: actor, exp: Math.floor(Date.now() / 1000) + 3600, ...patch })}`;
  return `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}
function vendor(url, value, status = 200) {
  let bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const stream = new ReadableStream({ type: 'bytes', pull(controller) {
    if (bytes) { const next = bytes; bytes = null; controller.enqueue(next); }
    else { controller.close(); controller.byobRequest?.respond(0); }
  } });
  const response = new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}
function deferred() { return Promise.withResolvers(); }
async function fixture(t) {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const kv = new Map(), sent = [], logs = [];
  const env = { CLAWROUTER_ACCESS_TEAM_DOMAIN: issuer, CLAWROUTER_ACCESS_AUD: "device-fixture",
    CLAWROUTER_ACCESS_ADMIN_EMAILS: `${email},${otherEmail}`, CLAWROUTER_ADMIN_TOKEN_SHA256: await sha256Hex("synthetic-admin-token"),
    POLICY_KV: { async get(k, type) { const v = kv.get(k); return v === undefined ? null : type === "json" ? structuredClone(v) : JSON.stringify(v); },
      async put(k, v) { kv.set(k, JSON.parse(v)); }, async list({ prefix = "" } = {}) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } } };
  const authority = createGrantAuthority(undefined, env);
  env.ACCESS_CONTROL = { idFromName: name => name, get: () => ({ fetch: (url, init) => authority.fetch(url, init) }) };
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: kv });
  const f = { env, kv, sent, logs, authority,
    advance(ms = 5000) { now += ms; },
    owner() { return env.GRANT_CREDENTIALS.objects.get(key); },
    record() { return structuredClone(f.owner()?.values.get("credential")); },
    restart() { const o = f.owner(); o.object = new GrantCredentialObject(o.state, env); },
    async user(enabled, actor = email) {
      return authority.fetch("https://clawrouter.internal/users/put", { method: "POST", body: JSON.stringify({ email: actor, record: { role: "admin", enabled, tenantId: "default", groups: [], contentRetentionDisabled: false } }) });
    },
    reply(url) {
      if (url.includes('/copilot_internal/user')) return vendor(url, { endpoints: { api: 'https://api.individual.githubcopilot.com/v1' } });
      return vendor(url, url.endsWith('/device/code')
        ? { device_code: 'synthetic-private-device-code', user_code: 'SYNTHETIC-CODE', verification_uri: new URL('/login/device', url).href, expires_in: 900, interval: 5 }
        : { access_token: 'synthetic-original-github-token', token_type: 'bearer', scope: 'read:user' });
    },
    async run(body, options = {}) {
      const headers = new Headers({ origin, "content-type": "application/json", "cf-access-jwt-assertion": await jwt(options.actor) });
      for (const [k, v] of Object.entries(options.headers ?? {})) { if (v === null) headers.delete(k); else headers.set(k, v); }
      return adminApi(new Request(`${origin}${options.path ?? path}?flow=${body.flow ?? "copilot-device.v1"}`, { method: "POST", headers, body: options.raw ?? JSON.stringify({ flow: "copilot-device.v1", provider: "github-copilot", ...body }), signal: options.signal }), env, options.path ?? path);
    },
    begin(extra = {}, options) { return f.run({ operation: "begin", githubDomain: "github.com", intentId: "synthetic-intent-0001", expectedGeneration: 0, ...extra }, options); },
    action(operation, attemptId, options) { return f.run({ operation, attemptId }, options); },
  };
  for (const name of ["log", "warn", "error"]) t.mock.method(console, name, (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    const init = input instanceof Request ? { method: input.method, headers: input.headers, signal: input.signal, ...options } : options;
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    assert.match(url, /^https:\/\/(?:github\.com|fixture\.ghe\.com|api\.github\.com|api\.fixture\.ghe\.com)\/(?:login\/(?:device\/code|oauth\/access_token)|copilot_internal\/user)$/);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has("cf-access-jwt-assertion"), false);
    sent.push({ url, init, record: f.record() });
    return f.reply(url, init);
  });
  t.after(() => assert.deepEqual(logs, []));
  // Capture the real owner continuation, including work that outlives a prompt
  // cancellation response. Never substitute a second cancel for its first ACK.
  env.GRANT_CREDENTIALS.get(key);
  const retained = new Set();
  f.owner().state.waitUntil = promise => { const work = promise.catch(() => undefined); retained.add(work); void work.finally(() => retained.delete(work)); };
  f.retired = async () => { while (retained.size) await Promise.all([...retained]); };
  await f.user(true); await f.user(true, otherEmail);
  return f;
}
async function body(response, status = 200) {
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-original-github-token|synthetic-private-device-code|ownerBinding|copilotDeviceCredential|credentialGeneration/);
  return value;
}

async function acquired(t, githubDomain = "github.com") {
  const f = await fixture(t), begun = await body(await f.begin({ githubDomain }));
  f.advance(); await body(await f.action('poll', begun.attemptId)); await f.retired();
  const original = f.record();
  f.input = { flow: 'copilot-account.v1', provider: 'github-copilot', attemptId: begun.attemptId,
    expectedGeneration: original.generation, expectedLineage: original.lineage };
  f.account = (operation = 'qualify', patch = {}, options) => f.run({ ...f.input, operation, ...patch }, options);
  f.accountSent = () => f.sent.filter(x => x.url.includes('/copilot_internal/user'));
  return f;
}

for (const domain of ['github.com','fixture.ghe.com']) test('Copilot account binds original private token and installation generation: ' + domain, async t => {
  const f = await acquired(t, domain), original = f.record();
  // Device code expiry never becomes invented GitHub token expiry.
  f.advance(1000000);
  if (domain !== 'github.com') f.reply = url => vendor(url, {});
  const value = await body(await f.account()); assert.equal(value.status, 'qualified');
  assert.equal(f.accountSent().length, 1);
  const sent = f.accountSent()[0]; assert.equal(sent.url, `https://api.${domain}/copilot_internal/user`);
  assert.equal(new Headers(sent.init.headers).get('authorization'), 'Bearer synthetic-original-github-token');
  assert.equal(sent.record.copilotAccountAttempt.phase, 'dispatch_unknown');
  const r = f.record(), binding = r.copilotAccountBinding;
  assert.equal(r.generation, original.generation); assert.equal(r.lineage, original.lineage);
  assert.equal(binding.acquisitionBinding, original.copilotDeviceCredential.ownerBinding);
  assert.notEqual(binding.ownerBinding, binding.acquisitionBinding);
  assert.equal(binding.apiBaseUrl, domain === 'github.com' ? 'https://api.individual.githubcopilot.com/v1' : 'https://copilot-api.fixture.ghe.com');
  assert.equal(r.status, 'reauth_required');
  assert.deepEqual(r.copilotDeviceCredential, original.copilotDeviceCredential);
  for(const field of ['accessToken','credential','refreshToken','expiresAt'])assert.equal(r[field],undefined);
  for(const op of ['qualify','status'])assert.equal((await body(await f.account(op))).status,'qualified');
  assert.equal(f.accountSent().length,1);
  const projection=await inspectGrantCredentials(f.env,key);
  assert.doesNotMatch(JSON.stringify(projection),/copilotAccount|apiBaseUrl|synthetic-original|ownerBinding/);
  assert.equal(projection.hasAccessToken,false);
  await assert.rejects(materializeGrantCredentials(f.env,key,projection,'github-copilot',null,false));
  await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const patch of [{expectedGeneration:1},{expectedLineage:'foreign-lineage-0000'},{attemptId:'foreign-attempt-0000'},
 {githubDomain:'github.com'},{accessToken:'forged'},{apiBaseUrl:'https://evil.example'},{provider:'copilot-proxy'}])
 test('Copilot account denies forged scope before HTTP '+JSON.stringify(patch),async t=>{
  const f=await acquired(t);await body(await f.account('qualify',patch),409);
  assert.equal(f.accountSent().length,0);await f.retired();assert.equal(bodyBudgetCharged(),0);
 });
for(const options of [{actor:otherEmail},{headers:{origin:null}},{headers:{origin:'https://foreign.example'}},
 {headers:{'cf-access-jwt-assertion':null,authorization:'Bearer synthetic-admin-token'}}])
 test('Copilot account requires current original Access administrator '+JSON.stringify(options),async t=>{
  const f=await acquired(t);const r=await f.account('qualify',{},options);assert.ok([401,403,409].includes(r.status));await r.text();
  assert.equal(f.accountSent().length,0);await f.retired();assert.equal(bodyBudgetCharged(),0);
 });
for(const change of ['generation','lineage','domain','acquisition','token','enabled'])test('Copilot account rejects replaced acquisition: '+change,async t=>{
 const f=await acquired(t),r=f.record();
 if(change==='generation')r.generation++;
 if(change==='lineage')r.lineage='foreign-lineage-0000';
 if(change==='domain')r.copilotDeviceCredential.githubDomain='fixture.ghe.com';
 if(change==='acquisition')r.copilotDeviceCredential.ownerBinding='foreign';
 if(change==='token')r.copilotDeviceCredential.accessToken='';
 if(change==='enabled')r.enabled=false;
 await f.owner().state.storage.put('credential',r);await body(await f.account(),409);
 assert.equal(f.accountSent().length,0);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const mutation of ['cancel','revoke','replace','admin'])test('Copilot account held HTTP permits '+mutation+' and rejects late success',async t=>{
 const f=await acquired(t),entered=deferred(),release=deferred(),reply=f.reply;
 f.reply=async(...args)=>{entered.resolve();await release.promise;return reply(...args);};
 const pending=f.account();await entered.promise;assert.equal(bodyBudgetCharged(),66*1024*1024);
 assert.equal((await body(await f.account('status'))).status,'qualifying');
 assert.equal((await body(await f.account())).status,'qualifying');assert.equal(f.accountSent().length,1);
 if(mutation==='cancel')assert.equal((await body(await f.account('cancel'))).status,'cancelled');
 if(mutation==='revoke')await revokeGrantCredentials(f.env,key);
 if(mutation==='replace')await putGrantCredentials(f.env,key,{provider:'github-copilot',kind:'api_key',credential:'synthetic-replacement'});
 if(mutation==='admin')await f.user(false);
 if(mutation!=='admin'){
  const r=await pending;assert.ok([200,403,409].includes(r.status));await r.text();
  assert.equal(f.accountSent()[0].init.signal.aborted,true);
  assert.ok(bodyBudgetCharged()>=64*1024*1024);
  const competitor=new BodyLease();assert.equal(competitor.grow(17*1024*1024),false);competitor.release();
 }
 release.resolve();if(mutation==='admin'){const r=await pending;assert.equal(r.status,403);await r.text();}
 await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(f.record().copilotAccountBinding,undefined);
 assert.equal(f.accountSent().length,1);
});
test('Copilot account capacity refusal precedes durable fence and HTTP',async t=>{
 const f=await acquired(t),other=new BodyLease();assert.equal(other.grow(17*1024*1024),true);
 await body(await f.account(),503);assert.equal(f.accountSent().length,0);assert.equal(f.record().copilotAccountAttempt,undefined);
 other.release();assert.equal((await body(await f.account())).status,'qualified');await f.retired();assert.equal(bodyBudgetCharged(),0);
});
for(const kind of ['malformed-tail','foreign-api','redirect','length','network','encoding'])test('Copilot account terminal failure does not replay: '+kind,async t=>{
 const f=await acquired(t);f.reply=url=>{
  if(kind==='network')throw new Error('synthetic transport uncertainty');
  if(kind==='malformed-tail')return vendor(url,'{"endpoints":{"api":"https://api.individual.githubcopilot.com"}}x');
  if(kind==='foreign-api')return vendor(url,{endpoints:{api:'https://foreign.example'}});
  const r=vendor(url,{},kind==='redirect'?302:200);
  if(kind==='length')r.headers.set('content-length','999');
  if(kind==='encoding')r.headers.set('content-encoding','gzip');return r;
 };
 assert.equal((await body(await f.account())).status,'unknown');assert.equal(f.record().copilotAccountBinding,undefined);
 f.restart();assert.equal((await body(await f.account('status'))).status,'unknown');await body(await f.account());
 assert.equal(f.accountSent().length,1);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
test('Copilot account atomic commit failure retains fence; lost publication ACK recovers without another GET',async t=>{
 const f=await acquired(t),storage=f.owner().state.storage,put=storage.put.bind(storage);let fail=true;
 storage.put=async(k,v)=>{if(fail&&v?.copilotAccountBinding){fail=false;throw new Error('synthetic persistence failure');}return put(k,v);};
 assert.equal((await body(await f.account())).status,'unknown');assert.equal(f.record().copilotAccountBinding,undefined);
 await body(await f.account('status'));assert.equal(f.accountSent().length,1);await f.retired();assert.equal(bodyBudgetCharged(),0);
});
test('Copilot account committed status retries only projection publication',async t=>{
 const f=await acquired(t),put=f.env.POLICY_KV.put;let failed=false;
 f.env.POLICY_KV.put=async(k,v)=>{if(!failed&&f.record().copilotAccountBinding){failed=true;throw new Error('synthetic publication failure');}return put(k,v);};
 await body(await f.account(),503);assert.ok(f.record().copilotAccountBinding);f.restart();
 assert.equal((await body(await f.account('status'))).status,'qualified');assert.equal(f.accountSent().length,1);
 await f.retired();assert.equal(bodyBudgetCharged(),0);
});
test('Copilot account first cancel and pending read hold physical lock and charge independently',async t=>{
 const f=await acquired(t),entered=deferred(),read=deferred(),cancel=deferred();let cancels=0,unlocks=0;
 let locked=false;
 f.reply=url=>{const r=vendor(url,{});const reader={async read(){entered.resolve();try{await read.promise;throw new Error('cancelled read');}finally{}},async cancel(){cancels++;await cancel.promise;},releaseLock(){locked=false;unlocks++;}};
 Object.defineProperty(r,'body',{value:{get locked(){return locked;},getReader(){locked=true;return reader;}}});return r;};
 const pending=f.account();await entered.promise;await body(await f.account('cancel'));await body(await pending);
 assert.equal(cancels,1);assert.equal(locked,true);assert.equal(bodyBudgetCharged(),64*1024*1024);
 read.resolve();await Promise.resolve();assert.equal(locked,true);assert.equal(bodyBudgetCharged(),64*1024*1024);
 cancel.resolve();await f.retired();assert.equal(unlocks,1);assert.equal(locked,false);assert.equal(bodyBudgetCharged(),0);
});
test('Copilot account private row bound precedes serialization and rejects getters/cycles/arrays',()=>{
 assert.doesNotThrow(()=>assertCopilotAccountRecord({text:'a'.repeat(96*1024-11)}));
 assert.throws(()=>assertCopilotAccountRecord({text:'a'.repeat(96*1024)}));
 assert.throws(()=>assertCopilotAccountRecord({text:'\u0000'.repeat(17000)}));
 let invoked=false;assert.throws(()=>assertCopilotAccountRecord({get text(){invoked=true;return 'x';}}));assert.equal(invoked,false);
 const cycle={};cycle.next=cycle;assert.throws(()=>assertCopilotAccountRecord(cycle));
 assert.throws(()=>assertCopilotAccountRecord({data:[]}));
});

test('Copilot account fresh administrator check follows the last owner read before commit',async t=>{
 const f=await acquired(t),storage=f.owner().state.storage,get=storage.get.bind(storage);let reads=0;
 storage.get=async k=>{const value=await get(k);if(value?.copilotAccountAttempt?.phase==='dispatch_unknown'&&++reads===2)await f.user(false);return value;};
 const response=await f.account();assert.equal(response.status,403);await response.text();
 assert.equal(f.record().copilotAccountBinding,undefined);assert.equal(f.accountSent().length,1);
 await f.retired();assert.equal(bodyBudgetCharged(),0);
});

test('Copilot account restart fences an outstanding GET and withholds old continuation installation',async t=>{
 const f=await acquired(t),entered=deferred(),release=deferred(),reply=f.reply;
 f.reply=async(...args)=>{entered.resolve();await release.promise;return reply(...args);};
 const pending=f.account();await entered.promise;f.restart();
 assert.equal((await body(await f.account('status'))).status,'unknown');
 release.resolve();assert.equal((await body(await pending)).status,'unknown');
 assert.equal(f.record().copilotAccountBinding,undefined);assert.equal(f.accountSent().length,1);
 await f.retired();assert.equal(bodyBudgetCharged(),0);
});

for(const end of ['eof','cancel'])test('Copilot account owner reply holds charge until producer '+end,async t=>{
 const f=await acquired(t),headers=new Headers({origin,'content-type':'application/json','cf-access-jwt-assertion':await jwt()});
 const response=await f.owner().object.fetch(new Request('https://clawrouter.internal/copilot-account',{method:'POST',headers,
  body:JSON.stringify({key,sourceUrl:origin+path+'?flow=copilot-account.v1',input:{...f.input,operation:'qualify'}})}));
 assert.equal(response.status,200);assert.equal(bodyBudgetCharged(),64*1024*1024);
 const reader=response.body.getReader(),first=await reader.read();assert.equal(first.done,false);assert.equal(bodyBudgetCharged(),64*1024*1024);
 if(end==='cancel')await reader.cancel();else assert.equal((await reader.read()).done,true);
 reader.releaseLock();await f.retired();assert.equal(bodyBudgetCharged(),0);assert.equal(f.accountSent().length,1);
});
