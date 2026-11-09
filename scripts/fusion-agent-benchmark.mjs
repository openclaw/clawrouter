import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTasks, hash, sandbox, readSource, readTaskContext, writeFiles, validateEdits, check, probe, verify } from './fusion-workloads.mjs';
import { nativePins, nativeRequest, nativeResult, responseDisposition, requireCompleteResponse, nativeErrorMetadata } from './fusion-native-provider.mjs';
import { priceBound, models } from './fusion-benchmark-accounting.mjs';
import { runCandidateEnsemble, compareCandidates, candidateSummaries } from './fusion-candidate-ensemble.mjs';

const strategies = ['cheap', 'strong', 'panel', 'cascade', 'claude', 'planned', 'critique', 'handoff', 'candidate-ensemble'];
const actionSchema = { type: 'object', additionalProperties: false, required: ['action', 'paths', 'edits', 'query', 'memory'], properties: {
  memory: { type: 'string' },
  action: { type: 'string', enum: ['read', 'search', 'edit', 'test', 'probe', 'candidate', 'compare', 'finish'] }, paths: { type: 'array', items: { type: 'string' } }, query: { type: 'string' },
  edits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'search', 'replace'],
    properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } } } },
} };
export const defaultExperiment = Object.freeze({ strategies: ['cheap', 'strong', 'panel', 'cascade'], trials: 1,
  maxTurns: 10, outputTokens: 2048, deadlineMs: 180000, trialBudgetMicros: 200000,
  campaignBudgetMicros: 5000000, priorCostMicros: 190914 });

export function validateExperiment(config, taskCount) {
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(Object.keys(defaultExperiment).sort())) throw new Error('invalid_experiment_fields');
  if (!Array.isArray(config.strategies) || !config.strategies.length || new Set(config.strategies).size !== config.strategies.length
    || config.strategies.some(strategy => !strategies.includes(strategy))) throw new Error('invalid_strategies');
  for (const [field, min, max] of [['trials', 1, 5], ['maxTurns', 1, 60], ['outputTokens', 256, 16384], ['deadlineMs', 1000, 900000],
    ['trialBudgetMicros', 1, 5000000], ['campaignBudgetMicros', 1, 100000000], ['priorCostMicros', 0, 100000000]]) {
    if (!Number.isSafeInteger(config[field]) || config[field] < min || config[field] > max) throw new Error(`invalid_${field}`);
  }
  if (config.strategies.includes('handoff') && config.maxTurns < 2) throw new Error('handoff_requires_two_turns');
  if (config.strategies.includes('candidate-ensemble') && config.maxTurns < 3) throw new Error('ensemble_requires_three_turns');
  const bound = taskCount * config.trials * config.strategies.length * config.trialBudgetMicros + config.priorCostMicros;
  if (!Number.isSafeInteger(bound) || bound > config.campaignBudgetMicros) throw new Error('campaign_budget_exceeded');
  return bound;
}

export class SpendLedger {
  constructor(config, persist) { this.config = config; this.persist = persist; this.attempts = []; this.blocked = false; }
  total(trialId) {
    return this.attempts.filter(a => trialId === undefined || a.trialId === trialId)
      .reduce((sum, a) => sum + (a.costMicros ?? a.reservationMicros), 0);
  }
  async reserve(trialId, model, reservationMicros) {
    if (this.blocked) throw new Error('unknown_cost');
    if (!Number.isSafeInteger(reservationMicros) || reservationMicros < 0) throw new Error('invalid_reservation');
    if (this.total(trialId) + reservationMicros > this.config.trialBudgetMicros) throw new Error('trial_budget');
    if (this.total() + reservationMicros + this.config.priorCostMicros > this.config.campaignBudgetMicros) throw new Error('campaign_budget');
    const attempt = { trialId, model, reservationMicros, costMicros: null, httpStatus: null };
    this.attempts.push(attempt); await this.persist(); return attempt;
  }
  async settle(attempt, costMicros, httpStatus) {
    attempt.httpStatus = httpStatus;
    if (!this.attempts.includes(attempt) || attempt.costMicros !== null || !Number.isSafeInteger(costMicros) || costMicros < 0) {
      this.blocked = true; await this.persist(); throw new Error('unknown_cost');
    }
    attempt.costMicros = costMicros;
    if (costMicros > attempt.reservationMicros) this.blocked = true;
    await this.persist(); if (this.blocked) throw new Error('unknown_cost');
  }
}

