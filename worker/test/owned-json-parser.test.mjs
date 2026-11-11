import '../../test/helpers/typescript-resolver.mjs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOwnedJsonObservation, observeOwnedJsonSource } from '../../test/helpers/owned-json-parser-observer.mjs';
import { ownedJsonCodecCases, ownedJsonCodecWire } from '../../test/helpers/owned-json-parser-cases.mjs';

let mutateLiteralToken, faultMediaInstall;
globalThis.__ownedMediaInstallFixture = index => faultMediaInstall?.(index);
globalThis.__ownedLiteralTokenFixture = token => mutateLiteralToken?.(token);
const observation = globalThis.__ownedJsonObservation = createOwnedJsonObservation();
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:') || !/(?:json-body\.ts|stream-json\/(?:src\/)?core\/parser\.js)$/.test(url)) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  let observed = observeOwnedJsonSource(fileURLToPath(url), source);
  if (url.endsWith('/json-body.ts')) {
    observed = observed.replace('function accept(token: Token) {',
      'function accept(token: Token) { if (privateParents) globalThis.__ownedLiteralTokenFixture(token);');
    observed = observed.replace('const slot = slots[index]; installed = index + 1;',
      'const slot = slots[index]; installed = index + 1; globalThis.__ownedMediaInstallFixture(index);');
  }
  return { ...result, source: observed };
} });
// Dynamic import is intentional: the actual source observers must precede load.
const { createPrivateJsonBodyParser, createJsonBodyParser, JsonBodyStructureLimit, measurePrivateJsonBody, copyPrivateQueueIntent, copyPrivateQueueCapsule, copyAccountingJson, privateAccountingArchive, privateCapsuleJson, privateMediaJsonBody, privateUploadJson, mediaJsonBody, privateMaterializationJson, privateAdmissionJson, privateGrantIdentityJson, privateMappedErrorJson } = await import('../json-body.ts');
after(() => { hooks.deregister(); delete globalThis.__ownedJsonObservation; delete globalThis.__ownedLiteralTokenFixture; delete globalThis.__ownedMediaInstallFixture; });

const feed = (parser, wire) => {
  for (let offset = 0; offset < wire.length;) {
    const width = wire.codePointAt(offset) > 65535 ? 2 : 1;
    parser.push(wire.slice(offset, offset + width)); offset += width;
  }
};

for (const [mode, valid] of ownedJsonCodecCases) test('private compact consumer ' + mode + ' preserves ordinary value/limit and observes actual original stacks', () => {
  const wire = ownedJsonCodecWire(mode, 'fixture-model'), parser = createPrivateJsonBodyParser();
  const row = observation.rows.at(-1), ordinary = createJsonBodyParser();
  assert.deepEqual(Object.keys(parser).sort(), ['discard', 'push', 'take']);
  try {
    if (valid) {
      feed(parser, wire); feed(ordinary, wire);
      const value = parser.take(), reference = JSON.parse(wire);
      assert.deepEqual(value, reference); assert.deepEqual(ordinary.take(), reference);
      if (mode === 'compact-mixed') {
        assert.equal(Object.hasOwn(value.extra, '__proto__'), true);
        assert.deepEqual(value.extra.__proto__, { last: 2 }); assert.equal(Object.getPrototypeOf(value.extra), Object.prototype);
        assert.equal(value.extra[''].sibling, 4); assert.equal(value.extra['\ud800']['\udfff'], 6);
      }
      assert.equal(row.parentPushes, row.parentPops, 'every actual consumer push has its original pop');
      assert.equal(row.tokenPushes, row.tokenPops, 'every actual pinned-tokenizer push has its original pop');
    } else {
      const expected = mode === 'compact-strict-space' || mode === 'compact-invalid-eof'
        ? error => error instanceof Error && !(error instanceof JsonBodyStructureLimit) : JsonBodyStructureLimit;
      assert.throws(() => { feed(parser, wire); parser.take(); }, expected);
      assert.throws(() => { feed(ordinary, wire); ordinary.take(); }, expected);
    }
  } finally { parser.discard(); ordinary.discard(); }
  assert.equal(row.cleared, true); assert.equal(row.parents, 0); assert.equal(row.tokens, 0); assert.equal(row.pending, false); assert.equal(row.member, false);
  if (mode === 'compact-object128') {
    assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 128); assert.equal(row.peakStored, 259);
    assert.equal(row.abandonedParents, 0); assert.equal(row.abandonedTokens, 0);
  } else if (mode === 'compact-object-string128') {
    assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 128); assert.equal(row.peakStored, 260, 'pending and attachment-member aliases coexist until defineProperty returns');
  } else if (mode === 'compact-object129' || mode === 'compact-open2048') {
    assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 129, 'tokenizer creates the rejection parent before consumer admission');
    assert.equal(row.peakStored, 260); assert.equal(row.abandonedParents, 128); assert.equal(row.abandonedTokens, 129);
  }
  assert.throws(() => parser.push('{}'), TypeError); assert.throws(() => parser.take(), TypeError);
});

