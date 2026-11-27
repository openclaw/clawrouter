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
test('missing draft can skip cheap repair without reallocating its call or losing feedback and costs', async () => {
  for (const fallbackMode of ['fresh', 'repair']) {
    for (const fallbackAttempts of [1, 2]) {
      const f = fixture({ 'strong-fallback': runtimeError, 'strong-fallback-repair': runtimeError });
      const invoke = f.invoke;
      f.invoke = async request => request.stage === 'draft'
        ? (f.requests.push(request), { artifact: null, feedback: 'invalid edit', costMicros: 5 }) : invoke(request);
      const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2,
        repairMissingDraft: false, fallbackAttempts, fallbackMode });
      assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'strong-fallback', 'strong-fallback-repair'].slice(0, fallbackAttempts + 1));
      assert.equal(f.requests[1].draft, null);
      assert.deepEqual(f.requests[1].feedback, fallbackMode === 'fresh' ? null
        : { runtimePassed: false, compilerPassed: false, feedback: 'invalid edit' });
      assert.equal(r.costMicros, 5 + fallbackAttempts * 7);
      assert.equal(r.passed, false);
    }
  }
});
test('missing-draft policy preserves default repairs and still repairs usable artifacts', async () => {
  for (const repairMissingDraft of [undefined, true, false]) {
    for (const artifact of [null, { failed: true }]) {
      const f = fixture({ draft: runtimeError });
      const invoke = f.invoke;
      f.invoke = async request => request.stage === 'draft'
        ? (f.requests.push(request), { artifact, costMicros: 5 }) : invoke(request);
      const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2, repairMissingDraft });
      assert.deepEqual(f.requests.map(x => x.stage), ['draft', repairMissingDraft === false && artifact === null
        ? 'strong-fallback' : 'draft-repair']);
      assert.equal(r.passed, true);
      assert.equal(r.costMicros, 12);
    }
  }
});
test('missing-draft policy rejects invalid options and never converts provider errors into fallback', async () => {
  for (const repairMissingDraft of [null, 0, 1, 'false']) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', repairMissingDraft }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
  for (const strategy of ['strong', 'fusion']) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy, repairMissingDraft: false }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
  let calls = 0;
  await assert.rejects(runVerifiedWorkflow({ models, strategy: 'cascade', draftAttempts: 2, repairMissingDraft: false,
    invoke: async () => { calls++; throw Error('provider failed'); }, verify: async () => assert.fail('unexpected verification') }), /provider failed/);
  assert.equal(calls, 1);
});
test('cascade accepts a verified draft with only two configured models', async () => {
  const f = fixture({});
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', models: { draft: models.draft, repair: models.repair } });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 7);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft']);
});
test('cascade starts a fresh verified fallback and accounts for both attempts', async () => {
  const f = fixture({ draft: runtimeError });
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade' });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'strong-fallback']);
  assert.equal(f.requests[1].model, models.repair);
  assert.equal(f.requests[1].draft, null); assert.equal(f.requests[1].feedback, null);
  assert.deepEqual(f.receipts.map(x => x.runtimePassed), [false, true]);
});
test('cascade stops after a failed fallback without calling specialist models', async () => {
  const f = fixture({ draft: typeError, 'strong-fallback': runtimeError });
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', models: {
    ...models, runtimeRepair: 'provider-d/runtime', admissionRepair: 'provider-e/admission',
  } });
  assert.equal(r.passed, false); assert.equal(r.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'strong-fallback']);
});
test('cascade treats a declared unusable draft as a failed attempt', async () => {
  const f = fixture({}), invoke = f.invoke;
  f.invoke = async request => request.stage === 'draft'
    ? (f.requests.push(request), { artifact: null, costMicros: 5 }) : invoke(request);
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade' });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 12); assert.equal(f.requests.length, 2);
});
test('optional fallback repair uses the failed strong candidate and retains every charge', async () => {
  for (const fallbackMode of ['fresh', 'repair']) {
    const failed = { ...runtimeError, detail: { cases: ['regression'] } };
    const f = fixture({ draft: typeError, 'strong-fallback': failed, 'strong-fallback-repair': good });
    const invoke = f.invoke;
    f.invoke = async request => {
      if (request.stage === 'strong-fallback-repair') {
        assert.deepEqual(request.draft, { name: 'strong-fallback' });
        assert.deepEqual(request.feedback, failed);
        request.feedback.detail.cases.push('changed');
      }
      return invoke(request);
    };
    const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackMode, fallbackAttempts: 2 });
    assert.equal(r.passed, true); assert.equal(r.costMicros, 21);
    assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'strong-fallback', 'strong-fallback-repair']);
    assert.deepEqual(f.requests.map(x => x.model), [models.draft, models.repair, models.repair]);
    assert.deepEqual(failed.detail.cases, ['regression']);
    assert.deepEqual(r.steps, f.receipts);
  }
});
test('optional fallback repair stops on acceptance or after its third failed call', async () => {
  for (const verdicts of [{}, { draft: runtimeError },
    { draft: runtimeError, 'strong-fallback': runtimeError, 'strong-fallback-repair': runtimeError }]) {
    const f = fixture(verdicts);
    const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackAttempts: 2 });
    const expected = Object.keys(verdicts).length === 3 ? 3 : Object.keys(verdicts).length + 1;
    assert.equal(f.requests.length, expected); assert.equal(r.costMicros, expected * 7);
    assert.equal(r.passed, expected !== 3);
  }
});
test('optional fallback repair retains missing-candidate diagnostics', async () => {
  const f = fixture({ draft: runtimeError }), invoke = f.invoke;
  f.invoke = async request => {
    if (request.stage === 'strong-fallback') {
      f.requests.push(request);
      return { artifact: null, feedback: 'invalid edit anchor', costMicros: 5 };
    }
    if (request.stage === 'strong-fallback-repair') {
      assert.equal(request.draft, null);
      assert.deepEqual(request.feedback, { runtimePassed: false, compilerPassed: false, feedback: 'invalid edit anchor' });
    }
    return invoke(request);
  };
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackAttempts: 2 });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 19);
});
test('optional fallback repair never retries callback errors or cancellation', async () => {
  for (const origin of ['invoke', 'verify', 'onStep']) {
    const f = fixture({ draft: runtimeError, 'strong-fallback': runtimeError });
    const operation = f[origin];
    f[origin] = async request => {
      if (request.stage === 'strong-fallback') throw Error('fallback_failed');
      return operation(request);
    };
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackAttempts: 2 }), /fallback_failed/);
    assert.ok(f.requests.length <= 2);
  }
  const f = fixture({ draft: runtimeError, 'strong-fallback': runtimeError }), controller = new AbortController();
  f.onStep = step => { if (step.stage === 'strong-fallback') controller.abort(Error('stop_after_fallback')); };
  await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackAttempts: 2,
    signal: controller.signal }), /stop_after_fallback/);
  assert.equal(f.requests.length, 2);
});
test('invalid fallback attempt limits fail before any provider call', async () => {
  for (const fallbackAttempts of [null, 0, 3, 1.5, '2', true]) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackAttempts }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
  for (const strategy of ['fusion', 'strong']) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy, fallbackAttempts: 2 }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
});
test('cascade repair passes cloned rejected artifacts and verifier feedback to one fallback', async () => {
  const feedback = { ...runtimeError, counterexample: { input: [1, 2, 1], expected: 0 } };
  const f = fixture({ draft: feedback, 'strong-fallback': runtimeError });
  const invoke = f.invoke;
  f.invoke = async request => {
    if (request.stage === 'strong-fallback') {
      assert.deepEqual(request.draft, { name: 'draft' });
      assert.deepEqual(request.feedback, feedback);
      request.draft.name = 'modified'; request.feedback.counterexample.input.push(4);
    }
    return invoke(request);
  };
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackMode: 'repair' });
  assert.equal(r.passed, false); assert.equal(r.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'strong-fallback']);
  assert.deepEqual(feedback.counterexample.input, [1, 2, 1]);
});
test('cascade repair handles missing drafts and stops on adapter errors', async () => {
  const f = fixture({});
  f.invoke = async request => {
    f.requests.push(request);
    if (request.stage === 'draft') return { artifact: null, feedback: 'output limit', costMicros: 3 };
    assert.equal(request.draft, null);
    assert.deepEqual(request.feedback, { runtimePassed: false, compilerPassed: false, feedback: 'output limit' });
    return { artifact: { name: request.stage }, costMicros: 7 };
  };
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackMode: 'repair' });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 10); assert.equal(f.requests.length, 2);
  const bad = fixture({});
  bad.verify = async () => { throw Error('verifier_unavailable'); };
  await assert.rejects(runVerifiedWorkflow({ ...bad, strategy: 'cascade', fallbackMode: 'repair' }), /verifier_unavailable/);
  assert.equal(bad.requests.length, 1);
});
test('fallback mode validation precedes calls and repair does not force a passing draft to escalate', async () => {
  for (const fallbackMode of [null, '', 'unknown', 1]) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackMode }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
  await assert.rejects(runVerifiedWorkflow({ ...fixture({}), strategy: 'fusion', fallbackMode: 'repair' }), /invalid_verified_workflow/);
  const f = fixture({});
  await runVerifiedWorkflow({ ...f, strategy: 'cascade', fallbackMode: 'repair' });
  assert.equal(f.requests.length, 1);
});
test('cascade never interprets adapter errors or cancellation as permission to spend again', async () => {
  for (const origin of ['invoke', 'verify']) {
    const f = fixture({}), calls = [];
    const invoke = f.invoke;
    f.invoke = async request => { calls.push(request.stage); if (origin === 'invoke') throw Error('adapter_failed'); return invoke(request); };
    if (origin === 'verify') f.verify = async () => { throw Error('adapter_failed'); };
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade' }), /adapter_failed/);
    assert.deepEqual(calls, ['draft']);
  }
  const controller = new AbortController(), f = fixture({ draft: runtimeError });
  f.onStep = () => { controller.abort(Error('stop_after_draft')); };
  await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', signal: controller.signal }), /stop_after_draft/);
  assert.equal(f.requests.length, 1);
});
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
test('optional runtime specialist accepts only a fully verified repair', async () => {
  const f = fixture({ draft: runtimeError });
  const r = await runVerifiedWorkflow({ ...f, models: { ...models, runtimeRepair: 'provider-d/runtime' } });
  assert.equal(r.passed, true); assert.equal(r.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-runtime']);
  assert.equal(f.requests[1].model, 'provider-d/runtime');
  assert.deepEqual(f.requests[1].draft, { name: 'draft' });
  assert.deepEqual(f.requests[1].feedback, runtimeError);
});
test('failed runtime specialist preserves original draft and the six-call ceiling', async () => {
  const f = fixture({ draft: runtimeError, 'draft-runtime': typeError, 'semantic-repair': typeError,
    'semantic-compiler': runtimeError, 'strong-restart': runtimeError, 'strong-repair': runtimeError });
  const invoke = f.invoke;
  f.invoke = async r => { if (r.stage === 'draft-runtime') { r.draft.name = 'corrupted'; r.feedback.feedback = 'changed'; } return invoke(r); };
  const r = await runVerifiedWorkflow({ ...f, models: { ...models, runtimeRepair: 'provider-d/runtime' } });
  assert.equal(r.passed, false); assert.equal(r.costMicros, 42);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-runtime', 'semantic-repair', 'semantic-compiler', 'strong-restart', 'strong-repair']);
  assert.deepEqual(f.requests[2].draft, { name: 'draft' }); assert.deepEqual(f.requests[2].feedback, runtimeError);
  assert.equal(f.requests[4].draft, null);
});
test('runtime specialist is skipped for other failure classes and strong controls', async () => {
  for (const [draft, strategy] of [[good, 'fusion'], [typeError, 'fusion'], [{ runtimePassed: false, compilerPassed: false }, 'fusion'], [runtimeError, 'strong']]) {
    const f = fixture({ draft });
    await runVerifiedWorkflow({ ...f, strategy, models: { ...models, runtimeRepair: 'provider-d/runtime' } });
    assert.ok(f.requests.every(x => x.stage !== 'draft-runtime'));
  }
});
test('runtime specialist errors stop the workflow and invalid model IDs fail before calls', async () => {
  const f = fixture({ draft: runtimeError }), invoke = f.invoke;
  f.invoke = async r => { if (r.stage === 'draft-runtime') throw Error('specialist_unavailable'); return invoke(r); };
  await assert.rejects(runVerifiedWorkflow({ ...f, models: { ...models, runtimeRepair: 'provider-d/runtime' } }), /specialist_unavailable/);
  assert.equal(f.requests.length, 1);
  for (const runtimeRepair of [null, '', ' ', 42, 'x'.repeat(257)]) {
    const invalid = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...invalid, models: { ...models, runtimeRepair } }), /invalid_verified_workflow/);
    assert.equal(invalid.requests.length, 0);
  }
});

