import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTasks, hash, command, verify, preservationQualificationMatches } from './fusion-workloads.mjs';
import { runAgent } from './fusion-agent-benchmark.mjs';
import { runGroundedAgent } from './fusion-grounded-agent.mjs';
import { models as roles } from './fusion-benchmark-accounting.mjs';
import { localEndpoint } from './fusion-selector-smoke.mjs';
import { localGenerator } from './fusion-execution-smoke.mjs';

export const localRepositorySettings = Object.freeze({ maxTurns: 8, outputTokens: 1536,
  contextTokens: 32768, deadlineMs: 180000, campaignDeadlineMs: 1200000, temperature: 0, seed: 42000 });
const strategies = ['general', 'coder', 'handoff'];
const responseFailures = new WeakMap();
function invalidLocalResponse(reason) {
  const error = new Error('invalid_local_response');
  responseFailures.set(error, reason);
  return error;
}
export const groundedSampling = Object.freeze({ temperature: 0.7, top_p: 0.8, top_k: 20,
  min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 });

export function localRoutes(strategy, pins) {
  if (!strategies.includes(strategy) || pins.length !== 2 || pins[0].model === pins[1].model) throw new Error('invalid_local_strategy');
  // The existing agent uses role identifiers internally. They select only these
  // pinned local models; no native provider transport is called.
  const primary = strategy === 'general' ? pins[0].model : pins[1].model;
  return { [roles.strong]: primary, [roles.critic]: strategy === 'handoff' ? pins[0].model : primary };
}

export function validateLocalQualification(tasks, qualification) {
  if (!/^node@sha256:[a-f0-9]{64}$/.test(qualification?.nodeImage ?? '')) throw new Error('unqualified_node_image');
  return tasks.map(task => {
    const matches = qualification.receipts?.filter(row => row.taskId === task.id), receipt = matches?.[0];
    if (matches?.length !== 1 || !preservationQualificationMatches(task.preservationProbes, receipt?.preservation) || receipt.taskDigest !== hash(JSON.stringify(task)) || receipt.qualified !== true
      || receipt.visible?.passed !== true || receipt.oracleVisible?.valid !== true || receipt.oracleVisible?.passed !== true
      || receipt.oracle?.passed !== true || receipt.oracle.valid !== true
      || !Number.isSafeInteger(receipt.oracle.tests) || receipt.oracle.tests < 1
      || !Number.isSafeInteger(receipt.oracle.skipped) || receipt.oracle.skipped < 0
      || receipt.broken?.valid !== true || receipt.broken.passed !== false
      || task.reproducer !== undefined && (receipt.reproduction?.assertionFailed !== true || receipt.oracleReproduction?.passed !== true)
      || !/^sha256:[a-f0-9]{64}$/.test(receipt.image)) throw new Error('unqualified_local_task');
    return { taskId: task.id, taskDigest: receipt.taskDigest, image: receipt.image,
      oracleTests: receipt.oracle.tests, oracleSkipped: receipt.oracle.skipped };
  });
}

function validateOutputTokens(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8192) throw new Error('invalid_local_output_tokens');
  return value;
}