test('private child attachment exists before pending and temporary member keys clear', () => {
  const parser = createPrivateJsonBodyParser(), row = observation.rows.at(-1);
  try {
    feed(parser, '{"child":{');
    assert.equal(row.attachments, 2); assert.equal(row.objectAttachments, 1, 'observer checked the actual own child property');
    assert.equal(row.parents, 2); assert.equal(row.pending, false); assert.equal(row.member, false);
    feed(parser, '},"after":1}');
    assert.deepEqual(parser.take(), { child: {}, after: 1 });
    assert.equal(row.objectAttachments, 2, 'parent sibling attaches with its new key');
  } finally { parser.discard(); }
  assert.equal(row.cleared, true);
});

// The private constructor contract intentionally bypasses mutable graph-building
// methods. Ordinary attachment still observes the old method and thrown reason.
test('private attachment excludes a replaced defineProperty while ordinary attachment preserves undefined failure', () => {
  const define = Object.defineProperty, parser = createPrivateJsonBodyParser(), ordinary = createJsonBodyParser();
  const row = observation.rows.at(-1); let calls = 0, value, hasPrimary = false, primary;
  Object.defineProperty = function (target, key, descriptor) {
    if (key === 'child') { calls++; throw undefined; }
    return Reflect.apply(define, this, [target, key, descriptor]);
  };
  try {
    feed(parser, '{"child":{}}'); value = parser.take();
    try { feed(ordinary, '{"child":{}}'); } catch (error) { hasPrimary = true; primary = error; }
  } finally { Object.defineProperty = define; parser.discard(); ordinary.discard(); }
  assert.deepEqual(value, { child: {} }); assert.equal(calls, 1);
  assert.equal(hasPrimary, true); assert.equal(primary, undefined);
  assert.equal(row.attachments, 2); assert.equal(row.cleared, true);
  assert.equal(row.parents, 0); assert.equal(row.pending, false); assert.equal(row.member, false);
});

// UNRUN_CODE_ONLY_HOSTED. Token names/text remain the trusted pinned grammar;
// these cases exercise only the adopted private graph-construction boundary.
test('private literal tokens cannot supply an injected graph value', () => {
  const parser = createPrivateJsonBodyParser(); let changes = 0, value;
  const foreign = { toJSON() { throw Error('foreign graph hook'); } };
  mutateLiteralToken = token => {
    if (token.name === 'nullValue' || token.name === 'trueValue' || token.name === 'falseValue') { token.value = foreign; changes++; }
  };
  try { feed(parser, '[null,true,false]'); value = parser.take(); }
  finally { mutateLiteralToken = undefined; parser.discard(); }
  assert.deepEqual(value, [null, true, false]); assert.equal(changes, 3);
});

test('private array attachment defines an own index instead of invoking an inherited setter', () => {
  const parser = createPrivateJsonBodyParser(), prior = Object.getOwnPropertyDescriptor(Array.prototype, '9999');
  let calls = 0, value;
  Object.defineProperty(Array.prototype, '9999', { configurable: true, set() { calls++; } });
  try { feed(parser, '[' + '0,'.repeat(9999) + '1]'); value = parser.take(); }
  finally { if (prior) Object.defineProperty(Array.prototype, '9999', prior); else delete Array.prototype[9999]; parser.discard(); }
  assert.equal(calls, 0); assert.equal(value.length, 10000); assert.equal(Object.hasOwn(value, '9999'), true); assert.equal(value[9999], 1);
});

