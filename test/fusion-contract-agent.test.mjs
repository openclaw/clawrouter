import assert from 'node:assert/strict';
import test from 'node:test';
import { contractRequest, runContractAgent, runSingleDraft, runRefinedDraft } from '../scripts/fusion-contract-agent.mjs';
import { models } from '../scripts/fusion-benchmark-accounting.mjs';

const task = { instruction: 'Repair both admission and settlement.', editPaths: ['worker/a.ts'], visibleTests: ['worker/test/a.test.mjs'] };
const config = { maxTurns: 8, outputTokens: 8192, deadlineMs: 10000 };
const actionBody = { messages: [], max_tokens: 256 };
const result = () => ({ files: [{ path: 'worker/a.ts', content: 'private source sentinel' }], publicPassed: true,
  actions: [{ action: 'finish', status: 'ok' }], toolMs: 2, turns: 1, outcome: 'submitted' });

function fixture(probes, responses = [{ probe: 'private probe sentinel' }]) {
  const seen = [], boxes = [], pending = [...probes], generated = [...responses];
  return { seen, boxes, dependencies: {
    makeSandbox: async () => { const box = { closed: false, async close() { this.closed = true; } }; boxes.push(box); return box; },
    read: async () => [{ path: 'worker/a.ts', content: 'original' }],
    write: async () => {},
    runProbe: async () => pending.shift(),
    agent: async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
      seen.push({ settings, options, instruction: _task.instruction });
      await invoke(id, models.strong, actionBody, options.signal);
      return result();
    },
  }, invoke: async (_id, role, body) => {
    seen.push({ role, body });
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(generated.shift() ?? {}) } }] };
  } };
}
const failed = { passed: false, assertionFailed: true, feedback: 'invariant failed' };
const passed = { passed: true, assertionFailed: false, feedback: '' };

test('a reproduced frozen check accepts the cheap candidate without strong repair', async () => {
  const f = fixture([failed, passed]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.cheap]);
  assert.equal(output.escalated, false); assert.equal(output.contractQualified, true); assert.equal(output.contractPassed, true);
  assert.equal(output.turns, 2); assert.equal(output.contractAttempts, 1);
  assert.deepEqual(output.actions.map(x => x.action), ['contract', 'finish', 'contract_check']);
  assert.ok(f.seen.find(x => x.instruction).instruction.includes('private probe sentinel'));
  const { files, ...trace } = output;
  assert.ok(!JSON.stringify(trace).includes('sentinel'));
  assert.ok(f.boxes.every(box => box.closed));
});

test('a passing partial candidate cannot skip fallback without a completed submission', async () => {
  for (const outcome of ['turn_limit', 'deadline', 'budget', 'draft_rejected', undefined]) {
    const f = fixture([failed, passed, passed]);
    const cheapAgent = async (...args) => ({ ...await f.dependencies.agent(...args), outcome });
    const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke,
      { ...f.dependencies, cheapAgent, providedProbe: 'public reproducer' });
    assert.equal(output.escalated, true);
    assert.equal(output.outcome, 'submitted');
    assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.cheap, models.strong]);
    assert.equal(output.turns, 2);
    assert.ok(output.actions.some(action => action.action === 'cheap_completion' && action.status === 'incomplete'));
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('a completed one-shot draft can still pass the cheap gate', async () => {
  const f = fixture([failed, passed]);
  const cheapAgent = async (...args) => ({ ...await f.dependencies.agent(...args), outcome: 'draft_submitted' });
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke,
    { ...f.dependencies, cheapAgent, providedProbe: 'public reproducer' });
  assert.equal(output.escalated, false);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.cheap]);
});

test('the test author receives the same declared original-source context as repair workers', async () => {
  const f = fixture([failed, passed]);
  f.dependencies.read = async (_box, paths) => paths.map(path => ({ path,
    content: path === 'scripts/registry.mjs' ? 'const declaredFormat = "example.native";' : 'original source' }));
  await runContractAgent({ ...task, hiddenTests: [], sourceContext: [{ path: 'scripts/registry.mjs', query: 'const declaredFormat' }] },
    'image', 'case:contract', config, f.invoke, f.dependencies);
  const author = f.seen.find(entry => entry.body?.messages?.[1]);
  const evidence = JSON.parse(author.body.messages[1].content).files;
  assert.match(evidence.find(file => file.path === 'scripts/registry.mjs').content, /example\.native/);
});

