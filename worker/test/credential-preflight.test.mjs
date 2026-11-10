import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { PolicyBindingIndexObject } = await import('../authority.ts');
const { BodyLease, bodyBudgetCharged } = await import('../body-budget.ts');
const { PreflightTicket, PreflightInstanceArena, preflightPayloadBytes, preflightFactoryCharges, preflightControlSlots } = await import('../credential-preflight-arena.ts');
const { preflightCredential, consumeCredentialPreflight, releaseCredentialPreflight, releaseCredentialPreflightContinuation } = await import('../credential-preflight.ts');
const { consumePreflightCredential, consumePreflightReply } = await import('../credential-preflight-source.ts');
const { identitySourceBudget, isIdentityFailure, advanceIdentitySource, identitySourceSnapshot, identityPlan } = await import('../identity-admission.ts');
const digest = 'ab'.repeat(32), otherDigest = 'cd'.repeat(32);
const path = '/admission/credential-preflight';
const record = (overrides = {}) => ({ enabled: true, secretSha256: digest, policyId: 'fixture-policy', policyGeneration: 'legacy', principalId: null, ...overrides });
const input = (id = 'fixturekid', source = identitySourceBudget()) => ({ credentialId: id, secretSha256: digest, source });
const denied = error => isIdentityFailure(error) && error.status === 503;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tagged = promise => promise.then(value => ({ failed: false, value }), error => ({ failed: true, error }));

function fixture(t) {
  let cleanup = () => {};
  t.after(() => cleanup()); // Registered before SQLite disposal and before dispatch.
  const { db, sql, transactionSync } = sqliteFixture(t), stored = new Map(), trace = { sql: [], kv: [], writes: 0 };
  let beforeKv;
  const env = { POLICY_KV: { async get(key, mode) {
    trace.kv.push({ key, mode }); assert.equal(mode, 'stream');
    await beforeKv?.(key);
    const value = stored.get(key);
    return value == null ? null : accessBytesResponse(typeof value === 'string' ? value : JSON.stringify(value), '').body;
  } } };
  const observedSql = { exec(query, ...args) {
    trace.sql.push(query); if (/^(INSERT|UPDATE|DELETE)/.test(query)) trace.writes++;
    return sql.exec(query, ...args);
  } };
  const owner = new PolicyBindingIndexObject({ storage: { sql: observedSql, transactionSync } }, env);
  trace.sql.length = 0; trace.writes = 0;
  const call = async (value = input(), raw = JSON.stringify(value)) => {
    const response = await owner.fetch(new Request('https://authority' + path, { method: 'POST',
      headers: { 'x-clawrouter-credential-preflight': 'v1' }, body: accessBytesResponse(raw, '').body, duplex: 'half' }));
    const body = await response.json(); return { status: response.status, body };
  };
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { fetch(url, init) {
    return owner.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' }));
  } }; } };
  return { env, owner, db, sql, stored, trace, call, cleanup(fn) { cleanup = fn; }, beforeKv(fn) { beforeKv = fn; } };
}

