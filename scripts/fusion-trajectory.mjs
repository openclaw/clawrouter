// Caller-side bounded tool trajectories. The caller owns model billing,
// tool isolation and the accuracy of each tool's read/write declaration.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function copy(value, limit) {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
      || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new Error('invalid_trajectory_json');
    }
    return item;
  });
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > limit) throw new Error('trajectory_context_limit');
  return JSON.parse(encoded);
}

export const runTrajectory = options => runController(options, true);
// Matched fixed-model baseline: identical tools and limits, no model reviewer.
export const runSingleTrajectory = options => runController(options, false);

async function runController({ task, tools, draft, verify, repair,
  chunkSize = 4, maxModelCalls = 32, maxToolCalls = 32, maxContextBytes = 131072,
  deadlineMs = 120000, signal, finalCheckTool } = {}, reviewDrafts) {
  for (const [value, max] of [[chunkSize, 16], [maxModelCalls, 128], [maxToolCalls, 128],
    [maxContextBytes, 1048576], [deadlineMs, 600000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('invalid_trajectory_limit');
  }
  if (typeof task !== 'string' || !task.trim() || !Array.isArray(tools)
    || !(reviewDrafts ? [draft, verify, repair] : [draft]).every(fn => typeof fn === 'function')) throw new Error('invalid_trajectory_config');
  const registry = new Map();
  for (const tool of tools) {
    if (!plain(tool) || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)
      || registry.has(tool.name) || !['read', 'write'].includes(tool.effect)
      || typeof tool.validate !== 'function' || typeof tool.execute !== 'function') throw new Error('invalid_trajectory_tool');
    registry.set(tool.name, { ...tool });
  }
  if (finalCheckTool !== undefined && (!registry.has(finalCheckTool)
    || registry.get(finalCheckTool).validate({}) !== true)) throw new Error('invalid_trajectory_final_check');
  const active = AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])]);
  const history = [], stats = { modelCalls: 0, toolCalls: 0, reviews: 0, repairs: 0, rejectedSteps: 0 };
  const owned = value => copy(value, maxContextBytes);
  owned({ task, history });
  const checkedAction = raw => {
    const action = owned(raw);
    if (!plain(action)) throw new Error('invalid_trajectory_action');
    if (action.type === 'final' && Object.keys(action).length === 2 && typeof action.content === 'string'
      && action.content.trim()) return action;
    const tool = registry.get(action.name);
    if (action.type !== 'tool' || Object.keys(action).length !== 3 || !plain(action.arguments)
      || !tool || tool.validate(owned(action.arguments)) !== true) throw new Error('invalid_trajectory_action');
    return action;
  };
  const context = extra => owned({ task, history, ...extra });
  const bounded = fn => new Promise((resolve, reject) => {
    const aborted = () => { active.removeEventListener('abort', aborted); reject(active.reason); };
    active.addEventListener('abort', aborted, { once: true });
    // Callbacks must still honor cancellation themselves. A timed-out write
    // can have an unknown outcome; this controller never retries it.
    Promise.resolve().then(() => { active.throwIfAborted(); return fn(); }).then(value => {
      active.removeEventListener('abort', aborted); resolve(value);
    }, error => {
      active.removeEventListener('abort', aborted); reject(error);
    });
    if (active.aborted) aborted();
  });
  const call = async (fn, request) => {
    active.throwIfAborted();
    if (stats.modelCalls >= maxModelCalls) throw new Error('trajectory_model_limit');
    stats.modelCalls++;
    const result = await bounded(() => fn(request, active));
    active.throwIfAborted();
    return owned(result);
  };
  const execute = async action => {
    active.throwIfAborted();
    if (stats.toolCalls >= maxToolCalls) throw new Error('trajectory_tool_limit');
    stats.toolCalls++;
    const observation = await bounded(() => registry.get(action.name).execute(owned(action.arguments), active));
    active.throwIfAborted();
    return { action, observation: owned(observation) };
  };
  const commit = steps => {
    owned({ task, history: [...history, ...steps] });
    history.push(...steps);
  };
  const finish = action => ({ content: action.content, history: owned(history), stats: { ...stats } });
  const checkedFinish = async action => {
    if (finalCheckTool !== undefined) {
      const step = await execute(checkedAction({ type: 'tool', name: finalCheckTool, arguments: {} }));
      if (typeof step.observation?.passed !== 'boolean') throw new Error('invalid_trajectory_final_check_result');
      commit([step]);
      if (!step.observation.passed) return null;
    }
    return finish(action);
  };
  while (true) {
    if (!reviewDrafts) {
      const action = checkedAction(await call(draft, context({ segment: [] })));
      if (action.type === 'final') { const result = await checkedFinish(action); if (result) return result; else continue; }
      commit([await execute(action)]);
      continue;
    }
    const segment = [];
    let held = false;
    while (segment.length < chunkSize) {
      const action = checkedAction(await call(draft, context({ segment })));
      held = action.type === 'final' || registry.get(action.name).effect === 'write';
      segment.push(held ? { action, observation: null } : await execute(action));
      if (held) break;
    }
    stats.reviews++;
    // Unlike the paper's unchecked K-read commit, every chunk is reviewed.
    const verdict = await call(verify, context({ segment }));
    if (!plain(verdict) || Object.keys(verdict).some(key => !['accepted', 'reason', 'replacement'].includes(key))
      || !Number.isSafeInteger(verdict.accepted) || verdict.accepted < 0 || verdict.accepted > segment.length
      || typeof verdict.reason !== 'string' || verdict.reason.length > 4096
      || !Object.hasOwn(verdict, 'replacement')) throw new Error('invalid_trajectory_verdict');
    if (verdict.accepted === segment.length) {
      if (verdict.replacement !== null) throw new Error('ambiguous_trajectory_verdict');
      commit(held ? segment.slice(0, -1) : segment);
      if (!held) continue;
      const action = segment.at(-1).action;
      if (action.type === 'final') { const result = await checkedFinish(action); if (result) return result; else continue; }
      commit([await execute(action)]);
    } else {
      if (!verdict.reason.trim()) throw new Error('invalid_trajectory_verdict');
      stats.rejectedSteps += segment.length - verdict.accepted;
      commit(segment.slice(0, verdict.accepted));
      let action;
      if (verdict.replacement !== null) {
        try { action = checkedAction(verdict.replacement); }
        catch (error) {
          if (error.message !== 'invalid_trajectory_action') throw error;
        }
      }
      if (!action) {
        stats.repairs++;
        action = checkedAction(await call(repair, context({ reason: verdict.reason })));
      }
      if (action.type === 'final') { const result = await checkedFinish(action); if (result) return result; else continue; }
      commit([await execute(action)]);
    }
  }
}
