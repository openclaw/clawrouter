import { randomUUID } from 'node:crypto';

// Native transports for the opt-in benchmark, not production gateway adapters.
const rate = (input, cached, write, output) => ({ input: input / 1e6, cached: cached / 1e6, write: write / 1e6, output: output / 1e6, request: 0, tiers: [] });
export const nativeModels = {
  'openai/gpt-6-luna': { provider: 'openai', upstream: 'gpt-6-luna', price: rate(0.1, 0.01, 0.125, 0.5), source: 'https://developers.openai.com/api/docs/models/gpt-6-luna' },
  'openai/gpt-6.1-sol': { provider: 'openai', upstream: 'gpt-6.1-sol', price: rate(2, 0.1, 2.5, 10), source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol' },
  'anthropic/claude-sonnet-5.5': { provider: 'anthropic', upstream: 'claude-sonnet-5-5', price: rate(2, 0.1, 2.5, 10), source: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview' },
};

const answerSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
// Prices have at most three fractional USD digits per million tokens. Compute
// in thousandths of a microdollar, then round the total once.
const costMicros = entries => Math.ceil(entries.reduce((sum, [tokens, price]) => sum + tokens * Math.round(price * 1e9), 0) / 1000);
function integer(value, optional = false) {
  if (optional && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('native_usage_invalid');
  return value;
}

export function nativeRequest(model, body, env) {
  const entry = nativeModels[model];
  if (!entry) throw new Error('native_model_unknown');
  if (entry.provider === 'openai') return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: { model: entry.upstream, messages: body.messages, max_completion_tokens: body.max_tokens,
      reasoning_effort: 'medium', service_tier: 'default', store: false,
      ...(body.response_format ? { response_format: body.response_format } : {}) },
  };
  const system = body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n');
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: { model: entry.upstream, max_tokens: body.max_tokens, system,
      messages: body.messages.filter(m => m.role !== 'system' && m.role !== 'developer'),
      thinking: { type: 'adaptive' }, service_tier: 'standard_only',
      output_config: { effort: 'medium', ...(body.response_format ? { format: { type: 'json_schema',
        schema: body.response_format.type === 'json_schema' ? body.response_format.json_schema.schema : answerSchema } } : {}) } },
  };
}

// Correlation only: never retain arbitrary response headers or error text.
export function attachNativeRequestId(model, request) {
  if (nativeModels[model]?.provider !== 'openai') return {};
  const clientRequestId = randomUUID();
  request.headers['X-Client-Request-Id'] = clientRequestId;
  return { clientRequestId };
}

export function nativeResponseMetadata(model, response) {
  if (nativeModels[model]?.provider !== 'openai') return {};
  const id = response.headers?.get('x-request-id');
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? { providerRequestId: id } : {};
}

export function nativeResult(model, result) {
  const { provider, price, upstream } = nativeModels[model];
  const u = result.usage;
  const identity = result.model === upstream || (typeof result.model === 'string' && result.model.startsWith(`${upstream}-`) && /^\d{4}-?\d{2}-?\d{2}$/.test(result.model.slice(upstream.length + 1)));
  if (!u || !identity) throw new Error('native_usage_or_identity_missing');
  if (provider === 'openai') {
    if (result.service_tier && result.service_tier !== 'default') throw new Error('native_tier_unqualified');
    const input = integer(u.prompt_tokens), output = integer(u.completion_tokens);
    const cached = integer(u.prompt_tokens_details?.cached_tokens, true);
    const write = integer(u.prompt_tokens_details?.cache_write_tokens, true);
    if (input > 200000 || cached + write > input) throw new Error('native_usage_invalid');
    if (integer(u.prompt_tokens_details?.audio_tokens, true) || integer(u.completion_tokens_details?.audio_tokens, true)) throw new Error('native_usage_unqualified');
    return { result, costMicros: costMicros([[input - cached - write, price.input], [cached, price.cached], [write, price.write], [output, price.output]]), provider,
      usageBreakdown: { uncachedInputTokens: input - cached - write, cacheReadInputTokens: cached,
        cacheWriteInputTokens: write, cacheWrite1hInputTokens: 0, outputTokens: output } };
  }
  if (u.service_tier && u.service_tier !== 'standard') throw new Error('native_tier_unqualified');
  if (u.speed && u.speed !== 'standard') throw new Error('native_tier_unqualified');
  if (u.inference_geo && u.inference_geo !== 'global') throw new Error('native_tier_unqualified');
  if (Object.values(u.server_tool_use ?? {}).some(n => n !== 0)) throw new Error('native_usage_unqualified');
  const input = integer(u.input_tokens), output = integer(u.output_tokens);
  const cached = integer(u.cache_read_input_tokens, true), write = integer(u.cache_creation_input_tokens, true);
  const hour = integer(u.cache_creation?.ephemeral_1h_input_tokens, true);
  const short = integer(u.cache_creation?.ephemeral_5m_input_tokens, true);
  if (short + hour !== write || input + cached + write > 200000) throw new Error('native_usage_invalid');
  const content = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  return { result: { model: result.model, choices: [{ message: { content }, finish_reason: result.stop_reason }], usage: u },
    costMicros: costMicros([[input, price.input], [cached, price.cached], [short, price.write], [hour, price.input * 2], [output, price.output]]), provider,
    usageBreakdown: { uncachedInputTokens: input, cacheReadInputTokens: cached,
      cacheWriteInputTokens: short, cacheWrite1hInputTokens: hour, outputTokens: output } };
}

// Classify normalized responses before treating their text as an action.
export function responseDisposition(result) {
  const choice = result?.choices?.[0], reason = choice?.finish_reason;
  if (reason === 'refusal' || reason === 'content_filter' || choice?.message?.refusal) return 'refused';
  if (reason === 'model_context_window_exceeded') return 'context_limit';
  if (reason === 'length' || reason === 'max_tokens') return 'truncated';
  if (['pause_turn', 'tool_use', 'tool_calls'].includes(reason)) return 'paused';
  if (!['stop', 'end_turn', 'stop_sequence'].includes(reason)) return 'unknown_stop';
  const content = choice?.message?.content;
  return typeof content === 'string' && content.trim() ? 'complete' : 'empty';
}

export function requireCompleteResponse(result) {
  const disposition = responseDisposition(result);
  if (disposition !== 'complete') throw new Error(`provider_${disposition}`);
  return result;
}

export async function nativePins(env, fetcher = fetch, selected = Object.keys(nativeModels)) {
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
    || selected.some(id => !Object.hasOwn(nativeModels, id))) throw new Error('native_model_unknown');
  if (selected.some(id => !env[nativeModels[id].provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'])) {
    throw new Error('native_credentials_missing');
  }
  const pins = {};
  for (const id of selected) {
    const entry = nativeModels[id];
    const request = nativeRequest(id, { messages: [], max_tokens: 4096 }, env);
    const origin = entry.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
    const response = await fetcher(`${origin}/v1/models/${entry.upstream}`, { headers: request.headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`native_model_preflight_http_${response.status}`);
    const result = await response.json();
    if (result.id !== entry.upstream) throw new Error('native_model_preflight_identity');
    // Cache writes can exceed uncached input rates. Reserve conservatively even
    // though this benchmark does not request explicit cache creation.
    pins[id] = { id, canonicalSlug: entry.upstream, provider: entry.provider,
      price: { ...entry.price, input: Math.max(entry.price.write, entry.price.input * (entry.provider === 'anthropic' ? 2 : 1)) },
      usagePrice: entry.price, source: entry.source, checkedAt: '2026-11-05', costSource: 'published-tariff-estimate' };
  }
  return pins;
}

// Error messages may echo request content. Persist only finite diagnostic labels.
export function nativeErrorMetadata(body) {
  const types = new Set(['invalid_request_error', 'authentication_error', 'billing_error',
    'permission_error', 'not_found_error', 'conflict_error', 'request_too_large',
    'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error']);
  const codes = new Set(['context_length_exceeded', 'invalid_json_schema', 'invalid_value',
    'unsupported_value', 'unsupported_parameter', 'missing_required_parameter', 'invalid_parameter',
    'invalid_prompt', 'model_not_found', 'insufficient_quota', 'rate_limit_exceeded', 'server_error']);
  const parameters = ['messages', 'response_format', 'max_tokens', 'max_completion_tokens',
    'reasoning_effort', 'model', 'service_tier', 'temperature', 'tools', 'tool_choice', 'stream'];
  const param = typeof body?.error?.param === 'string' ? body.error.param : '';
  const providerParam = parameters.find(name => param === name || param.startsWith(name + '.') || param.startsWith(name + '[')) ?? 'unknown';
  const message = typeof body?.error?.message === 'string' ? body.error.message.toLowerCase() : '';
  const hints = [
    ['safety_notice', /this content can[’']t be shown|safety refusal/],
    ['credit_balance', /credit balance/], ['spend_limit', /spend(?:ing)? (?:limit|cap)/],
    ['structured_output', /output_config|response_format|json schema|structured output/],
    ['thinking_parameters', /thinking|reasoning_effort/], ['message_format', /prefill|messages\./],
    ['token_limit', /max_tokens|maximum.*tokens|context (?:window|length)/],
    ['service_tier', /service_tier|service tier/],
  ];
  return { errorType: types.has(body?.error?.type) ? body.error.type : 'unknown',
    errorHint: hints.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unknown',
    providerCode: codes.has(body?.error?.code) ? body.error.code : 'unknown', providerParam };
}
