import assert from 'node:assert/strict';
import test from 'node:test';
import { GATEWAY_VERIFICATION_REVISION, gatewayVerificationCases } from '../benchmarks/fusion/gateway-verification.mjs';

function stopMatch({ chunks, stops }) {
  const text = chunks.join('');
  const matches = stops.map((stop, index) => ({ index, offset: stop ? text.indexOf(stop) : -1 }))
    .filter(match => match.offset !== -1).sort((a, b) => a.offset - b.offset || a.index - b.index);
  return matches.length ? { text: text.slice(0, matches[0].offset), stopIndex: matches[0].index } : { text, stopIndex: null };
}

function pointerRead({ document, pointer }) {
  if (pointer === '') return { found: true, value: document };
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return { found: false };
  let value = document;
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)
      || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) return { found: false };
    value = value[key];
  }
  return { found: true, value };
}

test('gateway checks preserve original stop indices across ignored empties and split surrogate pairs', () => {
  const cases = gatewayVerificationCases('stream-stop-match');
  assert.equal(cases.length, 27);
  let caughtFilteredIndices = 0;
  for (const { args, expected } of cases) {
    const before = structuredClone(args);
    assert.deepEqual(stopMatch(...args), expected);
    assert.deepEqual(args, before);
    const filtered = stopMatch({ ...args[0], stops: args[0].stops.filter(Boolean) });
    if (filtered.stopIndex !== expected.stopIndex) caughtFilteredIndices++;
  }
  assert.equal(caughtFilteredIndices, 12);
  assert.ok(cases.some(({ args: [{ chunks }] }) => chunks[0].endsWith('\ud83e') && chunks[1].startsWith('\udd8a')));
});

test('pointer checks reject missing slash, malformed escapes and noncanonical array indices', () => {
  const cases = gatewayVerificationCases('json-pointer-read');
  assert.equal(cases.length, 64);
  let caughtRootFallbacks = 0;
  for (const { args, expected } of cases) {
    const before = structuredClone(args);
    assert.deepEqual(pointerRead(...args), expected);
    assert.deepEqual(args, before);
    const { pointer, document } = args[0];
    const broken = pointer && !pointer.startsWith('/') ? { found: true, value: document } : pointerRead(...args);
    if (broken.found !== expected.found) caughtRootFallbacks++;
  }
  assert.equal(caughtRootFallbacks, 28);
  assert.ok(cases.some(({ expected }) => expected.found && expected.value === false));
  assert.ok(cases.some(({ expected }) => expected.found && expected.value === 0));
});

test('verification profiles are explicit and return independent case data', () => {
  assert.equal(GATEWAY_VERIFICATION_REVISION, 'gateway-boundaries-v1');
  assert.throws(() => gatewayVerificationCases('unknown'), /unsupported_gateway_verification_contract/);
  const first = gatewayVerificationCases('json-pointer-read');
  const original = structuredClone(first);
  first[0].expected.found = false;
  assert.deepEqual(gatewayVerificationCases('json-pointer-read'), original);
});
