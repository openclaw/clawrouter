// Run directly, so --cpu-prof captures the handler rather than a test-runner child.
// HTTP_CPU_OUT=/absolute/proof/dir node --cpu-prof --cpu-prof-dir=/absolute/proof/dir test/diagnostics/http-responses-cpu.test.mjs
import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runHttpCpuCase } from '../helpers/http-cpu.mjs';

const encoder = new TextEncoder();
const model = 'gpt-5.6';
const repetitions = Number(process.env.HTTP_CPU_RUNS ?? 30);
const warmups = Number(process.env.HTTP_CPU_WARMUPS ?? 30);
// Fewer deltas model short replies; 0 warmups exposes first-call compilation.
const deltas = Number(process.env.HTTP_CPU_DELTAS ?? 600);
const sizes = (process.env.HTTP_CPU_SIZES ?? '0.5,2,5').split(',').map(Number);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups >= 0);
assert.ok(Number.isSafeInteger(deltas) && deltas > 0);
assert.ok(sizes.every(size => size > 0 && size <= 5));
const out = process.env.HTTP_CPU_OUT && resolve(process.env.HTTP_CPU_OUT);

function codexBody(size, native) {
  const input = [], text = 'Synthetic repository context: café 🦊. Inspect code, preserve behavior.\n'.repeat(45);
  const group = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'c3ludGhldGlj'.repeat(150) },
    { type: 'function_call', call_id: 'call_fixture', name: 'exec_command', arguments: JSON.stringify({ cmd: 'read synthetic source' }) },
    { type: 'function_call_output', call_id: 'call_fixture', output: text },
  ];
  const body = { model: native ? model : `openai/${model}`, stream: true, max_output_tokens: 4096,
    instructions: 'Use only synthetic fixtures.', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }], input };
  const target = Math.round(size * 1024 * 1024), groupBytes = encoder.encode(JSON.stringify(group)).length;
  for (let n = 0; n < Math.floor((target - 1024) / groupBytes); n++) input.push(...group);
  const remaining = target - encoder.encode(JSON.stringify(body)).length - 60;
  if (remaining > 0) input.push({ role: 'user', content: 'x'.repeat(remaining) });
  return JSON.stringify(body);
}

function upstreamChunks() {
  const frame = value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
  const delta = 'Synthetic output with Unicode 🦊 and escaped syntax "\\\n'.repeat(10);
  const output = [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: delta.repeat(deltas), annotations: [] }] }];
  let wire = frame({ type: 'response.created', response: { id: 'resp_cpu_fixture', object: 'response', status: 'in_progress', output: [] } });
  wire += frame({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } });
  for (let n = 0; n < deltas; n++) wire += frame({ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, sequence_number: n, delta });
  wire += frame({ type: 'response.output_item.done', output_index: 0, item: output[0] });
  wire += frame({ type: 'response.completed', response: { id: 'resp_cpu_fixture', object: 'response', status: 'completed', output,
    usage: { input_tokens: 123456, output_tokens: 4096, total_tokens: 127552, input_tokens_details: { cached_tokens: 100000 } } } });
  const bytes = encoder.encode(wire), chunks = [];
  // Deliberately cross UTF-8, JSON escape and CRLF boundaries.
  for (let n = 0; n < bytes.length; n += 4093) chunks.push(bytes.subarray(n, n + 4093));
  return { chunks, bytes: bytes.length };
}

test('diagnostic: warm HTTP Responses CPU (synthetic only)', async t => {
  if (out) await mkdir(out, { recursive: true });
  const upstream = upstreamChunks(), results = [];
  for (const native of [false, true]) for (const size of sizes) for (const retention of [false, true]) {
    if (retention && size !== sizes.at(-1)) continue;
    const label = `${native ? 'native' : 'unified'}-${size}MiB-retention-${retention ? 'on' : 'off'}`;
    const result = await runHttpCpuCase(t, {
      provider: 'openai', credentialBinding: 'OPENAI_API_KEY', createBody: () => codexBody(size, native),
      path: `${native ? '/v1/native/openai' : ''}/v1/responses`,
      upstream, repetitions, warmups, retention, label, out,
      assertUsage(event) {
        assert.equal(event?.input_tokens, 123456);
        assert.equal(event?.output_tokens, 4096);
      },
    });
    results.push(result); console.log(JSON.stringify({ ...result, samples: undefined }));
  }
  if (out) await writeFile(resolve(out, 'results.json'), JSON.stringify({ node: process.version, warmups, results }, null, 2));
});
