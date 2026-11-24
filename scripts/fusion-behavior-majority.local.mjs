// Development-only public-contract probes and fail-closed three-candidate vote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function probes(task) {
  let state = Number.parseInt(createHash('sha256').update('behavior-majority-v1:' + task.id).digest('hex').slice(0, 8), 16) || 1;
  const random = limit => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % limit; };
  const list = (count, low, size) => Array.from({ length: count }, () => low + random(size));
  return Array.from({ length: 24 }, () => {
    switch (task.contract.name) {
      case 'minMaxSubarraySum': {
        const n = 1 + random(8); return [list(n, -8, 17), 1 + random(n)];
      }
      case 'maxScore': return [list(2 + random(5), 1, 9), 1 + random(24)];
      case 'lenOfVDiagonal': {
        const n = 1 + random(5), m = 1 + random(5); return [Array.from({ length: n }, () => list(m, 0, 3))];
      }
      case 'maxSubarrays': {
        const n = 2 + random(8);
        const pairs = Array.from({ length: 1 + random(2 * n) }, () => {
          const a = 1 + random(n); let b = 1 + random(n - 1); if (b >= a) b++;
          return [a, b];
        });
        return [n, pairs];
      }
      case 'minOperations': {
        const n = 2 + random(9), x = 2 + random(n - 1);
        return [list(n, -8, 17), x, 1 + random(Math.floor(n / x))];
      }
      case 'longestSpecialPath': {
        const n = 2 + random(9);
        return [Array.from({ length: n - 1 }, (_, i) => [i + 1, random(i + 1), 1 + random(10)]), list(n, 0, 6)];
      }
      default: throw new Error('unsupported_public_contract');
    }
  });
}

export function choose(rows) {
  assert.equal(rows.length, 3);
  const clusters = new Map();
  for (const row of rows) {
    if (row.public?.valid !== true || row.public?.passed !== true || row.trace?.valid !== true || row.trace?.passed !== true
      || !Array.isArray(row.trace.fingerprints) || row.trace.fingerprints.length !== 24
      || !row.trace.fingerprints.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) continue;
    const key = JSON.stringify(row.trace.fingerprints);
    clusters.set(key, [...(clusters.get(key) ?? []), row.arm]);
  }
  return [...clusters.values()].find(group => group.length >= 2)?.[0] ?? 'medium';
}

export function outcome(rows) {
  const ids = [...new Set(rows.map(row => row.id))]; assert.equal(ids.length, 6); assert.equal(rows.length, 24);
  const names = ['first', 'second', 'third', 'medium'];
  const totals = Object.fromEntries([...names, 'majority', 'public-cascade'].map(name => [name, { passed: 0, costMicros: 0 }]));
  let accepted = 0;
  for (const id of ids) {
    const one = arm => {
      const found = rows.filter(row => row.id === id && row.arm === arm); assert.equal(found.length, 1);
      assert.equal(typeof found[0].passed, 'boolean');
      assert.ok(Number.isSafeInteger(found[0].costMicros) && found[0].costMicros >= 0);
      return found[0];
    };
    for (const arm of names) {
      const row = one(arm); totals[arm].passed += Number(row.passed); totals[arm].costMicros += row.costMicros;
    }
    const selected = choose(names.slice(0, 3).map(one));
    accepted += Number(selected !== 'medium');
    totals.majority.passed += Number(one(selected).passed);
    totals.majority.costMicros += names.slice(0, 3).reduce((sum, name) => sum + one(name).costMicros, 0)
      + (selected === 'medium' ? one('medium').costMicros : 0);
    const publicSelected = one('first').public.passed === true ? 'first' : 'medium';
    totals['public-cascade'].passed += Number(one(publicSelected).passed);
    totals['public-cascade'].costMicros += one('first').costMicros + (publicSelected === 'medium' ? one('medium').costMicros : 0);
  }
  return { arms: totals, accepted, qualifiedDevelopmentGain: totals.medium.passed === 6 && totals.majority.passed === 6
    && totals.majority.passed > Math.max(...['first', 'second', 'third', 'public-cascade'].map(arm => totals[arm].passed))
    && totals.majority.costMicros <= .8 * totals.medium.costMicros, qualifiedProductionGain: false };
}
