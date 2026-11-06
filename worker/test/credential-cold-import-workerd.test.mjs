import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';

const modes = ['success', 'safe', 'undefined', 'generic', 'kv-list', 'kv-get', 'initializer-ack', 'final-reread', 'invalid-auth', 'invalid-body'];
const cases = Object.fromEntries(['admin', 'personal'].flatMap(scope => modes.map(mode => [scope + '-' + mode, { scope, mode }])));
const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Owner} from './worker/authority.ts';
import {HttpError,sha256Hex} from './worker/utils.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
// Test-only raw SQL inspection: never calls a list/import API or repairs state.
export class PolicyBindingIndexObject extends Owner {
 constructor(state,env){super(state,env);this.fixtureSql=state.storage.sql;}
 async fetch(request){if(new URL(request.url).pathname!=='/fixture-state')return super.fetch(request);
  const count=(table)=>[...this.fixtureSql.exec('SELECT count(*) AS n FROM '+table)][0].n;
  const exists=(id)=>[...this.fixtureSql.exec('SELECT count(*) AS n FROM proxy_credentials WHERE credential_id = ?',id)][0].n;
  return Response.json({credentials:count('proxy_credentials'),policies:count('access_policies'),users:count('access_users'),bindings:count('policy_binding_entries'),
   markers:count('policy_binding_meta'),legacy:exists('legacy_key'),created:exists('new_key')});
 }
}
const CASES=__CASES__,states=new Map(),raw=globalThis.fetch.bind(globalThis);
const names=['credentials','policies','users','bindings'],paths=['/credentials/list','/policies/list','/users/list','/list'];
const view=a=>({id:a.id,scope:a.scope,mode:a.mode,lists:a.lists,rereads:a.rereads,mutations:a.mutations,failed:a.failed,secondary:a.secondary,
 committed:a.committed,outward:a.outward,status:a.status,background:a.background,backgroundFailed:a.backgroundFailed,ownerFailure:a.ownerFailure});
const gate=async(a,label)=>{const r=await raw('https://cold-import.example/gate/'+a.id+'/'+label);if(!r.ok)throw Error('fixture gate failed');await r.text();};
function fail(a,kind){a.failed=true;if(kind==='safe')throw new HttpError(409,'fixture_safe','safe fixture denial');
 if(kind==='undefined')throw undefined;throw Error('PRIVATE_IMPORT_SENTINEL');}
