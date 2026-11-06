import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runReviewCascade } from './fusion-review-cascade.mjs';
import { runAgent, SpendLedger, toolErrorCode } from './fusion-agent-benchmark.mjs';
import { nativeModels, nativePins, nativeRequest, nativeResult, nativeErrorMetadata, requireCompleteResponse } from './fusion-native-provider.mjs';
import { models as roles, priceBound } from './fusion-benchmark-accounting.mjs';
import { validateLocalQualification } from './fusion-local-repository.mjs';
import { loadTasks, verify, hash, command } from './fusion-workloads.mjs';

export const pairDefaults = Object.freeze({ cheap: 'openai/gpt-6-luna', strong: 'openai/gpt-6.1-sol',
  maxCalls: 12, outputTokens: 8192, deadlineMs: 300000, trialBudgetMicros: 1000000,
  campaignBudgetMicros: 100000000, priorCostMicros: 0 });
const allowedStrategies = ['cheap', 'strong', 'architect', 'review'];
const strategies = ['cheap', 'strong', 'architect'];

export function validatePair(config, taskCount) {
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(Object.keys(pairDefaults).sort())
    || !Object.hasOwn(nativeModels, config.cheap) || !Object.hasOwn(nativeModels, config.strong)
    || config.cheap === config.strong) throw new Error('invalid_pair_config');
  for (const [key, min, max] of [['maxCalls', 2, 60], ['outputTokens', 256, 16384], ['deadlineMs', 1000, 900000],
    ['trialBudgetMicros', 1, 5000000], ['campaignBudgetMicros', 1, 100000000], ['priorCostMicros', 0, 100000000]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`invalid_${key}`);
  }
  if (!Number.isSafeInteger(taskCount) || taskCount < 1
    || config.priorCostMicros + taskCount * strategies.length * config.trialBudgetMicros > config.campaignBudgetMicros) {
    throw new Error('campaign_budget_exceeded');
  }
}

export function pairModel(strategy, role, config) {
  if (!allowedStrategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  return strategy === 'strong' || (strategy === 'review' && role !== roles.cheap) || (strategy === 'architect' && role === roles.cheap) ? config.strong : config.cheap;
}

// One planner call is deducted from the same total call allowance as each control.
export function pairExecution(strategy, config) {
  if (!allowedStrategies.includes(strategy)) throw new Error('invalid_pair_strategy');
  return { strategy: strategy === 'architect' ? 'planned' : strategy === 'review' ? 'review' : 'strong',
    settings: { maxTurns: config.maxCalls - Number(strategy === 'architect'),
      outputTokens: config.outputTokens, deadlineMs: config.deadlineMs } };
}

export async function runPairBenchmark({ repo, qualificationPath, taskManifest, out, sourceSha, config,
  cheapReasoning = 'none', preloadSource = false, policy = 'architect', env = process.env, fetcher = fetch, agent = runAgent, grade = verify, preflight = nativePins }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact_source_required');
  const tasks = await loadTasks(taskManifest);
  validatePair(config, tasks.length);
  if (!['none', 'medium'].includes(cheapReasoning)) throw new Error('invalid_cheap_reasoning');
  if (typeof preloadSource !== 'boolean') throw new Error('invalid_source_preload');
  if (!['architect', 'review'].includes(policy)) throw new Error('invalid_pair_policy');
  if (policy === 'review' && config.maxCalls < 3) throw new Error('review_requires_three_calls');
  preloadSource = policy === 'review' || preloadSource;
  const trialStrategies = ['cheap', 'strong', policy];
  const rawQualification = await readFile(qualificationPath);
  const receipts = validateLocalQualification(tasks, JSON.parse(rawQualification));
  const pins = await preflight(env, fetcher, [config.cheap, config.strong]);
  await mkdir(out, { mode: 0o700 });
  const state = { version: 1, kind: 'native-pair-repository', sourceSha, config,
    cheapReasoning, preloadSource, datasetDigest: hash(JSON.stringify(tasks)), qualificationDigest: hash(rawQualification), receipts, pins,
    strategies: trialStrategies, complete: false, records: [], calls: [], spentOrReservedMicros: config.priorCostMicros,
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
        const start = performance.now(), execution = pairExecution(strategy, config);
        const row = { taskId: task.id, split: task.split, strategy, score: 0, status: 'running' };
        state.records.push(row);
        await save();
        try {
          const result = execution.strategy === 'review'
            ? await runReviewCascade(task, receipt.image, trialId, execution.settings, invoke(strategy), agent)
            : await agent(task, receipt.image, execution.strategy, trialId, execution.settings, invoke(strategy), undefined, { preloadSource });
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
  runPairBenchmark({ repo: process.cwd(), qualificationPath, taskManifest, config, out, sourceSha, cheapReasoning: process.env.FUSION_CHEAP_REASONING ?? 'none', preloadSource: process.env.FUSION_PRELOAD_SOURCE === '1', policy: process.env.FUSION_PAIR_POLICY ?? 'architect' }).catch(() => {
    console.error('Pair benchmark incomplete; inspect the content-free checkpoint.'); process.exitCode = 1;
  });
}
