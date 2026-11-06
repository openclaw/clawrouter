import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { assignmentRulesRevision, evaluateUserAssignments } from '../assignment-evaluator.ts';

const email = 'member@example.com';
const rule = (version, extra = {}) => ({ ruleId: 'fifo', generatedGroup: 'assignment.fifo', version, enabled: true, kind: 'email_domain',
  subject: 'example.com', groups: ['automatic'], policyIds: [], priority: 10, revokeOnLoss: true, provenance: 'fixture-writer', ...extra });
const plans = [
  ...[101, 201, 301, 401].map(version => ({ version, hold: true, reject: null, rules: [rule(version)] })),
  { version: 102, hold: false, reject: null, rules: [rule(102, { enabled: false })] },
  { version: 103, hold: false, reject: null, rules: [rule(103, { groups: ['successor'] })] },
  { version: 202, hold: true, reject: 'undefined', rules: [rule(202, { enabled: false })] },
  { version: 203, hold: false, reject: null, rules: [rule(203, { groups: ['successor'] })] },
  { version: 302, hold: true, reject: 'error', rules: [rule(302, { enabled: false })] },
  { version: 303, hold: false, reject: null, rules: [rule(303, { groups: ['successor'] })] },
];
const router = String.raw`
import worker from './worker/index.ts';
import {PolicyBindingIndexObject as Owner} from './worker/authority.ts';
import {assignmentRulesRevision} from './worker/assignment-evaluator.ts';
export {BudgetLedgerObject,UsageLedgerObject,GrantCredentialObject} from './worker/index.ts';
const PLANS=__PLANS__,states=new Map(PLANS.map(plan=>[plan.version,{version:plan.version,entries:0,nativeSettled:0,held:false,settled:0,rejected:false,undefinedReason:false}]));
const raw=globalThis.fetch.bind(globalThis),originalDigest=crypto.subtle.digest.bind(crypto.subtle);
const matches=PLANS.map(plan=>({plan,bytes:new TextEncoder().encode(assignmentRulesRevision(plan.rules))}));
// Exact synthetic revision bytes only. Native digest settles FIRST; the held
// continuation is logical test custody, not a pending native crypto snapshot.
crypto.subtle.digest=function(algorithm,data){const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
 const found=matches.find(entry=>entry.bytes.length===bytes.length&&entry.bytes.every((byte,i)=>byte===bytes[i]));
 if(!found)return originalDigest(algorithm,data);
 const capture=Object.freeze({version:found.plan.version,hold:found.plan.hold,reject:found.plan.reject}),state=states.get(capture.version);
 const actual=originalDigest(algorithm,data);
 return actual.then(async result=>{state.nativeSettled++;if(capture.hold){state.held=true;
  const response=await raw('https://assignment-fixture.example/gate/'+capture.version);if(!response.ok)throw Error('fixture gate failed');await response.text();state.held=false;}
  if(capture.reject==='undefined')throw undefined;if(capture.reject==='error')throw Error('synthetic revision continuation failure');return result;});
};
export class PolicyBindingIndexObject extends Owner{
 constructor(state,env){super(state,env);this.fixtureSql=state.storage.sql;this.fixtureLists=0;this.fixtureInitializers=0;
  const original=this.reconcileUserAssignments.bind(this);
  // Called only AFTER the production body parser. No await or replacement
  // promise is inserted between observation and synchronous FIFO enrollment.
  this.reconcileUserAssignments=request=>{const state=states.get(request.rules[0]?.version);if(state)state.entries++;
   const actual=original(request);if(state)void actual.then(()=>{state.settled++;},reason=>{state.settled++;state.rejected=true;state.undefinedReason=reason===undefined;});return actual;};
 }
 fetch(request){const path=new URL(request.url).pathname;
  if(path==='/fixture-delete'){this.fixtureSql.exec('DELETE FROM access_users WHERE email = ?','member@example.com');return Response.json({deleted:true});}
  if(path==='/fixture-sql')return Response.json({rows:[...this.fixtureSql.exec('SELECT email,user_json FROM access_users ORDER BY email')],lists:this.fixtureLists,initializers:this.fixtureInitializers});
  if(path==='/users/list')this.fixtureLists++;if(path==='/users/initialize-all')this.fixtureInitializers++;
  return super.fetch(request);
 }
}
function environment(bindings,id){const prefix='writer/'+id+'/',kv=bindings.POLICY_KV,ns=bindings.ACCESS_CONTROL;
 return {...bindings,POLICY_KV:{get:(key,...args)=>kv.get(prefix+key,...args),put:(key,...args)=>kv.put(prefix+key,...args),delete:key=>kv.delete(prefix+key),
  async list(options){const page=await kv.list({...options,prefix:prefix+(options.prefix??'')});return {...page,keys:page.keys.map(key=>({...key,name:key.name.slice(prefix.length)}))};}},
  ACCESS_CONTROL:{idFromName:name=>ns.idFromName(id+'/'+name),get:identity=>ns.get(identity)}};
}
export default {async fetch(request,bindings,ctx){const u=new URL(request.url),id=u.searchParams.get('case');if(!id)return new Response(null,{status:404});
 if(u.pathname==='/state')return Response.json([...states.values()]);
 const env=environment(bindings,id);
 if(u.pathname==='/sql'||u.pathname==='/delete')return env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName('policy-bindings')).fetch('https://clawrouter.internal/'+(u.pathname==='/sql'?'fixture-sql':'fixture-delete'),{method:'POST'});
 const pending=[];let failed=false,primary,response;
 const track=p=>{const observed=Promise.resolve(p).then(()=>{},()=>{throw Error('fixture background failure');});pending.push(observed);ctx.waitUntil(observed);};
 try{response=await worker.fetch(request,env,{waitUntil:track});}catch(error){failed=true;primary=error;}
 const cleanup=[];for(const result of await Promise.allSettled(pending))if(result.status==='rejected')cleanup.push(result.reason);
 if(cleanup.length)throw new AggregateError(failed?[primary,...cleanup]:cleanup,'public reconciliation cleanup');if(failed)throw primary;return response;
},queue:worker.queue};`.replace('__PLANS__', JSON.stringify(plans));

