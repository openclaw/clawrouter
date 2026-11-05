import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRequest, nativeResult, nativePins, responseDisposition, requireCompleteResponse } from '../scripts/fusion-native-provider.mjs';

const body = { messages: [{ role: 'system', content: 'format instruction' }, { role: 'user', content: 'task' }], max_tokens: 4096, response_format: { type: 'json_object' } };
const env = { OPENAI_API_KEY: 'synthetic-openai', ANTHROPIC_API_KEY: 'synthetic-anthropic' };

test('native requests use explicit owned endpoints, medium reasoning and JSON answers', () => {
  const openai = nativeRequest('openai/gpt-6-luna', body, env);
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.body.max_completion_tokens, 4096);
  assert.equal(openai.body.reasoning_effort, 'medium');
  assert.equal(openai.body.service_tier, 'default');
  assert.equal(openai.body.store, false);
  assert.equal(openai.body.max_tokens, undefined);
  const claude = nativeRequest('anthropic/claude-sonnet-5.5', body, env);
  assert.equal(claude.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(claude.body.model, 'claude-sonnet-5-5');
  assert.equal(claude.body.service_tier, 'standard_only');
  assert.equal(claude.body.system, 'format instruction');
  assert.deepEqual(claude.body.messages, [body.messages[1]]);
  assert.deepEqual(claude.body.thinking, { type: 'adaptive' });
  assert.equal(claude.body.output_config.effort, 'medium');
  assert.equal(claude.body.output_config.format.schema.properties.answer.type, 'string');
  assert.equal(claude.body.temperature, undefined);
});

test('OpenAI tariff includes cached reads, cache writes and reasoning in completion tokens', () => {
  const r = { model: 'gpt-6.1-sol', service_tier: 'default', usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 400 } } };
  assert.equal(nativeResult('openai/gpt-6.1-sol', r).costMicros, 6670);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, service_tier: 'priority' }), /tier_unqualified/);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, model: 'different-model' }), /identity_missing/);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, usage: { ...r.usage, prompt_tokens: 1 } }), /usage_invalid/);
});

test('Anthropic tariff counts separate cache buckets and preserves only answer text', () => {
  const r = { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '{"answer":"B"}' }],
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } } };
  const out = nativeResult('anthropic/claude-sonnet-5.5', r);
  assert.equal(out.costMicros, 2570);
  assert.equal(out.result.choices[0].message.content, '{"answer":"B"}');
  assert.equal(JSON.stringify(out).includes('private reasoning'), false);
  assert.throws(() => nativeResult('anthropic/claude-sonnet-5.5', { ...r, usage: { ...r.usage, speed: 'fast' } }), /tier_unqualified/);
  assert.throws(() => nativeResult('anthropic/claude-sonnet-5.5', { ...r, usage: { ...r.usage, server_tool_use: { web_search_requests: 1 } } }), /usage_unqualified/);
});

test('native preflight checks all identities without inference or mixed credentials', async () => {
  const calls = [];
  const pins = await nativePins(env, async (url, options) => {
    calls.push({ url, headers: options.headers });
    return Response.json({ id: url.split('/').at(-1) });
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.url.includes('/v1/models/')));
  assert.equal(calls[0].headers['x-api-key'], undefined);
  assert.equal(calls[2].headers.authorization, undefined);
  assert.equal(pins['openai/gpt-6-luna'].costSource, 'published-tariff-estimate');
  assert.equal(pins['anthropic/claude-sonnet-5.5'].price.input, 4 / 1e6);
  await assert.rejects(nativePins(env, async () => new Response(null, { status: 401 })), /preflight_http_401/);
});

test('terminal provider states cannot masquerade as malformed action JSON', () => {
  for (const [reason, disposition] of [['refusal', 'refused'], ['content_filter', 'refused'],
    ['model_context_window_exceeded', 'context_limit'], ['length', 'truncated'], ['max_tokens', 'truncated'],
    ['pause_turn', 'paused'], ['tool_use', 'paused'], ['new_unhandled_reason', 'unknown_stop']]) {
    const response = { choices: [{ finish_reason: reason, message: { content: '{}' } }] };
    assert.equal(responseDisposition(response), disposition);
    assert.throws(() => requireCompleteResponse(response), new RegExp(`provider_${disposition}`));
  }
  assert.equal(responseDisposition({ choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'declined' } }] }), 'refused');
  assert.equal(responseDisposition({ choices: [{ finish_reason: 'end_turn', message: { content: '  ' } }] }), 'empty');
  const complete = { choices: [{ finish_reason: 'end_turn', message: { content: '{}' } }] };
  assert.equal(requireCompleteResponse(complete), complete);
});