test('private checks are withheld from cheap repair and revealed only after escalation', async () => {
  for (const cheapCheck of [passed, failed]) {
    const f = fixture([failed, cheapCheck, passed]);
    const output = await runContractAgent(task, 'image', 'case:contract-private', config, f.invoke,
      { ...f.dependencies, exposeProbe: false });
    const workers = f.seen.filter(entry => entry.instruction);
    assert.equal(workers[0].instruction, task.instruction);
    assert.equal(output.contractExposed, false);
    assert.equal(output.escalated, !cheapCheck.passed);
    if (!cheapCheck.passed) {
      assert.equal(workers.length, 2);
      assert.match(workers[1].instruction, /private probe sentinel/);
      assert.match(workers[1].instruction, /invariant failed/);
    } else assert.equal(workers.length, 1);
    assert.ok(f.boxes.every(box => box.closed));
  }
  await assert.rejects(runContractAgent(task, 'image', 'case:contract-private', config, async () => {},
    { exposeProbe: 'false' }), /invalid_contract_exposure/);
});

test('a supplied reproducer skips generation but still gates cheap repair in isolation', async () => {
  const f = fixture([failed, passed]);
  const output = await runContractAgent(task, 'image', 'case:provided', config, f.invoke,
    { ...f.dependencies, providedProbe: 'provided probe sentinel' });
  assert.deepEqual(f.seen.filter(entry => entry.role).map(entry => entry.role), [models.cheap]);
  assert.match(f.seen.find(entry => entry.instruction).instruction, /provided probe sentinel/);
  assert.equal(output.contractAttempts, 0);
  assert.equal(output.contractSource, 'provided');
  assert.equal(output.escalated, false);
  assert.ok(f.boxes.every(box => box.closed));
  const invalid = fixture([passed]);
  await assert.rejects(runContractAgent(task, 'image', 'case:provided', config, invalid.invoke,
    { ...invalid.dependencies, providedProbe: 'does not reproduce' }), /unqualified_reproducer/);
  assert.equal(invalid.seen.length, 0);
  assert.ok(invalid.boxes.every(box => box.closed));
});

test('a failed cheap check escalates within the same shared allowance', async () => {
  const f = fixture([failed, failed, passed]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.cheap, models.strong]);
  assert.equal(output.escalated, true); assert.equal(output.contractPassed, true);
  const settings = f.seen.filter(x => x.settings).map(x => x.settings.maxTurns);
  assert.deepEqual(settings, [6, 6]);
  assert.ok(f.seen.filter(x => x.options).every(x => x.options.preloadSource));
  assert.equal(output.turns, 3);
  assert.deepEqual(output.actions.map(x => x.action), ['contract', 'finish', 'contract_check', 'finish', 'contract_check']);
  assert.ok(f.boxes.every(box => box.closed));
});

test('invalid or non-reproducing checks cannot certify a cheap repair', async () => {
  const f = fixture([passed], [{ probe: '' }, { probe: 'non-reproducing' }]);
  const output = await runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies);
  assert.equal(output.contractQualified, false); assert.equal(output.contractAttempts, 2);
  assert.equal(output.escalated, true); assert.equal(output.contractPassed, false);
  assert.deepEqual(f.seen.filter(x => x.role).map(x => x.role), [models.strong, models.strong, models.strong]);
  assert.ok(f.boxes.every(box => box.closed));
});

