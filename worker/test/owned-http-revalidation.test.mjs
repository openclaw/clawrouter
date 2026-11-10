import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admitIdentityBytes, identitySourceBudget, parseIdentity, isIdentityFailure } from '../identity-admission.ts';
import { ownedHttpAuthorizationSnapshot } from '../authority.ts';
import { inspectOwnedHttpGrantCredentials } from '../grant-credentials.ts';
import { prepareOwnedVeniceChatAuthority } from '../venice-chat-authority.ts';
import { prepareOwnedGmiOrganizationBinding } from '../gmi-organization-binding.ts';
import { beginOwnedHttpRequest, finishOwnedHttpRequest } from '../http-identity-owner.ts';
import { bodyBudgetCharged } from '../body-budget.ts';

const recordLimit = 1048576;
const record = bytes => '{"pad":"' + 'x'.repeat(bytes - '{"pad":""}'.length) + '"}';
const parse = wire => {
  const budget = identitySourceBudget();
  admitIdentityBytes(budget, new TextEncoder().encode(wire).byteLength, 2097152);
  return { value: parseIdentity(wire, budget, 'complete', 'authorization-snapshot'), budget };
};

for (const field of ['credential', 'policy']) test('snapshot ORIGINAL ' + field + ' record exact boundary and discarded oversized duplicate', t => {
  const wrap = value => field === 'credential'
    ? '{"credential":' + value + ',"policy":{"policy":{}}}'
    : '{"credential":{},"policy":{"policy":' + value + '}}';
  const exact = parse(wrap(record(recordLimit)));
  assert.equal((field === 'credential' ? exact.value.credential : exact.value.policy.policy).pad.length, recordLimit - 10);
  let parses = 0;
  const original = JSON.parse;
  t.mock.method(JSON, 'parse', function (text, reviver) { parses++; return Reflect.apply(original, this, [text, reviver]); });
  assert.throws(() => parse(wrap(record(recordLimit + 1))), isIdentityFailure);
  const duplicate = field === 'credential'
    ? '{"credential":' + record(recordLimit + 1) + ',"credential":{},"policy":{"policy":{}}}'
    : '{"credential":{},"policy":{"policy":' + record(recordLimit + 1) + ',"policy":{}}}';
  assert.throws(() => parse(duplicate), isIdentityFailure);
  assert.equal(parses, 0, 'lexical raw admission precedes native JSON.parse even for discarded duplicates');
});

test('snapshot unknown complete fields and duplicate occurrences retain the existing cumulative profile', () => {
  const wire = '{"credential":{},"policy":{"policy":{}},"unknown":{"value":1},"unknown":{"value":2}}';
  const { value, budget } = parse(wire);
  assert.deepEqual(value.unknown, { value: 2 });
  assert.equal(budget.members, 7);
  assert.equal(budget.containers, 6);
  assert.equal(budget.values, 8);
  const oversized = '{"credential":{},"policy":{"policy":{}},"unknown":[' + '"x",'.repeat(32768) + '"x"]}';
  assert.throws(() => parse(oversized), isIdentityFailure, 'unknown array entries consume the complete allowance');
});

test('private snapshot and inspect reject forged and request-only caps before original namespace acquisition', async () => {
  let acquisitions = 0;
  const namespace = { idFromName() { acquisitions++; throw undefined; }, get() { acquisitions++; throw undefined; } };
  const env = { ACCESS_CONTROL: namespace, GRANT_CREDENTIALS: namespace };
  const request = new Request('https://router.example/v1/chat/completions'), baseline = bodyBudgetCharged();
  const requestOnly = beginOwnedHttpRequest(request, env);
  let hasPrimary = false, primary;
  try {
    for (const cap of [Object.freeze({}), requestOnly]) {
      assert.throws(() => ownedHttpAuthorizationSnapshot(cap, env, request.signal), isIdentityFailure);
      assert.throws(() => inspectOwnedHttpGrantCredentials(cap, env, request.signal), isIdentityFailure);
    }
    assert.equal(acquisitions, 0);
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = [];
  try { await finishOwnedHttpRequest(requestOnly); } catch (error) { failures.push(error); }
  try { assert.equal(bodyBudgetCharged(), baseline); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures);
  if (hasPrimary) throw primary;
});

test('private provider guard rejects an unregistered cap before headers, verifier or borrowed graph observation', async () => {
  let reads = 0;
  const graph = new Proxy({}, { get() { reads++; throw undefined; } }), cap = Object.freeze({});
  const request = new Request('https://router.example/v1/chat/completions');
  await assert.rejects(prepareOwnedVeniceChatAuthority(cap, graph, graph, graph, graph, graph, graph), isIdentityFailure);
  await assert.rejects(prepareOwnedGmiOrganizationBinding(cap, request, graph, graph, graph, graph, graph, graph), isIdentityFailure);
  assert.equal(reads, 0);
});
