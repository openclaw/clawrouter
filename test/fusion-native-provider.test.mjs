import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRequest, nativeResult, nativePins, responseDisposition, requireCompleteResponse, nativeErrorMetadata, attachNativeRequestId, nativeResponseMetadata } from '../scripts/fusion-native-provider.mjs';

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
  const out = nativeResult('openai/gpt-6.1-sol', r);
  assert.equal(out.costMicros, 6670);
  assert.deepEqual(out.usageBreakdown, { uncachedInputTokens: 700, cacheReadInputTokens: 200,
    cacheWriteInputTokens: 100, cacheWrite1hInputTokens: 0, outputTokens: 500 });
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, service_tier: 'priority' }), /tier_unqualified/);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, model: 'different-model' }), /identity_missing/);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', { ...r, usage: { ...r.usage, prompt_tokens: 1 } }), /usage_invalid/);
});

test('Anthropic tariff counts separate cache buckets and preserves only answer text', () => {
  const r = { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '{"answer":"B"}' }],
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } } };
  const out = nativeResult('anthropic/claude-sonnet-5.5', r);
  assert.equal(out.costMicros, 2570);
  assert.deepEqual(out.usageBreakdown, { uncachedInputTokens: 100, cacheReadInputTokens: 300,
    cacheWriteInputTokens: 40, cacheWrite1hInputTokens: 60, outputTokens: 200 });
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

