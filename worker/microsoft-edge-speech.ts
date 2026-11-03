// Frozen node-edge-tts 1.2.11 wire codec. Transport and authority stay outside it.
export const MICROSOFT_EDGE_SPEECH = Object.freeze({
  origin: "https://api.msedgeservices.com",
  path: "/tts/cognitiveservices/websocket/v1",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  mimeType: "audio/mpeg",
  maxRequestBytes: 64 * 1024,
  maxTextBytes: 16 * 1024,
  maxHeaderBytes: 4096,
  maxTextFrameBytes: 64 * 1024,
  maxBinaryFrameBytes: 1024 * 1024,
  maxWireBytes: 20 * 1024 * 1024,
  maxAudioBytes: 16 * 1024 * 1024,
  maxFrames: 8192,
} as const);

export interface MicrosoftEdgeSpeechInput {
  text: string;
  voice?: string;
  lang?: string;
  outputFormat?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const limits = MICROSOFT_EDGE_SPEECH;
type State = "prepared" | "configured" | "awaiting" | "complete" | "failed" | "delivered";

function invalid(code: string): never { throw new Error(code); }
function xml(value: string): string {
  return value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
function validXml(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFE\uFFFF]/.test(value);
}
function setting(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.length || value.length > 64 || !validXml(value) || /[\x00-\x1f\x7f]/.test(value)) invalid("invalid_edge_setting");
  return value;
}

export function prepareMicrosoftEdgeSpeech(input: MicrosoftEdgeSpeechInput, requestId: string): readonly [string, string] {
  if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId)) invalid("invalid_edge_request_id");
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["text", "voice", "lang", "outputFormat", "rate", "pitch", "volume"].includes(key))) invalid("invalid_edge_input");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > limits.maxTextBytes
    || !validXml(input.text)
    || encoder.encode(input.text).length > limits.maxTextBytes) invalid("invalid_edge_text");
  const voice = input.voice === undefined ? "en-US-MichelleNeural" : input.voice;
  const lang = input.lang === undefined ? "en-US" : input.lang;
  if (typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voice)
    || typeof lang !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(lang)) invalid("invalid_edge_voice");
  if (input.outputFormat !== undefined && input.outputFormat !== limits.outputFormat) invalid("unsupported_edge_output_format");
  const rate = setting(input.rate, "default"), pitch = setting(input.pitch, "default"), volume = setting(input.volume, "default");
  const config = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" + JSON.stringify({
    context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: limits.outputFormat } } },
  });
  const ssml = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n`
    + `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
    + `<voice name="${voice}"><prosody rate="${xml(rate)}" pitch="${xml(pitch)}" volume="${xml(volume)}">${xml(input.text)}</prosody></voice></speak>`;
  if (encoder.encode(config).length + encoder.encode(ssml).length > limits.maxRequestBytes) invalid("edge_request_limit");
  return Object.freeze([config, ssml] as const);
}

function headers(value: string): Map<string, string> {
  if (!value.length || value.length > limits.maxHeaderBytes || /[^\x20-\x7e\r\n]/.test(value)) invalid("invalid_edge_headers");
  const lines = value.replace(/\r\n$/, "").split("\r\n"), result = new Map<string, string>();
  if (lines.length > 16) invalid("invalid_edge_headers");
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9-]{0,63}):([^\r\n]*)$/.exec(line);
    if (!match) invalid("invalid_edge_headers");
    const key = match[1].toLowerCase();
    if (result.has(key)) invalid("invalid_edge_headers");
    result.set(key, match[2].trim());
  }
  return result;
}

export class MicrosoftEdgeSpeechCodec {
  #state: State = "prepared";
  #requestId: string;
  #requests: readonly string[];
  #audio?: Uint8Array;
  #size = 0;
  #frames = 0;
  #wireBytes = 0;
  #started = false;
  #responded = false;

