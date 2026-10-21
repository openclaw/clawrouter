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
export function fail(code: string): never { throw new HttpError(400, `realtime_${code}`, 'Realtime manual audio policy or protocol rejected this operation'); }
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
export function sessionPolicy(value: unknown): Json {
  const s = object(value); fields(s, ['type', 'model', 'instructions', 'output_modalities', 'max_output_tokens', 'audio', 'tools', 'tool_choice', 'tracing']);
  if (s.type !== 'realtime' || ![undefined, REALTIME.model, REALTIME.upstream].includes(s.model) || JSON.stringify(s.output_modalities) !== '["audio"]') fail('session');
  if (s.instructions !== undefined && (typeof s.instructions !== 'string' || s.instructions.length > 8192)) fail('instructions');
  if (s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.length)) fail('tools_unsupported');
  if (s.tool_choice !== undefined && s.tool_choice !== 'none') fail('tools_unsupported');
  if (s.tracing !== undefined && s.tracing !== null) fail('tracing_unsupported');
  const a = object(s.audio); fields(a, ['input', 'output']);
  const i = object(a.input), o = object(a.output); fields(i, ['format', 'turn_detection', 'transcription', 'noise_reduction']); fields(o, ['format', 'voice']);
  // Explicit null required: omission otherwise enables vendor defaults.
  if (i.turn_detection !== null || i.transcription !== null || (i.noise_reduction !== undefined && i.noise_reduction !== null)) fail('auto_stt_unsupported');
  const input = format(i.format), output = format(o.format);
  if (JSON.stringify(input) !== JSON.stringify(output)) fail('codec');
  if (!['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].includes(o.voice)) fail('voice');
  return { type: 'realtime', model: REALTIME.upstream, instructions: s.instructions ?? '', output_modalities: ['audio'], max_output_tokens: cap(s.max_output_tokens ?? REALTIME.output), audio: { input: { format: input, turn_detection: null, transcription: null, noise_reduction: null }, output: { format: output, voice: o.voice } }, tools: [], tool_choice: 'none', tracing: null };
}
export function effectiveSession(actual: unknown, expected: Json): boolean {
  try {
    const a = object(actual);
    return a.type === 'realtime' && a.model === expected.model && a.max_output_tokens === expected.max_output_tokens
      && JSON.stringify(a.output_modalities) === '["audio"]'
      && a.audio?.input?.turn_detection === null && a.audio?.input?.transcription === null
      && JSON.stringify(format(a.audio.input.format)) === JSON.stringify(expected.audio.input.format)
      && JSON.stringify(format(a.audio.output.format)) === JSON.stringify(expected.audio.output.format)
      && a.audio.output.voice === expected.audio.output.voice && Array.isArray(a.tools) && !a.tools.length
      && a.tool_choice === 'none' && a.tracing === null && a.instructions === expected.instructions
      && (a.audio.input.noise_reduction === null || a.audio.input.noise_reduction === undefined);
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
