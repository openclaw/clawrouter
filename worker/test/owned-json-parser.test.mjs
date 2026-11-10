import '../../test/helpers/typescript-resolver.mjs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOwnedJsonObservation, observeOwnedJsonSource } from '../../test/helpers/owned-json-parser-observer.mjs';
import { ownedJsonCodecCases, ownedJsonCodecWire } from '../../test/helpers/owned-json-parser-cases.mjs';

const observation = globalThis.__ownedJsonObservation = createOwnedJsonObservation();
const hooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:') || !/(?:json-body\.ts|stream-json\/(?:src\/)?core\/parser\.js)$/.test(url)) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  return { ...result, source: observeOwnedJsonSource(fileURLToPath(url), source) };
} });
// Dynamic import is intentional: the actual source observers must precede load.
const { createPrivateJsonBodyParser, createJsonBodyParser, JsonBodyStructureLimit } = await import('../json-body.ts');
after(() => { hooks.deregister(); delete globalThis.__ownedJsonObservation; });

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
      assert.throws(() => { feed(parser, wire); parser.take(); }, JsonBodyStructureLimit);
      assert.throws(() => { feed(ordinary, wire); ordinary.take(); }, JsonBodyStructureLimit);
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

test('failed original attachment still discards private state and preserves rejected undefined', t => {
  const define = Object.defineProperty, parser = createPrivateJsonBodyParser(), row = observation.rows.at(-1);
  t.mock.method(Object, 'defineProperty', function (target, key, descriptor) {
    if (key === 'child') throw undefined;
    return Reflect.apply(define, this, [target, key, descriptor]);
  });
  let hasPrimary = false, primary;
  try { feed(parser, '{"child":{}}'); } catch (error) { hasPrimary = true; primary = error; }
  finally { parser.discard(); }
  assert.equal(hasPrimary, true); assert.equal(primary, undefined);
  assert.equal(row.attachments, 1, 'no false successful child-attachment report');
  assert.equal(row.cleared, true); assert.equal(row.parents, 0); assert.equal(row.pending, false); assert.equal(row.member, false);
});