test('private number conversion and parent operations do not dispatch mutable graph methods', () => {
  const parser = createPrivateJsonBodyParser(), nativeNumber = Number, array = Array.isArray, own = Object.hasOwn;
  const push = Array.prototype.push, pop = Array.prototype.pop, at = Array.prototype.at;
  let exposed = 0, conversions = 0, value;
  const privateOperand = target => target && typeof target === 'object'
    && (own(target, 'privateMarker') || array(target) && target.length && target[0] && own(target[0], 'privateMarker'));
  const check = target => { if (privateOperand(target)) { exposed++; throw Error('private graph operand escaped'); } };
  Array.isArray = target => { check(target); return array(target); };
  Array.prototype.push = function (...items) { check(this); return Reflect.apply(push, this, items); };
  Array.prototype.pop = function () { check(this); return Reflect.apply(pop, this, []); };
  Array.prototype.at = function (index) { check(this); return Reflect.apply(at, this, [index]); };
  globalThis.Number = function (item) { if (typeof item === 'string') { conversions++; return {}; } return nativeNumber(item); };
  try { feed(parser, '{"privateMarker":true,"nested":[-0,1e999,{"n":7}]}'); value = parser.take(); }
  finally { globalThis.Number = nativeNumber; Array.isArray = array; Array.prototype.push = push; Array.prototype.pop = pop; Array.prototype.at = at; parser.discard(); }
  assert.equal(exposed, 0); assert.equal(conversions, 0); assert.equal(Object.is(value.nested[0], -0), true);
  assert.equal(value.nested[1], Infinity); assert.equal(value.nested[2].n, 7);
});

// The explicitly hardened census is independent of the broader trusted-runtime
// boundary. Restoring the public method before native parsing cannot forge it.
test('private census ignores a replaced public character reader', () => {
  const character = String.prototype.charCodeAt; let calls = 0, result, deep;
  String.prototype.charCodeAt = function (index) { calls++; return index === 0 ? 91 : 32; };
  try { result = measurePrivateJsonBody('[[0]]'); deep = measurePrivateJsonBody('['.repeat(129) + '0' + ']'.repeat(129)); }
  finally { String.prototype.charCodeAt = character; }
  assert.deepEqual(result, { upper: 48, exact: 40, limited: false });
  assert.equal(deep.limited, true); assert.equal(calls, 0);
});


// UNRUN_CODE_ONLY_HOSTED. The lower fixed copy is exercised only with closed
// profile-sized fixture data; actual sender custody is covered by the HTTP test.
for (const copy of [copyPrivateQueueIntent, copyPrivateQueueCapsule])
test(copy.name + ' freezes completed descendants before the single destination handoff', async () => {
  const source = JSON.parse('{"id":"queue-fixture","unknown":{"toJSON":"inert","__proto__":{"ok":true}},"array":[null,{"value":7}],"last":false}');
  source.omitted = undefined; source.array.push(undefined);
  const expected = JSON.stringify(source); let handoffs = 0, copied;
  const destination = { set subject(value) {
    handoffs++; copied = value;
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      assert.equal(Object.getPrototypeOf(item), null); assert.equal(Object.isFrozen(item), true);
      for (const key of Object.keys(item)) if (item[key] !== null && typeof item[key] === 'object') pending.push(item[key]);
    }
  } };
  copy(source, destination);
  assert.equal(handoffs, 1); assert.notEqual(copied, source); assert.notEqual(copied.array, source.array);
  assert.equal(Array.isArray(copied.array), true); assert.equal(Object.hasOwn(copied, 'omitted'), false);
  assert.equal(copied.array.at, undefined); assert.equal(copied.array[2], null);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const returned = gate.then(() => {
    for (const item of [copied, copied.unknown, copied.unknown.__proto__, copied.array, copied.array[1]]) {
      assert.equal(Reflect.defineProperty(item, 'toJSON', { value() { throw Error('sender hook'); } }), false);
      assert.equal(Reflect.setPrototypeOf(item, { toJSON() { throw Error('sender prototype hook'); } }), false);
    }
    assert.equal(Reflect.set(copied.array, 'length', 0), false);
    assert.equal(Reflect.set(copied.array[1], 'value', 99), false);
    assert.throws(() => { copied.id = 'changed'; }, TypeError);
    return JSON.stringify(copied);
  });
  try { release(); assert.equal(await returned, expected); }
  finally { release(); await returned.catch(() => {}); copied = undefined; }
  assert.equal(JSON.stringify(source), expected); assert.equal(Object.isFrozen(source), false); assert.equal(Object.isFrozen(source.array), false);
});

