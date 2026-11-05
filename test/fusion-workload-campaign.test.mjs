import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkloadCampaign } from '../scripts/run-fusion-workload-campaign.mjs';
import { defaultExperiment } from '../scripts/fusion-agent-benchmark.mjs';

const config = { ...defaultExperiment, strategies: ['strong'], priorCostMicros: 100 };
const env = { GITHUB_SHA: 'a'.repeat(40) };

test('campaign carries settled and reserved costs into the next set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-campaign-'));
  const priors = [];
  try {
    const result = await runWorkloadCampaign({ repo: process.cwd(), qualificationDir: root, out: join(root, 'run'), config, env,
      execute: async options => {
        priors.push(options.config.priorCostMicros);
        await mkdir(options.out);
        await writeFile(join(options.out, 'provenance.json'), JSON.stringify({ complete: true,
          spentOrReservedMicros: options.config.priorCostMicros + 50 }));
      } });
    assert.deepEqual(priors, [100, 150]); assert.equal(result.spentOrReservedMicros, 200);
    assert.equal(result.complete, true); assert.equal(result.sets.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an interrupted first set retains uncertainty and cannot start another set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-campaign-')); let calls = 0;
  try {
    await assert.rejects(runWorkloadCampaign({ repo: process.cwd(), qualificationDir: root, out: join(root, 'run'), config, env,
      execute: async options => {
        calls++; await mkdir(options.out);
        await writeFile(join(options.out, 'provenance.json'), JSON.stringify({ complete: false, spentOrReservedMicros: 350 }));
        throw Error('private response must not be copied');
      } }), /workload_campaign_incomplete/);
    const state = JSON.parse(await readFile(join(root, 'run/campaign.json')));
    assert.equal(calls, 1); assert.equal(state.spentOrReservedMicros, 350); assert.equal(state.complete, false);
    assert.equal(JSON.stringify(state).includes('private response'), false);
    await assert.rejects(runWorkloadCampaign({ repo: process.cwd(), qualificationDir: root, out: join(root, 'overspend'), env,
      config: { ...config, campaignBudgetMicros: 1000000 } }), /campaign_budget_exceeded/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt accounting evidence reserves the set ceiling and stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-campaign-')); let calls = 0;
  try {
    await assert.rejects(runWorkloadCampaign({ repo: process.cwd(), qualificationDir: root, out: join(root, 'run'), config, env,
      execute: async options => { calls++; await mkdir(options.out); await writeFile(join(options.out, 'provenance.json'), '{broken'); } }), /incomplete/);
    const state = JSON.parse(await readFile(join(root, 'run/campaign.json')));
    assert.equal(calls, 1); assert.equal(state.accountingUnknown, true);
    assert.equal(state.spentOrReservedMicros, 800100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing accounting evidence cannot release the set allowance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-campaign-')); let calls = 0;
  try {
    await assert.rejects(runWorkloadCampaign({ repo: process.cwd(), qualificationDir: root, out: join(root, 'run'), config, env,
      execute: async () => { calls++; throw Error('interrupted'); } }), /incomplete/);
    const state = JSON.parse(await readFile(join(root, 'run/campaign.json')));
    assert.equal(calls, 1); assert.equal(state.accountingUnknown, true);
    assert.equal(state.spentOrReservedMicros, 800100);
  } finally { await rm(root, { recursive: true, force: true }); }
});