export function replaceEdits(task, files, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 8) throw new Error('invalid_edits');
  const current = new Map(files.map(file => [file.path, file.content]));
  for (const edit of edits) {
    if (!task.editPaths.includes(edit?.path) || typeof edit.search !== 'string' || !edit.search.length
      || typeof edit.replace !== 'string' || !current.has(edit.path)) throw new Error('invalid_edit');
    const original = current.get(edit.path), index = original.indexOf(edit.search);
    if (index < 0 || original.indexOf(edit.search, index + 1) !== -1) throw new Error('search_must_match_once');
    current.set(edit.path, original.slice(0, index) + edit.replace + original.slice(index + edit.search.length));
  }
  return validateEdits(task, [...current].map(([path, content]) => ({ path, content })));
}

const toolErrorCodes = new Set(['unknown_cost', 'invalid_source_view', 'missing_source', 'invalid_line_range', 'source_view_too_large',
  'invalid_read_paths', 'invalid_edits', 'invalid_edit', 'search_must_match_once', 'invalid_edit_path_or_size',
  'missing_query', 'invalid_probe', 'invalid_action', 'command_timeout', 'command_output_limit',
  'command_failed', 'context_header_too_large', 'ensemble_deadline',
  'provider_refused', 'provider_context_limit', 'provider_truncated', 'provider_empty', 'provider_paused', 'provider_unknown_stop']);
export const toolErrorCode = error => toolErrorCodes.has(error?.message) ? error.message : 'execution_failed';
export const finishReason = value => ['stop', 'length', 'tool_calls', 'end_turn', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'content_filter', 'model_context_window_exceeded'].includes(value) ? value : 'other';

export const executorModel = (strategy, turn, forced = false) => ['claude', 'planned'].includes(strategy) ? models.critic
  : ['strong', 'critique', 'handoff'].includes(strategy) || (strategy === 'cascade' && (turn >= 2 || forced)) ? models.strong : models.cheap;

export const escalateSubmission = (strategy, escalated, passed) => strategy === 'cascade' && !escalated && !passed;

export function sourceView(files, selectors, query = '') {
  if (typeof query !== 'string' || query.length > 200 || !Array.isArray(selectors) || selectors.length > 3) throw new Error('invalid_source_view');
  const views = selectors.map(selector => {
    if (typeof selector !== 'string') throw new Error('invalid_source_view');
    const [path, range, extra] = selector.split(':');
    if (extra !== undefined) throw new Error('invalid_source_view');
    const file = files.find(file => file.path === path);
    if (!file) throw new Error('missing_source');
    const lines = file.content.split('\n');
    if (query) {
      const matches = lines.flatMap((line, index) => line.includes(query) ? [{ line: index + 1,
        content: lines.slice(Math.max(0, index - 3), index + 4).join('\n') }] : []).slice(0, 12);
      return { path, totalLines: lines.length, matches };
    }
    const values = range?.match(/^(\d+)-(\d+)$/);
    if (range && !values) throw new Error('invalid_line_range');
    const start = values ? Number(values[1]) : 1, requestedEnd = values ? Number(values[2]) : lines.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 1 || requestedEnd < start) throw new Error('invalid_line_range');
    const end = values ? Math.min(requestedEnd, start + 399) : requestedEnd;
    return { path, totalLines: lines.length, startLine: start, truncated: end < requestedEnd, content: lines.slice(start - 1, end).join('\n') };
  });
  if (Buffer.byteLength(JSON.stringify(views)) > 320000) throw new Error('source_view_too_large');
  return views;
}

export function agentContext(messages, memory = '') {
  const header = [...messages.slice(0, 2), ...(memory ? [{ role: 'user', content: `Your working notes from earlier actions:\n${memory}` }] : [])];
  let bytes = Buffer.byteLength(JSON.stringify(header));
  if (bytes > 384000) throw new Error('context_header_too_large');
  const recent = [];
  for (const message of messages.slice(2).slice(-10).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes + size > 384000) break;
    recent.unshift(message); bytes += size;
  }
  return [...header, ...recent];
}