test('queue sealing leaves ordinary copies, private archives and synchronous capsules unchanged', () => {
  const source = { id: 'ordinary-fixture', array: [null, { value: 'kept' }], toJSON: 'inert' };
  const expected = JSON.stringify(source), ordinary = copyAccountingJson(source, 'capsule');
  assert.equal(Object.isFrozen(ordinary), false); assert.equal(Object.isFrozen(ordinary.array), false);
  assert.equal(Object.getPrototypeOf(ordinary), Object.prototype);
  assert.equal(privateCapsuleJson(source), expected);
  const archive = privateAccountingArchive(source);
  try { assert.equal(archive.text(), expected); } finally { archive.discard(); }
  assert.equal(Object.isFrozen(source), false); assert.equal(Object.isFrozen(source.array[1]), false);
  assert.equal(JSON.stringify(source), expected);
});


// UNRUN_CODE_ONLY_HOSTED. Pure lower-algorithm fixtures; the genuine upload
// association and paid pricing component are exercised by the HTTP cases.
for (const units of [65535, 65536, 1048575, 1048576])
test('private marker media preserves ordinary threshold and exact bytes at ' + units + ' units', async () => {
  const source = { model: 'fixture', extra: ['x'.repeat(units)], trailing: { toJSON: 'inert', __proto__: null } };
  const expected = JSON.stringify(source), original = source.extra[0];
  // Concrete source-sized fixture allowance, not a production admission cap.
  const admission = { workspaceBytes: 512 + 2 * units, serializationBytes: 12 * expected.length + 524288, restorePending: false };
  const media = privateMediaJsonBody(source, admission);
  assert.equal(!!media, units >= 1048576); assert.equal(admission.restorePending, false);
  assert.equal(source.extra[0], original); assert.equal(JSON.stringify(source), expected);
  const ordinary = mediaJsonBody(source);
  assert.equal(!!ordinary, !!media);
  if (media) {
    const actual = new Response(media.stream()).text(), reference = new Response(ordinary.stream()).text();
    try { assert.equal(await actual, expected); assert.equal(await reference, expected); }
    finally { await Promise.allSettled([actual, reference]); }
    assert.equal(media.bytes, Buffer.byteLength(expected));
  } else assert.equal(privateUploadJson(source), expected);
});

test('private marker transaction restores every source property after native JSON construction throws', () => {
  const one = 'x'.repeat(524288), two = 'y'.repeat(524288), source = { one, nested: { two }, invalid: 1n };
  const admission = { workspaceBytes: 2100000, serializationBytes: 16000000, restorePending: false };
  assert.throws(() => privateMediaJsonBody(source, admission), TypeError);
  assert.equal(source.one, one); assert.equal(source.nested.two, two); assert.equal(source.invalid, 1n);
  assert.equal(admission.restorePending, false, 'native failure is not uncertain restoration');
  assert.deepEqual(Object.keys(source), ['one', 'nested', 'invalid']);
});

test('private media refuses the next variable workspace batch before allocating locators or mutating source', () => {
  const source = { value: 'x'.repeat(1048576) }, original = source.value;
  const admission = { workspaceBytes: 24, serializationBytes: 16000000, restorePending: false };
  assert.throws(() => privateMediaJsonBody(source, admission), /workspace changed/);
  assert.equal(source.value, original); assert.equal(admission.restorePending, false);
});

test('private media final prototype guard rejects a hook without invoking it or writing markers', () => {
  const source = { value: 'x'.repeat(1048576) }, original = source.value;
  const admission = { workspaceBytes: 2100000, serializationBytes: 16000000, restorePending: false };
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'); let hooks = 0, failed = false;
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { hooks++; throw Error('hook value borrowed'); } });
  try { try { privateMediaJsonBody(source, admission); } catch { failed = true; } }
  finally { if (prior) Object.defineProperty(Object.prototype, 'toJSON', prior); else delete Object.prototype.toJSON; }
  assert.equal(failed, true); assert.equal(hooks, 0); assert.equal(source.value, original); assert.equal(admission.restorePending, false);
});


test('private marker finally restores the first write after a later installation fault including undefined', () => {
  const source = { one: 'x'.repeat(524288), two: 'y'.repeat(524288) }, expected = JSON.stringify(source);
  const admission = { workspaceBytes: 2100000, serializationBytes: 16000000, restorePending: false };
  let failed = false, reason, installs = 0;
  faultMediaInstall = index => { installs++; if (index === 1) throw undefined; };
  try { try { privateMediaJsonBody(source, admission); } catch (error) { failed = true; reason = error; } }
  finally { faultMediaInstall = undefined; }
  assert.equal(installs, 2); assert.equal(failed, true); assert.equal(reason, undefined);
  assert.equal(JSON.stringify(source), expected); assert.equal(admission.restorePending, false);
});