test('settled unusable test-author outputs consume attempts before strong fallback', async () => {
  for (const reason of ['provider_truncated', 'provider_empty']) {
    const f = fixture([]);
    let calls = 0;
    const output = await runContractAgent(task, 'image', 'case:contract', config, async (...args) => {
      if (++calls <= 2) throw new Error(reason);
      return f.invoke(...args);
    }, f.dependencies);
    assert.equal(output.contractQualified, false);
    assert.equal(output.contractAttempts, 2);
    assert.equal(output.escalated, true);
    assert.equal(output.turns, 3);
    assert.deepEqual(output.actions.slice(0, 2).map(action => action.status), [reason, reason]);
    assert.equal(f.seen.find(entry => entry.settings).settings.maxTurns, 6);
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('a complete second probe can recover from an incomplete first response', async () => {
  const f = fixture([failed, passed]);
  let calls = 0;
  const output = await runContractAgent(task, 'image', 'case:contract', config, async (...args) => {
    if (++calls === 1) throw new Error('provider_truncated');
    return f.invoke(...args);
  }, f.dependencies);
  assert.equal(output.contractAttempts, 2);
  assert.equal(output.contractQualified, true);
  assert.equal(output.escalated, false);
  assert.equal(output.turns, 3);
  assert.match(f.seen.find(entry => entry.body?.messages?.[1]).body.messages[1].content, /shorter probe/);
});

test('unknown costs and refusals stop before fallback, without leaking a sandbox', async () => {
  for (const code of ['unknown_cost', 'provider_refused']) {
    const f = fixture([]);
    await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, async () => { throw new Error(code); }, f.dependencies), new RegExp(code));
    assert.ok(f.boxes.every(box => box.closed)); assert.equal(f.seen.length, 0);
  }
});

test('all stages share the call ceiling even if an executor asks for more', async () => {
  const f = fixture([failed]);
  f.dependencies.agent = async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
    for (let i = 0; i <= config.maxTurns; i++) await invoke(id, models.strong, actionBody, options.signal);
    return result();
  };
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies), /trial_budget/);
  assert.equal(f.seen.filter(x => x.role).length, config.maxTurns);
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', { ...config, maxTurns: 3 }, f.invoke, f.dependencies), /four_calls/);
});

test('a larger cheap allowance reserves one fallback call within the shared ceiling', async () => {
  const f = fixture([failed, failed, passed]);
  const allowances = [];
  f.dependencies.agent = async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
    allowances.push(settings.maxTurns);
    for (let i = 0; i < settings.maxTurns; i++) await invoke(id, models.strong, actionBody, options.signal);
    return result();
  };
  const output = await runContractAgent(task, 'image', 'case:allowance', config, f.invoke,
    { ...f.dependencies, providedProbe: 'provided probe', cheapMaxCalls: 20 });
  assert.deepEqual(allowances, [7, 1]);
  assert.equal(output.turns, config.maxTurns);
  assert.equal(output.escalated, true);
  assert.equal(output.contractPassed, true);
  assert.ok(f.boxes.every(box => box.closed));
  for (const cheapMaxCalls of [0, 60, 1.5, '20', NaN]) {
    await assert.rejects(runContractAgent(task, 'image', 'case:allowance', config, f.invoke,
      { ...f.dependencies, cheapMaxCalls }), /invalid_cheap_call_allowance/);
  }
});

test('fresh verification rejects test edits and always retires its own sandbox', async () => {
  const f = fixture([failed]);
  f.dependencies.agent = async () => ({ ...result(), files: [{ path: task.visibleTests[0], content: 'weakened' }] });
  await assert.rejects(runContractAgent(task, 'image', 'case:contract', config, f.invoke, f.dependencies), /invalid_edit_path/);
  assert.ok(f.boxes.every(box => box.closed));
  const request = contractRequest(task, [], 8192);
  assert.equal(request.max_tokens, 4096); assert.equal(request.response_format.json_schema.name, 'repair_contract');
});


test('single drafts are bounded and reject out-of-scope or malformed edits before writes', async () => {
  for (const edits of [[{ path: 'worker/a.ts', search: 'original', replace: 'fixed' }],
    [{ path: 'worker/test/a.test.mjs', search: 'original', replace: 'fixed' }],
    [{ path: 'worker/a.ts', search: 'absent', replace: 'fixed' }], []]) {
    const f = fixture([]); let calls = 0, writes = 0;
    const output = await runSingleDraft(task, 'image', 'strong', 'draft', config,
      async () => { calls++; return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ edits }) } }] }; },
      undefined, { ...f.dependencies, write: async () => { writes++; }, test: async () => passed });
    assert.equal(calls, 1); assert.equal(writes, edits[0]?.replace === 'fixed' && edits[0]?.search === 'original' && edits[0]?.path === 'worker/a.ts' ? 1 : 0);
    assert.equal(output.publicPassed, writes === 1);
    assert.equal(output.files[0].content, writes ? 'fixed' : 'original');
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('single drafts propagate uncertain charges and refusals; settled truncation returns no patch', async () => {
  for (const reason of ['unknown_cost', 'provider_refused', 'provider_truncated', 'provider_empty']) {
    const f = fixture([]); let writes = 0;
    const run = runSingleDraft(task, 'image', 'strong', 'draft', config, async () => { throw Error(reason); },
      undefined, { ...f.dependencies, write: async () => { writes++; }, test: async () => passed });
    if (['unknown_cost', 'provider_refused'].includes(reason)) await assert.rejects(run, new RegExp(reason));
    else assert.equal((await run).publicPassed, false);
    assert.equal(writes, 0); assert.ok(f.boxes.every(box => box.closed));
  }
});

