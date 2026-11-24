// Frozen confirmation policies; only public checks and behavior fingerprints select.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { choose } from './fusion-behavior-majority.local.mjs';

export const policies = ['pair12', 'pair13', 'pair23', 'majority', 'adaptive'];
const cheap = ['first', 'second', 'third'];

export function probes(task) {
  let state = Number.parseInt(createHash('sha256').update('confirmation-v1:' + task.id).digest('hex').slice(0, 8), 16) || 1;
  const random = limit => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % limit; };
  const list = (n, low, size) => Array.from({ length: n }, () => low + random(size));
  return Array.from({ length: 24 }, () => {
    switch (task.contract.name) {
      case 'countNonDecreasingSubarrays': return [list(1 + random(10), 1, 20), 1 + random(40)];
      case 'maxDistance': {
        const n = 1 + random(12); return [list(n, 0, 4).map(i => 'NSEW'[i]).join(''), random(n + 1)];
      }
      case 'assignElements': return [list(1 + random(12), 1, 60), list(1 + random(10), 1, 20)];
      case 'minOperations': {
        assert.equal(task.contract.arguments.length, 1);
        return [Array.from({ length: 1 + random(5) }, () => { const l = 1 + random(100); return [l, l + 1 + random(15)]; })];
      }
      case 'longestCommonPrefix': {
        const n = 1 + random(10);
        return [Array.from({ length: n }, () => list(1 + random(8), 0, 3).map(i => 'abc'[i]).join('')), 1 + random(n)];
      }
      case 'maxActiveSectionsAfterTrade': return [list(1 + random(20), 0, 2).join('')];
      default: throw new Error('unsupported_confirmation_contract');
    }
  });
}

function pair(rows, names) {
  return choose([...names.map(name => rows.find(row => row.arm === name)), { arm: 'unused' }]);
}

export function decision(rows, policy) {
  assert.equal(rows.length, 3);
  assert.deepEqual([...rows.map(row => row.arm)].sort(), [...cheap].sort());
  assert.ok(policies.includes(policy));
  if (policy.startsWith('pair')) {
    const names = [...policy.slice(4)].map(n => cheap[Number(n) - 1]);
    return { arm: pair(rows, names), paid: names };
  }
  if (policy === 'adaptive') {
    const arm = pair(rows, cheap.slice(0, 2));
    if (arm !== 'medium') return { arm, paid: cheap.slice(0, 2) };
  }
  return { arm: choose(rows), paid: [...cheap] };
}

export function selections(rows) {
  const ids = [...new Set(rows.map(row => row.id))];
  return Object.fromEntries(ids.map(id => [id, Object.fromEntries(policies.map(policy => [policy,
    decision(rows.filter(row => row.id === id && cheap.includes(row.arm)), policy)]))]));
}

export function outcome(rows, fixedSelections) {
  const ids = [...new Set(rows.map(row => row.id))];
  assert.equal(ids.length, 6); assert.equal(rows.length, 24);
  assert.deepEqual(fixedSelections, selections(rows));
  const names = [...cheap, 'medium', 'public-cascade', ...policies];
  const arms = Object.fromEntries(names.map(name => [name, { passed: 0, costMicros: 0 }]));
  const accepted = Object.fromEntries(policies.map(name => [name, 0]));
  for (const id of ids) {
    const one = arm => {
      const found = rows.filter(row => row.id === id && row.arm === arm); assert.equal(found.length, 1);
      const row = found[0]; assert.equal(typeof row.passed, 'boolean');
      assert.ok(Number.isSafeInteger(row.costMicros) && row.costMicros >= 0); return row;
    };
    for (const arm of [...cheap, 'medium']) {
      arms[arm].passed += Number(one(arm).passed); arms[arm].costMicros += one(arm).costMicros;
    }
    const publicArm = one('first').public?.valid === true && one('first').public?.passed === true ? 'first' : 'medium';
    arms['public-cascade'].passed += Number(one(publicArm).passed);
    arms['public-cascade'].costMicros += one('first').costMicros + (publicArm === 'medium' ? one('medium').costMicros : 0);
    for (const policy of policies) {
      const selected = fixedSelections[id][policy];
      arms[policy].passed += Number(one(selected.arm).passed);
      arms[policy].costMicros += selected.paid.reduce((sum, arm) => sum + one(arm).costMicros, 0)
        + (selected.arm === 'medium' ? one('medium').costMicros : 0);
      accepted[policy] += Number(selected.arm !== 'medium');
    }
  }
  const qualified = Object.fromEntries(policies.map(policy => [policy, arms.medium.passed === 6 && arms[policy].passed === 6
    && arms[policy].passed > Math.max(...[...cheap, 'public-cascade'].map(arm => arms[arm].passed))
    && arms[policy].costMicros <= .8 * arms.medium.costMicros]));
  return { arms, accepted, qualifiedConfirmationGain: qualified, qualifiedProductionGain: false };
}
