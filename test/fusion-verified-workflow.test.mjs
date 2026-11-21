import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerifiedWorkflow } from '../scripts/fusion-verified-workflow.mjs';
const models = { draft: 'provider-a/draft', repair: 'provider-b/repair', compiler: 'provider-c/tiny' };
const good = { runtimePassed: true, compilerPassed: true };
const typeError = { runtimePassed: true, compilerPassed: false, feedback: 'type error' };
const runtimeError = { runtimePassed: false, compilerPassed: true, feedback: 'test failure' };
function fixture(verdicts) {
  const requests = [], receipts = [];
  return { models, requests, receipts,
    invoke: async request => { requests.push(request); return { artifact: { name: request.stage }, costMicros: 7 }; },
    verify: async ({ stage }) => verdicts[stage] ?? good,
    onStep: step => { receipts.push(step); } };
}
test('passing draft returns without calling another provider or exposing content in step receipts', async () => {
  const f = fixture({}); const r = await runVerifiedWorkflow(f);
  assert.equal(r.passed, true); assert.equal(r.costMicros, 7); assert.equal(f.requests.length, 1);
  assert.deepEqual(Object.keys(f.receipts[0]).sort(), ['stage', 'model', 'costMicros', 'runtimePassed', 'compilerPassed', 'elapsedMs'].sort());
});
test('compiler repair cannot corrupt the preserved draft used for semantic repair', async () => {
  const f = fixture({ draft: typeError, 'draft-compiler': runtimeError, 'semantic-repair': typeError });
  const invoke = f.invoke;
  f.invoke = async r => { if (r.stage === 'draft-compiler') r.draft.name = 'corrupted'; return invoke(r); };
  const result = await runVerifiedWorkflow(f);
  assert.equal(result.passed, true);
  assert.deepEqual(f.requests.map(x => x.model), [models.draft, models.compiler, models.repair, models.compiler]);
  assert.deepEqual(f.requests[2].draft, { name: 'draft' });
  assert.deepEqual(f.requests[3].draft, { name: 'semantic-repair' });
});
test('failed paths terminate after six calls with fresh strong restart and complete costs', async () => {
  const f = fixture({ draft: typeError, 'draft-compiler': runtimeError, 'semantic-repair': typeError,
    'semantic-compiler': runtimeError, 'strong-restart': runtimeError, 'strong-repair': runtimeError });
  const r = await runVerifiedWorkflow(f);
  assert.equal(r.passed, false); assert.equal(r.costMicros, 42); assert.equal(f.requests.length, 6);
  assert.equal(f.requests[4].draft, null); assert.deepEqual(f.requests[5].draft, { name: 'strong-restart' });
});
test('strong control gets at most one repair and skips all draft/compiler roles', async () => {
  const f = fixture({ 'strong-initial': runtimeError }); const r = await runVerifiedWorkflow({ ...f, strategy: 'strong' });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['strong-initial', 'strong-repair']);
  assert.ok(f.requests.every(x => x.model === models.repair));
});
test('provider failures and invalid verification stop without another model call', async () => {
  const f = fixture({ draft: { runtimePassed: 'yes', compilerPassed: true } });
  await assert.rejects(runVerifiedWorkflow(f), /invalid_verification_receipt/); assert.equal(f.requests.length, 1);
  let calls = 0;
  await assert.rejects(runVerifiedWorkflow({ ...fixture({}), invoke: async () => { calls++; throw Error('provider_stopped'); } }), /provider_stopped/);
  assert.equal(calls, 1);
});
test('caller abort stops a callback that ignores cancellation, without dispatching fallback', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = runVerifiedWorkflow({ ...fixture({}), signal: controller.signal, invoke: async () => { calls++; controller.abort(Error('stopped')); return new Promise(() => {}); } });
  await assert.rejects(pending, /stopped/); assert.equal(calls, 1);
});
test('already cancelled workflow never invokes its adapter', async () => {
  let calls = 0;
  await assert.rejects(runVerifiedWorkflow({ ...fixture({}), signal: AbortSignal.abort(Error('cancelled')),
    invoke: async () => { calls++; return { artifact: null, costMicros: 0 }; } }), /cancelled/);
  assert.equal(calls, 0);
});
test('invalid or overflowing costs cannot become successful accounting receipts', async () => {
  const f = fixture({ draft: runtimeError }); let calls = 0;
  await assert.rejects(runVerifiedWorkflow({ ...f, invoke: async () => {
    calls++; return { artifact: {}, costMicros: Number.MAX_SAFE_INTEGER };
  } }), /invalid_generation_receipt/);
  assert.equal(calls, 2);
  await assert.rejects(runVerifiedWorkflow({ ...fixture({}), invoke: async () => ({ artifact: undefined, costMicros: 0 }) }), /invalid_generation_receipt/);
});
