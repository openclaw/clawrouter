import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrajectory, runSingleTrajectory } from '../scripts/fusion-trajectory.mjs';

test('scheduled checks use real observations and tool counts without another model call', async () => {
  let edited = false, checked = false, calls = 0;
  const result = await runSingleTrajectory({ task: 'Edit then check.', maxModelCalls: 2, maxToolCalls: 3,
    finalCheckTool: 'check',
    tools: [
      { name: 'edit', effect: 'write', validate: args => Object.keys(args).length === 0,
        execute: async () => { edited = true; return { revision: 1 }; } },
      { name: 'check', effect: 'read', validate: args => Object.keys(args).length === 0,
        execute: async () => { assert.ok(edited); checked = true; return { passed: true }; } },
    ],
    nextAction: request => {
      assert.deepEqual(request.segment, []);
      if (edited && !checked) {
        assert.equal(request.history.at(-1).observation.revision, 1);
        request.history.length = 0;
        return { type: 'tool', name: 'check', arguments: {} };
      }
      return null;
    },
    draft: async ({ history }) => {
      calls++;
      if (calls === 1) return { type: 'tool', name: 'edit', arguments: {} };
      assert.equal(history.length, 2);
      assert.deepEqual(history.at(-1).observation, { passed: true });
      return { type: 'final', content: 'checked' };
    },
  });
  assert.equal(result.content, 'checked');
  assert.equal(result.stats.modelCalls, 2);
  assert.equal(result.stats.toolCalls, 3);
  assert.equal(result.history.length, 3);
});

test('scheduled actions cannot escape validation or the tool budget', async () => {
  let executed = 0, models = 0;
  const options = { task: 'Check.', maxToolCalls: 1,
    tools: [{ name: 'check', effect: 'read', validate: args => Object.keys(args).length === 0,
      execute: async () => { executed++; return { passed: true }; } }],
    draft: async () => { models++; return { type: 'final', content: 'done' }; },
  };
  await assert.rejects(runSingleTrajectory({ ...options,
    nextAction: () => ({ type: 'tool', name: 'check', arguments: { unexpected: true } }),
  }), /invalid_trajectory_action/);
  assert.equal(executed, 0);
  await assert.rejects(runSingleTrajectory({ ...options,
    nextAction: () => ({ type: 'tool', name: 'check', arguments: {} }),
  }), /trajectory_tool_limit/);
  assert.equal(executed, 1); assert.equal(models, 0);
});

test('caller scheduling cannot return final answers or bypass reviewed execution', async () => {
  const tool = { name: 'read', effect: 'read', validate: () => true, execute: async () => ({ value: 1 }) };
  let models = 0;
  const options = { task: 'Inspect.', tools: [tool], nextAction: () => ({ type: 'final', content: 'unchecked' }),
    draft: async () => { models++; return { type: 'final', content: 'done' }; } };
  await assert.rejects(runSingleTrajectory(options), /invalid_trajectory_scheduled_action/);
  await assert.rejects(runTrajectory({ ...options, verify: async () => ({}), repair: options.draft }), /invalid_trajectory_scheduler/);
  assert.equal(models, 0);
});

test('caller scheduling honors cancellation before invoking a tool', async () => {
  const controller = new AbortController(); controller.abort();
  let scheduled = 0, executed = 0;
  await assert.rejects(runSingleTrajectory({ task: 'Inspect.', signal: controller.signal,
    tools: [{ name: 'read', effect: 'read', validate: () => true, execute: async () => { executed++; return {}; } }],
    nextAction: () => { scheduled++; return { type: 'tool', name: 'read', arguments: {} }; },
    draft: async () => ({ type: 'final', content: 'done' }),
  }), { name: 'AbortError' });
  assert.equal(scheduled, 0); assert.equal(executed, 0);
});

const read = name => ({ type: 'tool', name: 'read', arguments: { name } });
const write = value => ({ type: 'tool', name: 'write', arguments: { value } });

