// Native Anthropic messages variant of http-responses-cpu (synthetic only).
// Run directly, so --cpu-prof captures the handler rather than a test-runner child.
// HTTP_CPU_OUT=/absolute/proof/dir node test/diagnostics/http-anthropic-cpu.test.mjs
import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHttpCpuCase } from '../helpers/http-cpu.mjs';

const encoder = new TextEncoder();
const model = 'claude-sonnet-5-5';
const repetitions = Number(process.env.HTTP_CPU_RUNS ?? 30);
const warmups = Number(process.env.HTTP_CPU_WARMUPS ?? 30);
const sizes = (process.env.HTTP_CPU_SIZES ?? '0.75,2').split(',').map(Number);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups > 0);
assert.ok(sizes.every(size => size > 0 && size <= 5));
const out = process.env.HTTP_CPU_OUT && resolve(process.env.HTTP_CPU_OUT);

function claudeBody(size) {
  const text = 'Synthetic repository context: café 🦊. Inspect code, preserve behavior.\n'.repeat(45);
  const messages = [];
  const tools = Array.from({ length: 12 }, (_, n) => ({ name: `tool_${n}`, description: text.slice(0, 600), input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } }));
  const body = { model, max_tokens: 4096, stream: true, system: [{ type: 'text', text: 'Use only synthetic fixtures.' }, { type: 'text', text, cache_control: { type: 'ephemeral' } }], tools, messages };
  const turn = n => [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: text.slice(0, 400), signature: 'c3ludGhldGlj'.repeat(40) }, { type: 'tool_use', id: `toolu_${n}`, name: 'tool_1', input: { path: 'src/fixture.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: text }] },
  ];
  const target = Math.round(size * 1024 * 1024);
  for (let n = 0; encoder.encode(JSON.stringify(body)).length < target; n++) messages.push(...turn(n));
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.', cache_control: { type: 'ephemeral' } }] });
  return JSON.stringify(body);
}

function upstreamChunks() {
  const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  let wire = frame({ type: 'message_start', message: { id: 'msg_cpu_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1234, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  wire += frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let n = 0; n < 2000; n++) wire += frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${n % 7} ` } });
  wire += frame({ type: 'content_block_stop', index: 0 });
  wire += frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2000 } });
  wire += frame({ type: 'message_stop' });
  const bytes = encoder.encode(wire), chunks = [];
  for (let n = 0; n < bytes.length; n += 1400) chunks.push(bytes.subarray(n, n + 1400));
  return { chunks, bytes: bytes.length };
}

test('diagnostic: warm native Anthropic messages CPU (synthetic only)', async t => {
  if (out) await mkdir(out, { recursive: true });
  const upstream = upstreamChunks(), results = [];
  for (const size of sizes) for (const retention of [false, true]) {
    if (retention && size !== sizes.at(-1)) continue;
    const label = `anthropic-${size}MiB-retention-${retention ? 'on' : 'off'}`;
    const result = await runHttpCpuCase(t, {
      provider: 'anthropic', credentialBinding: 'ANTHROPIC_API_KEY', createBody: () => claudeBody(size),
      path: '/v1/native/anthropic/v1/messages', headers: { 'anthropic-version': '2023-06-01' },
      upstream, repetitions, warmups, retention, label, out,
      assertUsage(event) {
        assert.ok(event?.input_tokens > 0, JSON.stringify(event));
        assert.equal(event?.output_tokens, 2000);
      },
    });
    results.push(result); console.log(JSON.stringify({ ...result, samples: undefined }));
  }
  if (out) await writeFile(resolve(out, 'results.json'), JSON.stringify({ node: process.version, warmups, results }, null, 2));
});