export function advisoryBody(task, files, role, config) {
  if (!['plan', 'review'].includes(role)) throw new Error('invalid_advisory_role');
  const instruction = role === 'plan'
    ? 'Plan a concrete source repair for another coding agent. Identify exact locations, replacement anchors, edge cases and a small executable behavior probe. Be concise. Do not claim you ran tests.'
    : 'Review the candidate source against the task requirements. Identify concrete remaining bugs, missing edge cases and precise corrections. Existing visible tests passed before the bug was fixed; do not treat them as proof. Be concise. Do not claim you ran tests.';
  return { max_tokens: Math.min(config.outputTokens, 8192), messages: [
    { role: 'system', content: instruction },
    { role: 'user', content: `${task.instruction}\nSource files:\n${JSON.stringify(files)}` },
  ] };
}

function bodyFor(messages, config) {
  return { messages, max_tokens: config.outputTokens, response_format: { type: 'json_schema',
    json_schema: { name: 'repository_action', strict: true, schema: actionSchema } } };
}

export function actionFeedback(code, action, task) {
  if (['read', 'search'].includes(action) && ['invalid_read_paths', 'invalid_source_view', 'command_failed'].includes(code)) {
    return `Tool error: ${code}. Use at most three existing file paths, not directories, globs or shell commands. Known task files: ${JSON.stringify([...task.editPaths, ...task.visibleTests])}. For search, leave paths empty to search editable files; query is literal text of at most 200 characters. Read supports file.ts:100-200 ranges. Other files may be read under worker/, shared/, scripts/, test/, providers/ or docs/, plus package.json, pnpm-lock.yaml and pnpm-workspace.yaml.`;
  }
  if (['invalid_edits', 'invalid_edit', 'search_must_match_once'].includes(code)) {
    return `Tool error: ${code}. Supply 1–8 edits to the declared editable source files. Each edit needs path, nonempty search matching exactly once in current source, and replace. Read current source before correcting stale or ambiguous search text.`;
  }
  return `Tool error: ${code}. Check allowed paths, line ranges and exact unique search text.`;
}