test('automatic final checks consume the existing tool budget and reject malformed results', async () => {
  for (const malformed of [false, true]) {
    let checks = 0;
    await assert.rejects(runSingleTrajectory({ task: 'Finish only after checking.', maxToolCalls: 1,
      finalCheckTool: 'check', tools: [{ name: 'check', effect: 'read',
        validate: args => Object.keys(args).length === 0,
        execute: async () => { checks++; return malformed ? { status: 'ok' } : { passed: false }; } }],
      draft: async () => ({ type: 'final', content: 'done' }),
    }), malformed ? /invalid_trajectory_final_check_result/ : /trajectory_tool_limit/);
    assert.equal(checks, 1);
  }
});
const final = content => ({ type: 'final', content });
const accept = segment => ({ accepted: segment.length, reason: '', replacement: null });
function fixture(extra = {}) {
  const events = [];
  return { events, options: {
    task: 'Read the record and update its value.',
    tools: [
      { name: 'read', effect: 'read', validate: args => typeof args.name === 'string',
        execute: async args => { events.push(['read', args.name]); return `record:${args.name}`; } },
      { name: 'write', effect: 'write', validate: args => typeof args.value === 'number',
        execute: async args => { events.push(['write', args.value]); return 'updated'; } },
    ],
    draft: async () => final('done'), verify: async ({ segment }) => accept(segment),
    repair: async () => { throw new Error('unexpected_repair'); }, ...extra,
  } };
}

test('reads use real observations; writes and final answers wait for review', async () => {
  let drafts = 0;
  const { events, options } = fixture({
    draft: async ({ segment, history }) => {
      if (drafts++ === 0) return read('first');
      if (drafts === 2) { assert.equal(segment[0].observation, 'record:first'); return write(7); }
      assert.equal(history.at(-1).observation, 'updated');
      return final('done');
    },
    verify: async ({ segment }) => { events.push(['review', segment.at(-1).action.type]); return accept(segment); },
  });
  const result = await runTrajectory(options);
  assert.deepEqual(events, [['read', 'first'], ['review', 'tool'], ['write', 7], ['review', 'final']]);
  assert.equal(result.content, 'done');
  assert.equal(result.stats.modelCalls, 5);
});

test('rejected suffix and held write are absent from repair and future drafts', async () => {
  let drafts = 0, reviews = 0;
  const { events, options } = fixture({
    draft: async ({ history }) => {
      const next = [read('kept'), read('discarded'), write(9), final('done')][drafts++];
      if (drafts === 4) {
        assert.deepEqual(history.map(step => step.action), [read('kept'), write(2)]);
        assert.ok(!JSON.stringify(history).includes('discarded'));
      }
      return next;
    },
    verify: async ({ segment }) => reviews++ ? accept(segment)
      : { accepted: 1, reason: 'second lookup uses the wrong key', replacement: null },
    repair: async request => {
      assert.deepEqual(request.history.map(step => step.action), [read('kept')]);
      assert.equal(Object.hasOwn(request, 'segment'), false);
      return write(2);
    },
  });
  const result = await runTrajectory(options);
  assert.deepEqual(events, [['read', 'kept'], ['read', 'discarded'], ['write', 2]]);
  assert.equal(result.stats.rejectedSteps, 2);
  assert.equal(result.stats.repairs, 1);
});

test('verifier replacement avoids another model call', async () => {
  let drafts = 0;
  const { options } = fixture({ draft: async () => drafts++ ? final('done') : write(9),
    verify: async ({ segment }) => segment[0].action.type === 'final' ? accept(segment)
      : { accepted: 0, reason: 'wrong value', replacement: write(2) } });
  const result = await runTrajectory(options);
  assert.equal(result.stats.repairs, 0);
  assert.deepEqual(result.history[0].action, write(2));
});

test('unknown replacement falls back to strong repair; unknown draft never executes', async () => {
  const { events, options } = fixture({ draft: async () => write(9),
    verify: async () => ({ accepted: 0, reason: 'wrong tool', replacement: { type: 'tool', name: 'shell', arguments: {} } }),
    repair: async () => final('repaired') });
  assert.equal((await runTrajectory(options)).content, 'repaired');
  assert.deepEqual(events, []);
  await assert.rejects(runTrajectory({ ...options, draft: async () => ({ type: 'tool', name: 'shell', arguments: {} }) }), /invalid_trajectory_action/);
});

