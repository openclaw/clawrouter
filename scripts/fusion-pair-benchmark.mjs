import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent, SpendLedger, toolErrorCode } from './fusion-agent-benchmark.mjs';
import { nativeModels, nativePins, nativeRequest, nativeResult, nativeErrorMetadata, requireCompleteResponse } from './fusion-native-provider.mjs';
import { models as roles, priceBound } from './fusion-benchmark-accounting.mjs';
import { validateLocalQualification } from './fusion-local-repository.mjs';
import { loadTasks, verify, hash, command, withReproducer } from './fusion-workloads.mjs';
import { runContractAgent, runSingleDraft, runRefinedDraft } from './fusion-contract-agent.mjs';

export const pairDefaults = Object.freeze({ cheap: 'openai/gpt-6-luna', strong: 'openai/gpt-6.1-sol',
  maxCalls: 12, outputTokens: 8192, deadlineMs: 300000, trialBudgetMicros: 1000000,
  campaignBudgetMicros: 100000000, priorCostMicros: 0 });
const strategies = ['cheap', 'strong', 'architect'];
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
  if (['contract-cheap', 'contract-provided-cheap'].includes(strategy)) return config.cheap;
  if (['contract-strong', 'contract-provided-strong'].includes(strategy)) return config.strong;
  if (contractPolicies.includes(strategy)) return role === roles.cheap ? config.cheap : config.strong;
  if (!strategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  return strategy === 'strong' || (strategy === 'architect' && role === roles.cheap) ? config.strong : config.cheap;
}

// One planner call is deducted from the same total call allowance as each control.
export function pairExecution(strategy, config) {
  if (!strategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  return { strategy: strategy === 'architect' ? 'planned' : 'strong',
    settings: { maxTurns: config.maxCalls - Number(strategy === 'architect'),
      outputTokens: config.outputTokens, deadlineMs: config.deadlineMs } };
}

export async function runPairBenchmark({ repo, qualificationPath, taskManifest, out, sourceSha, config,
  cheapReasoning = 'none', cheapMaxCalls = 10, executor = 'interactive', preloadSource = false, policy = 'architect', includeControls = true, controlsOnly = false, env = process.env, fetcher = fetch, agent, contractAgent = runContractAgent, grade = verify, preflight = nativePins }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact_source_required');
  if (!['architect', 'scope', ...contractPolicies].includes(policy)) throw new Error('invalid_pair_policy');
  if (!['interactive', 'single-draft'].includes(executor) || (executor === 'single-draft' && !providedPolicies.includes(policy))) throw new Error('invalid_pair_executor');
  agent ??= executor === 'single-draft' ? runSingleDraft : runAgent;
  if (typeof includeControls !== 'boolean' || typeof controlsOnly !== 'boolean'
    || (controlsOnly && !includeControls) || (!includeControls && !contractPolicies.includes(policy))) throw new Error('invalid_control_selection');
  if (policy !== 'architect') preloadSource = true;
  if (contractPolicies.includes(policy) && config.maxCalls < 4) throw new Error('contract_requires_four_calls');
  const trialStrategies = controlsOnly ? ['cheap', 'strong'] : includeControls ? ['cheap', 'strong', policy] : [policy];
  const tasks = await loadTasks(taskManifest);
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
    cheapReasoning, cheapMaxCalls, executor, preloadSource, datasetDigest: hash(JSON.stringify(tasks)), qualificationDigest: hash(rawQualification), receipts, pins,
    strategies: trialStrategies, policy, complete: false, records: [], calls: [], spentOrReservedMicros: config.priorCostMicros,
    limitations: ['One trial per task; report the declared task split and do not infer general superiority.',
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
    const attempt = await ledger.reserve(trialId, model, priceBound(request.body, pins[model].price));
    // The attempt exists before dispatch; all transport/parse failures leave it reserved.
    await save();
    let normalized;
    try {
      const response = await fetcher(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
      attempt.httpStatus = response.status;
      const raw = await response.json();
      if (!response.ok) {
        Object.assign(attempt, nativeErrorMetadata(raw));
        if (attempt.errorHint === 'safety_notice') console.error("Provider safety notice: This content can't be shown.");
        throw new Error('unknown_cost');
      }
      normalized = nativeResult(model, raw);
      const usage = raw.usage;
      attempt.inputTokens = usage.prompt_tokens ?? usage.input_tokens;
      attempt.outputTokens = usage.completion_tokens ?? usage.output_tokens;
      attempt.promptDigest = hash(JSON.stringify(body.messages));
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
        const row = { taskId: task.id, split: task.split, strategy, score: 0, status: 'running',
          ...(strategy === 'scope' ? { selectedStrategy, selectedModel: config[selectedStrategy] } : {}) };
        state.records.push(row);
        await save();
        try {
          const result = contractPolicies.includes(strategy)
            ? await contractAgent(task, receipt.image, trialId, execution.settings, invoke(strategy),
              { agent, ...(['contract-draft', 'contract-refine'].includes(policy) ? { cheapAgent: policy === 'contract-refine' ? runRefinedDraft : runSingleDraft } : {}), cheapMaxCalls, exposeProbe: policy !== 'contract-private', providedProbe: providedPolicies.includes(policy) ? task.reproducer : null })
            : await agent(providedPolicies.includes(policy) ? withReproducer(task, task.reproducer) : task,
              receipt.image, execution.strategy, trialId, execution.settings, invoke(selectedStrategy), undefined, { preloadSource });
          const verdict = await grade(task, receipt.image, result.files, repo);
          const { files, ...trace } = result;
          Object.assign(row, { ...trace, verdict, score: Number(verdict.passed && verdict.tests === receipt.oracleTests
            && verdict.skipped === receipt.oracleSkipped && result.publicPassed), status: 'complete' });
        } catch (error) {
          Object.assign(row, { status: 'error', errorCode: toolErrorCode(error) });
          if (ledger.blocked || error.message === 'provider_refused' || error.message === 'provider_safety_notice') throw error;
        } finally {
          row.costMicros = ledger.total(trialId);
          row.calls = ledger.attempts.filter(call => call.trialId === trialId).length;
          row.elapsedMs = Math.round(performance.now() - start);
          await save();
        }
        console.log(JSON.stringify({ taskId: task.id, strategy, score: row.score, calls: row.calls }));
      }
    }
    state.complete = true;
    await save();
    return state;
  } catch (error) {
    state.failure = ledger.blocked ? 'unknown_cost' : toolErrorCode(error);
    await save();
    throw new Error('pair_benchmark_incomplete');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [qualificationPath, taskManifest, configPath, out] = process.argv.slice(2);
  if (!out) throw new Error('qualification, task manifest, explicit config and fresh output directory required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const sourceSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.toString().trim();
  runPairBenchmark({ repo: process.cwd(), qualificationPath, taskManifest, config, out, sourceSha, policy: process.env.FUSION_PAIR_POLICY ?? 'architect', cheapReasoning: process.env.FUSION_CHEAP_REASONING ?? 'none', cheapMaxCalls: Number(process.env.FUSION_CHEAP_MAX_CALLS ?? 10), executor: process.env.FUSION_PAIR_EXECUTOR ?? 'interactive', preloadSource: process.env.FUSION_PRELOAD_SOURCE === '1', includeControls: process.env.FUSION_PAIR_CONTROLS !== '0', controlsOnly: process.env.FUSION_PAIR_CONTROLS_ONLY === '1' }).catch(() => {
    console.error('Pair benchmark incomplete; inspect the content-free checkpoint.'); process.exitCode = 1;
  });
}