  constructor(input: MicrosoftEdgeSpeechInput, requestId: string) {
    this.#requests = prepareMicrosoftEdgeSpeech(input, requestId);
    this.#requestId = requestId;
  }
  get state(): State { return this.#state; }

  // Call in order and enqueue each returned message once. This is not a remote
  // dispatch acknowledgement; only the transport owner can record that fact.
  nextRequestFrame(): string {
    if (this.#state === "prepared") { this.#state = "configured"; return this.#requests[0]; }
    if (this.#state === "configured") {
      const ssml = this.#requests[1]; this.#requests = []; this.#state = "awaiting"; return ssml;
    }
    return this.#fail("edge_request_order");
  }

  receive(frame: string | Uint8Array): void {
    if (this.#state !== "awaiting") this.#fail("edge_late_or_early_frame");
    try {
      const binary = frame instanceof Uint8Array;
      if (!binary && typeof frame !== "string") invalid("invalid_edge_frame");
      if (frame.length > (binary ? limits.maxBinaryFrameBytes : limits.maxTextFrameBytes)) invalid("edge_frame_limit");
      const bytes = binary ? frame : encoder.encode(frame);
      if (bytes.length > (binary ? limits.maxBinaryFrameBytes : limits.maxTextFrameBytes)
        || ++this.#frames > limits.maxFrames || (this.#wireBytes += bytes.length) > limits.maxWireBytes) invalid("edge_frame_limit");
      let head: Map<string, string>, body: Uint8Array;
      if (binary) {
        if (bytes.length < 2) invalid("invalid_edge_binary");
        const length = bytes[0] * 256 + bytes[1];
        if (!length || length > limits.maxHeaderBytes || length + 2 > bytes.length) invalid("invalid_edge_binary");
        head = headers(decoder.decode(bytes.subarray(2, 2 + length)));
        body = bytes.subarray(2 + length);
      } else {
        const separator = frame.indexOf("\r\n\r\n");
        if (separator < 0 || separator > limits.maxHeaderBytes) invalid("invalid_edge_headers");
        head = headers(frame.slice(0, separator));
        body = encoder.encode(frame.slice(separator + 4));
      }
      if (head.get("x-requestid") !== this.#requestId) invalid("edge_request_mismatch");
      const path = head.get("path");
      if (binary) {
        if (path !== "audio" || body.length && head.get("content-type")?.toLowerCase() !== limits.mimeType
          || !body.length && head.has("content-type") && head.get("content-type")?.toLowerCase() !== limits.mimeType) invalid("invalid_edge_audio");
        if (this.#size + body.length > limits.maxAudioBytes) invalid("edge_audio_limit");
        if (body.length) {
          this.#audio ??= new Uint8Array(limits.maxAudioBytes);
          this.#audio.set(body, this.#size); this.#size += body.length;
        }
        return;
      }
      if (!["turn.start", "response", "audio.metadata", "turn.end"].includes(path ?? "")) invalid("invalid_edge_path");
      if (body.length) {
        const type = head.get("content-type")?.toLowerCase();
        if (type !== "application/json" && type !== "application/json; charset=utf-8") invalid("invalid_edge_metadata");
        const json = JSON.parse(decoder.decode(body));
        if (!json || typeof json !== "object" || Array.isArray(json) || "error" in json || "ErrorDetails" in json || "errorDetails" in json) invalid("invalid_edge_metadata");
      }
      if (path === "turn.start") {
        if (this.#started || this.#size) invalid("edge_turn_order");
        this.#started = true;
      } else if (path === "response") {
        if (this.#responded || this.#size) invalid("edge_turn_order");
        this.#responded = true;
      } else if (path === "turn.end") {
        if (!this.#size) invalid("edge_empty_audio");
        this.#state = "complete";
      }
    } catch { this.#fail("invalid_edge_response"); }
  }

  interrupt(reason: "timeout" | "abort" | "close" | "error"): void {
    if (!["timeout", "abort", "close", "error"].includes(reason)) this.#fail("invalid_edge_interrupt");
    if (this.#state === "complete" || this.#state === "delivered" || this.#state === "failed") return;
    this.#discard(); this.#state = "failed";
  }

  takeAudio(): { requestId: string; audio: Uint8Array; mimeType: "audio/mpeg"; upstreamCostMicros: null } {
    if (this.#state !== "complete" || !this.#audio) return this.#fail("edge_audio_incomplete");
    const audio = this.#audio.subarray(0, this.#size);
    this.#audio = undefined; this.#state = "delivered";
    return { requestId: this.#requestId, audio, mimeType: limits.mimeType, upstreamCostMicros: null };
  }
  #discard(): void { this.#audio = undefined; this.#size = 0; this.#requests = []; }
  #fail(code: string): never {
    this.#discard(); if (this.#state !== "delivered") this.#state = "failed";
    return invalid(code);
  }
}
