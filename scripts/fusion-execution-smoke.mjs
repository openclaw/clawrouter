import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { command, hash, sandbox, writeFiles } from './fusion-workloads.mjs';
import { localEndpoint } from './fusion-selector-smoke.mjs';
import { executionTasks, executionPrompt, executionCorpusDigestInput } from '../benchmarks/fusion/execution-smoke.mjs';

export function parseModule(content) {
  try {
    const value = JSON.parse(content);
    return value && Object.keys(value).length === 1 && typeof value.code === 'string'
      && value.code.trim() && Buffer.byteLength(value.code) <= 16384 ? value.code : null;
  } catch { return null; }
}

// Only the isolated process sees generated source. Expected values stay in this
// parent process; candidate stdout never decides whether its own tests passed.
export async function gradeCandidate(image, code, examples, makeSandbox = sandbox) {
  const box = await makeSandbox(image);
  try {
    await writeFiles(box, [{ path: 'candidate.mjs', content: code }]);
    const script = `import fn from './candidate.mjs';
const inputs=${JSON.stringify(examples.map(row => row.args))};
const values=inputs.map(args=>{const value=fn(...args);if(value===undefined||value?.then)throw Error('invalid result');return {value,args};});
process.stdout.write(JSON.stringify(values));`;
    let result;
    try {
      result = await box.exec(['timeout', '--signal=KILL', '4s', 'node', '--input-type=module'],
        { input: script, allowFailure: true, timeout: 6000, maxBytes: 262144 });
    } catch (error) {
      if (error.message === 'command_output_limit') return { passed: false, outcome: 'output_limit' };
      throw error;
    }
    if ([125, 126, 127].includes(result.code)) throw new Error('sandbox_execution_unavailable');
    if (result.code !== 0) return { passed: false, outcome: result.code === 137 ? 'timeout' : 'execution_error' };
    let values;
    try { values = JSON.parse(result.stdout.toString()); } catch { return { passed: false, outcome: 'invalid_output' }; }
    const passed = isDeepStrictEqual(values, examples.map(row => ({ value: row.expected, args: row.args })));
    return { passed, outcome: passed ? 'pass' : 'wrong_answer' };
  } finally { await box.close(); }
}

