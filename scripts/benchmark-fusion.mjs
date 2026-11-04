#!/usr/bin/env node
// Opt-in live composition benchmark. Never retain prompts, answers, or credentials.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const datasetCommit = '9ee07bd481feebf959a6b59d61ea57bdcf30964d';
export const domains = ['logical_deduction_seven_objects', 'multistep_arithmetic_two', 'tracking_shuffled_objects_seven_objects'];
export const models = { cheap: 'openai/gpt-6-luna', strong: 'openai/gpt-6.1-sol', critic: 'anthropic/claude-sonnet-5.5' };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const limit = 4096;
const instructions = 'Solve the task. Return only a JSON object with one string field "answer" containing the answer: a letter for multiple choice, or a number for arithmetic. No explanation in the final answer.';

export function gradeAnswer(content, target) {
  try {
    const answer = JSON.parse(content).answer;
    const normalize = value => String(value).trim().replace(/^\(([A-Z])\)$/, '$1');
    return typeof answer === 'string' && normalize(answer) === normalize(target) ? 1 : 0;
  } catch { return 0; }
}

export function selectCases(examples, domain, count = 10) {
  if (!Array.isArray(examples) || examples.length < count) throw new Error('dataset incomplete');
  return examples.map((item, index) => ({ ...item, caseId: `${domain}:${index}`, domain, rank: digest(`fusion-pilot-v1:${domain}:${index}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, count);
}

export function priceBound(body, price) {
  // UTF-8 bytes bound text tokens conservatively; no tools, images or web search.
  const inputBytes = Buffer.byteLength(JSON.stringify(body)) + 1024;
  return Math.ceil((inputBytes * price.input + limit * price.output + price.request) * 1e6);
}

export function parsePrice(row) {
  let input = Number(row?.pricing?.prompt), output = Number(row?.pricing?.completion);
  const request = Number(row?.pricing?.request ?? 0);
  if (![input, output, request].every(n => Number.isFinite(n) && n >= 0)) throw new Error('model pricing unavailable');
  if (row.pricing.overrides?.length) {
    for (const p of row.pricing.overrides) {
      const pi = Number(p.prompt ?? input), po = Number(p.completion ?? output);
      if (![pi, po].every(n => Number.isFinite(n) && n >= 0)) throw new Error('invalid tiered price');
      input = Math.max(input, pi); output = Math.max(output, po);
    }
  }
  return { input, output, request };
}

export async function runCase(item, configuration, engine, invoke) {
  const config = engine.normalizeFusionConfig({ enabled: true, strategy: configuration.strategy,
    aggregatorModel: configuration.model, adviserModels: [models.strong, models.critic],
    adviserTimeoutMs: 120000, maxOutputTokens: limit, maxProposalChars: 6000 });
  const original = { model: configuration.model, stream: false, max_tokens: limit,
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: item.input }],
    response_format: { type: 'json_object' } };
  const started = performance.now();
  const calls = [];
  const call = async (model, body, timeout, _index, signal) => {
    const result = await invoke(model, body, timeout, signal);
    calls.push(result);
    return result.response;
  };
  const proposals = await engine.collectFusionProposals(config, original, call);
  const final = await call(configuration.model, engine.buildAggregatorBody(original, config, proposals.proposals), 120000);
  const body = await final.json();
  const content = body.choices?.[0]?.message?.content;
  if (calls.some(c => c.costMicros === null)) throw new Error('unknown billed cost; comparison blocked');
  return { caseId: item.caseId, domain: item.domain, trial: 1, strategy: configuration.name,
    configurationId: digest(configuration), score: final.ok ? gradeAnswer(content, item.target) : 0,
    costMicros: calls.reduce((sum, c) => sum + c.costMicros, 0), latencyMs: Math.round(performance.now() - started),
    callCount: calls.length, status: final.ok && typeof content === 'string' ? 'completed' : 'error',
    failedAdvisers: proposals.failedModels.length, served: calls.map(c => c.served),
  };
}

export async function main(out) {
  if (!out || !process.env.OPENROUTER_API_KEY) throw new Error('output and OPENROUTER_API_KEY required');
  const sourceSha = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('exact source SHA required');
  await mkdir(out, { recursive: false, mode: 0o700 });
  const engine = await import('../worker/fusion.ts');
  const configurations = [
    { name: 'single', strategy: 'single', model: models.cheap, effort: 'medium', maxOutputTokens: limit },
    { name: 'strong-single', strategy: 'single', model: models.strong, effort: 'medium', maxOutputTokens: limit },
    { name: 'panel', strategy: 'ensemble', model: models.cheap, advisers: [models.strong, models.critic], effort: 'medium', maxOutputTokens: limit },
  ];
  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30000) });
  if (!catalogResponse.ok) throw new Error('model catalog unavailable');
  const catalog = (await catalogResponse.json()).data;
  const pins = Object.fromEntries(Object.values(models).map(id => {
    const row = catalog.find(r => r.id === id);
    if (!row || !row.reasoning?.supported_efforts?.includes('medium')) throw new Error('configured model unavailable');
    return [id, { id, canonicalSlug: row.canonical_slug, price: parsePrice(row) }];
  }));
  const cases = [], datasetHashes = {};
  for (const domain of domains) {
    const response = await fetch(`https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/${datasetCommit}/bbh/${domain}.json`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('dataset unavailable');
    const text = await response.text();
    datasetHashes[domain] = digest(text);
    cases.push(...selectCases(JSON.parse(text).examples, domain));
  }
  const planned = cases.reduce((sum, item) => {
    const inputBytes = Buffer.byteLength(item.input) + 2048;
    return sum + [models.cheap, models.strong, models.strong, models.critic, models.cheap]
      .reduce((n, model, index) => n + priceBound({ padding: ' '.repeat(inputBytes + (index === 4 ? 48000 : 0)) }, pins[model].price), 0);
  }, 0);
  const budgetMicros = 5000000;
  if (planned > budgetMicros) throw new Error('whole-run conservative cost bound exceeds $5');
  let reservedMicros = 0, actualMicros = 0, blocked = false;
  const attempts = [], records = [], observations = [];
  const invoke = async (model, body, _timeout, callerSignal) => {
    if (blocked) throw new Error('benchmark stopped');
    const request = { ...body, model, reasoning: { effort: 'medium' },
      provider: { allow_fallbacks: false, require_parameters: true } };
    const reservation = priceBound(request, pins[model].price);
    if (reservedMicros + reservation > budgetMicros) { blocked = true; throw new Error('spend guard'); }
    reservedMicros += reservation;
    const attempt = { model, reservationMicros: reservation, costMicros: null };
    attempts.push(attempt);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      });
      const result = await response.json();
      const cost = result.usage?.cost;
      attempt.httpStatus = response.status;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('unknown cost');
      attempt.costMicros = Math.ceil(cost * 1e6);
      actualMicros += attempt.costMicros;
      if (attempt.costMicros > reservation) { blocked = true; throw new Error('cost exceeded bound'); }
      return { response: Response.json(result, { status: response.status }), costMicros: attempt.costMicros,
        served: { model: result.model ?? null, provider: result.provider ?? null, finishReason: result.choices?.[0]?.finish_reason ?? null } };
    } catch {
      blocked = true;
      throw new Error('upstream measurement incomplete');
    }
  };
  const metadata = { sourceSha, datasetCommit, datasetHashes, pins, configurations,
    selection: 'sha256(fusion-pilot-v1:domain:index), first 10 per domain',
    graderRevision: 'json-string-exact-v1', budgetMicros, plannedUpperBoundMicros: planned,
    scope: 'fusion composition; excludes gateway auth, routing, production concurrency and tool use',
    limitations: ['public tasks may be present in model training', 'one trial per case', 'provider aliases cannot attest hidden serving revisions'],
  };
  let failure = false;
  try {
    for (const [index, item] of cases.entries()) {
      // Rotate ordering so a strategy is not always measured first.
      for (let offset = 0; offset < configurations.length; offset++) {
        const configuration = configurations[(index + offset) % configurations.length];
        const result = await runCase(item, configuration, engine, invoke);
        const { served, failedAdvisers, ...record } = result;
        records.push(record); observations.push({ caseId: item.caseId, strategy: configuration.name, served, failedAdvisers });
        console.log(JSON.stringify({ completed: records.length, total: cases.length * configurations.length, actualMicros }));
      }
    }
  } catch { failure = true; }
  const write = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await write('provenance.json', { ...metadata, complete: !failure, actualMicros, reservedMicros, attempts, observations });
  await write('runs.json', { version: 1, evaluationId: `fusion-${sourceSha.slice(0, 12)}`, datasetRevision: digest({ datasetHashes, cases: cases.map(c => c.caseId) }),
    graderRevision: metadata.graderRevision, split: 'test', records });
  if (failure) throw new Error('incomplete benchmark; inspect content-free provenance');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(() => { console.error('Fusion benchmark incomplete. No prompt, response or credential is printed.'); process.exitCode = 1; });
}