test('actual public admin reconciliation writes compact revisions and preserves FIFO/current canonical state', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assignment-revision-'));
  const gates = new Map(), released = new Set(), clients = [];
  let runtime, server, primary, releaseFuture = false;
  const abort = new AbortController();
  const release = label => { released.add(String(label)); gates.get(String(label))?.end('released'); gates.delete(String(label)); };
  const releaseAll = () => { releaseFuture = true; for (const label of gates.keys()) release(label); };
  const stop = () => { releaseAll(); abort.abort(t.signal.reason); };
  t.signal.addEventListener('abort', stop, { once: true });
  t.after(async () => {
    releaseAll(); const failures = [];
    for (const result of await Promise.allSettled(clients)) if (result.status === 'rejected' && result.reason !== primary) failures.push(result.reason);
    try { if (runtime) await runtime.dispose(); } catch (error) { failures.push(error); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    t.signal.removeEventListener('abort', stop);
    if (failures.length) throw new AggregateError(failures, 'writer fixture cleanup');
  });
  try {
    server = createServer((request, response) => { const label = new URL(request.url, 'http://fixture').pathname.slice('/gate/'.length);
      if (releaseFuture || released.has(label)) response.end('released'); else gates.set(label, response); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const upstream = `export default {fetch(request){const u=new URL(request.url);if(u.origin!=='https://assignment-fixture.example')throw Error('unexpected fixture egress');return fetch(${JSON.stringify(origin)}+u.pathname,{signal:request.signal});}};`;
    runtime = await startWorkerdFixture(directory, router, upstream, { preventEviction: true, bindings: { CLAWROUTER_ADMIN_TOKEN_SHA256: createHash('sha256').update('synthetic-writer-admin').digest('hex') } });
    const kv = await runtime.getKVNamespace('POLICY_KV', 'router');
    const put = (id, key, value) => kv.put('writer/' + id + '/' + key, JSON.stringify(value));
    const baseUser = { role: 'user', tenantId: 'fixture', enabled: true, groups: ['manual'], contentRetentionDisabled: false,
      budgetOverrides: { policy: { monthlyBudgetMicros: 17, updatedBy: 'admin@example.com', updatedAt: '2026-01-01T00:00:00.000Z' } } };
    const seed = async (id, rules, record = baseUser) => {
      await put(id, 'access/users/' + email, record);
      await put(id, 'policies/policy', { enabled: true, generation: 'g1', providers: ['openai'], monthlyBudgetMicros: null, retainRequestContent: false });
      for (let offset = 0; offset < rules.length; offset += 32) await Promise.all(rules.slice(offset, offset + 32).map(r => put(id, 'access/assignment-rules/' + r.ruleId, r)));
    };
    const call = (id, path, body, method = body === undefined ? 'GET' : 'POST') => {
      const actual = runtime.dispatchFetch('https://router.example' + path + '?case=' + id, { method, signal: abort.signal,
        headers: { authorization: 'Bearer synthetic-writer-admin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        .then(async response => ({ status: response.status, body: await response.json() }));
      clients.push(actual); void actual.catch(() => {}); return actual;
    };
    const state = async (version, predicate, original) => {
      const premature = original?.then(() => { throw Error('original request completed before expected FIFO observation'); }); if (premature) void premature.catch(() => {});
      for (let i = 0; i < 2000; i++) { const result = await Promise.race([call('state', '/state'), ...(premature ? [premature] : [])]);
        const row = result.body.find(row => row.version === version); if (predicate(row)) return row;
        await Promise.race([delay(5), ...(premature ? [premature] : [])]); }
      assert.fail('bounded writer fixture arrival expired');
    };
    const current = async id => { const result = await call(id, '/sql'); assert.equal(result.status, 200); return result.body; };
    const reconcile = (id, body = { email }) => call(id, '/v1/admin/assignment-rules/reconcile', body);
    const large = Array.from({ length: 1000 }, (_, i) => rule(1, { ruleId: `absent-${String(i).padStart(4, '0')}`, subject: `absent-${i}.example`, groups: [], policyIds: [] }));
    const legacy = assignmentRulesRevision(large); assert.ok(Buffer.byteLength(legacy) > 65536);
    await seed('large', large);
    assert.equal((await reconcile('large', { all: true })).status, 200);
    let sql = await current('large'), record = JSON.parse(sql.rows[0].user_json);
    assert.ok(sql.lists >= 2); assert.equal(sql.initializers, 1, 'real KV cold hydration followed by final SQLite reread');
    assert.match(record.assignmentState.revision, /^assignment-rules\.v1:sha256:[a-f0-9]{64}$/);
    const compact = record.assignmentState.revision;
    const expected = createHash('sha256').update(legacy).digest('hex'); assert.equal(compact, 'assignment-rules.v1:sha256:' + expected);
    const legacyRecord = evaluateUserAssignments({ email, record: baseUser }, large).user.record;
    await seed('unchanged', large, legacyRecord);
    assert.equal((await call('unchanged', '/v1/admin/access-users')).status, 200);
    const before = await current('unchanged'), kvBefore = await kv.get('writer/unchanged/access/users/' + email);
    assert.equal((await reconcile('unchanged', { all: true })).status, 200);
    assert.equal((await current('unchanged')).rows[0].user_json, before.rows[0].user_json);
    assert.equal(await kv.get('writer/unchanged/access/users/' + email), kvBefore);
    const added = { enabled: true, kind: 'exact_email', subject: email, groups: ['from-put'], policyIds: ['policy'], priority: 1 };
    assert.equal((await call('large', '/v1/admin/assignment-rules/added', added, 'PUT')).status, 200);
    assert.ok(JSON.parse((await current('large')).rows[0].user_json).groups.includes('from-put'));
    await kv.delete('writer/large/access/assignment-rules/added');
    assert.equal((await reconcile('large')).status, 200);
    assert.deepEqual(JSON.parse((await current('large')).rows[0].user_json).groups, ['manual']);

    for (const [id, first] of [['fifo', 101], ['undefined', 201], ['error', 301]]) {
      await seed(id, [rule(first)]);
      const a = reconcile(id); await state(first, row => row.held && row.nativeSettled === 1, a);
      await put(id, 'access/assignment-rules/fifo', rule(first + 1, { enabled: false }));
      const b = reconcile(id); let bDone = false; b.then(() => { bDone = true; }, () => { bDone = true; });
      const queuedB = await state(first + 1, row => row.entries === 1, b);
      assert.equal(queuedB.nativeSettled, 0); assert.equal(queuedB.settled, 0);
      assert.equal(bDone, false); assert.equal((await current(id)).rows.length, 1);
      assert.equal(JSON.parse((await current(id)).rows[0].user_json).assignmentState, undefined);
      const profile = { enabled: false, tenantId: 'updated', groups: ['new-manual'], contentRetentionDisabled: true };
      assert.equal((await call(id, '/v1/admin/access-users/' + email, profile, 'PUT')).status, 200);
      if (id === 'fifo') {
        await put(id, 'access/assignment-rules/fifo', rule(103, { groups: ['successor'] })); // AFTER B capture.
        release(first); assert.equal((await a).status, 200); assert.equal((await b).status, 200);
        record = JSON.parse((await current(id)).rows[0].user_json);
        assert.deepEqual(record.groups, ['new-manual']); assert.equal(record.enabled, false); assert.equal(record.tenantId, 'updated');
        assert.equal(record.contentRetentionDisabled, true); assert.deepEqual(record.budgetOverrides, baseUser.budgetOverrides);
        assert.equal((await reconcile(id)).status, 200); assert.deepEqual(JSON.parse((await current(id)).rows[0].user_json).groups, ['new-manual', 'successor']);
      } else {
        await put(id, 'access/assignment-rules/fifo', rule(first + 2, { groups: ['successor'] }));
        const c = reconcile(id); let cDone = false; c.then(() => { cDone = true; }, () => { cDone = true; });
        const queuedC = await state(first + 2, row => row.entries === 1, c);
        assert.equal(queuedC.nativeSettled, 0); assert.equal(queuedC.settled, 0); assert.equal(cDone, false);
        release(first); assert.equal((await a).status, 200);
        await state(first + 1, row => row.held && row.nativeSettled === 1, b); assert.equal(cDone, false);
        assert.equal((await state(first + 2, () => true)).nativeSettled, 0);
        release(first + 1); assert.equal((await b).status, 500); assert.equal((await c).status, 200);
        const failed = await state(first + 1, row => row.settled === 1);
        assert.equal(failed.rejected, true); assert.equal(failed.undefinedReason, id === 'undefined');
        assert.deepEqual(JSON.parse((await current(id)).rows[0].user_json).groups, ['new-manual', 'successor']);
      }
    }
    await seed('deleted', [rule(401)]);
    const deleted = reconcile('deleted'); await state(401, row => row.held, deleted);
    assert.equal((await call('deleted', '/delete')).body.deleted, true, 'labelled raw SQL deletion, not an invented public endpoint');
    release(401); const deletionReply = await deleted;
    assert.equal(deletionReply.status, 500); assert.equal(deletionReply.body.error.code, 'internal_error'); assert.deepEqual((await current('deleted')).rows, []);

    const orgRules = [rule(1, { ruleId: 'revoking', kind: 'github_org', subject: 'example', groups: ['revoking'] }),
      rule(1, { ruleId: 'retained', kind: 'github_org', subject: 'example', groups: ['retained'], revokeOnLoss: false })].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    const present = { source: 'github', verified: true, githubOrgs: ['example'], githubTeams: [] };
    const assigned = evaluateUserAssignments({ email, record: { ...baseUser, enabled: false } }, orgRules, present, true).user.record;
    await seed('evidence', orgRules, assigned);
    assert.equal((await reconcile('evidence')).status, 200); assert.deepEqual(JSON.parse((await current('evidence')).rows[0].user_json).groups, ['manual', 'retained', 'revoking']);
    assert.equal((await reconcile('evidence', { email, evidence: { ...present, githubOrgs: [] } })).status, 200);
    record = JSON.parse((await current('evidence')).rows[0].user_json); assert.deepEqual(record.groups, ['manual', 'retained']); assert.equal(record.enabled, false);
    await put('evidence', 'access/assignment-rules/retained', { ...orgRules[0], enabled: false });
    assert.equal((await reconcile('evidence')).status, 200); assert.deepEqual(JSON.parse((await current('evidence')).rows[0].user_json).groups, ['manual']);
  } catch (error) { primary = error; throw error; }
});
