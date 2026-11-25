import { runSingleDraft } from './fusion-contract-agent.mjs';
import { runAgent } from './fusion-agent-benchmark.mjs';
import { models } from './fusion-benchmark-accounting.mjs';
import { validateEdits, hash } from './fusion-workloads.mjs';

// A sampling control: fixed-order visible selection, no judge or hidden feedback.
export async function runDraftSampling(task, image, trialId, config, invoke, {
  draft = runSingleDraft, agent = runAgent,
} = {}) {
  if (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 3) throw new Error('sampling_requires_three_calls');
  const started = performance.now(), signal = AbortSignal.timeout(config.deadlineMs);
  const candidates = [], actions = [];
  let calls = 0, toolMs = 0;
  const remaining = () => {
    const ms = config.deadlineMs - Math.ceil(performance.now() - started);
    if (ms <= 0 || signal.aborted) throw new Error('command_timeout');
    return ms;
  };
  const call = limit => {
    let phaseCalls = 0;
    return async (id, _role, body, childSignal) => {
      remaining();
      if (calls >= config.maxTurns || phaseCalls >= limit) throw new Error('trial_budget');
      calls++; phaseCalls++;
      return invoke(id, models.cheap, body, AbortSignal.any([signal, childSignal]));
    };
  };
  for (let index = 0; index < 2; index++) {
    const candidate = await draft(task, image, 'strong', trialId,
      { ...config, maxTurns: 1, deadlineMs: remaining() }, call(1), undefined, { signal });
    validateEdits(task, candidate.files);
    candidates.push(candidate);
    toolMs += candidate.toolMs;
    actions.push(...candidate.actions.map(action => ({ ...action, phase: `candidate-${index + 1}` })));
  }
  const selected = candidates.findIndex(candidate => candidate.outcome === 'draft_submitted' && candidate.publicPassed === true);
  let result = candidates[selected];
  if (selected === -1) {
    result = await agent(task, image, 'strong', trialId,
      { ...config, maxTurns: config.maxTurns - calls, deadlineMs: remaining() }, call(config.maxTurns - calls),
      undefined, { preloadSource: true, signal });
    actions.push(...result.actions.map(action => ({ ...action, phase: 'fallback' })));
    toolMs += result.toolMs;
  }
  return { ...result, actions, turns: calls, toolMs: Math.round(toolMs), agentMs: Math.round(performance.now() - started),
    invalidActions: candidates.reduce((sum, candidate) => sum + (candidate.invalidActions ?? 0), 0)
      + (selected === -1 ? result.invalidActions ?? 0 : 0),
    escalated: selected === -1, draftSampling: { selectedCandidate: selected === -1 ? null : selected + 1,
      candidates: candidates.map(candidate => ({ outcome: candidate.outcome, publicPassed: candidate.publicPassed,
        patchDigest: hash(JSON.stringify([...candidate.files].sort((a, b) => a.path.localeCompare(b.path)))) })) } };
}
