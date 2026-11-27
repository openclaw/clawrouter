import assert from 'node:assert/strict';
import test from 'node:test';
import { experimentModels, executorModel } from '../scripts/fusion-agent-benchmark.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';
import { nativePins } from '../scripts/fusion-native-provider.mjs';

const expected = {
  cheap: [models.cheap], strong: [models.strong], claude: [models.critic],
  panel: [models.cheap, models.strong, models.critic], cascade: [models.cheap, models.strong],
  planned: [models.cheap, models.critic], critique: [models.strong, models.critic],
  handoff: [models.strong, models.critic], 'candidate-ensemble': [models.strong, models.critic],
};
test('selected strategy admission includes all executors, advisers and fallbacks', () => {
  for (const [strategy, ids] of Object.entries(expected)) {
    assert.deepEqual(experimentModels([strategy]), ids);
    if (strategy !== 'candidate-ensemble') {
      for (const turn of [0, 1, 2, 10]) for (const forced of [false, true]) {
        assert.ok(ids.includes(executorModel(strategy, turn, forced)));
      }
    }
  }
  assert.deepEqual(experimentModels(['cheap', 'cascade', 'panel']), [models.cheap, models.strong, models.critic]);
  for (const value of [undefined, [], ['unknown'], ['toString'], [null]]) assert.throws(() => experimentModels(value), /invalid_strategies/);
});

test('cheap-only and cascade runs do not require unrelated provider credentials', async () => {
  for (const strategy of ['cheap', 'cascade']) {
    const ids = experimentModels([strategy]), calls = [];
    const pins = await nativePins({ OPENAI_API_KEY: 'synthetic-openai' }, async url => {
      calls.push(url); return Response.json({ id: url.split('/').at(-1) });
    }, ids);
    assert.deepEqual(Object.keys(pins), ids);
    assert.equal(calls.length, ids.length);
    assert.ok(calls.every(url => url.startsWith('https://api.openai.com/v1/models/')));
  }
});

test('every selected fallback still needs credentials and an exact upstream identity', async () => {
  await assert.rejects(nativePins({ OPENAI_API_KEY: 'synthetic-openai' }, async () => assert.fail('must reject before requests'),
    experimentModels(['handoff'])), /native_credentials_missing/);
  await assert.rejects(nativePins({ OPENAI_API_KEY: 'synthetic-openai' }, async url =>
    Response.json({ id: url.endsWith('gpt-6-luna') ? 'gpt-6-luna' : 'wrong-model' }), experimentModels(['cascade'])), /native_model_preflight_identity/);
});