test('single-draft injection leaves the strong fallback on its original execution route', async () => {
  const f = fixture([failed, failed, passed]); let draftCalls = 0;
  const output = await runContractAgent(task, 'image', 'draft', config, f.invoke, {
    ...f.dependencies, providedProbe: 'provided', cheapAgent: async (_task, _image, _strategy, id, settings, invoke, _engine, options) => {
      draftCalls++; await invoke(id, models.cheap, actionBody, options.signal); return { ...result(), publicPassed: false };
    },
  });
  assert.equal(draftCalls, 1); assert.equal(output.escalated, true);
  assert.equal(f.seen.filter(row => row.settings).length, 1);
  assert.deepEqual(f.seen.filter(row => row.role).map(row => row.role), [models.cheap, models.strong]);
  assert.equal(output.turns, 2); assert.equal(output.contractPassed, true);
});


test('bounded draft refinement carries current source and failed checks into one correction', async () => {
  const seen = [], boxes = [], checks = [false, true];
  const refinedTask = { ...task, reproducer: 'supplied probe' };
  const output = await runRefinedDraft(refinedTask, 'image', 'strong', 'refine', config, async () => {}, undefined, {
    draft: async (_task, _image, _strategy, _id, settings, _invoke, _engine, options) => {
      seen.push({ settings, options });
      return { ...result(), files: [{ path: 'worker/a.ts', content: seen.length === 1 ? 'incomplete' : 'fixed' }], publicPassed: false };
    },
    makeSandbox: async () => { const box = { closed: false, async close() { this.closed = true; } }; boxes.push(box); return box; },
    write: async () => {}, test: async () => passed,
    runProbe: async () => ({ ...passed, passed: checks.shift(), feedback: 'private failed-check sentinel' }),
  });
  assert.equal(seen.length, 2); assert.equal(output.turns, 2); assert.equal(output.publicPassed, true);
  assert.equal(seen[1].options.initialFiles[0].content, 'incomplete');
  assert.match(seen[1].options.feedback, /private failed-check sentinel/);
  assert.ok(seen.every(row => row.settings.maxTurns === 1));
  assert.deepEqual(output.actions.filter(row => row.action === 'draft_check').map(row => row.status), ['failed', 'passed']);
  const { files, ...trace } = output; assert.ok(!JSON.stringify(trace).includes('sentinel'));
  assert.ok(boxes.every(box => box.closed));
});

test('draft refinement stops at the available allowance or three drafts', async () => {
  for (const allowance of [1, 2, 20]) {
    let calls = 0;
    const f = fixture([]);
    const output = await runRefinedDraft({ ...task, reproducer: 'supplied' }, 'image', 'strong', 'refine',
      { ...config, maxTurns: allowance }, async () => {}, undefined, {
        ...f.dependencies, draft: async () => { calls++; return result(); }, test: async () => passed, runProbe: async () => failed,
      });
    assert.equal(calls, Math.min(allowance, 3)); assert.equal(output.turns, calls);
    assert.ok(f.boxes.every(box => box.closed));
  }
});

test('draft refinement stops on uncertain charges and rejects an escaped candidate before verification', async () => {
  for (const reason of ['unknown_cost', 'provider_refused']) {
    let calls = 0;
    await assert.rejects(runRefinedDraft({ ...task, reproducer: 'supplied' }, 'image', 'strong', 'refine', config,
      async () => {}, undefined, { draft: async () => { calls++; throw Error(reason); } }), new RegExp(reason));
    assert.equal(calls, 1);
  }
  await assert.rejects(runRefinedDraft({ ...task, reproducer: 'supplied' }, 'image', 'strong', 'refine', config,
    async () => {}, undefined, { draft: async () => ({ ...result(), files: [{ path: 'worker/test/a.test.mjs', content: 'escape' }] }),
      makeSandbox: async () => { throw Error('must_not_allocate'); } }), /invalid_edit_path/);
});