export async function runAgent(task, image, strategy, trialId, config, invoke, engine, options = {}) {
  const box = await sandbox(image), started = performance.now();
  const actions = [];
  let memory = '';
  const deadline = AbortSignal.any([AbortSignal.timeout(config.deadlineMs), ...(options.signal ? [options.signal] : [])]);
  const messages = [{ role: 'system', content: 'Repair the repository task. Return one JSON action. read requests up to three repository paths, optionally file.ts:100-200 line ranges. Without a range it returns the complete file; explicit ranges are capped at 400 lines. search uses a literal query and paths to find source locations. edit applies exact unique search/replace strings to allowed source files; test runs fixed visible tests; probe runs a Node ES module supplied in query for at most 15 seconds inside the isolated repository; finish submits. Supply empty paths/edits/query when unused. Include memory in every action: concise working notes with discovered source locations, verified facts and the current repair plan, at most 6,000 characters. Preserve useful notes across actions. The visible tests already pass on the broken code: passing them does not prove this task is fixed. Read their test helpers to learn how to load project modules. Write a probe of the reported invariant and check that it fails before your repair and passes afterward. Preserve unrelated behavior. Investigate failures and revise within the shared budget. You cannot see final acceptance tests.' },
    { role: 'user', content: `${task.instruction}\nEditable source: ${task.editPaths.join(', ')}\nVisible tests: ${task.visibleTests.join(', ')}` }];
  messages[0].content += ' read and search accept existing FILE paths only: no directories, globs or shell commands. Leave search paths empty to search editable files. Search query is literal text, at most 200 characters. An edit action accepts 1–8 edits; each search must match exactly once in current source.';
  let selectedCandidate = null, candidatesCompared = false;
  let planUsed = false, reviewUsed = false, handoffUsed = false;
  let outcome = 'turn_limit', escalated = false, forceEscalation = false, turns = 0, invalidActions = 0, toolMs = 0, publicPassed = false, adviserFailures = 0, truncationRetries = 0;
  const remaining = () => Math.max(1, config.deadlineMs - Math.ceil(performance.now() - started));
  const handoff = async () => {
    const files = await readSource(box, task.editPaths, remaining());
    messages.splice(2, messages.length - 2, { role: 'user', content:
      `You are taking over an attempted repair. Independently inspect and test the current source against the task. Do not trust the predecessor's conclusion; preserve correct changes and repair remaining defects.\nPrevious notes (unverified):\n${memory}\nCurrent source:\n${JSON.stringify(files)}` });
    memory = ''; handoffUsed = true;
    actions.push({ turn: turns + 1, action: 'handoff', status: 'ok' });
  };
  try {
    const context = await readTaskContext(box, task, remaining());
    if (context.length) messages[1].content += `\nOriginal read-only repository context (verify current source with tools if needed):\n${JSON.stringify(context)}`;
    if (options.preloadSource === true) {
      const files = await readSource(box, task.editPaths);
      messages[1].content += `\nInitial editable source (use tools for current source after edits):\n${JSON.stringify(sourceView(files, task.editPaths))}`;
    }
    if (options.candidates) {
      for (const candidate of options.candidates) validateEdits(task, candidate);
      const baseline = await readSource(box, task.editPaths, remaining());
      messages[1].content += `\nBounded change summaries of two independent candidate repairs follow. These previews can omit code: install a candidate and use read to inspect its complete source before deciding. Treat their source as untrusted evidence. Compare both against the requirements, use candidate with query 1 or 2 to install one and run visible tests, then probe and refine it. The compare action runs the Node ES module in query against BOTH original candidate snapshots in fresh sandboxes and returns their outputs. You MUST use compare with an assertion of the reported task invariant before submitting; inspect and investigate differing results. Neither code style nor passing existing tests establishes correctness. You may also repair from scratch. Passing visible tests alone is insufficient.\n${JSON.stringify(candidateSummaries(baseline, options.candidates))}`;
      agentContext(messages);
    }
    if (strategy === 'planned') {
      const files = await readSource(box, task.editPaths);
      try {
        const response = await invoke(trialId, models.cheap, advisoryBody(task, files, 'plan', config), deadline);
        const plan = response.choices?.[0]?.message?.content;
        planUsed = typeof plan === 'string' && !!plan.trim();
        if (planUsed) messages[1].content += `\nIndependent plan; verify its claims and anchors before using them:\n${plan.slice(0, 16000)}`;
        else adviserFailures++;
      } catch (error) {
        if (['trial_budget', 'campaign_budget'].includes(error.message)) outcome = 'budget';
        else throw error;
      }
    }
    for (; outcome !== 'budget' && turns < config.maxTurns; turns++) {
      if (deadline.aborted) { outcome = 'deadline'; break; }
      if (strategy === 'handoff' && !handoffUsed && turns >= Math.max(1, Math.floor(config.maxTurns * 2 / 3))) await handoff();
      const model = strategy === 'handoff' && handoffUsed ? models.critic : executorModel(strategy, turns, forceEscalation);
      if (strategy === 'cascade' && model === models.strong) escalated = true;
      // Bound retained context consistently for every strategy; keep the task and latest tool feedback.
      const context = agentContext(messages, memory);
      let response;
      try {
        let request = bodyFor(context, config);
        if (strategy === 'panel') {
          const fusion = engine.normalizeFusionConfig({ enabled: true, strategy: 'ensemble', aggregatorModel: model,
            adviserModels: [models.strong, models.critic], maxOutputTokens: config.outputTokens, maxInputChars: 40000,
            maxProposalChars: 3000, adviserTimeoutMs: 90000 });
          const proposals = await engine.collectFusionProposals(fusion, request, async (worker, request) =>
            Response.json(await invoke(trialId, worker, request, deadline)));
          adviserFailures += proposals.failedModels.length;
          request = engine.buildAggregatorBody(request, fusion, proposals.proposals);
        }
        response = await invoke(trialId, model, request, deadline);
        requireCompleteResponse(response);
      } catch (error) {
        if (error.message === 'provider_truncated' && truncationRetries === 0
          && turns + 1 < config.maxTurns && !deadline.aborted) {
          truncationRetries++;
          actions.push({ turn: turns + 1, action: 'truncated_output', status: 'rejected' });
          messages.push({ role: 'user', content: 'Your previous response exceeded the output limit and was discarded without applying edits. Return one concise JSON action. Use a smaller edit or a focused read. Do not repeat partial output.' });
          continue;
        }
        if (error.message === 'unknown_cost' || error.message.startsWith('provider_')) throw error;
        if (['trial_budget', 'campaign_budget'].includes(error.message)) { outcome = 'budget'; break; }
        throw error;
      }
      const content = response.choices?.[0]?.message?.content;
      let action;
      try { action = JSON.parse(content); } catch { actions.push({ turn: turns + 1, action: 'invalid_json', status: 'rejected' }); invalidActions++; messages.push({ role: 'user', content: 'Invalid JSON action. Return a valid action object.' }); continue; }
      if (typeof content !== 'string' || content.length > 40000) { invalidActions++; continue; }
      if (typeof action?.memory === 'string' && action.memory.length <= 6000) memory = action.memory;
      messages.push({ role: 'assistant', content });
      const event = { turn: turns + 1, action: ['read', 'search', 'edit', 'test', 'probe', 'candidate', 'compare', 'finish'].includes(action?.action) ? action.action : 'invalid', status: 'ok' };
      actions.push(event);
      const toolStarted = performance.now();
      try {
        if (action.action === 'read' || action.action === 'search') {
          const paths = action.paths?.length ? action.paths : task.editPaths;
          const files = await readSource(box, paths.map(path => path.split(':')[0]), remaining());
          if (action.action === 'search' && !action.query) throw new Error('missing_query');
          messages.push({ role: 'user', content: JSON.stringify(sourceView(files, paths, action.action === 'search' ? action.query : '')) });
        } else if (action.action === 'compare') {
          if (!options.candidates) throw new Error('invalid_action');
          const results = await compareCandidates(task, image, options.candidates, action.query, remaining());
          candidatesCompared = true;
          event.passed = results.map(result => result.passed);
          messages.push({ role: 'user', content: `Same probe on both candidate snapshots:\n${JSON.stringify(results)}` });
        } else if (action.action === 'candidate') {
          if (!options.candidates || !['1', '2'].includes(action.query)) throw new Error('invalid_action');
          await writeFiles(box, validateEdits(task, options.candidates[Number(action.query) - 1]), remaining());
          selectedCandidate = Number(action.query);
          const result = await check(box, task.visibleTests, remaining()); publicPassed = result.passed;
          messages.push({ role: 'user', content: `Candidate ${selectedCandidate} installed. Visible tests passed: ${publicPassed}\n${result.feedback}` });
        } else if (action.action === 'probe') {
          const result = await probe(box, action.query, remaining());
          messages.push({ role: 'user', content: `Behavior probe passed: ${result.passed}\n${result.feedback}` });
        } else if (action.action === 'edit') {
          const files = await readSource(box, task.editPaths, remaining());
          await writeFiles(box, replaceEdits(task, files, action.edits), remaining());
          const result = await check(box, task.visibleTests, remaining()); publicPassed = result.passed;
          messages.push({ role: 'user', content: `Visible tests passed: ${publicPassed}\n${result.feedback}` });
        } else if (action.action === 'test' || action.action === 'finish') {
          const result = await check(box, task.visibleTests, remaining()); publicPassed = result.passed;
          messages.push({ role: 'user', content: `Visible tests passed: ${publicPassed}\n${result.feedback}` });
          if (action.action === 'finish') {
            if (options.candidates && !candidatesCompared) {
              messages.push({ role: 'user', content: 'Before submitting, use compare to run the same task-invariant assertion against both candidate snapshots. Investigate the outputs and repair any remaining failures.' });
            } else if (strategy === 'handoff' && !handoffUsed) {
              await handoff();
            } else if (strategy === 'critique' && !reviewUsed) {
              reviewUsed = true;
              const files = await readSource(box, task.editPaths, remaining());
              const response = await invoke(trialId, models.critic, advisoryBody(task, files, 'review', config), deadline);
              const review = response.choices?.[0]?.message?.content;
              if (typeof review === 'string' && review.trim()) messages.push({ role: 'user',
                content: `Independent code review; verify these findings and repair any real defects before submitting again:\n${review.slice(0, 16000)}` });
              else { adviserFailures++; messages.push({ role: 'user', content: 'Independent review was empty. Verify the task invariants before submitting again.' }); }
            } else if (escalateSubmission(strategy, escalated, publicPassed)) forceEscalation = true;
            else { outcome = 'submitted'; turns++; break; }
          }
        } else throw new Error('invalid_action');
      } catch (error) {
        if (error.message === 'unknown_cost' || error.message.startsWith('provider_')) throw error;
        if (['trial_budget', 'campaign_budget'].includes(error.message)) { outcome = 'budget'; break; }
        event.status = toolErrorCode(error);
        if (deadline.aborted) { outcome = 'deadline'; break; }
        invalidActions++; messages.push({ role: 'user', content: actionFeedback(event.status, action.action, task) }); }
      finally { toolMs += performance.now() - toolStarted; }
      // This is a development cascade using observable tests, not an oracle gate.
      if (strategy === 'cascade' && !escalated && publicPassed && turns === 1) { outcome = 'public_test_accept'; turns++; break; }
    }
    const files = await readSource(box, task.editPaths);
    return { files, actions, selectedCandidate, candidatesCompared, planUsed, reviewUsed, handoffUsed, patchDigest: hash(JSON.stringify(files)), outcome, escalated, turns, invalidActions, adviserFailures,
      publicPassed, truncationRetries, toolMs: Math.round(toolMs), agentMs: Math.round(performance.now() - started) };
  } finally { await box.close(); }
}