test('optional admission repair receives a rejected draft and must pass both gates', async () => {
  const f = fixture({}), invoke = f.invoke;
  f.invoke = async request => request.stage === 'draft'
    ? (f.requests.push(request), { artifact: null, feedback: 'invalid syntax', costMicros: 7 }) : invoke(request);
  const result = await runVerifiedWorkflow({ ...f, models: { ...models, admissionRepair: 'provider-d/admission' } });
  assert.equal(result.passed, true); assert.equal(result.costMicros, 14);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-admission']);
  assert.equal(f.requests[1].draft, null);
  assert.deepEqual(f.requests[1].feedback, { runtimePassed: false, compilerPassed: false, feedback: 'invalid syntax' });
});

test('failed admission repair preserves rejected draft feedback and the six-call limit', async () => {
  const f = fixture({ 'draft-admission': runtimeError, 'semantic-repair': typeError,
    'semantic-compiler': runtimeError, 'strong-restart': runtimeError, 'strong-repair': runtimeError }), invoke = f.invoke;
  f.invoke = async request => {
    if (request.stage === 'draft') { f.requests.push(request); return { artifact: null, feedback: 'invalid syntax', costMicros: 7 }; }
    if (request.stage === 'draft-admission') request.feedback.feedback = 'corrupted';
    return invoke(request);
  };
  const result = await runVerifiedWorkflow({ ...f, models: { ...models, admissionRepair: 'provider-d/admission', runtimeRepair: 'provider-e/runtime' } });
  assert.equal(result.passed, false); assert.equal(result.costMicros, 42);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-admission', 'semantic-repair', 'semantic-compiler', 'strong-restart', 'strong-repair']);
  assert.equal(f.requests[2].draft, null); assert.equal(f.requests[2].feedback.feedback, 'invalid syntax');
});

