import { readFile, mkdir, writeFile, rename, rm, open, link } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent, SpendLedger, toolErrorCode, finishReason, agentFailureTrace } from './fusion-agent-benchmark.mjs';
import { nativeModels, nativePins, nativeRequest, nativeResult, nativeErrorMetadata, requireCompleteResponse, responseDisposition } from './fusion-native-provider.mjs';
import { models as roles, priceBound } from './fusion-benchmark-accounting.mjs';
import { validateLocalQualification } from './fusion-local-repository.mjs';
import { loadTasks, verify, hash, command, withReproducer, validateEdits } from './fusion-workloads.mjs';
import { runContractAgent, runSingleDraft, runRefinedDraft } from './fusion-contract-agent.mjs';
import { runProbeSelection, diagnoseProbeSelection } from './fusion-probe-selection.mjs';
import { runDraftSampling } from './fusion-draft-sampling.mjs';

export const pairDefaults = Object.freeze({ cheap: 'openai/gpt-6-luna', strong: 'openai/gpt-6.1-sol',
  maxCalls: 12, outputTokens: 8192, deadlineMs: 300000, trialBudgetMicros: 1000000,
  campaignBudgetMicros: 100000000, priorCostMicros: 0 });
const strategies = ['cheap', 'strong', 'architect', 'edit-handoff', 'completion-handoff', 'probe-selection', 'draft-sampling'];
const providedPolicies = ['contract-provided', 'contract-draft', 'contract-refine', 'contract-provided-cheap', 'contract-provided-strong'];
const contractPolicies = ['contract', 'contract-cheap', 'contract-strong', 'contract-private', ...providedPolicies];

// The caller supplies repair scope before inference; never inspect test answers.
export function scopeStrategy(task) {
  return task.editPaths.length === 1 ? 'cheap' : 'strong';
}

export function validatePair(config, taskCount, armCount = 3) {
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(Object.keys(pairDefaults).sort())
    || !Object.hasOwn(nativeModels, config.cheap) || !Object.hasOwn(nativeModels, config.strong)
    || config.cheap === config.strong) throw new Error('invalid_pair_config');
  for (const [key, min, max] of [['maxCalls', 2, 60], ['outputTokens', 256, 16384], ['deadlineMs', 1000, 900000],
    ['trialBudgetMicros', 1, 5000000], ['campaignBudgetMicros', 1, 100000000], ['priorCostMicros', 0, 100000000]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`invalid_${key}`);
  }
  if (!Number.isSafeInteger(taskCount) || taskCount < 1
    || !Number.isSafeInteger(armCount) || armCount < 1 || armCount > 3
    || config.priorCostMicros + taskCount * armCount * config.trialBudgetMicros > config.campaignBudgetMicros) {
    throw new Error('campaign_budget_exceeded');
  }
}