export async function runExperiment({ qualificationPath, out, repo, config = defaultExperiment, env = process.env, taskManifest }) {
  const tasks = await loadTasks(taskManifest ?? resolve(repo, 'benchmarks/fusion/workloads.json'));
  const budgetBound = validateExperiment(config, tasks.length);
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('exact_source_required');
  const qualification = JSON.parse(await readFile(qualificationPath, 'utf8'));
  for (const task of tasks) {
    const receipts = qualification.receipts?.filter(receipt => receipt.taskId === task.id);
    if (receipts?.length !== 1 || receipts[0].qualified !== true || receipts[0].oracleVisible?.valid !== true
      || receipts[0].oracleVisible?.passed !== true || receipts[0].taskDigest !== hash(JSON.stringify(task))) throw new Error('unqualified_task');
  }
  await mkdir(out, { recursive: false, mode: 0o700 });
  const engine = await import('../worker/fusion.ts');
  const pins = await nativePins(env);
  const records = [], details = [];
  let complete = false, tail = Promise.resolve();
  const snapshot = () => {
    tail = tail.then(async () => {
      for (const [name, data] of [['runs', { version: 1, evaluationId: `workload-${env.GITHUB_SHA.slice(0, 12)}`,
        datasetRevision: hash(JSON.stringify(tasks)), graderRevision: hash(JSON.stringify(qualification)), split: 'development', records }],
      ['provenance', { sourceSha: env.GITHUB_SHA, datasetSplit: 'development', complete, config, budgetBound,
        pins, costSource: 'published-tariff-estimate-from-native-usage', spentOrReservedMicros: ledger.total() + config.priorCostMicros,
        attempts: ledger.attempts, details }]]) {
        await writeFile(resolve(out, `${name}.json.tmp`), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        await rename(resolve(out, `${name}.json.tmp`), resolve(out, `${name}.json`));
      }
    });
    return tail;
  };
  const ledger = new SpendLedger(config, snapshot);
  const stoppedTrials = new Map();
  const invoke = async (trialId, model, body, signal) => {
    if (stoppedTrials.has(trialId)) throw new Error(stoppedTrials.get(trialId));
    const request = nativeRequest(model, body, env);
    const attempt = await ledger.reserve(trialId, model, priceBound(request.body, pins[model].price));
    let result;
    try {
      const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
      attempt.httpStatus = response.status;
      if (!response.ok) {
        Object.assign(attempt, nativeErrorMetadata(await response.json().catch(() => null)));
        if (attempt.errorHint === 'safety_notice') console.log("Provider safety notice: This content can't be shown. The campaign stopped without retry or fallback.");
        throw new Error('unknown_cost');
      }
      result = nativeResult(model, await response.json());
      attempt.responseDisposition = responseDisposition(result.result);
      attempt.finishReason = finishReason(result.result.choices?.[0]?.finish_reason);
      const content = result.result.choices?.[0]?.message?.content;
      attempt.emptyOutput = typeof content !== 'string' || !content.trim();
      await ledger.settle(attempt, result.costMicros, response.status);
    } catch { ledger.blocked = true; await snapshot(); throw new Error('unknown_cost'); }
    try { requireCompleteResponse(result.result); }
    catch (error) { if (error.message !== 'provider_truncated') stoppedTrials.set(trialId, error.message); throw error; }
    return result.result;
  };
  await snapshot();
  try {
    for (const [index, task] of tasks.entries()) for (let trial = 1; trial <= config.trials; trial++) {
      const receipt = qualification.receipts.find(receipt => receipt.taskId === task.id);
      for (let offset = 0; offset < config.strategies.length; offset++) {
        const strategy = config.strategies[(index + trial - 1 + offset) % config.strategies.length];
        const trialId = `${task.id}:${trial}:${strategy}`, started = performance.now();
        let result, graded;
        try {
          result = strategy === 'candidate-ensemble'
            ? await runCandidateEnsemble(task, receipt.image, trialId, config, invoke, engine, runAgent)
            : await runAgent(task, receipt.image, strategy, trialId, config, invoke, engine);
          graded = await verify(task, receipt.image, result.files, repo);
        } catch (error) {
          details.push({ trialId, outcome: 'interrupted', errorClass: ledger.blocked ? 'unknown_cost' : 'execution_failure',
            failureCode: toolErrorCode(error),
            costIncludesReservation: ledger.attempts.some(attempt => attempt.trialId === trialId && attempt.costMicros === null) });
          records.push({ caseId: task.id, domain: 'repository-regression-development', trial, strategy,
            configurationId: hash(JSON.stringify({ strategy, config })), score: 0, costMicros: ledger.total(trialId),
            latencyMs: Math.round(performance.now() - started),
            callCount: ledger.attempts.filter(attempt => attempt.trialId === trialId).length, status: 'error' });
          await snapshot();
          if (error.message === 'provider_refused') console.log(JSON.stringify({ trialId, notice: 'Provider refused the request; this trial stopped without retry or fallback.' }));
          if (ledger.blocked || error.message === 'provider_refused') throw error;
          continue;
        }
        // Exact non-skipped test counts must match the qualified known repair.
        const passed = graded.passed && graded.tests === receipt.oracle.tests && graded.skipped === receipt.oracle.skipped;
        const { files, ...detail } = result;
        details.push({ trialId, ...detail, verifier: graded, falsePublicAcceptance: result.publicPassed && !passed });
        records.push({ caseId: task.id, domain: 'repository-regression-development', trial, strategy,
          configurationId: hash(JSON.stringify({ strategy, config })), score: passed ? 1 : 0,
          costMicros: ledger.total(trialId), latencyMs: Math.round(performance.now() - started),
          callCount: ledger.attempts.filter(attempt => attempt.trialId === trialId).length, status: 'completed' });
        await snapshot(); console.log(JSON.stringify({ completed: records.length, total: tasks.length * config.trials * config.strategies.length,
          spentOrReservedMicros: ledger.total() + config.priorCostMicros }));
      }
    }
    complete = true; await snapshot();
  } catch { await snapshot(); throw new Error('workload_experiment_incomplete'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [qualificationPath, out, taskManifest] = process.argv.slice(2);
  if (!qualificationPath || !out) throw new Error('qualification receipt and fresh output directory required');
  runExperiment({ qualificationPath, out, taskManifest, repo: process.cwd() }).catch(() => {
    console.error('Workload experiment incomplete; inspect content-free checkpoint.'); process.exitCode = 1;
  });
}
