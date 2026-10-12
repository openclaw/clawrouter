#!/usr/bin/env node
import { open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const scenarios = ['catalog', 'pool', 'count', 'messages', 'stream'];
const limit = 2 * 1024 * 1024;
const safeCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;

// Nearest-rank percentiles; missing observations are never reported as zero.
export function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)];
}
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, ...Object.fromEntries([50, 90, 95, 99].map(p => [`p${p}`, sorted[Math.ceil(p / 100 * sorted.length) - 1] ?? null])), max: sorted.at(-1) ?? null };
}

// Incremental, bounded SSE parser, including CRLF split across network chunks.
export function sseParser(onEvent) {
  const decoder = new TextDecoder();
  let line = '', data = [], event = '', size = 0, overflow = false, afterCR = false;
  function endLine() {
    if (!line) {
      if (!overflow && data.length) {
        try { onEvent(event, JSON.parse(data.join('\n'))); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      data = []; event = ''; size = 0; overflow = false;
    } else if (!overflow) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    line = '';
  }
  function feed(text) {
    for (const char of text) {
      if (afterCR) { afterCR = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') { endLine(); afterCR = char === '\r'; }
      else if (++size <= limit && !overflow) line += char;
      else { overflow = true; line = ''; data = []; }
    }
  }
  return { push(bytes) { feed(decoder.decode(bytes, { stream: true })); }, end() { feed(decoder.decode()); } };
}

export function parseOptions(argv) {
  const strings = ['base-url', 'key-file', 'scenario', 'model', 'concurrency', 'requests', 'duration', 'rps', 'max-tokens', 'session-spread', 'prompt', 'timeout-ms', 'abort-fraction', 'json-out'];
  const { values } = parseArgs({ args: argv, options: { ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])), help: { type: 'boolean' } }, strict: true });
  if (values.help) return null;
  const number = (name, fallback, min, max, integer = true) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) throw new Error(`invalid --${name}`);
    return value;
  };
  if (!values['base-url'] || !values['key-file']) throw new Error('--base-url and --key-file are required');
  let url;
  try { url = new URL(values['base-url']); } catch { throw new Error('invalid --base-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--base-url must be an HTTP(S) URL without credentials, query or fragment');
  if (values.requests !== undefined && values.duration !== undefined) throw new Error('choose --requests or --duration');
  const scenario = values.scenario ?? 'mixed';
  if (![...scenarios, 'mixed'].includes(scenario)) throw new Error('invalid --scenario');
  return {
    baseUrl: url.href.replace(/\/$/, ''), keyFile: values['key-file'], scenario, model: values.model ?? 'anthropic/claude-sonnet-5',
    concurrency: number('concurrency', 10, 1, 10000), requests: values.duration === undefined ? number('requests', 100, 1, 10000000) : null,
    duration: values.duration === undefined ? null : number('duration', 0, 0.001, 86400, false), rps: values.rps === undefined ? null : number('rps', 0, 0.001, 1000000, false),
    maxTokens: number('max-tokens', 32, 1, 1000000), sessionSpread: number('session-spread', 20, 1, 1000000), prompt: values.prompt ?? 'Reply with hello.',
    timeoutMs: number('timeout-ms', 30000, 1, 3600000), abortFraction: number('abort-fraction', 0, 0, 1, false), jsonOut: values['json-out'],
  };
}

export async function readKey(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error('--key-file must be a regular mode-0600 file of at most 4096 bytes');
    const key = (await handle.readFile('utf8')).trim();
    if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('invalid key file contents');
    return key;
  } finally { await handle.close(); }
}

export function summarize(rows, seconds, dropped = 0) {
  const histogram = key => rows.reduce((out, row) => { const value = String(row[key] ?? 'none'); out[value] = (out[value] ?? 0) + 1; return out; }, {});
  const sessions = new Map();
  for (const row of rows) if (row.grantIdentity) {
    const ids = sessions.get(row.session) ?? new Set(); ids.add(row.grantIdentity); sessions.set(row.session, ids);
  }
  return {
    completed: rows.length, seconds, throughput: rows.length / seconds, dropped,
    errors: rows.filter(row => row.error && row.error !== 'intentional_abort').length,
    intentionalAborts: rows.filter(row => row.error === 'intentional_abort').length,
    totalMs: distribution(rows.map(row => row.totalMs)), ttfbMs: distribution(rows.map(row => row.ttfbMs).filter(value => value !== null)),
    firstByteMs: distribution(rows.map(row => row.firstByteMs).filter(value => value !== null)),
    statuses: histogram('status'), errorsByCode: histogram('error'), lanes: histogram('lane'), failovers: rows.filter(row => row.failover).length,
    stickiness: sessions.size ? { observedSessions: sessions.size, changedSessions: [...sessions.values()].filter(ids => ids.size > 1).length, note: 'Changes can be legitimate failover/quota routing; inspect request rows.' } : { note: 'No grant identity header exposed; consistency cannot be inferred from lane alone.' },
  };
}