export async function localActionRequest({ endpoint, model, pin, body, signal, seed, profile = 'legacy',
  maxOutputTokens = localRepositorySettings.outputTokens, fetcher = fetch, onDispatch = async () => {} }) {
  validateOutputTokens(maxOutputTokens);
  if (!['legacy', 'grounded', 'checked'].includes(profile)) throw new Error('invalid_local_profile');
  const base = localEndpoint(endpoint);
  if (model !== pin.model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1
    || body.max_tokens > maxOutputTokens || !Array.isArray(body.messages)
    || body.messages.some(row => !['system', 'user', 'assistant'].includes(row.role) || typeof row.content !== 'string')
    || body.response_format?.type !== 'json_schema') throw new Error('invalid_local_action_request');
  // Byte length is a conservative token upper bound for these text messages.
  // Fail a trial explicitly rather than allowing silent context truncation.
  if (Buffer.byteLength(JSON.stringify(body.messages)) + body.max_tokens + 2048 > localRepositorySettings.contextTokens) {
    throw new Error('provider_context_limit');
  }
  await onDispatch();
  let response;
  try { response = await fetcher(base + '/api/chat', { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(profile !== 'legacy' ? 120000 : 60000)]),
    body: JSON.stringify({ model, stream: false, keep_alive: '5m', ...(pin.thinking ? { think: false } : {}),
      format: body.response_format.json_schema.schema, messages: body.messages,
      options: { num_predict: body.max_tokens, num_ctx: localRepositorySettings.contextTokens,
        ...(profile !== 'legacy' ? groundedSampling : { temperature: localRepositorySettings.temperature }), seed } }) }); }
  catch (error) { if (signal.aborted) throw new Error('provider_local_deadline'); throw error; }
  if (!response.ok) throw new Error('local_transport_failed');
  let value;
  try { value = await response.json(); } catch { throw invalidLocalResponse('unreadable_body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLocalResponse('invalid_envelope');
  const content = value.message?.content;
  if (typeof content === 'string' && /this content can[’']t be shown|safety refusal/i.test(content)) throw new Error('provider_safety_notice');
  if (value.model !== model) throw invalidLocalResponse('model_mismatch');
  if (value.done !== true) throw invalidLocalResponse('incomplete');
  if (typeof content !== 'string') throw invalidLocalResponse('missing_content');
  if (![value.prompt_eval_count, value.eval_count].every(n => Number.isSafeInteger(n) && n >= 0)) throw invalidLocalResponse('invalid_usage');
  if (value.eval_count > body.max_tokens) throw invalidLocalResponse('output_limit');
  if (value.prompt_eval_count + value.eval_count > localRepositorySettings.contextTokens) throw invalidLocalResponse('context_limit');
  if (!['stop', 'length'].includes(value.done_reason)) throw invalidLocalResponse('invalid_stop_reason');
  return { result: { model, choices: [{ message: { content }, finish_reason: value.done_reason }] },
    inputTokens: value.prompt_eval_count, outputTokens: value.eval_count,
    promptDigest: hash(JSON.stringify(body.messages)), responseDigest: hash(content), stopReason: value.done_reason };
}

export async function runLocalRepository({ repo, qualificationPath, out, sourceSha,
  models, endpoint = 'http://127.0.0.1:11435', fetcher = fetch, profile = 'legacy', taskManifest,
  actionSchemaProfile = 'legacy',
  outputTokens = localRepositorySettings.outputTokens,
  agent, grade = verify, inspectImage = async image => {
    const result = await command('docker', ['image', 'inspect', '--format={{.Id}}', image]);
    if (result.stdout.toString().trim() !== image) throw new Error('local_image_missing');
  }, preflight = localGenerator }) {
  const settings = { ...localRepositorySettings, outputTokens: validateOutputTokens(outputTokens) };
  localEndpoint(endpoint);
  if (!['legacy', 'grounded', 'checked'].includes(profile)) throw new Error('invalid_local_profile');
  if (!['legacy', 'compact'].includes(actionSchemaProfile) || actionSchemaProfile !== 'legacy' && profile !== 'legacy') {
    throw new Error('invalid_local_action_schema_profile');
  }
  const execute = agent ?? (profile !== 'legacy' ? runGroundedAgent : runAgent);
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact_source_required');
  const tasks = await loadTasks(taskManifest ?? resolve(repo, 'benchmarks/fusion/validation-workloads.json'));
  const rawQualification = await readFile(qualificationPath), qualification = JSON.parse(rawQualification);
  const receipts = validateLocalQualification(tasks, qualification);
  for (const receipt of receipts) await inspectImage(receipt.image);
  const local = await preflight(models, endpoint, fetcher);
  if (local.pins.length !== 2) throw new Error('two_local_models_required');
  await mkdir(out, { mode: 0o700 });
  const state = { version: 1, kind: 'local-repository-development', sourceSha, profile,
    datasetDigest: hash(JSON.stringify(tasks)), qualificationDigest: hash(rawQualification), receipts,
    modelPins: local.pins, settings: { ...settings, actionSchemaProfile,
      ...(profile !== 'legacy' ? groundedSampling : {}), requestTimeoutMs: profile !== 'legacy' ? 120000 : 60000 }, apiSpendMicros: 0,
    maxCalls: tasks.length * strategies.length * settings.maxTurns,
    complete: false, calls: [], records: [],
    limitations: ['Previously used development repository tasks; not an unseen holdout.',
      'Same action harness and turn/context limits across arms; token and compute cost can differ.',
      profile === 'checked' ? 'Handoff switches from reproduction to repair after a failing assertion; at most three reproduction actions.'
        : 'The handoff arm uses the existing two-thirds-turn or early-submit transfer rule.',
      'Zero paid API spend excludes local compute, power, downloads and test execution.'] };
  const checkpoint = async () => {
    await writeFile(resolve(out, 'local-repository.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(resolve(out, 'local-repository.json.tmp'), resolve(out, 'local-repository.json'));
  };
  await checkpoint();
  try {
    const campaignDeadline = performance.now() + settings.campaignDeadlineMs;
    for (const [index, task] of tasks.entries()) for (let offset = 0; offset < strategies.length; offset++) {
      if (performance.now() >= campaignDeadline) throw new Error('campaign_deadline');
      const strategy = strategies[(index + offset) % strategies.length], trialId = `${task.id}:${strategy}`;
      const routes = localRoutes(strategy, local.pins), receipt = receipts.find(row => row.taskId === task.id);
      const trialCalls = [], started = performance.now();
      const invoke = async (id, role, body, signal) => {
        if (id !== trialId || !routes[role] || trialCalls.length >= settings.maxTurns || state.calls.length >= state.maxCalls) {
          throw new Error('local_call_limit');
        }
        const model = routes[role], pin = local.pins.find(row => row.model === model);
        const call = { trialId, model, ordinal: trialCalls.length, dispatched: false, status: 'pending', inputTokens: null, outputTokens: null };
        trialCalls.push(call); state.calls.push(call); await checkpoint();
        const callStarted = performance.now();
        try {
          const generated = await localActionRequest({ endpoint, model, pin, body, signal, profile, maxOutputTokens: settings.outputTokens,
            seed: settings.seed + index, fetcher,
            onDispatch: async () => { call.dispatched = true; await checkpoint(); } });
          const { result, ...metadata } = generated; Object.assign(call, metadata, { status: 'complete', elapsedMs: Math.round(performance.now() - callStarted) });
          await checkpoint(); return result;
        } catch (error) {
          call.status = error.message === 'provider_context_limit' ? 'context_limit' : 'failed';
          const responseFailure = responseFailures.get(error);
          if (responseFailure) call.responseFailure = responseFailure;
          if (!call.dispatched) { call.inputTokens = 0; call.outputTokens = 0; }
          call.elapsedMs = Math.round(performance.now() - callStarted);
          await checkpoint(); throw error;
        }
      };
      let result, graded, outcome;
      try {
        result = await execute(task, receipt.image, strategy === 'handoff' ? 'handoff' : 'strong', trialId,
          { ...settings, requireReproducer: profile === 'checked', deadlineMs: Math.min(settings.deadlineMs, Math.max(1, Math.floor(campaignDeadline - performance.now()))) }, invoke, undefined,
          profile === 'legacy' ? { actionSchemaProfile } : undefined);
        graded = await grade(task, receipt.image, result.files, repo);
        if (graded.valid !== true || typeof graded.passed !== 'boolean') throw new Error('invalid_local_grade');
        outcome = result.outcome;
      } catch (error) {
        if (!['provider_context_limit', 'provider_truncated', 'provider_local_deadline'].includes(error.message)) throw error;
        outcome = { provider_context_limit: 'context_limit', provider_truncated: 'truncated', provider_local_deadline: 'deadline' }[error.message];
      }
      const passed = graded?.passed === true && graded.tests === receipt.oracleTests && graded.skipped === receipt.oracleSkipped
        && (profile !== 'checked' || (result?.reproducerQualified === true && result.probePassed === true && result.publicPassed === true));
      state.records.push({ caseId: task.id, strategy, score: passed ? 1 : 0, outcome,
        calls: trialCalls.filter(row => row.dispatched).length, attempts: trialCalls.length,
        inputTokens: trialCalls.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
        outputTokens: trialCalls.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
        usageIncomplete: trialCalls.some(row => row.inputTokens === null),
        patchDigest: result?.patchDigest ?? null, actions: result?.actions ?? [], invalidActions: result?.invalidActions ?? 0,
        handoffUsed: result?.handoffUsed ?? false,
        ...(profile === 'checked' ? { reproducerQualified: result?.reproducerQualified ?? false, probePassed: result?.probePassed ?? false,
          graderPassed: graded?.passed ?? false } : {}),
        graderDigest: graded?.digest ?? null,
        graderTests: graded?.tests ?? null, graderSkipped: graded?.skipped ?? null, elapsedMs: Math.round(performance.now() - started) });
      await checkpoint(); console.log(JSON.stringify({ caseId: task.id, strategy, score: passed ? 1 : 0,
        calls: trialCalls.filter(row => row.dispatched).length, attempts: trialCalls.length }));
    }
    await local.verifyPins();
    state.summary = strategies.map(strategy => {
      const rows = state.records.filter(row => row.strategy === strategy);
      return { strategy, solved: rows.reduce((sum, row) => sum + row.score, 0), cases: rows.length,
        calls: rows.reduce((sum, row) => sum + row.calls, 0),
        inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0) };
    });
    state.complete = true; await checkpoint(); return state;
  } catch (error) {
    state.failure = error.message === 'provider_safety_notice' ? 'provider_safety_notice' : 'local_repository_incomplete';
    state.failureCode = ['local_transport_failed', 'invalid_local_response', 'local_call_limit', 'invalid_local_grade', 'campaign_deadline', 'model_changed']
      .includes(error.message) ? error.message : 'other';
    await checkpoint();
    if (state.failure === 'provider_safety_notice') console.error("Provider safety notice: This content can't be shown. No retry or fallback.");
    throw new Error(state.failure);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [qualificationPath, out, general, coder, profile = 'legacy', taskManifest] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    const sourceSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.toString().trim();
    if (process.env.GITHUB_SHA !== sourceSha || (await command('git', ['status', '--porcelain'])).stdout.length) throw new Error('clean_exact_source_required');
    await runLocalRepository({ repo: process.cwd(), qualificationPath, out, sourceSha, models: [general, coder],
      endpoint: process.env.FUSION_OLLAMA_URL, profile, taskManifest,
      actionSchemaProfile: process.env.FUSION_LOCAL_ACTION_SCHEMA_PROFILE,
      outputTokens: process.env.FUSION_LOCAL_OUTPUT_TOKENS === undefined ? undefined : Number(process.env.FUSION_LOCAL_OUTPUT_TOKENS) });
  }).catch(() => { console.error('Local repository campaign incomplete; inspect its content-free checkpoint.'); process.exitCode = 1; });
}