test('exact tickets share the existing body counter; capacity precedes binding factories; DO arenas are separate', async () => {
  const baseline = bodyBudgetCharged(), tickets = [], body = new BodyLease();
  try {
    for (let i = 0; i < 3; i++) tickets.push(PreflightTicket.reserve());
    assert.equal(bodyBudgetCharged() - baseline, 96 * 1024 * 1024);
    let factories = 0;
    assert.throws(() => preflightCredential({ get ACCESS_CONTROL() { factories++; throw Error('not reached'); } }, 'fixturekid', digest), denied);
    assert.equal(factories, 0);
    tickets.pop().release(); assert.equal(body.grow(1024 * 1024), true);
    assert.throws(() => PreflightTicket.reserve(), denied);
    const independent = new PreflightInstanceArena(), ticket = PreflightTicket.reserve(independent);
    assert.equal(independent.charged, preflightPayloadBytes); ticket.release(); assert.equal(independent.charged, 0);
    for (const [window, rows] of Object.entries(preflightFactoryCharges)) assert.ok(Object.values(rows).reduce((a, b) => a + b, 0) <= preflightControlSlots[window]);
    assert.equal(Object.values(preflightControlSlots).reduce((a, b) => a + b, 0), 1024);
  } finally { body.release(); for (const ticket of tickets) ticket.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test('cold preflight: full canonical reads, credential-only work, opaque single-use proof and atomic small/full transfer', async t => {
  const f = fixture(t), baseline = bodyBudgetCharged(); f.stored.set('credentials/fixturekid', record({ copilotPublicIdentity: { forged: true } }));
  let proof, continuation;
  t.after(() => { if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const result = await preflightCredential(f.env, 'fixturekid', digest); assert.equal(result.outcome, 'matched'); proof = result.proof;
  const retained = bodyBudgetCharged() - baseline;
  assert.equal(retained, 2 * ('fixturekid'.length + 64 + 'policy-bindings'.length) + 56); assert.ok(retained < 1024 * 1024);
  assert.deepEqual(f.trace.kv, [{ key: 'credentials/fixturekid', mode: 'stream' }]);
  assert.equal(f.trace.sql.some(query => /access_policies|access_users|provider_connections|grant_pools/.test(query)), false);
  for (let i = 0; i < f.trace.sql.length; i++) if (f.trace.sql[i].startsWith('SELECT credential_json')) assert.ok(f.trace.sql[i - 1].startsWith('SELECT length'));
  const canonical = JSON.parse(f.db.prepare('SELECT credential_json FROM proxy_credentials WHERE credential_id=?').get('fixturekid').credential_json);
  assert.equal(Object.hasOwn(canonical, 'copilotPublicIdentity'), false);
  assert.throws(() => consumeCredentialPreflight(structuredClone(proof), f.env, 'fixturekid', digest), denied);
  assert.throws(() => consumeCredentialPreflight(proof, { ACCESS_CONTROL: {} }, 'fixturekid', digest), denied);
  assert.throws(() => consumeCredentialPreflight(proof, f.env, 'fixturekid', otherDigest), denied);
  continuation = consumeCredentialPreflight(proof, f.env, 'fixturekid', digest);
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  assert.throws(() => consumeCredentialPreflight(proof, f.env, 'fixturekid', digest), denied); proof = undefined;
  releaseCredentialPreflightContinuation(continuation); continuation = undefined;
  assert.equal(bodyBudgetCharged(), baseline);
  // A later operation sees rotation. The scalar proof is never authentication.
  f.db.prepare('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?').run(JSON.stringify(record({ secretSha256: otherDigest })), 'fixturekid');
  assert.deepEqual(await preflightCredential(f.env, 'fixturekid', digest), { outcome: 'invalid' });
});

test('disabled correct-secret credential preliminarily matches; this proof is not authentication', async t => {
  const f = fixture(t); f.stored.set('credentials/fixturekid', record({ enabled: false }));
  const result = await preflightCredential(f.env, 'fixturekid', digest);
  if (result.outcome === 'matched') t.after(() => releaseCredentialPreflight(result.proof));
  assert.equal(result.outcome, 'matched');
  const canonical = JSON.parse(f.db.prepare('SELECT credential_json FROM proxy_credentials').get().credential_json);
  assert.equal(canonical.enabled, false);
  const { proxyCredentialFailure } = await import('../proxy-auth.ts');
  const failure = proxyCredentialFailure(canonical, { policyId: 'fixture-policy', policy: { enabled: true, generation: 'legacy' } });
  assert.equal(failure.status, 403); assert.equal(failure.code, 'proxy_key_revoked');
});

test('unknown/invalid are closed outcomes; initialized fence and nonnull malformed legacy prevent fallback', async t => {
  const f = fixture(t);
  assert.deepEqual(await preflightCredential(f.env, 'unknownkid', digest), { outcome: 'unknown' });
  f.stored.set('credentials/fixturekid', {}); f.stored.set('keys/fixturekid', record());
  f.trace.kv.length = 0;
  assert.deepEqual(await preflightCredential(f.env, 'fixturekid', digest), { outcome: 'invalid' });
  assert.deepEqual(f.trace.kv.map(row => row.key), ['credentials/fixturekid']);
  f.sql.exec('INSERT INTO policy_binding_meta(meta_key) VALUES(?)', 'credentials_global_initialized');
  f.trace.kv.length = 0;
  assert.deepEqual(await preflightCredential(f.env, 'fencedkid', digest), { outcome: 'unknown' });
  assert.deepEqual(f.trace.kv, []);
});

test('failed proof expansion retains genuine small credit; successful transfer has no release gap', async t => {
  const f = fixture(t), baseline = bodyBudgetCharged(), body = new BodyLease();
  f.stored.set('credentials/fixturekid', record());
  let proof, continuation;
  t.after(() => { body.release(); if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const result = await preflightCredential(f.env, 'fixturekid', digest); assert.equal(result.outcome, 'matched'); proof = result.proof;
  const retained = bodyBudgetCharged() - baseline;
  assert.equal(body.grow(33 * 1024 * 1024), true);
  assert.throws(() => consumeCredentialPreflight(proof, f.env, 'fixturekid', digest), denied);
  assert.equal(bodyBudgetCharged() - baseline, 66 * 1024 * 1024 + retained);
  body.release(); continuation = consumeCredentialPreflight(proof, f.env, 'fixturekid', digest); proof = undefined;
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
});

test('canonical winner during original KV wait wins before normalization; no overwrite or unrelated work', async t => {
  const f = fixture(t), arrived = deferred(), release = deferred();
  f.stored.set('credentials/fixturekid', record()); f.beforeKv(async () => { arrived.resolve(); await release.promise; });
  let operation;
  f.cleanup(async () => { release.resolve(); if (operation) { const outcome = await operation; if (outcome.failed) throw outcome.error; } });
  operation = tagged(f.call());
  await Promise.race([arrived.promise, operation.then(outcome => { if (outcome.failed) throw outcome.error; throw Error('premature preflight'); })]);
  f.db.prepare('INSERT INTO proxy_credentials(credential_id,credential_json) VALUES(?,?)').run('fixturekid', JSON.stringify(record({ secretSha256: otherDigest })));
  release.resolve(); const outcome = await operation; operation = undefined; if (outcome.failed) throw outcome.error;
  assert.equal(outcome.value.body.outcome, 'invalid'); assert.equal(f.trace.writes, 0);
  assert.equal(JSON.parse(f.db.prepare('SELECT credential_json FROM proxy_credentials').get().credential_json).secretSha256, otherDigest);
});

test('prospective final full-record reread plus request/reply deny BEFORE seed, marker or commit writes', async t => {
  const f = fixture(t), value = record({ policyId: '' });
  value.policyId = 'x'.repeat(1048576 - Buffer.byteLength(JSON.stringify(value)));
  const raw = JSON.stringify(value); assert.equal(Buffer.byteLength(raw), 1048576);
  f.stored.set('credentials/fixturekid', raw);
  const result = await f.call(); assert.equal(result.status, 503); assert.equal(result.body.error.code, 'identity_admission_unavailable');
  assert.equal(f.trace.writes, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM proxy_credentials').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM policy_binding_meta').get().n, 0);
});

test('closed grammar follows original duplicate/unknown profile; nullish legacy only; repeated source counts are cumulative', async t => {
  const f = fixture(t);
  const raw = JSON.stringify(input()).replace('"fixturekid"', '"firstkid","credentialId":"fixturekid"');
  f.stored.set('keys/fixturekid', record());
  const result = await f.call(undefined, raw); assert.equal(result.body.outcome, 'matched');
  assert.equal(result.body.source.bytes > Buffer.byteLength(raw), true);
  const invalid = fixture(t); const heavy = JSON.stringify({ ...input(), extra: 'x'.repeat(1048000) });
  const rejected = await invalid.call(undefined, heavy); assert.equal(rejected.status, 503); assert.deepEqual(invalid.trace.kv, []); assert.deepEqual(invalid.trace.sql, []);
  const counters = identitySourceBudget(); counters.values = 131071;
  const capped = await invalid.call(input('fixturekid', counters)); assert.equal(capped.status, 503); assert.deepEqual(invalid.trace.sql, []);
  const owner = identitySourceBudget(), sent = identitySourceSnapshot(owner), producer = identitySourceSnapshot(owner), reply = identitySourceBudget();
  producer.bytes = 10; reply.bytes = 5; advanceIdentitySource(owner, sent, producer, reply); assert.equal(owner.bytes, 15);
  assert.throws(() => advanceIdentitySource(owner, sent, producer, reply), denied);
});

for (const reason of [undefined, new Error('shared synthetic reason')]) test('original read/FIRST cancel/unlock preserve each independent origin, including shared/undefined', async t => {
  const ticket = PreflightTicket.reserve(), read = deferred(), cancel = deferred(), entered = deferred(), cancelEntered = deferred();
  let locked = true, cancels = 0, unlocks = 0, done = false, operation;
  const body = { get locked() { return locked; }, getReader(options) {
    assert.equal(options.mode, 'byob');
    return { read() { entered.resolve(); return read.promise; }, cancel() { cancels++; cancelEntered.resolve(); return cancel.promise; }, releaseLock() { unlocks++; locked = false; throw reason; } };
  } };
  t.after(async () => {
    read.reject(reason); cancel.reject(reason);
    try { if (operation) { const result = await operation; assert.equal(result.failed, true); assert.ok(result.error instanceof AggregateError); assert.deepEqual(result.error.errors, [reason, reason, reason]); } }
    finally { ticket.release(); }
  });
  operation = tagged(consumePreflightCredential(ticket, async () => body, identitySourceBudget()));
  void operation.then(() => { done = true; });
  await entered.promise; read.reject(reason);
  await Promise.race([cancelEntered.promise, operation.then(() => { throw Error('premature cleanup settlement'); })]);
  assert.equal(done, false); assert.equal(ticket.bytes, preflightPayloadBytes); assert.equal(cancels, 1); assert.equal(unlocks, 0);
  cancel.reject(reason); const result = await operation; operation = undefined;
  assert.equal(result.failed, true); assert.ok(result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [reason, reason, reason]); assert.equal(cancels, 1); assert.equal(unlocks, 1);
  ticket.release(); assert.equal(ticket.bytes, 0);
});

test('late ORIGINAL transport and body cleanup keep ticket until actual settlement; no header retirement', async t => {
  const ticket = PreflightTicket.reserve(), arrival = deferred(), cancel = deferred(), cancelEntered = deferred(), controller = new AbortController();
  let operation, cancelled = 0, released = 0, locked = true;
  const response = new Response(null);
  Object.defineProperty(response, 'body', { value: { get locked() { return locked; }, getReader() { return {
    read() { throw Error('aborted late source must not read'); }, cancel() { cancelled++; cancelEntered.resolve(); return cancel.promise; }, releaseLock() { locked = false; released++; },
  }; } } });
  t.after(async () => {
    arrival.resolve(response); cancel.resolve();
    try { if (operation) { const result = await operation; assert.equal(result.failed, true); assert.ok(denied(result.error)); } }
    finally { ticket.release(); }
  });
  operation = tagged(consumePreflightReply(ticket, () => arrival.promise, identitySourceBudget(), controller.signal));
  controller.abort(); assert.equal(ticket.bytes, preflightPayloadBytes); arrival.resolve(response);
  await Promise.race([cancelEntered.promise, operation.then(() => { throw Error('premature late-body cleanup'); })]); assert.equal(ticket.bytes, preflightPayloadBytes); assert.equal(released, 0);
  cancel.resolve(); const result = await operation; operation = undefined; assert.equal(result.failed, true); assert.ok(denied(result.error));
  assert.equal(cancelled, 1); assert.equal(released, 1); ticket.release();
});

for (const extra of [0, 1]) test(`ORIGINAL read count includes EOF: 8192 ${extra ? 'plus one denies' : 'exact passes'}`, async t => {
  const ticket = PreflightTicket.reserve(); t.after(() => ticket.release());
  let reads = 0, cancels = 0, unlocked = false;
  const dataReads = 8191 + extra;
  const body = { get locked() { return !unlocked; }, getReader() { return {
    async read(backing) { const index = reads++; if (index === dataReads) return { done: true, value: backing.subarray(0, 0) };
      backing[0] = index === dataReads - 1 ? 48 : 32; return { done: false, value: backing.subarray(0, 1) }; },
    async cancel() { cancels++; }, releaseLock() { unlocked = true; },
  }; } };
  const outcome = await tagged(consumePreflightCredential(ticket, async () => body, identitySourceBudget()));
  assert.equal(outcome.failed, !!extra); if (extra) assert.ok(denied(outcome.error)); else assert.equal(outcome.value, 0);
  assert.equal(reads, 8192); assert.equal(cancels, extra); assert.equal(unlocked, true);
});

test('whole backing plus one denies before decode; original cancellation and unlock still join', async t => {
  const ticket = PreflightTicket.reserve(); t.after(() => ticket.release()); let cancels = 0, unlocked = false;
  const body = { get locked() { return !unlocked; }, getReader() { return {
    async read() { return { done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 1) }; },
    async cancel() { cancels++; }, releaseLock() { unlocked = true; },
  }; } };
  const outcome = await tagged(consumePreflightCredential(ticket, async () => body, identitySourceBudget()));
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error)); assert.equal(cancels, 1); assert.equal(unlocked, true);
});

test('actual Node whole Unicode mapping/property/context qualifier; no collected case vector or version assumption', t => {
  const encoder = new TextEncoder(); let points = 0, casedCount = 0, ignoredCount = 0, whitespaceCount = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const text = String.fromCodePoint(cp), bytes = encoder.encode(text).length;
    const cased = /\p{Cased}/u.test(text), ignored = /\p{Case_Ignorable}/u.test(text);
    assert.ok(text.toLowerCase().length <= bytes); assert.ok(text.trim().length <= text.length);
    assert.equal(('A' + text + 'Σ').toLowerCase().endsWith(cased || ignored ? 'ς' : 'σ'), true);
    assert.equal(('AΣ' + text).toLowerCase().charCodeAt(1), !cased || ignored ? 0x3c2 : 0x3c3);
    const escaped = JSON.stringify(text); assert.ok(JSON.parse(escaped).toLowerCase().length <= encoder.encode(escaped).length);
    points++; if (cased) casedCount++; if (ignored) ignoredCount++; if (/\p{White_Space}/u.test(text)) whitespaceCount++;
  }
  assert.equal(points, 0x110000);
  const dotted = String.fromCodePoint(0x69, 0x307); assert.equal(dotted.length, 2); assert.equal(dotted.charCodeAt(1), 0x307);
  assert.equal('İ'.toLowerCase(), dotted);
  const loneHigh = String.fromCharCode(0xd800), loneLow = String.fromCharCode(0xdfff), bom = String.fromCharCode(0xfeff);
  assert.equal(loneHigh.charCodeAt(0), 0xd800); assert.equal(loneLow.charCodeAt(0), 0xdfff);
  for (const text of [loneHigh, loneLow, '  İΣ' + String.fromCodePoint(0x307) + '  ', bom + 'A' + bom]) {
    const bytes = encoder.encode(text).length, lower = text.toLowerCase(), trimmed = text.trim();
    assert.ok(lower.length <= bytes); assert.ok(trimmed.length <= bytes);
    // Separate aggregate allowance for TWO live transforms, not either one.
    assert.ok(lower.length + trimmed.length <= 2 * bytes + 64);
  }
  const invalid = new Uint8Array([0xff]), replacement = new TextDecoder().decode(invalid);
  assert.equal(replacement, String.fromCodePoint(0xfffd)); assert.equal(replacement.charCodeAt(0), 0xfffd);
  assert.ok(replacement.toLowerCase().length <= invalid.byteLength);
  if (typeof t.log === 'function') t.log(JSON.stringify({ phase: 'unicode-qualifier', points, casedCount, ignoredCount, whitespaceCount, unicode: process.versions.unicode }));
});