async function requestOne(options, key, index) {
  const scenario = options.scenario === 'mixed' ? scenarios[index % scenarios.length] : options.scenario;
  const streaming = scenario === 'stream';
  const session = `loadtest-session-${index % options.sessionSpread}`;
  const path = { catalog: '/v1/models', pool: '/v1/pool', count: '/v1/messages/count_tokens', messages: '/v1/messages', stream: '/v1/messages' }[scenario];
  const start = performance.now(), controller = new AbortController();
  let intentional = false;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const row = { index, scenario, session, status: null, error: null, totalMs: 0, ttfbMs: null, firstByteMs: null, lane: null, failover: false, grantIdentity: null, grantHeaders: {}, requestId: null };
  try {
    const get = scenario === 'catalog' || scenario === 'pool';
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: get ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-clawrouter-session-id': session },
      body: get ? undefined : JSON.stringify({ model: options.model, messages: [{ role: 'user', content: options.prompt }], ...(scenario === 'count' ? {} : { max_tokens: options.maxTokens, stream: streaming }) }),
    });
    row.status = response.status;
    row.lane = response.headers.get('x-clawrouter-grant-lane');
    row.requestId = response.headers.get('x-request-id');
    for (const [name, value] of response.headers) if (/^x-clawrouter-(grant|failover)(-|$)/.test(name)) row.grantHeaders[name] = value;
    row.failover = response.headers.get('x-clawrouter-grant-failover') === '1';
    row.grantIdentity = ['x-clawrouter-grant-id', 'x-clawrouter-grant-key', 'x-clawrouter-grant-token-ref'].map(name => response.headers.get(name)).find(Boolean) ?? null;
    const eventStream = streaming && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
    if (streaming && response.ok && !eventStream) row.error = 'unexpected_content_type';
    let terminal = false;
    const parser = sseParser((event, body) => {
      if ((event === 'content_block_delta' || body?.type === 'content_block_delta') && row.ttfbMs === null) row.ttfbMs = performance.now() - start;
      if (event === 'message_stop' || body?.type === 'message_stop') terminal = true;
      if (event === 'error' || body?.type === 'error') row.error = safeCode(body?.error?.code ?? body?.error?.type) ?? 'sse_error';
    });
    const chunks = []; let bytes = 0, firstChunk = true;
    const reader = response.body?.getReader();
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (!value.byteLength) continue;
        row.firstByteMs ??= performance.now() - start;
        if (!streaming) row.ttfbMs ??= row.firstByteMs;
        if (eventStream) parser.push(value);
        else if ((bytes += value.byteLength) <= limit) chunks.push(value);
        if (firstChunk && streaming && response.ok && !row.error && Math.random() < options.abortFraction) {
          intentional = true; controller.abort(); await reader.cancel().catch(() => {}); row.error = 'intentional_abort'; break;
        }
        // Decide abort only on the first nonempty chunk.
        firstChunk = false;
      }
      if (eventStream) parser.end();
    } finally { reader.releaseLock(); }
    if (!response.ok) {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* bounded diagnostics only */ }
      row.error ??= safeCode(body?.error?.code ?? body?.error?.type) ?? `http_${response.status}`;
    } else if (eventStream && !intentional) {
      if (!terminal) row.error ??= 'incomplete_stream';
      else if (row.ttfbMs === null) row.error ??= 'missing_content_delta';
    }
  } catch (error) {
    row.error ??= intentional ? 'intentional_abort' : controller.signal.aborted ? 'timeout' : safeCode(error.cause?.code) ?? 'network_error';
  } finally { clearTimeout(timer); row.totalMs = performance.now() - start; }
  return row;
}

export async function runLoad(options) {
  const key = await readKey(options.keyFile);
  const started = performance.now(), rows = [], active = new Set();
  const deadline = options.duration === null ? Infinity : started + options.duration * 1000;
  let index = 0, dropped = 0;
  const launch = index => {
    const job = requestOne(options, key, index).then(row => rows.push(row)).finally(() => active.delete(job)); active.add(job);
  };
  while ((options.requests === null || index < options.requests) && performance.now() < deadline) {
    if (options.rps) {
      const due = started + index * 1000 / options.rps;
      if (due >= deadline) break;
      if (due > performance.now()) await sleep(due - performance.now());
      if (performance.now() >= deadline) break;
      if (active.size >= options.concurrency) dropped++; else launch(index);
      index++;
    } else {
      if (active.size >= options.concurrency) await Promise.race(active);
      if (performance.now() >= deadline) break;
      launch(index++);
    }
  }
  if (options.rps && options.duration !== null && performance.now() < deadline) await sleep(deadline - performance.now());
  await Promise.all(active);
  const summary = summarize(rows, (performance.now() - started) / 1000, dropped);
  const { keyFile: _key, prompt: _prompt, jsonOut: _out, ...configuration } = options;
  const report = { version: 1, configuration, summary, requests: rows.sort((a, b) => a.index - b.index) };
  if (options.jsonOut) await writeFile(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required');
    const options = parseOptions(process.argv.slice(2));
    if (!options) console.log('Usage: pnpm loadtest --base-url URL --key-file FILE [--scenario catalog|pool|count|messages|stream|mixed] [--model ID] [--concurrency 10] [--requests 100 | --duration SECONDS] [--rps RATE] [--max-tokens 32] [--session-spread 20] [--prompt TEXT] [--timeout-ms 30000] [--abort-fraction 0] [--json-out FILE]');
    else console.log(JSON.stringify((await runLoad(options)).summary, null, 2));
  } catch { console.error('Load test failed. Check flags, URL, mode-0600 key file and exclusive output path. No credential or server response is printed.'); process.exitCode = 1; }
}
