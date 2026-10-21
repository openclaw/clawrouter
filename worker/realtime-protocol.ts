import { HttpError } from './utils';

// Source-qualified 2026-10-20: model page, pricing page and Realtime client
// events reference. Generic manifest rates are highest-modality upper bounds;
// only the singular native modality details below qualify exact settlement.
export const REALTIME = Object.freeze({
  model: 'openai/gpt-realtime-2.1', upstream: 'gpt-realtime-2.1',
  pricingRef: 'openai-realtime-2.1-manual-2026-10-20',
  context: 128_000, output: 4096, reservation: 4_358_144,
  textInput: 4, audioInput: 32, cachedText: 0.4, cachedAudio: 0.4, textOutput: 24, audioOutput: 64,
  frame: 64 * 1024, queue: 16, queueBytes: 256 * 1024,
  inputBytes: 4 * 1024 * 1024, outputBytes: 8 * 1024 * 1024,
  events: 4096, identities: 256, turns: 64, idleMs: 30_000, durationMs: 120_000, guardMs: 5000,
});
export type Json = Record<string, any>;
export interface RealtimeUsage {
  input: number; output: number; total: number; textInput: number; audioInput: number;
  cached: number; cachedText: number; cachedAudio: number; textOutput: number; audioOutput: number; cost: number;
}
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object_required');
  return value as Json;
}
export function fail(code: string): never { throw new HttpError(400, `realtime_${code}`, 'Realtime audio policy or protocol rejected this operation'); }
export function fields(value: Json, allowed: string[]): void { if (Object.keys(value).some(k => !allowed.includes(k))) fail('unsupported_field'); }
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('invalid_identity');
  return value;
}
export function cap(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > REALTIME.output) fail('output_limit');
  return value as number;
}
export function format(value: unknown): Json {
  const f = object(value); fields(f, ['type', 'rate']);
  if (f.type === 'audio/pcm' && f.rate === 24000) return { type: f.type, rate: f.rate };
  if (f.type === 'audio/pcmu' && f.rate === undefined) return { type: f.type };
  fail('codec');
}
export function audio(value: unknown, codec: Json): number {
  if (typeof value !== 'string' || !value.length || value.length > REALTIME.frame || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('audio');
  const decoded = atob(value);
  if (btoa(decoded) !== value || (codec.type === 'audio/pcm' && decoded.length % 2)) fail('audio_alignment');
  return decoded.length;
}
// Server VAD is retained, but the proxy owns response creation/cancellation.
// Both vendor auto flags MUST remain false on the wire: every response must be
// admitted under current authority and capacity before provider egress.
export function vadPolicy(value: unknown): Json | null {
  if (value === null) return null;
  const v = object(value); fields(v, ['type', 'threshold', 'prefix_padding_ms', 'silence_duration_ms', 'create_response', 'interrupt_response']);
  if (v.type !== 'server_vad') fail('auto_stt_unsupported');
  const threshold = v.threshold ?? .5, padding = v.prefix_padding_ms ?? 300, silence = v.silence_duration_ms ?? 500;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1
    || !Number.isSafeInteger(padding) || padding < 0 || padding > 1000 || !Number.isSafeInteger(silence) || silence < 100 || silence > 2000
    || ![undefined, true, false].includes(v.create_response) || ![undefined, true, false].includes(v.interrupt_response)) fail('vad');
  return { type: 'server_vad', threshold, prefix_padding_ms: padding, silence_duration_ms: silence, create_response: v.create_response ?? true, interrupt_response: v.interrupt_response ?? true };
}
export function toolChoice(value: unknown, tools: Json[]): unknown {
  if (['none', 'auto', 'required'].includes(value as string)) {
    if (value !== 'none' && !tools.length) fail('tools_unsupported'); return value;
  }
  const t = object(value); fields(t, ['type', 'name']);
  if (t.type !== 'function' || !tools.some(tool => tool.name === t.name)) fail('tools_unsupported');
  return { type: 'function', name: t.name };
}
export function sessionPolicy(value: unknown): Json {
  const s = object(value); fields(s, ['type', 'model', 'instructions', 'output_modalities', 'max_output_tokens', 'audio', 'tools', 'tool_choice', 'tracing']);
  if (s.type !== 'realtime' || ![undefined, REALTIME.model, REALTIME.upstream].includes(s.model) || JSON.stringify(s.output_modalities) !== '["audio"]') fail('session');
  if (s.instructions !== undefined && (typeof s.instructions !== 'string' || s.instructions.length > 8192)) fail('instructions');
  const tools: Json[] = s.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 32 || JSON.stringify(tools).length > 32768) fail('tools_unsupported');
  const names = new Set<string>();
  for (const tool of tools) {
    object(tool); fields(tool, ['type', 'name', 'description', 'parameters']);
    if (tool.type !== 'function' || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)
      || tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 4096)) fail('tools_unsupported');
    names.add(tool.name); if (tool.parameters !== undefined) object(tool.parameters);
  }
  const choice = toolChoice(s.tool_choice ?? (tools.length ? 'auto' : 'none'), tools);
  if (s.tracing !== undefined && s.tracing !== null) fail('tracing_unsupported');
  const a = object(s.audio); fields(a, ['input', 'output']);
  const i = object(a.input), o = object(a.output); fields(i, ['format', 'turn_detection', 'transcription', 'noise_reduction']); fields(o, ['format', 'voice']);
  // Omitted turn/transcription policy remains unsafe; no vendor default grants.
  const vad = vadPolicy(i.turn_detection);
  let transcription: Json | null = null;
  if (i.transcription !== null) {
    const t = object(i.transcription); fields(t, ['model', 'language']);
    if (t.model !== 'gpt-4o-mini-transcribe' || t.language !== undefined && (typeof t.language !== 'string' || !/^[a-z]{2}$/.test(t.language))) fail('auto_stt_unsupported');
    transcription = { model: t.model, ...(t.language ? { language: t.language } : {}) };
  }
  let noise = null;
  if (i.noise_reduction != null) { const n = object(i.noise_reduction); fields(n, ['type']); if (!['near_field', 'far_field'].includes(n.type)) fail('noise_reduction'); noise = n; }
  const input = format(i.format), output = format(o.format);
  if (JSON.stringify(input) !== JSON.stringify(output)) fail('codec');
  if (!['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].includes(o.voice)) fail('voice');
  return { type: 'realtime', model: REALTIME.upstream, instructions: s.instructions ?? '', output_modalities: ['audio'], max_output_tokens: cap(s.max_output_tokens ?? REALTIME.output), audio: { input: { format: input, turn_detection: vad, transcription, noise_reduction: noise }, output: { format: output, voice: o.voice } }, tools, tool_choice: choice, tracing: null };
}
export function wireSession(policy: Json): Json {
  const v = policy.audio.input.turn_detection;
  const transcription = policy.audio.input.transcription;
  return { ...policy, audio: { ...policy.audio, input: { ...policy.audio.input, transcription: transcription ? { ...transcription, prompt: '' } : null, turn_detection: v ? { ...v, create_response: false, interrupt_response: false, idle_timeout_ms: null } : null } } };
}
function effectiveVad(value: unknown): Json | null {
  if (value === null) return null;
  const v = object(value);
  // SDK/server responses may materialize the documented nullable timeout. A
  // non-null timeout can independently create billable work and is forbidden.
  if (v.idle_timeout_ms != null) fail('unsafe_ack');
  const { idle_timeout_ms, ...rest } = v; return vadPolicy(rest);
}
function effectiveTranscription(actual: unknown, expected: Json | null): boolean {
  if (expected === null) return actual === null;
  const t = object(actual); fields(t, ['model', 'language', 'prompt']);
  return t.model === expected.model && (t.language ?? null) === (expected.language ?? null) && [undefined, null, ''].includes(t.prompt);
}
export function effectiveSession(actual: unknown, expected: Json): boolean {
  try {
    const a = object(actual), wire = wireSession(expected);
    return a.type === 'realtime' && a.model === wire.model && a.max_output_tokens === wire.max_output_tokens
      && JSON.stringify(a.output_modalities) === '["audio"]'
      && JSON.stringify(effectiveVad(a.audio?.input?.turn_detection)) === JSON.stringify(effectiveVad(wire.audio.input.turn_detection))
      && effectiveTranscription(a.audio.input.transcription, wire.audio.input.transcription)
      && JSON.stringify(format(a.audio.input.format)) === JSON.stringify(wire.audio.input.format)
      && JSON.stringify(format(a.audio.output.format)) === JSON.stringify(wire.audio.output.format)
      && a.audio.output.voice === wire.audio.output.voice && JSON.stringify(a.tools) === JSON.stringify(wire.tools)
      && JSON.stringify(a.tool_choice) === JSON.stringify(wire.tool_choice) && a.tracing === null && a.instructions === wire.instructions
      && JSON.stringify(a.audio.input.noise_reduction ?? null) === JSON.stringify(wire.audio.input.noise_reduction);
  } catch { return false; }
}
export function parseRealtimeUsage(value: unknown, outputCap: number): RealtimeUsage | null {
  try {
    const u = object(value), i = object(u.input_token_details), o = object(u.output_token_details), c = object(i.cached_tokens_details);
    const n = (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error(); return v as number; };
    const input = n(u.input_tokens), output = n(u.output_tokens), total = n(u.total_tokens);
    const textInput = n(i.text_tokens), audioInput = n(i.audio_tokens), imageInput = n(i.image_tokens ?? 0);
    const cached = n(i.cached_tokens), cachedText = n(c.text_tokens), cachedAudio = n(c.audio_tokens), cachedImage = n(c.image_tokens ?? 0);
    const textOutput = n(o.text_tokens), audioOutput = n(o.audio_tokens);
    if (input > REALTIME.context || output > outputCap || total !== input + output || input !== textInput + audioInput + imageInput || output !== textOutput + audioOutput
      || imageInput !== 0 || cachedImage !== 0 || cached !== cachedText + cachedAudio || cachedText > textInput || cachedAudio > audioInput) return null;
    // Integer fifth-microUSD units avoid binary .4 rounding above an exact
    // integer (e.g. 1 cached text + 14 cached audio must cost 6, not 7).
    const uncachedCost = (textInput - cachedText) * REALTIME.textInput + (audioInput - cachedAudio) * REALTIME.audioInput + textOutput * REALTIME.textOutput + audioOutput * REALTIME.audioOutput;
    const cost = Math.ceil((uncachedCost * 5 + (cachedText + cachedAudio) * 2) / 5);
    return { input, output, total, textInput, audioInput, cached, cachedText, cachedAudio, textOutput, audioOutput, cost };
  } catch { return null; }
}