test('private materialization copy keeps the complete identity profile and excludes inherited serialization hooks', async () => {
  const { identityJson, admitIdentity } = await import('../identity-admission.ts');
  let extra = { toJSON: 'inert', values: [null, -0, Infinity, undefined] };
  for (let depth = 0; depth < 12; depth++) extra = { child: extra };
  const grant = { provider: 'fixture', credential: 'fixture-only', unknown: extra };
  Object.defineProperty(grant, '__proto__', { value: { kept: true }, enumerable: true });
  const source = { key: 'oauth/fixture', grant, legacy: grant, providerId: 'fixture', refresh: null, force: false, expectedGeneration: null, operation: undefined };
  admitIdentity(grant, 'record'); const expected = identityJson(source);
  const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'), arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0, text;
  const hook = { configurable: true, get() { calls++; throw Error('inherited materialization hook'); } };
  Object.defineProperty(Object.prototype, 'toJSON', hook); Object.defineProperty(Array.prototype, 'toJSON', hook);
  try { text = privateMaterializationJson(source); }
  finally {
    if (objectHook) Object.defineProperty(Object.prototype, 'toJSON', objectHook); else delete Object.prototype.toJSON;
    if (arrayHook) Object.defineProperty(Array.prototype, 'toJSON', arrayHook); else delete Array.prototype.toJSON;
  }
  assert.equal(calls, 0); assert.equal(text, expected); assert.equal(source.grant, source.legacy);
  assert.equal(Object.isFrozen(grant), false); assert.equal(Object.getPrototypeOf(grant), Object.prototype);
});

test('private materialization preserves identity omission and array-null semantics without retaining executable leaves', async () => {
  const { identityJson } = await import('../identity-admission.ts');
  const value = { absent: undefined, omitted: function () {}, values: [undefined, function () {}, Symbol('fixture')], toJSON: 'inert' };
  assert.equal(privateMaterializationJson(value), identityJson(value));
});

// The protected continuation keeps the existing complete profile, including
// sparse-array nulls and unknown fields; no capsule profile is substituted.
test('private admission serialization preserves owner replacement order and nested complete-profile values', async () => {
  const { identityJson } = await import('../identity-admission.ts');
  const admission = Object.assign(Object.create(null), { unknown: { list: [1, , 3], toJSON: 'inert' }, credentialId: 'fixture-id', secretSha256: 'fixture-digest' });
  const value = { admission, source: { bytes: 1, text: 2, values: 3, containers: 4, members: 5, entries: 6, units: 7 } };
  const expected = identityJson(value), descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let calls = 0, actual;
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { calls++; throw Error('private admission hook'); } });
  try { actual = privateAdmissionJson(value); }
  finally { if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor); else delete Object.prototype.toJSON; }
  assert.equal(actual, expected); assert.equal(calls, 0);
  assert.deepEqual(Object.keys(admission), ['unknown', 'credentialId', 'secretSha256']);
  assert.equal(1 in admission.unknown.list, false);
});

test('private grant fingerprint keeps structured admitted leaves and ordinary JSON bytes', async () => {
  const { identityJson } = await import('../identity-admission.ts');
  const tuple = ['venice', 'api_key', 7, { generation: ['fixture', null] }, { unknown: { toJSON: 'inert', value: -0 } }];
  const expected = identityJson(tuple), descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0, actual;
  Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, get() { calls++; throw Error('fingerprint hook'); } });
  try { actual = privateGrantIdentityJson(tuple); }
  finally { if (descriptor) Object.defineProperty(Array.prototype, 'toJSON', descriptor); else delete Array.prototype.toJSON; }
  assert.equal(calls, 0); assert.equal(actual, expected); assert.equal(Object.isFrozen(tuple), false);
});

test('private mapped-error serialization keeps deep parsed params without a recursive protective copy', () => {
  const param = JSON.parse('['.repeat(200) + '{"__proto__":1,"toJSON":"inert","value":1e400}' + ']'.repeat(200));
  const envelope = { error: { message: 'fixture rejection', type: 'invalid_request_error', param, code: 400 } };
  assert.equal(privateMappedErrorJson(envelope), JSON.stringify(envelope));
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'); let calls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { calls++; throw Error('mapped-error hook'); } });
  try { assert.throws(() => privateMappedErrorJson(envelope)); }
  finally { if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor); else delete Object.prototype.toJSON; }
  assert.equal(calls, 0);
});