test('admission repair stays opt-in and does not run on executable drafts or strong controls', async () => {
  for (const strategy of ['fusion', 'strong']) {
    const f = fixture({ draft: runtimeError });
    await runVerifiedWorkflow({ ...f, strategy, models: { ...models, admissionRepair: 'provider-d/admission' } });
    assert.ok(f.requests.every(x => x.stage !== 'draft-admission'));
  }
  const f = fixture({}), invoke = f.invoke;
  f.invoke = async request => request.stage === 'draft' ? (f.requests.push(request), { artifact: null, costMicros: 7 }) : invoke(request);
  await runVerifiedWorkflow(f);
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'semantic-repair']);
});

test('admission repair provider failure stops and invalid model ids are rejected', async () => {
  const f = fixture({}), invoke = f.invoke;
  f.invoke = async request => {
    if (request.stage === 'draft') { f.requests.push(request); return { artifact: null, costMicros: 7 }; }
    if (request.stage === 'draft-admission') throw Error('admission_unavailable');
    return invoke(request);
  };
  await assert.rejects(runVerifiedWorkflow({ ...f, models: { ...models, admissionRepair: 'provider-d/admission' } }), /admission_unavailable/);
  assert.equal(f.requests.length, 1);
  for (const admissionRepair of [null, '', ' ', 42, 'x'.repeat(257)]) {
    const invalid = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...invalid, models: { ...models, admissionRepair } }), /invalid_verified_workflow/);
    assert.equal(invalid.requests.length, 0);
  }
});