async function setup(env,id){
 if(states.has(id))return states.get(id);
 const definition=CASES[id];if(!definition)throw Error('unknown case');
 const a={id,...definition,lists:[0,0,0,0],rereads:[0,0,0,0],mutations:0,failed:false,secondary:false,committed:false,outward:false,status:null,background:0,backgroundFailed:false,ownerFailure:null};
 const stub=env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings-'+id));a.stub=stub;
 const email='owner@example.com',policy={enabled:true,generation:'v1',providers:['openai'],tenantId:'fixture',monthlyBudgetMicros:null,requestCostMicros:1000,
  retainRequestContent:false,grantRouting:{strategy:'priority',eligibleGrants:{}}};
 const user={enabled:true,role:'user',groups:['maintainers'],tenantId:'fixture'},digest='ab'.repeat(32),cookie='cd'.repeat(32);
 const store=new Map([['policies/fixture',policy],['credentials/legacy_key',{enabled:true,secretSha256:digest,policyId:'fixture',policyGeneration:'v1',principalId:email}],
  ['access/users/'+email,user],['access/users/imported@example.com',{...user,groups:[]}],
  ['access/bindings/group/maintainers/fixture',{policyId:'fixture',principalType:'group',principalId:'maintainers',enabled:true,priority:10}],
  ['local/sessions/'+await sha256Hex(cookie),{email,role:'admin',createdAt:new Date().toISOString(),expiresAtMs:Date.now()+300000}]]);
 // Actor resolution is warm; the GLOBAL users import remains cold.
 const seeded=await stub.fetch('https://clawrouter.internal/users/initialize',{method:'POST',body:JSON.stringify([{email,record:user}])});
 if(!seeded.ok||await seeded.text()!=='initialized')throw Error('actor seed failed');
 const kv={async list({prefix}){if(a.mode==='kv-list'&&prefix==='access/users/')fail(a,'generic');
   return {list_complete:true,keys:[...store.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};},
  async get(key){if(a.mode==='kv-get'&&typeof key==='string'&&key.startsWith('access/users/'))fail(a,'generic');
   return structuredClone(store.get(key)??null);},async put(key,value){store.set(key,JSON.parse(value));},async delete(key){store.delete(key);}};
 const access={idFromName:n=>env.ACCESS_CONTROL.idFromName(n+'-'+id),get:()=>({async fetch(input,init){
  const path=new URL(input).pathname,index=paths.indexOf(path);
  if(path==='/credentials/mutate'){
   a.mutations++;const expected=a.scope==='personal'?4:3;
   if(a.rereads.slice(0,expected).some(n=>n!==1))throw Error('mutation preceded final import reread');
  }
  if(index!==-1){a.lists[index]++;
   if(a.lists[index]===1){await gate(a,names[index]);
    if(index===2&&['safe','undefined','generic'].includes(a.mode))fail(a,a.mode);
    if(index===1&&['safe','undefined','generic'].includes(a.mode)){a.secondary=true;throw Error('SECOND_IMPORT_SENTINEL');}
   }else if(index===2&&a.mode==='final-reread')fail(a,'generic');
  }
  let response;
  try{response=await stub.fetch(input,init);}catch(error){
   a.ownerFailure??={stage:index===-1?'initializer-or-control':names[index],kind:['Error','TypeError'].includes(error?.name)?error.name:'other',
    requestContext:typeof error?.message==='string'&&/different request|I\/O.*context/i.test(error.message)};
   throw error;
  }
  if(path==='/users/initialize-all'&&a.mode==='initializer-ack'){
   a.committed=true;await response.body.cancel();fail(a,'generic');
  }
  if(index!==-1&&a.lists[index]===2)a.rereads[index]++;
  return response;
 }})};
 a.env={...env,POLICY_KV:kv,ACCESS_CONTROL:access,CLAWROUTER_LOCAL_AUTH:'enabled',CLAWROUTER_ADMIN_TOKEN_SHA256:await sha256Hex('synthetic-admin-token')};
 states.set(id,a);return a;
}
export default {async fetch(request,env,ctx){const u=new URL(request.url),id=u.searchParams.get('case');
 if(!CASES[id])return new Response(null,{status:404});
 if(u.pathname==='/setup'){const a=await setup(env,id);const r=await a.stub.fetch('https://clawrouter.internal/fixture-state',{method:'POST'});return r;}
 const a=states.get(id);if(!a)throw Error('case not initialized');
 if(u.pathname==='/state')return Response.json(view(a));
 if(u.pathname==='/sql')return a.stub.fetch('https://clawrouter.internal/fixture-state',{method:'POST'});
 if(!['/v1/admin/credentials','/v1/session/credentials'].includes(u.pathname))return new Response(null,{status:404});
 const response=await worker.fetch(request,a.env,{waitUntil(p){a.background++;const observed=Promise.resolve(p).then(()=>{a.background--;},()=>{a.background--;a.backgroundFailed=true;});ctx.waitUntil(observed);}});
 a.outward=true;a.status=response.status;return response;
},queue:worker.queue};`.replace('__CASES__', JSON.stringify(cases));

test('public admin and personal credential mutations join real cold imports before failure or one mutation', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'credential-cold-import-'));
  let runtime, server, primary, releaseFuture = false;
  const gates = new Map(), released = new Set(), clients = [], initialized = [];
  const controller = new AbortController();
  const release = key => { released.add(key); gates.get(key)?.end('released'); gates.delete(key); };
  const releaseAll = () => { releaseFuture = true; for (const key of gates.keys()) release(key); };
  const abort = () => { releaseAll(); controller.abort(t.signal.reason); };
  t.signal.addEventListener('abort', abort, { once: true });
  // Every client and current/future originating-request barrier is owned first.
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const result of await Promise.allSettled(clients)) if (result.status === 'rejected' && result.reason !== primary) failures.push(result.reason);
    if (runtime) {
      try {
        for (const id of initialized) {
          const r = await runtime.dispatchFetch('https://router.example/state?case=' + id);
          if (r.status !== 200) { await r.body?.cancel(); continue; }
          let s = await r.json();
          for (let n = 0; s.background && n < 500; n++) { await delay(10); s = await (await runtime.dispatchFetch('https://router.example/state?case=' + id)).json(); }
          assert.equal(s.background, 0); assert.equal(s.backgroundFailed, false);
        }
      } catch (error) { failures.push(error); }
      try { await runtime.dispose(); } catch (error) { failures.push(error); }
    }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', abort);
    if (failures.length) throw new AggregateError(failures, 'cold import fixture cleanup');
  });
  try {
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (!path.startsWith('/gate/')) { response.writeHead(404); response.end(); return; }
      const key = path.slice(6);
      if (releaseFuture || released.has(key)) response.end('released'); else gates.set(key, response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://cold-import.example')throw Error('unexpected egress');return fetch(${JSON.stringify(origin)}+u.pathname,{signal:request.signal});}};`;
    runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true });
    const call = (path, options) => {
      const pending = runtime.dispatchFetch('https://router.example' + path, { ...options, signal: controller.signal })
        .then(async r => ({ status: r.status, text: await r.text() }));
      pending.catch(() => {}); clients.push(pending); return pending;
    };
    const json = async path => { const r = await call(path); assert.equal(r.status, 200); return JSON.parse(r.text); };
    for (const [id, { scope, mode }] of Object.entries(cases)) {
      const seeded = await json('/setup?case=' + id);
      initialized.push(id);
      assert.equal(seeded.users, 1); assert.equal(seeded.markers, 0); assert.equal(seeded.credentials, 0);
      const headers = { origin: 'https://router.example', 'content-type': 'application/json',
        ...(scope === 'admin' ? { authorization: 'Bearer synthetic-admin-token' } : { cookie: 'clawrouter_session=' + 'cd'.repeat(32) }) };
      if (mode === 'invalid-auth') { delete headers.authorization; delete headers.cookie; }
      const started = call('/v1/' + (scope === 'admin' ? 'admin' : 'session') + '/credentials?case=' + id, {
        method: 'POST', headers, body: JSON.stringify({ credentialId: 'new_key', policyId: 'fixture', secretSha256: mode === 'invalid-body' ? 'bad' : 'ab'.repeat(32) }),
      });
      // Immediately observe BOTH originating rejection and premature fulfillment.
      const early = started.then(() => { throw Error('public credential request completed before held imports'); }, error => { throw error; });
      early.catch(() => {});
      const wait = async predicate => {
        let last;
        for (let n = 0; n < 1000; n++) {
          const s = await Promise.race([early, json('/state?case=' + id)]);
          last = s;
          if (predicate(s)) return s;
          await Promise.race([early, delay(10)]);
        }
        assert.fail('bounded cold import arrival expired: ' + JSON.stringify(last));
      };
      if (mode.startsWith('invalid-')) {
        const response = await started; assert.equal(response.status, mode === 'invalid-body' ? 400 : 401);
        const s = await json('/state?case=' + id); assert.deepEqual(s.lists, [0, 0, 0, 0]); assert.equal(s.mutations, 0); continue;
      }
      const count = scope === 'personal' ? 4 : 3, expected = ['credentials', 'policies', 'users', 'bindings'].slice(0, count);
      let s = await wait(row => expected.every((name, i) => gates.has(id + '/' + name) && row.lists[i] === 1));
      assert.equal(s.outward, false); assert.equal(s.mutations, 0);
      assert.deepEqual(s.lists, count === 4 ? [1, 1, 1, 1] : [1, 1, 1, 0]);
      if (mode === 'success') {
        for (const name of expected.slice(1)) release(id + '/' + name);
        s = await wait(row => row.rereads.slice(1, count).every(n => n === 1));
      } else {
        release(id + '/users'); s = await wait(row => row.failed);
        release(id + '/policies'); if (scope === 'personal') release(id + '/bindings');
        if (['safe', 'undefined', 'generic'].includes(mode)) s = await wait(row => row.secondary);
      }
      // These assertions are on the awaited path, before releasing the held sibling.
      assert.equal(s.outward, false); assert.equal(s.mutations, 0);
      assert.equal((await json('/sql?case=' + id)).created, 0);
      if (mode === 'initializer-ack') { assert.equal(s.committed, true); assert.equal((await json('/sql?case=' + id)).users, 2); }
      release(id + '/credentials');
      const response = await started, final = await json('/state?case=' + id), sql = await json('/sql?case=' + id);
      assert.equal(final.outward, true); assert.equal(final.mutations, mode === 'success' ? 1 : 0);
      assert.equal(sql.created, mode === 'success' ? 1 : 0); assert.equal(sql.legacy, 1, 'sibling import commit is not compensated');
      assert.equal(response.status, mode === 'success' ? 201 : mode === 'safe' ? 409 : 500);
      assert.equal(response.text.includes('PRIVATE_IMPORT_SENTINEL'), false); assert.equal(response.text.includes('SECOND_IMPORT_SENTINEL'), false);
      if (mode === 'safe') assert.equal(JSON.parse(response.text).error.code, 'fixture_safe');
      if (mode === 'success') {
        assert.equal(sql.policies, 1); assert.equal(sql.users, 2); assert.equal(sql.bindings, scope === 'personal' ? 1 : 0);
        assert.deepEqual(final.rereads, count === 4 ? [1, 1, 1, 1] : [1, 1, 1, 0]);
        assert.equal(JSON.parse(response.text).credentialId, 'new_key');
      }
    }
  } catch (error) { primary = error; throw error; }
});