test('read chunk limit triggers a review and retains only accepted history', async () => {
  let drafts = 0;
  const { options } = fixture({ chunkSize: 2,
    draft: async ({ segment, history }) => {
      if (drafts++ < 2) return read(String(drafts));
      assert.equal(segment.length, 0); assert.equal(history.length, 2);
      return final('done');
    } });
  assert.equal((await runTrajectory(options)).stats.reviews, 2);
});

test('callback mutation cannot alter owned history, segment, action or tool registry', async () => {
  let drafts = 0;
  const { events, options } = fixture({
    draft: async request => { request.history.push({ poison: true }); return drafts++ ? final('done') : write(7); },
    verify: async request => {
      const verdict = accept(request.segment);
      request.segment[0].action.arguments = { value: 666 };
      options.tools[1].effect = 'read';
      return verdict;
    } });
  const result = await runTrajectory(options);
  assert.deepEqual(events, [['write', 7]]);
  assert.equal(result.history.length, 1);
});

test('malformed and ambiguous verdicts never release the held write', async () => {
  for (const verdict of [null, { accepted: 2, reason: '', replacement: null },
    { accepted: 0, reason: '', replacement: null }, { accepted: 1, reason: '' },
    { accepted: 1, reason: '', replacement: write(3) }]) {
    const { events, options } = fixture({ draft: async () => write(7), verify: async () => verdict });
    await assert.rejects(runTrajectory(options), /trajectory_verdict/);
    assert.deepEqual(events, []);
  }
});

test('cancellation during review prevents a write even if the callback ignores it', async () => {
  const controller = new AbortController();
  const { events, options } = fixture({ signal: controller.signal, draft: async () => write(7),
    verify: async ({ segment }) => { controller.abort(); return accept(segment); } });
  await assert.rejects(runTrajectory(options), { name: 'AbortError' });
  assert.deepEqual(events, []);
});

test('model and tool limits stop without retries or unreviewed writes', async () => {
  const first = fixture({ maxModelCalls: 1, draft: async () => write(7) });
  await assert.rejects(runTrajectory(first.options), /trajectory_model_limit/);
  assert.deepEqual(first.events, []);
  const second = fixture({ maxToolCalls: 1, draft: async () => read('loop') });
  await assert.rejects(runTrajectory(second.options), /trajectory_tool_limit/);
  assert.equal(second.events.length, 1);
});

test('provider and tool failures propagate once and preserve held writes', async () => {
  let calls = 0;
  const { events, options } = fixture({ draft: async () => write(7),
    verify: async () => { calls++; throw new Error('provider_failure'); } });
  await assert.rejects(runTrajectory(options), /provider_failure/);
  assert.equal(calls, 1); assert.deepEqual(events, []);
  options.draft = async () => read('failed');
  options.tools[0].execute = async () => { throw new Error('tool_failure'); };
  await assert.rejects(runTrajectory(options), /tool_failure/);
});

test('context overflow is explicit and cannot release a pending action', async () => {
  const { events, options } = fixture({ maxContextBytes: 256, draft: async () => write(7),
    verify: async () => ({ accepted: 1, reason: 'x'.repeat(256), replacement: null }) });
  await assert.rejects(runTrajectory(options), /trajectory_context_limit/);
  assert.deepEqual(events, []);
});

test('deadline bounds noncooperative model and tool callbacks without retrying', async () => {
  // AbortSignal.timeout alone does not keep Node alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let modelCalls = 0, toolCalls = 0;
    const model = fixture({ deadlineMs: 15, draft: () => { modelCalls++; return new Promise(() => {}); } });
    await assert.rejects(runTrajectory(model.options), { name: 'TimeoutError' });
    assert.equal(modelCalls, 1);
    const tool = fixture({ deadlineMs: 15, draft: async () => write(7) });
    tool.options.tools[1].execute = () => { toolCalls++; return new Promise(() => {}); };
    await assert.rejects(runTrajectory(tool.options), { name: 'TimeoutError' });
    assert.equal(toolCalls, 1);
  } finally { clearTimeout(keepAlive); }
});