test('HTTP error diagnostics retain only finite labels, never echoed content', () => {
  const result = nativeErrorMetadata({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low. private prompt and key' } });
  assert.deepEqual(result, { errorType: 'invalid_request_error', errorHint: 'credit_balance', providerCode: 'unknown', providerParam: 'unknown' });
  assert.deepEqual(nativeErrorMetadata({ error: { type: 'private unknown type', message: 'private arbitrary content' } }),
    { errorType: 'unknown', errorHint: 'unknown', providerCode: 'unknown', providerParam: 'unknown' });
  assert.deepEqual(nativeErrorMetadata(null), { errorType: 'unknown', errorHint: 'unknown', providerCode: 'unknown', providerParam: 'unknown' });
  for (const [message, hint] of [
    ['output_config.format schema unsupported', 'structured_output'],
    ['thinking must be supported', 'thinking_parameters'],
    ['This content cannot be displayed: This content can’t be shown', 'safety_notice'],
    ['Workspace spend limit exceeded', 'spend_limit'],
    ['Assistant prefill unsupported', 'message_format'],
    ['max_tokens exceeds maximum', 'token_limit'],
    ['service_tier unsupported', 'service_tier'],
  ]) assert.equal(nativeErrorMetadata({ error: { message } }).errorHint, hint);
});

test('selected-model preflight requires only the selected providers', async () => {
  const pair = ['openai/gpt-6-luna', 'openai/gpt-6.1-sol'], calls = [];
  const pins = await nativePins({ OPENAI_API_KEY: 'synthetic-openai' }, async url => {
    calls.push(url); return Response.json({ id: url.split('/').at(-1) });
  }, pair);
  assert.deepEqual(Object.keys(pins), pair);
  assert.equal(calls.length, 2);
  await assert.rejects(nativePins({}, async () => {}, pair), /credentials_missing/);
  await assert.rejects(nativePins(env, async () => {}, ['unknown']), /model_unknown/);
});


test('structured error diagnostics admit known labels and discard arbitrary provider strings', () => {
  for (const param of ['messages', 'messages.4.content', 'messages[4].content']) {
    const result = nativeErrorMetadata({ error: { type: 'invalid_request_error', code: 'invalid_value', param } });
    assert.equal(result.providerCode, 'invalid_value');
    assert.equal(result.providerParam, 'messages');
  }
  for (const param of ['messages_private', 'private prompt sentinel', null, 42]) {
    const result = nativeErrorMetadata({ error: { code: 'private secret sentinel', param } });
    assert.equal(result.providerCode, 'unknown');
    assert.equal(result.providerParam, 'unknown');
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
  assert.equal(nativeErrorMetadata({ error: { code: 'context_length_exceeded', param: 'max_tokens' } }).providerCode, 'context_length_exceeded');
});


test('OpenAI correlation IDs are unique and leave bodies and other providers unchanged', () => {
  const first = nativeRequest('openai/gpt-6-luna', body, env);
  const before = JSON.stringify(first.body);
  const one = attachNativeRequestId('openai/gpt-6-luna', first);
  const second = nativeRequest('openai/gpt-6-luna', body, env);
  const two = attachNativeRequestId('openai/gpt-6-luna', second);
  assert.match(one.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(first.headers['X-Client-Request-Id'], one.clientRequestId);
  assert.notEqual(one.clientRequestId, two.clientRequestId);
  assert.equal(JSON.stringify(first.body), before);
  const anthropic = nativeRequest('anthropic/claude-sonnet-5.5', body, env);
  const unchanged = JSON.stringify(anthropic);
  assert.deepEqual(attachNativeRequestId('anthropic/claude-sonnet-5.5', anthropic), {});
  assert.equal(JSON.stringify(anthropic), unchanged);
});

test('response metadata accepts only bounded opaque OpenAI request IDs', () => {
  for (const id of ['req_abc-123', 'a'.repeat(128)]) {
    assert.deepEqual(nativeResponseMetadata('openai/gpt-6-luna', { headers: new Headers({ 'x-request-id': id }) }), { providerRequestId: id });
  }
  for (const id of ['', 'a'.repeat(129), 'private prompt sentinel', 'req_1,req_2', 'req_1\nsecret', 'req_1\n', 'req_1\r', null, 12]) {
    assert.deepEqual(nativeResponseMetadata('openai/gpt-6-luna', { headers: { get: () => id } }), {});
  }
  assert.deepEqual(nativeResponseMetadata('openai/gpt-6-luna', {}), {});
  assert.deepEqual(nativeResponseMetadata('anthropic/claude-sonnet-5.5', { headers: new Headers({ 'x-request-id': 'req_abc' }) }), {});
});

const responsesFixture = () => ({ tool_usage: { web_search: { num_requests: 0 }, image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 } } }, model: 'gpt-6.1-sol', service_tier: 'default', status: 'completed',
  output: [{ type: 'reasoning', summary: [{ text: 'private reasoning sentinel' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }],
  usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100, cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 0 } },
    output_tokens_details: { reasoning_tokens: 400 } } });

test('Responses maps the benchmark message and format contract without changing inputs', () => {
  const original = structuredClone(body);
  const request = nativeRequest('openai/gpt-6-luna', body, env, 'responses');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(request.body, { model: 'gpt-6-luna', input: body.messages, max_output_tokens: 4096,
    reasoning: { effort: 'medium' }, service_tier: 'default', store: false, text: { format: { type: 'json_object' } } });
  const schema = { name: 'answer', strict: true, schema: { type: 'object' } };
  assert.deepEqual(nativeRequest('openai/gpt-6-luna', { ...body, response_format: { type: 'json_schema', json_schema: schema } }, env, 'responses').body.text,
    { format: { type: 'json_schema', ...schema } });
  assert.deepEqual(body, original);
  assert.deepEqual(nativeRequest('anthropic/claude-sonnet-5.5', body, env, 'responses'), nativeRequest('anthropic/claude-sonnet-5.5', body, env));
  assert.throws(() => nativeRequest('openai/gpt-6-luna', body, env, 'invalid'), /invalid_openai_api/);
  assert.throws(() => nativeRequest('openai/gpt-6-luna', { ...body, response_format: { type: 'text' } }, env, 'responses'), /native_format_unsupported/);
});

test('Responses settles cache and reasoning usage without forwarding reasoning or mutating the response', () => {
  const raw = responsesFixture(), copy = structuredClone(raw);
  const normalized = nativeResult('openai/gpt-6.1-sol', raw, 'responses');
  assert.equal(normalized.costMicros, 6670);
  assert.equal(responseDisposition(normalized.result), 'complete');
  assert.equal(normalized.result.choices[0].message.content, '{"answer":"ok"}');
  assert.ok(!JSON.stringify(normalized).includes('sentinel'));
  assert.deepEqual(raw, copy);
});

for (const [name, mutate] of [
  ['missing usage', r => delete r.usage],
  ['wrong identity', r => r.model = 'different-model'],
  ['unpriced tier', r => r.service_tier = 'priority'],
  ['wrong total', r => r.usage.total_tokens++],
  ['excess reasoning', r => r.usage.output_tokens_details.reasoning_tokens = 501],
  ['negative input', r => r.usage.input_tokens = -1],
  ['overlapping cache', r => r.usage.input_tokens_details.cached_tokens = 1000],
  ['unpriced tools', r => r.tool_usage.web_search.num_requests = 1],
  ['unpriced image tokens', r => r.tool_usage.image_gen.input_tokens_details.image_tokens = 1],
  ['malformed tool usage', r => r.tool_usage.web_search.num_requests = '0'],
  ['null tool usage', r => r.tool_usage = null],
  ['array tool usage', r => r.tool_usage = [0]],
  ['unpriced audio', r => r.usage.output_tokens_details.audio_tokens = 1],
  ['unpriced long cache', r => r.usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens = 1],
  ['inconsistent cache', r => r.usage.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens = 99],
]) test(`Responses refuses unqualified accounting: ${name}`, () => {
  const raw = responsesFixture(); mutate(raw);
  assert.throws(() => nativeResult('openai/gpt-6.1-sol', raw, 'responses'), /native_/);
});

for (const [name, mutate, disposition] of [
  ['truncation', r => { r.status = 'incomplete'; r.incomplete_details = { reason: 'max_output_tokens' }; }, 'truncated'],
  ['filter', r => { r.status = 'incomplete'; r.incomplete_details = { reason: 'content_filter' }; }, 'refused'],
  ['refusal', r => r.output[1].content = [{ type: 'refusal', refusal: 'no' }], 'refused'],
  ['tool call', r => r.output.push({ type: 'function_call' }), 'paused'],
  ['unknown item', r => r.output.push({ type: 'new_output_kind' }), 'unknown_stop'],
  ['multiple messages', r => r.output.push(r.output[1]), 'unknown_stop'],
  ['unfinished message', r => r.output[1].status = 'in_progress', 'unknown_stop'],
  ['wrong role', r => r.output[1].role = 'user', 'unknown_stop'],
  ['malformed content', r => r.output[1].content = [null], 'unknown_stop'],
  ['missing output', r => delete r.output, 'unknown_stop'],
  ['empty answer', r => r.output[1].content = [], 'empty'],
  ['failed response', r => r.status = 'failed', 'unknown_stop'],
]) test(`Responses preserves settled usage but rejects ${name}`, () => {
  const raw = responsesFixture(); mutate(raw); raw.output_text = 'must not override canonical output';
  const normalized = nativeResult('openai/gpt-6.1-sol', raw, 'responses');
  assert.equal(normalized.costMicros, 6670);
  assert.equal(responseDisposition(normalized.result), disposition);
  assert.throws(() => requireCompleteResponse(normalized.result), new RegExp(`provider_${disposition}`));
  assert.equal(normalized.result.choices[0].message.content, '');
});

for (const phase of [undefined, null, 'final_answer']) test(`Responses excludes commentary from the structured action: ${phase}`, () => {
  const raw = responsesFixture();
  raw.output[1].phase = phase;
  raw.output.unshift({ type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
    content: [{ type: 'output_text', text: 'private commentary sentinel' }] });
  const normalized = nativeResult('openai/gpt-6.1-sol', raw, 'responses');
  assert.equal(normalized.result.choices[0].message.content, '{"answer":"ok"}');
  assert.equal(responseDisposition(normalized.result), 'complete');
  assert.ok(!JSON.stringify(normalized).includes('sentinel'));
  raw.output[2].content = [{ type: 'refusal', refusal: 'no' }];
  assert.equal(responseDisposition(nativeResult('openai/gpt-6.1-sol', raw, 'responses').result), 'refused');
});

for (const [name, mutate] of [
  ['commentary only', r => r.output[1].phase = 'commentary'],
  ['unknown phase', r => r.output[1].phase = 'new_phase'],
  ['unfinished commentary', r => r.output.unshift({ type: 'message', role: 'assistant', status: 'in_progress', phase: 'commentary', content: [] })],
  ['multiple final answers', r => { r.output[1].phase = 'final_answer'; r.output.push(structuredClone(r.output[1])); }],
]) test(`Responses does not guess the final answer: ${name}`, () => {
  const raw = responsesFixture(); mutate(raw);
  const normalized = nativeResult('openai/gpt-6.1-sol', raw, 'responses');
  assert.equal(responseDisposition(normalized.result), 'unknown_stop');
  assert.equal(normalized.result.choices[0].message.content, '');
  assert.equal(normalized.costMicros, 6670);
});
