import assert from 'node:assert/strict';

const money = value => assert.ok(Number.isSafeInteger(value) && value >= 0, 'invalid_fusion_cost');
const add = (a, b) => { money(a); money(b); const total = a + b; money(total); return total; };

// Include every audited call, including rejected drafts and unsuccessful repairs.
// The caller supplies one complete arm's stages; this does not authenticate receipts.
export function auditedFusionCosts(stages) {
  assert.ok(Array.isArray(stages) && stages.length > 0, 'missing_fusion_stages');
  let costMicros = 0, normalizedMicros = 0;
  for (const stage of stages) {
    assert.equal(stage.status, 'audited', 'unaudited_fusion_stage');
    assert.ok(Array.isArray(stage.records) && stage.records.length > 0, 'missing_fusion_calls');
    let stageCost = 0;
    for (const record of stage.records) {
      stageCost = add(stageCost, record.costMicros);
      normalizedMicros = add(normalizedMicros, record.normalizedMicros);
    }
    money(stage.newCostMicros);
    assert.equal(stageCost, stage.newCostMicros, 'fusion_stage_cost_mismatch');
    costMicros = add(costMicros, stageCost);
  }
  return { costMicros, normalizedMicros };
}

// Cost eligibility only. Quality, latency and independent confirmation remain separate gates.
export function screenFusionCosts(records, taskCount) {
  assert.ok(Number.isSafeInteger(taskCount) && taskCount > 0, 'invalid_fusion_task_count');
  assert.ok(Array.isArray(records) && records.length === taskCount * 2, 'incomplete_fusion_pairs');
  const totals = { strong: { costMicros: 0, normalizedMicros: 0 }, cascade: { costMicros: 0, normalizedMicros: 0 } };
  const pairs = new Map();
  for (const row of records) {
    assert.ok(typeof row.id === 'string' && row.id.length > 0, 'invalid_fusion_task_id');
    assert.ok(row.strategy === 'strong' || row.strategy === 'cascade', 'invalid_fusion_strategy');
    const seen = pairs.get(row.id) ?? new Set();
    assert.ok(!seen.has(row.strategy), 'duplicate_fusion_arm');
    seen.add(row.strategy); pairs.set(row.id, seen);
    for (const key of ['costMicros', 'normalizedMicros']) totals[row.strategy][key] = add(totals[row.strategy][key], row[key]);
  }
  assert.equal(pairs.size, taskCount, 'incomplete_fusion_pairs');
  assert.ok([...pairs.values()].every(pair => pair.size === 2), 'incomplete_fusion_pairs');
  const ratio = key => totals.strong[key] > 0 ? totals.cascade[key] / totals.strong[key] : null;
  const costRatio = ratio('costMicros'), normalizedCostRatio = ratio('normalizedMicros');
  const invoiceCostScreen = costRatio !== null && costRatio <= 0.8;
  const normalizedCostScreen = normalizedCostRatio !== null && normalizedCostRatio <= 0.8;
  return { costBasis: 'invoice-and-cache-neutral-v1', ...totals, costRatio, normalizedCostRatio,
    invoiceCostScreen, normalizedCostScreen, costScreen: invoiceCostScreen && normalizedCostScreen };
}