test('single-model control uses the same tools and action guard without reviewer calls', async () => {
  let drafts = 0;
  const { events, options } = fixture({ draft: async ({ history }) => {
    assert.equal(history.length, drafts);
    return [read('initial'), write(7), final('done')][drafts++];
  }, verify: undefined, repair: undefined });
  const result = await runSingleTrajectory(options);
  assert.deepEqual(events, [['read', 'initial'], ['write', 7]]);
  assert.deepEqual(result.stats, { modelCalls: 3, toolCalls: 2, reviews: 0, repairs: 0, rejectedSteps: 0 });
  await assert.rejects(runSingleTrajectory({ ...options, draft: async () => write('bad') }), /invalid_trajectory_action/);
  assert.equal(events.length, 2);
});


test('checkpoints preserve committed work before a limit and isolate caller mutations', async () => {
  const saved = []; let calls = 0;
  await assert.rejects(runSingleTrajectory({ task: 'Edit and check.', maxModelCalls: 2,
    tools: [{ name: 'write', effect: 'write', validate: () => true, execute: async args => ({ applied: args.value }) }],
    draft: async ({ history }) => {
      assert.equal(history.length, calls);
      if (history.length) assert.equal(history[0].observation.applied, 1);
      return write(++calls);
    },
    onCheckpoint: async (snapshot, signal) => {
      assert.equal(signal.aborted, false);
      await Promise.resolve();
      saved.push(structuredClone(snapshot));
      snapshot.history.length = 0; snapshot.stats.modelCalls = 99;
    },
  }), /trajectory_model_limit/);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(s => s.history.length), [1, 2]);
  assert.deepEqual(saved.map(s => s.stats.modelCalls), [1, 2]);
  assert.equal(saved[0].history[0].observation.applied, 1);
});

test('checkpoints exclude rejected reads and held writes until review and execution', async () => {
  const saved = []; let drafted = 0, writes = 0;
  await assert.rejects(runTrajectory({ task: 'Review changes.', maxModelCalls: 3,
    tools: [
      { name: 'read', effect: 'read', validate: () => true, execute: async () => ({ secret: 'rejected observation' }) },
      { name: 'write', effect: 'write', validate: () => true, execute: async () => { writes++; return { applied: true }; } },
    ],
    draft: async () => drafted++ === 0 ? read('source') : write('unreviewed'),
    verify: async () => {
      assert.equal(saved.length, 0); assert.equal(writes, 0);
      return { accepted: 0, reason: 'Reject the proposed segment.', replacement: write('corrected') };
    }, repair: async () => { throw Error('unexpected repair'); },
    onCheckpoint: snapshot => saved.push(structuredClone(snapshot)),
  }), /trajectory_model_limit/);
  assert.equal(writes, 1); assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].history, [{ action: write('corrected'), observation: { applied: true } }]);
});

test('checkpoint persistence errors stop execution without replaying committed writes', async () => {
  const failed = Error('checkpoint storage unavailable'); let writes = 0, models = 0;
  await assert.rejects(runSingleTrajectory({ task: 'Write once.',
    tools: [{ name: 'write', effect: 'write', validate: () => true, execute: async () => { writes++; return {}; } }],
    draft: async () => { models++; return write('once'); },
    onCheckpoint: async () => { throw failed; },
  }), error => error === failed);
  assert.equal(writes, 1); assert.equal(models, 1);
});

test('cancellation while saving a checkpoint stops before another model or tool call', async () => {
  const controller = new AbortController(); let calls = 0, writes = 0;
  await assert.rejects(runSingleTrajectory({ task: 'Write once.', signal: controller.signal,
    tools: [{ name: 'write', effect: 'write', validate: () => true, execute: async () => { writes++; return {}; } }],
    draft: async () => { calls++; return write('once'); },
    onCheckpoint: (_snapshot, signal) => {
      assert.equal(signal.aborted, false); controller.abort(); return new Promise(() => {});
    },
  }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(writes, 1);
});

test('invalid checkpoint hooks are rejected before execution', async () => {
  let calls = 0;
  await assert.rejects(runSingleTrajectory({ task: 'Inspect.', onCheckpoint: true,
    tools: [{ name: 'read', effect: 'read', validate: () => true, execute: async () => ({}) }],
    draft: async () => { calls++; return read('source'); },
  }), /invalid_trajectory_checkpoint/);
  assert.equal(calls, 0);
});
