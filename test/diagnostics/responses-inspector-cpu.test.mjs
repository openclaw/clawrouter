// Response-side usage/tool inspection on a delta-heavy stream (synthetic only).
// Real Codex streams are thousands of tiny deltas; per-event cost dominates there.
// INSPECTOR_CPU_RUNS=60 node test/diagnostics/responses-inspector-cpu.test.mjs
import '../../worker/test/typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponsesUsageInspector } from '../../worker/responses-usage.ts';

const runs = Number(process.env.INSPECTOR_CPU_RUNS ?? 60), deltas = 4000;
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

function stream() {
  const words = 'The quick brown fox jumps over the lazy dog, again and again.'.split(' ');
  let text = '', wire = frame({ type: 'response.created', sequence_number: 0, response: { id: 'resp_inspector', object: 'response', status: 'in_progress', output: [] } });
  for (let n = 0; n < deltas; n++) {
    const delta = `${words[n % words.length]} `; text += delta;
    wire += frame({ type: 'response.output_text.delta', sequence_number: n + 1, item_id: 'msg_inspector', output_index: 0, content_index: 0, delta, logprobs: [], obfuscation: 'synthetic' });
  }
  const item = { id: 'msg_inspector', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  wire += frame({ type: 'response.output_item.done', output_index: 0, item });
  wire += frame({ type: 'response.completed', response: { id: 'resp_inspector', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1000, output_tokens: deltas, total_tokens: 1000 + deltas } } });
  const bytes = new TextEncoder().encode(wire), chunks = [];
  for (let n = 0; n < bytes.length; n += 1400) chunks.push(bytes.subarray(n, n + 1400));
  return { bytes: bytes.length, chunks };
}

async function inspect(chunks) {
  const inspector = createResponsesUsageInspector(true, undefined, async () => {});
  for (const chunk of chunks) await inspector.push(chunk);
  await inspector.end();
  return inspector.result(true);
}

test('diagnostic: delta-heavy Responses inspection CPU (synthetic only)', async () => {
  const { bytes, chunks } = stream();
  for (let n = 0; n < 30; n++) await inspect(chunks);
  const result = await inspect(chunks);
  assert.equal(result.outcome, 'success');
  assert.equal(result.tokens.output, deltas);
  const start = process.cpuUsage();
  for (let n = 0; n < runs; n++) await inspect(chunks);
  const used = process.cpuUsage(start);
  console.log(JSON.stringify({ responseBytes: bytes, deltas, runs, cpuMs: (used.user + used.system) / 1000 / runs }));
});
