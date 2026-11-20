import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectorCases, selectorPrompt } from '../benchmarks/fusion/selector-smoke.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const decisionSchema = { type: 'object', additionalProperties: false,
  required: ['choice', 'confidence'], properties: {
    choice: { type: 'integer', minimum: 0, maximum: 3 }, confidence: { type: 'integer', minimum: 0, maximum: 100 },
  } };

export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('local_endpoint_required');
  return url.origin;
}

export function parseDecision(content) {
  try {
    const value = JSON.parse(content);
    if (!value || JSON.stringify(Object.keys(value).sort()) !== '["choice","confidence"]'
      || !Number.isInteger(value.choice) || value.choice < 0 || value.choice > 3
      || !Number.isInteger(value.confidence) || value.confidence < 0 || value.confidence > 100) return null;
    return value;
  } catch { return null; }
}

const valid = row => row?.status === 'valid';
export function summarizeSelectors(cases, records, models) {
  const caseIds = new Set(cases.map(task => task.id));
  if (caseIds.size !== cases.length) throw new Error('duplicate_smoke_case');
  const byKey = new Map();
  for (const row of records) {
    if (!caseIds.has(row.caseId) || !models.includes(row.model) || !['valid', 'invalid'].includes(row.status)
      || !Number.isInteger(row.sample) || row.sample < 0 || row.sample > (row.model === models[0] ? 2 : 0)
      || ![row.inputTokens, row.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000)
      || (row.status === 'valid' && !parseDecision(JSON.stringify({ choice: row.choice, confidence: row.confidence })))) {
      throw new Error('invalid_smoke_record');
    }
    const key = `${row.caseId}:${row.model}:${row.sample}`;
    if (byKey.has(key)) throw new Error('duplicate_smoke_record');
    byKey.set(key, row);
  }
  const result = [];
  const policies = models.length === 1 ? ['first-single', 'first-vote-3']
    : ['first-single', 'second-single', 'first-vote-3', 'confidence-cascade-80'];
  for (const policy of policies) {
    let correct = 0, invalid = 0, falseAcceptance = 0, calls = 0, tokens = 0, escalations = 0;
    const families = {};
    for (const task of cases) {
      const tiny = byKey.get(`${task.id}:${models[0]}:0`), small = byKey.get(`${task.id}:${models[1]}:0`);
      let selected, used;
      if (policy === 'first-single') { selected = tiny; used = [tiny]; }
      else if (policy === 'second-single') { selected = small; used = [small]; }
      else if (policy === 'confidence-cascade-80') {
        const escalate = !valid(tiny) || tiny.choice === 0 || tiny.confidence < 80;
        selected = escalate ? small : tiny; used = escalate ? [tiny, small] : [tiny]; escalations += Number(escalate);
      } else {
        used = [0, 1, 2].map(sample => byKey.get(`${task.id}:${models[0]}:${sample}`));
        const votes = [0, 0, 0, 0];
        for (const row of used) if (valid(row)) votes[row.choice]++;
        const winner = votes.findIndex(count => count >= 2);
        selected = used.every(valid) ? { status: 'valid', choice: winner < 0 ? 0 : winner } : null;
      }
      if (used.some(row => !row)) throw new Error('incomplete_smoke_records');
      calls += used.length;
      tokens += used.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
      const passed = valid(selected) && selected.choice === task.correctChoice;
      correct += Number(passed); invalid += Number(!valid(selected));
      falseAcceptance += Number(valid(selected) && selected.choice > 0 && selected.choice !== task.correctChoice);
      families[task.family] ??= { correct: 0, cases: 0 };
      families[task.family].correct += Number(passed); families[task.family].cases++;
    }
    result.push({ policy, correct, cases: cases.length, invalid, falseAcceptance, escalations,
      replayCalls: calls, replayTokens: tokens, families });
  }
  return result;
}

