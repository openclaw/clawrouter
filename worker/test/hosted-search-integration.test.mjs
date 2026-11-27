import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { observeUsage } = await import('../proxy-response.ts');

for (const compact of [true, false]) test('hosted observation stays ' + (compact ? 'absent for compact' : 'enabled for ordinary Responses'), async () => {
  const value = { object: compact ? 'response.compaction' : 'response', id: compact ? 'cmp_fixture' : 'resp_fixture', status: 'completed',
    output: [{ type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search' } }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } };
  // A retained search-shaped item in a compact window is not new hosted work.
  const body = JSON.stringify(value), bytes = new TextEncoder().encode(body); let offset = 0;
  const upstream = new Response(new ReadableStream({ pull(controller) {
    if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; }
    else controller.close();
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  const observed = observeUsage(upstream, undefined, undefined, compact ? 'openai.responses_compact' : 'openai.responses');
  assert.equal(await observed.response.text(), body);
  const result = await observed.result;
  assert.equal(result.delivery, 'complete'); assert.equal(result.outcome, compact ? null : 'success');
  assert.equal(result.tokens.input, 100); assert.equal(result.tokens.output, 20); assert.equal(result.tokens.total, 120);
  assert.equal(result.tokens.cached, 40); assert.equal(result.tokens.cacheWrite, 10);
  if (compact) assert.equal(result.hostedSearch, undefined);
  else assert.deepEqual(result.hostedSearch, { webSearch: 1, complete: true });
});