test('optional draft repair stays on the draft model and stops before fallback on success', async () => {
  const f = fixture({ draft: runtimeError });
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2 });
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-repair']);
  assert.deepEqual(f.requests.map(x => x.model), [models.draft, models.draft]);
  assert.deepEqual(f.requests[1].draft, { name: 'draft' });
  assert.deepEqual(f.requests[1].feedback, runtimeError);
  assert.equal(r.passed, true); assert.equal(r.costMicros, 14);
});
test('two rejected drafts keep fresh fallback isolated and repair fallback uses the latest draft', async () => {
  for (const fallbackMode of ['fresh', 'repair']) {
    const f = fixture({ draft: runtimeError, 'draft-repair': typeError });
    const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2, fallbackMode });
    assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-repair', 'strong-fallback']);
    assert.equal(f.requests[2].model, models.repair);
    assert.deepEqual(f.requests[2].draft, fallbackMode === 'fresh' ? null : { name: 'draft-repair' });
    assert.deepEqual(f.requests[2].feedback, fallbackMode === 'fresh' ? null : typeError);
    assert.equal(r.passed, true); assert.equal(r.costMicros, 21);
  }
});
test('draft and fallback repairs share the four-call bound and complete cost accounting', async () => {
  const f = fixture({ draft: runtimeError, 'draft-repair': runtimeError, 'strong-fallback': runtimeError,
    'strong-fallback-repair': runtimeError });
  const r = await runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2, fallbackAttempts: 2 });
  assert.deepEqual(f.requests.map(x => x.stage), ['draft', 'draft-repair', 'strong-fallback', 'strong-fallback-repair']);
  assert.deepEqual(f.requests[3].draft, { name: 'strong-fallback' });
  assert.equal(r.passed, false); assert.equal(r.costMicros, 28); assert.deepEqual(r.steps, f.receipts);
});
test('draft repair errors and cancellation stop without dispatching strong', async () => {
  for (const mode of ['invoke', 'verify', 'abort']) {
    const f = fixture({ draft: runtimeError }), invoke = f.invoke, verify = f.verify;
    const controller = new AbortController();
    f.invoke = async request => {
      if (request.stage === 'draft-repair' && mode === 'invoke') throw Error('repair failed');
      const result = await invoke(request);
      if (request.stage === 'draft-repair' && mode === 'abort') controller.abort(Error('repair aborted'));
      return result;
    };
    f.verify = async request => {
      if (request.stage === 'draft-repair' && mode === 'verify') throw Error('repair failed');
      return verify(request);
    };
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts: 2, signal: controller.signal }), /repair (failed|aborted)/);
    assert.ok(f.requests.every(x => x.model === models.draft));
  }
});
test('invalid draft attempt limits and other strategies reject before dispatch', async () => {
  for (const draftAttempts of [null, 0, 3, 1.5, '2', true]) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy: 'cascade', draftAttempts }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
  for (const strategy of ['fusion', 'strong']) {
    const f = fixture({});
    await assert.rejects(runVerifiedWorkflow({ ...f, strategy, draftAttempts: 2 }), /invalid_verified_workflow/);
    assert.equal(f.requests.length, 0);
  }
});
