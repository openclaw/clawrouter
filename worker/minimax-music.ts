import { mediaObject } from "./managed-media-json.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { inputRetirement } from "./input-retirement.ts";

export const miniMaxMusicModels = ["music-2.6", "music-2.6-free", "music-cover", "music-cover-free"] as const;
// Regional documentation observations, not account entitlement, prices or routing authority.
export const miniMaxMusicAvailability = {
  checkedAt: "2026-11-05",
  global: {
    source: "https://platform.minimax.io/docs/guides/music-generation",
    paid: "existing_paying_users_only", newPaidUsersDeniedSince: "2026-08-20",
    free: "discontinuation_announced_date_unspecified",
  },
  cn: {
    source: "https://platform.minimax.cn/docs/guides/music-generation",
    paid: "existing_paying_users_only", newPaidUsersDeniedSince: "2026-08-20",
    free: "stopped",
  },
} as const;
const origins = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;
const maxAudio = 8 * 1024 * 1024, maxEnvelope = maxAudio * 5 + 64 * 1024, encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface MiniMaxMusicRequest { origin: string; path: "/v1/music_generation"; body: Json; model: string; headers: Headers }
export interface MiniMaxMusicObservation {
  audio: Uint8Array; frames: Json[]; model: string; mimeType: "audio/mpeg";
  durationMillis: number | null; upstreamCostMicros: null;
}
export function prepareMiniMaxMusic(region: keyof typeof origins, value: unknown): MiniMaxMusicRequest {
  if (region !== "global" && region !== "cn") fail("region");
  const body = object(value); keys(body, ["model", "prompt", "lyrics", "lyrics_optimizer", "is_instrumental", "stream", "output_format", "audio_setting", "audio_url", "audio_base64"]);
  if (typeof body.model !== "string" || !(miniMaxMusicModels as readonly string[]).includes(body.model)
    || body.stream !== true && body.stream !== false || body.output_format !== "hex") fail("request");
  if (body.stream === false && (region !== "global" || !["music-2.6", "music-2.6-free"].includes(body.model)
    || Object.hasOwn(body, "audio_url") || Object.hasOwn(body, "audio_base64"))) fail("unary_request");
  const settings = object(body.audio_setting); keys(settings, ["sample_rate", "bitrate", "format"]);
  if (settings.sample_rate !== 44100 || settings.bitrate !== 256000 || settings.format !== "mp3") fail("audio_settings");
  const cover = body.model.startsWith("music-cover");
  const prompt = text(body.prompt, cover ? 300 : 2000);
  if (!prompt.trim() || cover && prompt.length < 10) fail("prompt");
  if (cover) {
    if (body.lyrics_optimizer !== undefined || body.is_instrumental !== undefined
      || (body.audio_url !== undefined) === (body.audio_base64 !== undefined)) fail("cover_reference");
    if (body.lyrics !== undefined && text(body.lyrics, 1000).length < 10) fail("lyrics");
    if (body.audio_url !== undefined) {
      const source = text(body.audio_url, 8192); let url: URL;
      try { url = new URL(source); } catch { fail("audio_url"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("audio_url");
    } else {
      inspectMiniMaxCoverBase64(body.audio_base64);
    }
  } else {
    if (body.audio_url !== undefined || body.audio_base64 !== undefined) fail("unexpected_reference");
    if (body.is_instrumental !== undefined && body.is_instrumental !== true
      || body.lyrics_optimizer !== undefined && body.lyrics_optimizer !== true) fail("options");
    if (body.is_instrumental === true) {
      if (body.lyrics !== undefined || body.lyrics_optimizer !== undefined) fail("instrumental_lyrics");
    } else if (body.lyrics !== undefined) {
      if (!text(body.lyrics, 3500).trim() || body.lyrics_optimizer !== undefined) fail("lyrics");
    } else if (body.lyrics_optimizer !== true) fail("lyrics");
  }
  return { origin: origins[region], path: "/v1/music_generation", body, model: body.model,
    headers: new Headers({ "content-type": "application/json", accept: body.stream === false ? "application/json" : "text/event-stream, application/json" }) };
}

// Inspect the original string with scalar state; never decode, normalize or retain it.
export function inspectMiniMaxCoverBase64(value: unknown): Readonly<{ decodedBytes: number }> {
  const audio = text(value, Math.ceil(maxAudio / 3) * 4);
  if (!audio || audio.length % 4) fail("audio_base64");
  const padding = audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0;
  const end = audio.length - padding, decodedBytes = audio.length / 4 * 3 - padding;
  if (decodedBytes < 1 || decodedBytes > maxAudio) fail("audio_base64");
  let last = 0;
  for (let index = 0; index < end; index++) {
    const code = audio.charCodeAt(index);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else fail("audio_base64");
  }
  // Canonical padding requires unused low bits in the final sextet to be zero.
  if (padding === 2 && (last & 15) !== 0 || padding === 1 && (last & 3) !== 0) fail("audio_base64");
  return Object.freeze({ decodedBytes });
}

export function observeMiniMaxMusic(values: unknown[], request: MiniMaxMusicRequest, complete: boolean): MiniMaxMusicObservation {
  if (!complete || values.length < 1 || values.length > 2048 || encoder.encode(JSON.stringify(values)).length > maxEnvelope) fail("frames");
  if (request.body.stream === false && values.length !== 1) fail("unary_frames");
  let audioHex = "", terminal = false, durationMillis: number | null = null;
  const frames: Json[] = [];
  for (const value of values) {
    const frame = object(value);
    if (terminal || !mediaObject(frame.base_resp) || frame.base_resp.status_code !== 0 || frame.error !== undefined
      || frame.model !== undefined && frame.model !== request.model || frame.task_id !== undefined || frame.audio_url !== undefined) fail("frame");
    const data = object(frame.data);
    if (data.audio_url !== undefined || data.status !== 1 && data.status !== 2 && data.status !== "1" && data.status !== "2") fail("status");
    const chunk = data.audio === undefined || data.audio === "" ? "" : hex(data.audio);
    if (String(data.status) === "2") {
      terminal = true;
      // The frozen consumer suppresses terminal aggregate audio after deltas.
      // Verify the prefix before accepting a terminal full-file replacement.
      // An ambiguous final delta is rejected, never appended speculatively.
      if (chunk) {
        if (audioHex && !chunk.startsWith(audioHex)) fail("terminal_audio_mismatch");
        audioHex = chunk;
      }
      const extra = frame.extra_info === undefined ? undefined : object(frame.extra_info);
      if (extra) {
        if (extra.music_size !== undefined && extra.music_size !== audioHex.length / 2
          || extra.music_sample_rate !== undefined && extra.music_sample_rate !== 44100
          || extra.bitrate !== undefined && extra.bitrate !== 256000) fail("metadata");
        if (extra.music_duration !== undefined) {
          if (typeof extra.music_duration !== "number" || !Number.isFinite(extra.music_duration) || extra.music_duration < 0) fail("duration");
          durationMillis = extra.music_duration;
        }
      }
    } else {
      if (audioHex.length + chunk.length > maxAudio * 2) fail("audio_size");
      audioHex += chunk;
    }
    frames.push(frame);
  }
  if (!terminal || !audioHex) fail("incomplete_audio");
  const audio = new Uint8Array(audioHex.length / 2);
  for (let index = 0; index < audio.length; index++) audio[index] = Number.parseInt(audioHex.slice(index * 2, index * 2 + 2), 16);
  return { audio, frames, model: request.model, mimeType: "audio/mpeg", durationMillis, upstreamCostMicros: null };
}
export async function readMiniMaxMusic(response: Response, request: MiniMaxMusicRequest, signal: AbortSignal): Promise<MiniMaxMusicObservation> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(), length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || mime !== "application/json" && mime !== "text/event-stream"
    || request.body.stream === false && mime !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxEnvelope)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true }); let size = 0, body = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxEnvelope) fail("size"); body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    return observeMiniMaxMusic(mime === "application/json" ? [JSON.parse(body)] : events(body), request, true);
  } catch { void reader.cancel().catch(() => undefined); fail("response"); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function events(body: string): unknown[] {
  const frames: unknown[] = []; let data: string[] = [], done = false;
  const flush = () => {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (done) fail("after_done");
    if (payload === "[DONE]") { done = true; return; }
    if (frames.length >= 2048) fail("frame_limit");
    frames.push(JSON.parse(payload));
  };
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":"); const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (!["event", "id", "retry"].includes(field)) fail("sse_field");
  }
  if (data.length) fail("incomplete_event");
  return frames;
}
function hex(value: unknown): string {
  const result = text(value, maxAudio * 2 + 2).trim();
  if (!result || result.length > maxAudio * 2 || result.length % 2 || !/^[0-9a-f]+$/i.test(result)) fail("hex");
  return result.toLowerCase();
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) fail("text");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  return value;
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_minimax_music_${reason}`); }

export interface MiniMaxMusicStreamObservation {
  audio: Uint8Array<ArrayBuffer>;
  terminal: Json;
  model: string;
  mimeType: "audio/mpeg";
  durationMillis: number | null;
  upstreamCostMicros: null;
}
const streamWindow = 64 * 1024, streamReadLimit = 262144, metadataLimit = 64 * 1024;

// Additive bounded mode; the existing complete-frame reader above is unchanged.
// Owns one 8 MiB accumulator, never the request, full wire, frame array or hex.
// Caller owns the returned view/backing and capacity through delivery/cancel.
export async function readMiniMaxMusicStream(response: Response, model: string, signal: AbortSignal): Promise<MiniMaxMusicStreamObservation> {
  // Own the original body before validation. The public operation can fail
  // promptly, while this promise joins its first cancellation and pending read.
  if (!response.body || response.bodyUsed || response.body.locked) fail("stream_http");
  let byob: ReadableStreamBYOBReader | undefined, regular: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try { byob = response.body.getReader({ mode: "byob" }); }
  catch { regular = response.body.getReader(); }
  const reader = byob ?? regular!, input = inputRetirement(reader);
  const mime = response.headers.get("content-type"), encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
  if (!["music-2.6", "music-2.6-free"].includes(model) || response.status !== 200 || response.redirected || !response.body
    || response.headers.has("content-range") || !mime || !/^text\/event-stream(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxEnvelope)) {
    await input.retire("cancel"); fail("stream_http");
  }
  let eof = false;
  const cancel = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const state = new BoundedMusicStream(model), framing = musicSse(state), decoder = new TextDecoder("utf-8", { fatal: true });
    let window = new Uint8Array(streamWindow), size = 0, reads = 0;
    for (;;) {
      if (++reads > streamReadLimit) fail("stream_reads");
      // Never lend audio backing to BYOB. Only the returned view owns a read window.
      const part = await input.read(() => byob ? byob.read(window) : regular!.read());
      signal.throwIfAborted();
      if (part.done) { if (part.value?.byteLength) fail("stream_eof"); eof = true; break; }
      const bytes = part.value;
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
        || bytes.byteLength > streamWindow || bytes.buffer.byteLength > streamWindow) fail("stream_window");
      size += bytes.byteLength; if (size > maxEnvelope) fail("stream_size");
      framing.push(decoder.decode(bytes, { stream: true }));
      if (byob) window = new Uint8Array(bytes.buffer);
    }
    framing.push(decoder.decode()); framing.end();
    if (length !== null && Number(length) !== size) fail("stream_length");
    return state.result();
  } catch { await input.retire(eof ? "eof" : "cancel", signal.reason); return fail("stream_response"); }
  finally { signal.removeEventListener("abort", cancel); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}

class BoundedMusicStream {
  private readonly audio = new Uint8Array(maxAudio);
  private size = 0;
  private previous = 0;
  private count = 0;
  private nibble = -1;
  private prefix = true;
  private aggregateOnly = false;
  private trailing = false;
  private hexUnits = 0;
  private terminal: Json | null = null;
  private duration: number | null = null;
  private frames = 0;
  private readonly model: string;
  constructor(model: string) { this.model = model; }
  begin(): void {
    if (this.terminal || ++this.frames > 2048) fail("stream_frame");
    this.previous = this.size; this.count = 0; this.nibble = -1; this.prefix = true; this.aggregateOnly = false; this.trailing = false; this.hexUnits = 0;
  }
  hex(text: string): void {
    this.hexUnits += text.length;
    for (const character of text) {
      if (!character.trim()) {
        if (this.nibble >= 0) fail("stream_hex");
        if (this.count) this.trailing = true;
        continue;
      }
      const code = character.charCodeAt(0), value = code >= 48 && code <= 57 ? code - 48
        : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
      if (value < 0 || this.trailing) fail("stream_hex");
      if (this.nibble < 0) { this.nibble = value; continue; }
      const byte = this.nibble * 16 + value; this.nibble = -1;
      if (this.count >= maxAudio) fail("stream_audio_limit");
      if (this.count < this.previous && this.audio[this.count] !== byte) this.prefix = false;
      if (!this.aggregateOnly && this.previous + this.count >= maxAudio) {
        // A delta no longer fits. Only a matching aggregate can still succeed.
        // Compact its already-received suffix in place; never allocate a second file.
        if (!this.prefix) fail("stream_audio_limit");
        this.aggregateOnly = true;
        if (this.count > this.previous) this.audio.copyWithin(this.previous, this.previous * 2, this.previous + this.count);
      }
      if (this.aggregateOnly) { if (this.count >= this.previous) this.audio[this.count] = byte; }
      else this.audio[this.previous + this.count] = byte;
      this.count++;
    }
  }
  endHex(): void { if (this.nibble >= 0 || this.hexUnits && !this.count) fail("stream_hex"); }
  accept(frame: Json): void {
    if (!mediaObject(frame.base_resp) || frame.base_resp.status_code !== 0 || Object.hasOwn(frame, "error")
      || Object.hasOwn(frame, "model") && frame.model !== this.model) fail("stream_frame");
    const data = object(frame.data);
    if (data.status !== 1 && data.status !== 2 && data.status !== "1" && data.status !== "2") fail("stream_status");
    if (String(data.status) === "1") {
      if (this.aggregateOnly) fail("stream_audio_limit");
      this.size = this.previous + this.count; return;
    }
    if (this.count) {
      if (!this.prefix || this.count < this.previous) fail("stream_terminal_audio");
      if (!this.aggregateOnly) this.audio.copyWithin(this.previous, this.previous * 2, this.previous + this.count);
      this.size = this.count;
    }
    if (!this.size) fail("stream_empty");
    const extra = frame.extra_info === undefined ? undefined : object(frame.extra_info);
    if (extra) {
      if (extra.music_size !== undefined && extra.music_size !== this.size
        || extra.music_sample_rate !== undefined && extra.music_sample_rate !== 44100
        || extra.bitrate !== undefined && extra.bitrate !== 256000) fail("stream_metadata");
      if (extra.music_duration !== undefined) {
        if (typeof extra.music_duration !== "number" || !Number.isFinite(extra.music_duration) || extra.music_duration < 0) fail("stream_duration");
        this.duration = extra.music_duration;
      }
    }
    this.terminal = frame;
  }
  result(): MiniMaxMusicStreamObservation {
    if (!this.terminal) fail("stream_incomplete");
    return { audio: this.audio.subarray(0, this.size), terminal: this.terminal, model: this.model,
      mimeType: "audio/mpeg", durationMillis: this.duration, upstreamCostMicros: null };
  }
}

// JSON audio strings are consumed as tokenizer chunks, not packed values.
// Every other field has one bounded metadata graph, discarded at each frame.
function musicFrame(state: BoundedMusicStream) {
  type Container = { value: Json | unknown[]; path: string[]; key: string | null; seen: Set<string> };
  const stack: Container[] = [];
  let root: unknown, text = "", kind: "key" | "string" | "number" | "audio" | null = null, units = 0, nodes = 0;
  const charge = (value: string) => { units += value.length; if (units * 2 > metadataLimit) fail("stream_metadata_limit"); };
  const path = (): string[] => {
    const parent = stack.at(-1);
    if (!parent) return [];
    return [...parent.path, Array.isArray(parent.value) ? String(parent.value.length) : parent.key ?? ""];
  };
  const audioPath = () => { const p = path(); return p.length === 2 && p[0] === "data" && p[1] === "audio"; };
  const add = (value: unknown): void => {
    if (++nodes > 512) fail("stream_nodes");
    const parent = stack.at(-1);
    if (!parent) { if (root !== undefined) fail("stream_root"); root = value; }
    else if (Array.isArray(parent.value)) parent.value.push(value);
    else {
      if (parent.key === null) fail("stream_key");
      parent.value[parent.key] = value; parent.key = null;
    }
  };
  state.begin();
  const parser = createJsonTokenizer(token => {
    if (token.name === "startObject" || token.name === "startArray") {
      if (audioPath() || stack.length >= 8) fail("stream_depth");
      const at = path(), value = token.name === "startObject" ? Object.create(null) as Json : [];
      add(value); stack.push({ value, path: at, key: null, seen: new Set() });
    } else if (token.name === "endObject" || token.name === "endArray") stack.pop();
    else if (token.name === "startKey") { kind = "key"; text = ""; }
    else if (token.name === "endKey") {
      const parent = stack.at(-1)!;
      if (parent.seen.has(text) || text.length > 256) fail("stream_duplicate_key");
      parent.seen.add(text); parent.key = text; kind = null;
      if ((parent.path.length === 0 || parent.path.length === 1 && parent.path[0] === "data")
        && ["audio_url", "audio_base64", "file_id", "file", "url", "task_id", "error"].includes(text)) fail("stream_unbound_field");
    } else if (token.name === "startString" || token.name === "startNumber") {
      if (audioPath() && token.name !== "startString") fail("stream_audio_type");
      kind = audioPath() ? "audio" : token.name === "startString" ? "string" : "number"; text = "";
    } else if (token.name === "stringChunk" || token.name === "numberChunk") {
      if (kind === "audio") state.hex(token.value);
      else { charge(token.value); text += token.value; if (kind === "number" && text.length > 64) fail("stream_number"); }
    } else if (token.name === "endString" || token.name === "endNumber") {
      if (kind === "audio") {
        state.endHex(); stack.at(-1)!.key = null; // Omit the native hex from metadata.
      } else {
        const value = kind === "number" ? Number(text) : text;
        if (typeof value === "number" && !Number.isFinite(value)) fail("stream_number"); add(value);
      }
      kind = null; text = "";
    } else if (token.name === "nullValue" || token.name === "trueValue" || token.name === "falseValue") {
      if (audioPath()) fail("stream_audio_type");
      add(token.name === "nullValue" ? null : token.name === "trueValue");
    }
  });
  return { push(text: string) { for (let i = 0; i < text.length; i += 1024) parser.push(text.slice(i, i + 1024)); },
    end() { parser.end(); state.accept(object(root)); } };
}

function musicSse(state: BoundedMusicStream) {
  let prefix = "", field: string | null = null, header = "", space = false, lineBytes = 0, carriage = false;
  let frame: ReturnType<typeof musicFrame> | undefined, data = false, probe = "", done = false, metadata = 0, lines = 0;
  const payload = (part: string) => {
    if (done) fail("stream_after_done");
    if (!frame && probe.startsWith("[")) { if (probe.length + part.length > 6) fail("stream_done"); probe += part; return; }
    if (!frame && probe.length < 6) {
      const take = Math.min(6 - probe.length, part.length); probe += part.slice(0, take); part = part.slice(take);
      if (probe.startsWith("[")) { if (probe.length > 6 || part.length) fail("stream_done"); return; }
      if (probe.length) { frame = musicFrame(state); frame.push(probe); probe = ""; }
    }
    if (frame) frame.push(part);
  };
  const consume = (part: string) => {
    lineBytes += part.length;
    if (field === null) {
      const colon = part.indexOf(":");
      if (colon < 0) { prefix += part; if (prefix.length > 16) fail("stream_field"); return; }
      prefix += part.slice(0, colon); field = prefix; prefix = "";
      if (!["", "data", "event", "id", "retry"].includes(field)) fail("stream_field");
      part = part.slice(colon + 1); space = true;
      if (field === "data") { if (data) payload("\n"); data = true; }
    }
    if (space && part.length) { space = false; if (part[0] === " ") part = part.slice(1); }
    if (field === "data") payload(part);
    else { metadata += part.length * 2; if (metadata > metadataLimit) fail("stream_headers"); if (field === "event") header += part; }
  };
  const newline = () => {
    if (++lines > 4096) fail("stream_lines");
    if (!lineBytes) {
      if (data) {
        if (probe === "[DONE]" && !frame) { state.result(); done = true; }
        else if (frame) frame.end(); else fail("stream_event");
      }
      frame = undefined; data = false; probe = ""; metadata = 0; lines = 0;
    } else {
      if (field === null) { if (prefix !== "data" && !["event", "id", "retry"].includes(prefix)) fail("stream_field"); if (prefix === "data") { if (data) payload("\n"); data = true; } }
      if (field === "event" && header.trim() === "error") fail("stream_event_error");
    }
    prefix = ""; field = null; header = ""; space = false; lineBytes = 0;
  };
  return {
    push(text: string) {
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (carriage) { carriage = false; if (c === "\n") { start = i + 1; continue; } }
        if (c !== "\r" && c !== "\n") continue;
        consume(text.slice(start, i)); newline(); carriage = c === "\r"; start = i + 1;
      }
      if (start < text.length) consume(text.slice(start));
    },
    end() { if (lineBytes || data || frame || probe) fail("stream_incomplete_event"); },
  };
}