export function pairModel(strategy, role, config) {
  if (strategy === 'draft-sampling') return config.cheap;
  if (strategy === 'probe-selection') return role === roles.strong ? config.strong : config.cheap;
  if (['contract-cheap', 'contract-provided-cheap'].includes(strategy)) return config.cheap;
  if (['contract-strong', 'contract-provided-strong'].includes(strategy)) return config.strong;
  if (contractPolicies.includes(strategy)) return role === roles.cheap ? config.cheap : config.strong;
  if (!strategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  if (['edit-handoff', 'completion-handoff'].includes(strategy)) return role === roles.critic ? config.cheap : config.strong;
  return strategy === 'strong' || (strategy === 'architect' && role === roles.cheap) ? config.strong : config.cheap;
}

// One planner call is deducted from the same total call allowance as each control.
export function pairExecution(strategy, config) {
  if (!strategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  return { strategy: strategy === 'architect' ? 'planned' : ['edit-handoff', 'completion-handoff'].includes(strategy) ? 'handoff' : 'strong',
    settings: { maxTurns: config.maxCalls - Number(strategy === 'architect'),
      outputTokens: config.outputTokens, deadlineMs: config.deadlineMs } };
}

async function exportAcceptedRepair(out, task, files, sourceSha, qualificationDigest) {
  const contents = validateEdits(task, files).map(({ path, content }) => ({ path, content }));
  if (!contents.length || contents.length > 32) throw new Error('repair_export_failed');
  const payload = JSON.stringify({ version: 1, kind: 'accepted-repository-repair', taskId: task.id,
    base: task.base, sourceSha, taskDigest: hash(JSON.stringify(task)), qualificationDigest,
    filesDigest: hash(JSON.stringify(contents)), files: contents }, null, 2) + '\n';
  const bytes = Buffer.byteLength(payload);
  if (bytes > 4 * 1024 * 1024) throw new Error('repair_export_failed');
  const file = `${task.id}.repair.json`, temporary = resolve(out, file + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(payload);
    await handle.close();
    await link(temporary, resolve(out, file));
  } finally { await handle.close(); await rm(temporary, { force: true }); }
  return { file, sha256: hash(payload), bytes };
}

export async function runPairBenchmark({ repo, qualificationPath, taskManifest, out, sourceSha, config,
  cheapReasoning = 'none', cheapMaxCalls = 10, executor = 'interactive', preloadSource = false, policy = 'architect', includeControls = true, controlsOnly = false, exportRepairs = false, handoffEvidence = false, probeRegressionGate = false, handoffMaxTurns = null, env = process.env, fetcher = fetch, agent, contractAgent = runContractAgent, probeAgent = runProbeSelection, samplingAgent = runDraftSampling, grade = verify, preflight = nativePins }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact_source_required');
  if (!['architect', 'edit-handoff', 'completion-handoff', 'probe-selection', 'draft-sampling', 'matched-handoff', 'scope', ...contractPolicies].includes(policy)) throw new Error('invalid_pair_policy');
  if (!['interactive', 'single-draft'].includes(executor) || (executor === 'single-draft' && !providedPolicies.includes(policy))) throw new Error('invalid_pair_executor');
  agent ??= executor === 'single-draft' ? runSingleDraft : runAgent;
  if (typeof includeControls !== 'boolean' || typeof controlsOnly !== 'boolean'
    || (controlsOnly && !includeControls)
    || (!includeControls && policy !== 'edit-handoff' && !contractPolicies.includes(policy))) throw new Error('invalid_control_selection');
  if (typeof exportRepairs !== 'boolean' || (exportRepairs && (includeControls || policy !== 'edit-handoff'))) {
    throw new Error('invalid_repair_export');
  }
  if (typeof handoffEvidence !== 'boolean' || (handoffEvidence && (controlsOnly || !['edit-handoff', 'completion-handoff', 'matched-handoff'].includes(policy)))) throw new Error('invalid_handoff_evidence');
  if (typeof probeRegressionGate !== 'boolean' || (probeRegressionGate && (executor !== 'interactive' || !['architect', 'edit-handoff', 'completion-handoff', 'matched-handoff'].includes(policy)))) throw new Error('invalid_probe_regression_gate');
  if (handoffMaxTurns !== null && (controlsOnly || !['edit-handoff', 'matched-handoff'].includes(policy)
    || !Number.isSafeInteger(handoffMaxTurns) || handoffMaxTurns < 1
    || handoffMaxTurns >= config.maxCalls)) throw new Error('invalid_handoff_turn_limit');
  if (policy !== 'architect') preloadSource = true;
  if (!controlsOnly && contractPolicies.includes(policy) && config.maxCalls < 4) throw new Error('contract_requires_four_calls');
  if (!controlsOnly && policy === 'probe-selection' && config.maxCalls < 4) throw new Error('probe_selection_requires_four_calls');
  if (!controlsOnly && policy === 'draft-sampling' && config.maxCalls < 3) throw new Error('sampling_requires_three_calls');
  const candidateStrategy = policy === 'matched-handoff' ? 'edit-handoff' : policy;
  const trialStrategies = controlsOnly ? ['cheap', 'strong'] : includeControls ? ['cheap', 'strong', candidateStrategy] : [candidateStrategy];
  const tasks = await loadTasks(taskManifest);
  if (tasks.some(task => task.preservationProbes !== undefined) && !probeRegressionGate) throw new Error('preservation_requires_regression_gate');
  if (providedPolicies.includes(policy) && tasks.some(task => task.reproducer === undefined)) throw new Error('missing_reproducer');
  validatePair(config, tasks.length, trialStrategies.length);
  if (!['none', 'medium'].includes(cheapReasoning)) throw new Error('invalid_cheap_reasoning');
  if (!Number.isSafeInteger(cheapMaxCalls) || cheapMaxCalls < 1 || cheapMaxCalls > 59) throw new Error('invalid_cheap_call_allowance');
  if (typeof preloadSource !== 'boolean') throw new Error('invalid_source_preload');
  const rawQualification = await readFile(qualificationPath);
  const receipts = validateLocalQualification(tasks, JSON.parse(rawQualification));
  const pins = await preflight(env, fetcher, [config.cheap, config.strong]);
  await mkdir(out, { mode: 0o700 });
  const state = { version: 1, kind: controlsOnly ? 'native-controls-repository' : includeControls ? 'native-pair-repository' : 'native-policy-repository', sourceSha, config, includeControls, controlsOnly,
    cheapReasoning, cheapMaxCalls, executor, preloadSource, exportRepairs, handoffEvidence, probeRegressionGate, handoffMaxTurns, datasetDigest: hash(JSON.stringify(tasks)), qualificationDigest: hash(rawQualification), receipts, pins,
    strategies: trialStrategies, policy, complete: false, records: [], calls: [], spentOrReservedMicros: config.priorCostMicros,
    limitations: ['One trial per task; report the declared task split and do not infer general superiority.',
      ...(!includeControls ? ['No fixed-model controls ran; this report cannot establish comparative quality, cost or latency.'] : []),
      'Visible tests already pass on broken source. Only isolated final acceptance determines correctness.',
      'Published tariffs applied to reported usage; unknown charges retain their full reservation.'] };
  const save = async () => {
    state.spentOrReservedMicros = config.priorCostMicros + ledger.total();
    await writeFile(resolve(out, 'pair.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(resolve(out, 'pair.json.tmp'), resolve(out, 'pair.json'));
  };
  const ledger = new SpendLedger(config, save);
  state.calls = ledger.attempts;
  const invoke = strategy => async (trialId, role, body, signal) => {
    if (ledger.attempts.filter(call => call.trialId === trialId).length >= config.maxCalls) throw new Error('trial_budget');
    const model = pairModel(strategy, role, config);
    const request = nativeRequest(model, body, env);
    if (model === config.cheap && model === 'openai/gpt-6-luna') request.body.reasoning_effort = cheapReasoning;
    const requestBody = JSON.stringify(request.body);
    const attempt = await ledger.reserve(trialId, model, priceBound(request.body, pins[model].price));
    attempt.requestDigest = hash(requestBody);
    attempt.requestBytes = Buffer.byteLength(requestBody);
    attempt.promptDigest = hash(JSON.stringify(body.messages));
    // The attempt exists before dispatch; all transport/parse failures leave it reserved.
    await save();
    let normalized;
    try {
      const response = await fetcher(request.url, { method: 'POST', headers: request.headers,
        body: requestBody, signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
      attempt.httpStatus = response.status;
      const raw = await response.json();
      if (!response.ok) {
        Object.assign(attempt, nativeErrorMetadata(raw));
        if (attempt.errorHint === 'safety_notice') console.error("Provider safety notice: This content can't be shown.");
        throw new Error('unknown_cost');
      }
      normalized = nativeResult(model, raw);
      attempt.finishReason = finishReason(normalized.result.choices?.[0]?.finish_reason);
      attempt.responseDisposition = responseDisposition(normalized.result);
      const usage = raw.usage;
      attempt.inputTokens = usage.prompt_tokens ?? usage.input_tokens;
      attempt.outputTokens = usage.completion_tokens ?? usage.output_tokens;
      attempt.usageBreakdown = normalized.usageBreakdown;
      attempt.responseDigest = hash(normalized.result.choices?.[0]?.message?.content ?? '');
      await ledger.settle(attempt, normalized.costMicros, response.status);
    } catch {
      ledger.blocked = true;
      await save();
      throw new Error('unknown_cost');
    }
    if (/this content can[’']t be shown|safety refusal/i.test(normalized.result.choices?.[0]?.message?.content ?? '')) {
      console.error("Provider safety notice: This content can't be shown.");
      throw new Error('provider_refused');
    }
    requireCompleteResponse(normalized.result);
    return normalized.result;
  };
  await save();
  try {
    for (const [index, task] of tasks.entries()) {
      const receipt = receipts.find(row => row.taskId === task.id);
      // Rotate arm order to avoid always giving one arm the warmest caches.
      for (let offset = 0; offset < trialStrategies.length; offset++) {
        const strategy = trialStrategies[(index + offset) % trialStrategies.length], trialId = `${task.id}:${strategy}`;
        const selectedStrategy = strategy === 'scope' ? scopeStrategy(task) : contractPolicies.includes(strategy) ? 'strong' : strategy;
        const start = performance.now(), execution = pairExecution(selectedStrategy, config);
        let diagnosticMs = 0, agentElapsedMs = null, gradingElapsedMs = null;
        const matchedStrong = policy === 'matched-handoff' && strategy === 'strong';
        if (matchedStrong) execution.strategy = 'handoff';
        const row = { taskId: task.id, split: task.split, strategy, score: 0, status: 'running',
          ...(strategy === 'scope' ? { selectedStrategy, selectedModel: config[selectedStrategy] } : {}) };
        state.records.push(row);
        await save();
        try {
          let result;
          const agentStarted = performance.now();
          try {
            result = strategy === 'draft-sampling'
              ? await samplingAgent(task, receipt.image, trialId, execution.settings, invoke(strategy), { agent })
              : strategy === 'probe-selection'
              ? await probeAgent(task, receipt.image, trialId, execution.settings, invoke(strategy), { agent })
              : contractPolicies.includes(strategy)
              ? await contractAgent(task, receipt.image, trialId, execution.settings, invoke(strategy),
                { agent, ...(['contract-draft', 'contract-refine'].includes(policy) ? { cheapAgent: policy === 'contract-refine' ? runRefinedDraft : runSingleDraft } : {}), cheapMaxCalls, exposeProbe: policy !== 'contract-private', providedProbe: providedPolicies.includes(policy) ? task.reproducer : null })
              : await agent(providedPolicies.includes(policy) ? withReproducer(task, task.reproducer) : task,
                receipt.image, execution.strategy, trialId, execution.settings, invoke(selectedStrategy), undefined,
                { preloadSource, ...(probeRegressionGate ? { probeRegressionGate: true } : {}), ...(handoffEvidence && execution.strategy === 'handoff' ? { handoffEvidence: true } : {}), ...(strategy === 'completion-handoff' ? { handoffOnFinish: true }
                  : strategy === 'edit-handoff' || matchedStrong ? { handoffAfterEdit: true, ...(handoffMaxTurns === null ? {} : { handoffMaxTurns }) } : {}) });
          } finally { agentElapsedMs = Math.round(performance.now() - agentStarted); }
          let verdict;
          const gradingStarted = performance.now();
          try { verdict = await grade(task, receipt.image, result.files, repo); }
          finally { gradingElapsedMs = Math.round(performance.now() - gradingStarted); }
          const { files, ...trace } = result;
          Object.assign(row, { ...trace, verdict, score: Number(verdict.passed && verdict.tests === receipt.oracleTests
            && verdict.skipped === receipt.oracleSkipped && result.publicPassed && (!probeRegressionGate || result.probeRegressionPassed === true)), status: 'complete' });
          if (strategy === 'probe-selection') {
            const diagnosticStart = performance.now();
            row.probeDiagnostics = await diagnoseProbeSelection(result, task, receipt.image, repo, receipt, { grade });
            diagnosticMs = performance.now() - diagnosticStart;
          }
          if (exportRepairs && row.score === 1) {
            try { row.repairExport = await exportAcceptedRepair(out, task, files, sourceSha, state.qualificationDigest); }
            catch { row.repairExportFailed = true; throw new Error('repair_export_failed'); }
          }
        } catch (error) {
          if (error.message === 'repair_export_failed') throw error;
          Object.assign(row, { status: 'error', errorCode: toolErrorCode(error),
            ...(agentFailureTrace(error) ? { failureTrace: agentFailureTrace(error) } : {}) });
          if (ledger.blocked || error.message === 'provider_refused' || error.message === 'provider_safety_notice') throw error;
        } finally {
          row.costMicros = ledger.total(trialId);
          row.calls = ledger.attempts.filter(call => call.trialId === trialId).length;
          row.agentElapsedMs = agentElapsedMs;
          row.gradingElapsedMs = gradingElapsedMs;
          row.elapsedMs = Math.round(performance.now() - start - diagnosticMs);
          await save();
        }
        console.log(JSON.stringify({ taskId: task.id, strategy, score: row.score, calls: row.calls }));
      }
    }
    state.complete = true;
    await save();
    return state;
  } catch (error) {
    state.failure = ledger.blocked ? 'unknown_cost' : error.message === 'repair_export_failed' ? 'repair_export_failed' : toolErrorCode(error);
    await save();
    throw new Error('pair_benchmark_incomplete');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [qualificationPath, taskManifest, configPath, out] = process.argv.slice(2);
  if (!out) throw new Error('qualification, task manifest, explicit config and fresh output directory required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const sourceSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.toString().trim();
  runPairBenchmark({ repo: process.cwd(), qualificationPath, taskManifest, config, out, sourceSha, policy: process.env.FUSION_PAIR_POLICY ?? 'architect', cheapReasoning: process.env.FUSION_CHEAP_REASONING ?? 'none', cheapMaxCalls: Number(process.env.FUSION_CHEAP_MAX_CALLS ?? 10), executor: process.env.FUSION_PAIR_EXECUTOR ?? 'interactive', preloadSource: process.env.FUSION_PRELOAD_SOURCE === '1', includeControls: process.env.FUSION_PAIR_CONTROLS !== '0', controlsOnly: process.env.FUSION_PAIR_CONTROLS_ONLY === '1', exportRepairs: process.env.FUSION_EXPORT_REPAIRS === '1', handoffMaxTurns: process.env.FUSION_HANDOFF_MAX_TURNS === undefined ? null : Number(process.env.FUSION_HANDOFF_MAX_TURNS), handoffEvidence: process.env.FUSION_HANDOFF_EVIDENCE === '1', probeRegressionGate: process.env.FUSION_PROBE_REGRESSION_GATE === '1' }).catch(() => {
    console.error('Pair benchmark incomplete; inspect the content-free checkpoint.'); process.exitCode = 1;
  });
}