export async function runSelectorSmoke({ out, models, sourceSha = process.env.GITHUB_SHA,
  endpoint = 'http://127.0.0.1:11435', fetcher = fetch }) {
  const base = localEndpoint(endpoint);
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact_source_required');
  if (!Array.isArray(models) || models.length < 1 || models.length > 2 || new Set(models).size !== models.length
    || models.some(model => !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(model) || model.endsWith(':cloud'))) throw new Error('one_or_two_local_models_required');
  const request = async (path, body) => {
    const response = await fetcher(base + path, { method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('local_transport_failed');
    return response.json();
  };
  const tags = await request('/api/tags');
  const pins = models.map(model => {
    const entries = tags.models?.filter(entry => entry.name === model);
    const entry = entries?.[0];
    if (entries?.length !== 1 || entry.remote_model || entry.remote_host || !/^[a-f0-9]{64}$/.test(entry.digest)
      || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('unqualified_local_model');
    return { model, digest: entry.digest, bytes: entry.size };
  });
  for (const pin of pins) {
    const info = await request('/api/show', { model: pin.model });
    if (info.remote_model || info.remote_host) throw new Error('local_model_required');
    pin.thinking = Array.isArray(info.capabilities) && info.capabilities.includes('thinking');
  }
  const cases = selectorCases(), records = [];
  const state = { version: 1, sourceSha, kind: 'local-selector-smoke', complete: false, apiSpendMicros: 0,
    modelPins: pins, datasetDigest: hash(JSON.stringify(cases)), cases: cases.length, families: 12,
    settings: { firstSamples: 3, secondSamples: models.length === 2 ? 1 : 0, outputTokens: 96, contextTokens: 4096,
      temperatures: [0, 0.7, 0.7], seedBase: 1729, cascadeConfidence: 80 }, records,
    limitations: ['Hand-authored selector smoke; not a coding-agent or frontier efficacy benchmark.',
      'Policy metrics replay already-generated responses; they are not online latency measurements.',
      'Case variants share twelve families; forty-eight cases are not forty-eight independent problems.',
      'Zero API spend excludes local hardware, electricity and download costs.'] };
  await mkdir(out, { recursive: false, mode: 0o700 });
  const checkpoint = async () => {
    await writeFile(resolve(out, 'selector-smoke.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(resolve(out, 'selector-smoke.json.tmp'), resolve(out, 'selector-smoke.json'));
  };
  await checkpoint();
  try {
    const deadline = performance.now() + 15 * 60 * 1000;
    // Block by model to avoid repeatedly evicting and loading weights.
    for (const [modelIndex, model] of models.entries()) for (const [index, task] of cases.entries()) {
      for (let sample = 0; sample < (modelIndex === 0 ? 3 : 1); sample++) {
        if (performance.now() >= deadline) throw new Error('smoke_deadline');
        const prompt = selectorPrompt(task), started = performance.now();
        const response = await request('/api/chat', { model, stream: false, format: decisionSchema,
          ...(pins[modelIndex].thinking ? { think: false } : {}),
          keep_alive: '5m', messages: [{ role: 'user', content: prompt }],
          options: { num_predict: 96, num_ctx: 4096, temperature: state.settings.temperatures[sample], seed: 1729 + index * 3 + sample } });
        const content = response.message?.content;
        if (typeof content !== 'string' || response.model !== model) throw new Error('invalid_local_response');
        if (/this content can[’']t be shown|safety refusal/i.test(content)) throw new Error('provider_safety_notice');
        const decision = response.done === true && response.done_reason === 'stop' ? parseDecision(content) : null;
        for (const field of ['prompt_eval_count', 'eval_count']) if (!Number.isSafeInteger(response[field]) || response[field] < 0) throw new Error('invalid_local_usage');
        records.push({ caseId: task.id, family: task.family, model, sample,
          promptDigest: hash(prompt), responseDigest: hash(content), status: decision ? 'valid' : 'invalid',
          choice: decision?.choice ?? null, confidence: decision?.confidence ?? null,
          inputTokens: response.prompt_eval_count, outputTokens: response.eval_count,
          latencyMs: Math.round(performance.now() - started) });
        await checkpoint();
      }
      console.log(JSON.stringify({ modelIndex, completedCases: index + 1, totalCases: cases.length, calls: records.length }));
    }
    const finalTags = await request('/api/tags');
    if (pins.some(pin => finalTags.models?.find(entry => entry.name === pin.model)?.digest !== pin.digest)) throw new Error('model_changed');
    state.policies = summarizeSelectors(cases, records, models);
    state.modelDiagnostics = models.map(model => {
      const baseline = records.filter(row => row.model === model && row.sample === 0);
      const correct = row => row.choice === cases.find(task => task.id === row.caseId).correctChoice;
      return { model, invalid: baseline.filter(row => !valid(row)).length,
        highConfidenceWrong: baseline.filter(row => valid(row) && row.confidence >= 80 && !correct(row)).length,
        correctByPosition: [0, 1, 2, 3].map(position => {
          const group = baseline.filter(row => cases.find(task => task.id === row.caseId).correctChoice === position);
          return { position, correct: group.filter(row => valid(row) && correct(row)).length, cases: group.length };
        }) };
    });
    state.complete = true; await checkpoint(); return state;
  } catch (error) {
    state.failure = error.message === 'provider_safety_notice' ? 'provider_safety_notice' : 'local_smoke_incomplete';
    await checkpoint();
    if (state.failure === 'provider_safety_notice') console.error("Provider safety notice: This content can't be shown. No retry or fallback.");
    throw new Error(state.failure);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [out, ...models] = process.argv.slice(2);
  if (!out) throw new Error('fresh output directory and one or two local model names required');
  runSelectorSmoke({ out, models, endpoint: process.env.FUSION_OLLAMA_URL ?? 'http://127.0.0.1:11435' })
    .catch(() => { console.error('Local selector smoke incomplete; inspect its content-free checkpoint.'); process.exitCode = 1; });
}