export async function buildExecutionImage(nodeImage, run = command) {
  if (!/^node@sha256:[a-f0-9]{64}$/.test(nodeImage)) throw new Error('pinned_node_image_required');
  const directory = await mkdtemp(join(tmpdir(), 'fusion-execution-'));
  try {
    await writeFile(join(directory, 'Dockerfile'), `FROM ${nodeImage}\nRUN mkdir /seed && touch /seed/candidate.mjs && chmod 666 /seed/candidate.mjs\n`);
    // The final stdout line is the local immutable image identity, never a tag.
    const built = await run('docker', ['build', '--pull=false', '--quiet', directory], { timeout: 120000 });
    const image = built.stdout.toString().trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('invalid_image_identity');
    return image;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function qualifyExecution(image, tasks = executionTasks(), grade = gradeCandidate) {
  const results = [];
  for (const task of tasks) {
    const reference = `export default ${task.reference.toString()};`, mutant = `export default ${task.mutant};`;
    const referencePublic = await grade(image, reference, task.visible), referenceHidden = await grade(image, reference, task.hidden);
    const mutantPublic = await grade(image, mutant, task.visible), mutantHidden = await grade(image, mutant, task.hidden);
    const qualified = referencePublic.passed && referenceHidden.passed && mutantPublic.passed && !mutantHidden.passed;
    results.push({ caseId: task.id, qualified, referencePublic, referenceHidden, mutantPublic, mutantHidden });
    if (!qualified) throw new Error(`unqualified_execution_fixture:${task.id}`);
  }
  return results;
}

export function summarizeExecution(tasks, records, models) {
  const byKey = new Map();
  for (const row of records) {
    if (!tasks.some(task => task.id === row.caseId) || !models.includes(row.model)
      || !Number.isInteger(row.sample) || row.sample < 0 || row.sample > (row.model === models[0] ? 0 : 1)
      || !['valid', 'invalid'].includes(row.status) || typeof row.publicPassed !== 'boolean' || typeof row.hiddenPassed !== 'boolean'
      || ![row.inputTokens, row.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)
      || (row.status === 'invalid' && (row.publicPassed || row.hiddenPassed))) throw new Error('invalid_execution_record');
    const key = `${row.caseId}:${row.model}:${row.sample}`;
    if (byKey.has(key)) throw new Error('duplicate_execution_record');
    byKey.set(key, row);
  }
  return ['small-single', 'small-two-verified', 'tiny-small-verified', 'tiny-single'].map(policy => {
    let solved = 0, abstained = 0, falseAcceptance = 0, calls = 0, tokens = 0, selectionChecks = 0;
    for (const task of tasks) {
      const tiny = byKey.get(`${task.id}:${models[0]}:0`), small = byKey.get(`${task.id}:${models[1]}:0`);
      const candidates = policy === 'tiny-single' ? [tiny] : policy === 'small-single' ? [small] : policy === 'small-two-verified'
        ? [small, byKey.get(`${task.id}:${models[1]}:1`)] : [tiny, small];
      if (candidates.some(row => !row)) throw new Error('incomplete_execution_records');
      const verified = policy !== 'small-single' && policy !== 'tiny-single';
      // Retry policies stop after the first public pass. Hidden outcomes cannot
      // influence selection or save calls in this replay.
      const chosenIndex = verified ? candidates.findIndex(row => row.status === 'valid' && row.publicPassed) : 0;
      const used = candidates.slice(0, chosenIndex < 0 ? candidates.length : chosenIndex + 1);
      calls += used.length; tokens += used.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
      selectionChecks += verified ? used.filter(row => row.status === 'valid').length : 0;
      const selected = chosenIndex < 0 ? null : candidates[chosenIndex];
      const passed = selected?.status === 'valid' && selected.publicPassed && selected.hiddenPassed;
      solved += Number(passed);
      abstained += Number(!selected || selected.status === 'invalid');
      falseAcceptance += Number(selected?.status === 'valid' && !passed);
    }
    return { policy, solved, cases: tasks.length, abstained, falseAcceptance, replayCalls: calls, replayTokens: tokens, selectionChecks };
  });
}

export async function localGenerator(models, endpoint = 'http://127.0.0.1:11435', fetcher = fetch) {
  const base = localEndpoint(endpoint);
  if (!Array.isArray(models) || models.length !== 2 || new Set(models).size !== 2
    || models.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(name) || name.endsWith(':cloud'))) throw new Error('two_local_models_required');
  const request = async (path, body) => {
    const response = await fetcher(base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('local_transport_failed');
    return response.json();
  };
  const tags = await request('/api/tags');
  const pins = [];
  for (const model of models) {
    const matches = tags.models?.filter(row => row.name === model), row = matches?.[0];
    if (matches?.length !== 1 || row.remote_model || row.remote_host || !/^[a-f0-9]{64}$/.test(row.digest)
      || !Number.isSafeInteger(row.size) || row.size <= 0) throw new Error('unqualified_local_model');
    const info = await request('/api/show', { model });
    if (info.remote_model || info.remote_host) throw new Error('local_model_required');
    pins.push({ model, digest: row.digest, bytes: row.size, thinking: info.capabilities?.includes('thinking') === true });
  }
  return { pins, async verifyPins() {
    const current = await request('/api/tags');
    if (pins.some(pin => current.models?.find(row => row.name === pin.model)?.digest !== pin.digest)) throw new Error('model_changed');
  }, async generate(model, prompt, seed) {
    const pin = pins.find(row => row.model === model);
    const response = await request('/api/chat', { model, stream: false, keep_alive: '5m',
      ...(pin.thinking ? { think: false } : {}),
      format: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string' } } },
      messages: [{ role: 'user', content: prompt }], options: { num_predict: 512, num_ctx: 4096, temperature: 0.7, seed } });
    if (response.model !== model || typeof response.message?.content !== 'string'
      || ![response.prompt_eval_count, response.eval_count].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_local_response');
    const content = response.message.content;
    if (/this content can[’']t be shown|safety refusal/i.test(content)) throw new Error('provider_safety_notice');
    return { content, code: response.done === true && response.done_reason === 'stop' ? parseModule(content) : null,
      inputTokens: response.prompt_eval_count, outputTokens: response.eval_count };
  } };
}

export async function runExecutionSmoke({ out, image, generator, sourceSha, tasks = executionTasks(), grade = gradeCandidate }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('exact_source_and_image_required');
  const models = generator.pins.map(pin => pin.model);
  if (models.length !== 2 || new Set(models).size !== 2) throw new Error('two_local_models_required');
  const qualification = await qualifyExecution(image, tasks, grade);
  await mkdir(out, { mode: 0o700 });
  const state = { version: 1, kind: 'local-execution-smoke', sourceSha, image, modelPins: generator.pins,
    corpusDigest: hash(JSON.stringify(executionCorpusDigestInput(tasks))), qualification, complete: false, apiSpendMicros: 0,
    settings: { samples: [1, 2], temperatures: [0.7], outputTokens: 512, contextTokens: 4096, seedBase: 42000 }, records: [],
    limitations: ['Eight small fresh development families, not a repository-repair or frontier benchmark.',
      'Selection sees public checks only. Hidden tests grade frozen candidates without feedback.',
      'Policies replay recorded candidates and stop on the first public pass; token totals exclude grading compute.',
      'Zero API spend excludes local hardware, power, container and download costs.'] };
  const checkpoint = async () => {
    await writeFile(resolve(out, 'execution-smoke.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(resolve(out, 'execution-smoke.json.tmp'), resolve(out, 'execution-smoke.json'));
  };
  await checkpoint();
  try {
    const deadline = performance.now() + 15 * 60 * 1000;
    for (const [modelIndex, model] of models.entries()) for (const [index, task] of tasks.entries()) {
      for (let sample = 0; sample < (modelIndex === 0 ? 1 : 2); sample++) {
        if (performance.now() >= deadline) throw new Error('execution_deadline');
        const prompt = executionPrompt(task), started = performance.now();
        const generated = await generator.generate(model, prompt, 42000 + index * 3 + sample);
        const publicResult = generated.code ? await grade(image, generated.code, task.visible) : { passed: false, outcome: 'invalid_module' };
        const hiddenResult = generated.code ? await grade(image, generated.code, task.hidden) : { passed: false, outcome: 'invalid_module' };
        state.records.push({ caseId: task.id, model, sample, status: generated.code ? 'valid' : 'invalid',
          promptDigest: hash(prompt), responseDigest: hash(generated.content), publicPassed: publicResult.passed,
          hiddenPassed: hiddenResult.passed, publicOutcome: publicResult.outcome, hiddenOutcome: hiddenResult.outcome,
          inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, elapsedMs: Math.round(performance.now() - started) });
        await checkpoint();
      }
      console.log(JSON.stringify({ modelIndex, completedCases: index + 1, calls: state.records.length }));
    }
    await generator.verifyPins();
    state.policies = summarizeExecution(tasks, state.records, models); state.complete = true;
    await checkpoint(); return state;
  } catch (error) {
    state.failure = error.message === 'provider_safety_notice' ? 'provider_safety_notice' : 'execution_smoke_incomplete';
    await checkpoint();
    if (state.failure === 'provider_safety_notice') console.error("Provider safety notice: This content can't be shown. No retry or fallback.");
    throw new Error(state.failure);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [out, nodeImage, tiny, small] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (!out) throw new Error('fresh_output_directory_required');
    const generator = await localGenerator([tiny, small], process.env.FUSION_OLLAMA_URL);
    const image = await buildExecutionImage(nodeImage);
    await runExecutionSmoke({ out, image, generator, sourceSha: process.env.GITHUB_SHA });
  }).catch(() => { console.error('Local execution smoke incomplete; no automatic retry.'); process.exitCode = 1; });
}
