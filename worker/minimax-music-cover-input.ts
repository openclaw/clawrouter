import { BodyLease } from "./body-budget.ts";
import { createJsonTokenizer } from "./json-tokens.ts";

// Inactive, application-owned intake/hash foundation. This is neither audio
// qualification nor an authority, provider request or transport implementation.
const KiB = 1024, MiB = 1024 * KiB;
export const musicCoverInputLimits = Object.freeze({
  decoded: 50_000_000, wire: 66_732_204, nonAudio: 64 * KiB,
  backing: 16 * KiB, feed: 256, reads: 8192, scalarPlan: 4 * KiB,
  reservation: 96 * MiB, hashPhase: 100_655_360, slack: 7936,
  remainder: Object.freeze([64, 128, 32, 64, 32, 64, 256].map(value => value * KiB)),
  records: 12, recordCell: 16 * KiB, unusedRecordAllowance: 64 * KiB,
});
type Failure = "capacity" | "invalid" | "cancelled" | "deadline" | "hash" | "cleanup" | "used";
type Phase = "intake" | "hash" | "sealed" | "retired";
const failure = (code: Failure) => Object.assign(new Error("music cover input " + code), { code });
const invalid = (): never => { throw failure("invalid"); };
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface MusicCoverInputSource {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  deadlineAt: number;
  route: "native" | "manifest";
  contentType: string;
  contentEncoding?: string;
  contentLength?: number;
}
export interface MusicCoverInputMetadata {
  readonly model: "music-cover";
  readonly prompt: string;
  readonly lyrics?: string;
  readonly bytes: number;
  readonly sha256: string;
}
// No bytes, writer, caller reconstructible permission or dispatch API escapes.
export interface SealedMusicCoverInput { readonly kind: "minimax-cover-input.v1" }
const sealedOwners = new WeakMap<SealedMusicCoverInput, CoverInputOwner>();

class AudioWriter {
  private bytes: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(musicCoverInputLimits.decoded);
  private quartet = 0;
  private digits = 0;
  private padding = 0;
  private ended = false;
  length = 0;
  push(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const digit = text[i] === "=" ? 64 : alphabet.indexOf(text[i]);
      if (!this.bytes || digit < 0 || this.ended || this.padding && digit !== 64) invalid();
      if (digit === 64) {
        if (this.digits < 2 || ++this.padding > 2) invalid();
      }
      this.quartet = this.quartet * 64 + (digit === 64 ? 0 : digit); this.digits++;
      if (this.digits !== 4) continue;
      if (this.padding === 2 && (this.quartet & 0xffff) || this.padding === 1 && (this.quartet & 0xff)) invalid();
      const count = 3 - this.padding;
      if (this.length + count > this.bytes.length) invalid();
      this.bytes[this.length++] = this.quartet >>> 16;
      if (count > 1) this.bytes[this.length++] = this.quartet >>> 8;
      if (count > 2) this.bytes[this.length++] = this.quartet;
      this.ended = this.padding > 0; this.digits = 0; this.quartet = 0;
    }
  }
  seal(): Uint8Array<ArrayBuffer> {
    if (!this.bytes || !this.length || this.digits) invalid();
    const view = this.bytes.subarray(0, this.length); this.bytes = undefined;
    return view;
  }
  discard(): void { this.bytes = undefined; }
}

// Independent RAW accounting, before tokenizer copies. Keys are canonical
// ASCII in this private profile. Escapes in values remain JSON-compatible;
// every escape byte (including escaped base64) spends the non-audio budget.
class WireCounter {
  raw = 0;
  nonAudio = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private isKey = false;
  private audio = false;
  private key = "";
  private expectKey = false;
  private value = false;
  private readonly route: "native" | "manifest";
  constructor(route: "native" | "manifest") { this.route = route; }
  inspect(bytes: Uint8Array): void {
    if (this.raw + bytes.length > musicCoverInputLimits.wire) invalid();
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]; let credit = false;
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) { if (this.isKey) invalid(); this.escaped = true; }
        else if (byte === 34) { this.quoted = false; this.audio = false; }
        else if (this.isKey) {
          if (byte < 32 || byte > 126 || this.key.length >= 32) invalid();
          this.key += String.fromCharCode(byte);
        } else if (this.audio && (byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122
          || byte >= 48 && byte <= 57 || byte === 43 || byte === 47 || byte === 61)) credit = true;
      } else if (byte === 34) {
        this.quoted = true; this.isKey = this.expectKey && !this.value;
        if (this.isKey) this.key = "";
        this.audio = !this.isKey && this.key === "audio_base64" && this.depth === (this.route === "native" ? 1 : 2);
      } else if (byte === 123) {
        if (++this.depth > (this.route === "native" ? 1 : 2)) invalid();
        this.expectKey = true; this.value = false;
      } else if (byte === 125) { if (--this.depth < 0) invalid(); this.value = false; }
      else if (byte === 91 || byte === 93) invalid();
      else if (byte === 58) { this.value = true; this.expectKey = false; }
      else if (byte === 44) { this.expectKey = true; this.value = false; }
      this.raw++;
      if (!credit && ++this.nonAudio > musicCoverInputLimits.nonAudio) invalid();
    }
  }
}

type Plan = { model: "music-cover"; prompt: string; lyrics?: string };
function scalarBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) invalid(); bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
  }
  return bytes;
}
function characters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++, count++) if (text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff) i++;
  return count;
}

// Closed flat scalar grammar: no AST, discarded metadata, arrays, number
// accumulation or unknown fields. The raw scanner caps structural depth BEFORE
// each <=256-byte tokenizer feed, including feeds that subsequently throw.
function intakeParser(route: "native" | "manifest") {
  let writer: AudioWriter | undefined, depth = 0, key = "", text = "", keyMode = false, audio = false;
  let seen = 0, rootSeen = false, units = 0, model = "", prompt = "", lyrics: string | undefined;
  const scope = route === "native" ? 1 : 2;
  const parser = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject":
        if (++depth > scope || depth === 1 && rootSeen || depth === 2 && key !== "body") invalid();
        rootSeen = true; key = ""; break;
      case "endObject": if (depth-- < 1) invalid(); break;
      case "startKey": keyMode = true; text = ""; break;
      case "endKey": {
        key = text; keyMode = false; text = "";
        const bit = depth === scope ? ["model", "prompt", "lyrics", "audio_base64"].indexOf(key) : key === "body" ? 4 : -1;
        if (bit < 0 || seen & 1 << bit) invalid(); seen |= 1 << bit; break;
      }
      case "startString": if (depth !== scope || !key) invalid(); audio = key === "audio_base64"; text = "";
        if (audio) { if (writer) invalid(); writer = new AudioWriter(); } break;
      case "stringChunk":
        if (audio && !keyMode) writer!.push(token.value);
        else {
          if (text.length + token.value.length > (keyMode ? 32 : 2000) || (units += token.value.length) > 4096) invalid();
          text += token.value;
        }
        break;
      case "endString":
        if (key === "model") model = text;
        else if (key === "prompt") prompt = text;
        else if (key === "lyrics") lyrics = text;
        else if (!audio) invalid();
        audio = false; text = ""; key = ""; break;
      default: invalid();
    }
  });
  return {
    push: parser.push,
    end() {
      parser.end();
      if (depth || !rootSeen || !writer || model !== "music-cover" || characters(prompt) < 10 || characters(prompt) > 300
        || lyrics !== undefined && (characters(lyrics) < 10 || characters(lyrics) > 1000)) invalid();
      // No stringify/encoding copy; the closed plan has at most eight admitted
      // 4KiB representations, including keys, quotes and worst JSON escaping.
      let serialized = 64;
      for (const scalar of [model, prompt, lyrics ?? ""]) {
        serialized += scalarBytes(scalar);
        for (let i = 0; i < scalar.length; i++) serialized += scalar.charCodeAt(i) < 32 ? 5 : scalar[i] === '"' || scalar[i] === "\\" ? 1 : 0;
      }
      if (serialized > musicCoverInputLimits.scalarPlan) invalid();
      const plan: Plan = Object.freeze(lyrics === undefined ? { model: "music-cover", prompt } : { model: "music-cover", prompt, lyrics });
      const bytes = writer.seal(); writer = undefined;
      return { bytes, plan };
    },
    discard() { writer?.discard(); writer = undefined; text = key = model = prompt = ""; lyrics = undefined; },
  };
}

export interface MusicCoverInputOperation {
  readonly result: Promise<SealedMusicCoverInput>;
  readonly retired: Promise<void>;
  discard(): Promise<void>;
  snapshot(): Readonly<{ phase: Phase; reads: number; wire: number; nonAudio: number; maxBacking: number;
    maxFeed: number; digestStarted: boolean; claimed: boolean; cleanupFailed: boolean }>;
}

class CoverInputOwner {
  readonly lease = new BodyLease();
  phase: Phase = "intake";
  reads = 0; wire = 0; nonAudio = 0; maxBacking = 0; maxFeed = 0;
  claimed = false; cleanupFailed = false; digestStarted = false;
  private bytes?: Uint8Array<ArrayBuffer>;
  private metadata?: MusicCoverInputMetadata;
  private reader?: ReadableStreamBYOBReader;
  private pending?: Promise<ReadableStreamReadResult<Uint8Array>>;
  private cancellation?: Promise<void>;
  private digest?: Promise<ArrayBuffer>;
  private stopped?: Failure;
  private timer?: ReturnType<typeof setTimeout>;
  private deadlineAt = 0;
  private signal?: AbortSignal;
  private settled = false;
  private resolveResult!: (input: SealedMusicCoverInput) => void;
  private rejectResult!: (error: Error) => void;
  private releaseTerminal!: () => void;
  private readonly terminal = new Promise<void>(resolve => { this.releaseTerminal = resolve; });
  readonly result = new Promise<SealedMusicCoverInput>((resolve, reject) => { this.resolveResult = resolve; this.rejectResult = reject; });
  private resolveRetired!: () => void;
  private rejectRetired!: (error: Error) => void;
  readonly retired = new Promise<void>((resolve, reject) => { this.resolveRetired = resolve; this.rejectRetired = reject; });
  private readonly abort = () => this.stop("cancelled");

  constructor(source: MusicCoverInputSource) {
    void this.result.catch(() => undefined); void this.retired.catch(() => undefined);
    if (!this.lease.grow(48 * MiB)) { this.fail("capacity"); this.phase = "retired"; this.resolveRetired(); return; }
    this.signal = source.signal;
    try {
      if (!Number.isSafeInteger(source.deadlineAt)) invalid();
      const remaining = source.deadlineAt - Date.now();
      if (remaining <= 0 || remaining > 300_000) throw failure("deadline");
      this.deadlineAt = source.deadlineAt;
      if ((source.route !== "native" && source.route !== "manifest") || source.contentType !== "application/json"
        || source.contentEncoding !== undefined && source.contentEncoding !== "identity"
        || source.contentLength !== undefined && (!Number.isSafeInteger(source.contentLength) || source.contentLength < 1 || source.contentLength > musicCoverInputLimits.wire)
        || !source.body || source.body.locked) invalid();
      // A default reader cannot bound the producer's next backing before read.
      this.reader = source.body.getReader({ mode: "byob" });
      this.signal.addEventListener("abort", this.abort, { once: true });
      this.timer = setTimeout(() => this.stop("deadline"), remaining);
      if (this.signal.aborted) this.stop("cancelled");
      // Only reader + bounded scalar values cross the asynchronous boundary.
      void this.run(source.route, source.contentLength).then(() => this.complete(), () => this.complete());
    } catch {
      this.fail(source.signal.aborted ? "cancelled" : "invalid");
      if (!source.body?.locked && !this.reader) this.cancelBody(source.body);
      void this.complete();
    }
  }
  private fail(code: Failure): void {
    if (!this.settled) { this.settled = true; this.rejectResult(failure(code)); }
  }
  private stop(code: Failure): void {
    this.stopped ??= code; this.fail(code); this.cancelReader(); this.releaseTerminal();
  }
  private check(): void {
    if (!this.stopped && Date.now() >= this.deadlineAt) this.stop("deadline");
    if (this.stopped) throw failure(this.stopped);
  }
  private cancelBody(body?: ReadableStream<Uint8Array>): void {
    if (!body || this.cancellation) return;
    // Memoize BEFORE invocation, including synchronous reentrant rejection.
    let resolve!: () => void;
    this.cancellation = new Promise<void>(yes => { resolve = yes; });
    try { void Promise.resolve(body.cancel("cover input stopped")).then(resolve, () => { this.cleanupFailed = true; resolve(); }); }
    catch { this.cleanupFailed = true; resolve(); }
  }
  private cancelReader(): void {
    if (!this.reader || this.cancellation) return;
    let resolve!: () => void;
    this.cancellation = new Promise<void>(yes => { resolve = yes; });
    try { void Promise.resolve(this.reader.cancel("cover input stopped")).then(resolve, () => { this.cleanupFailed = true; resolve(); }); }
    catch { this.cleanupFailed = true; resolve(); }
  }
  private async intake(route: "native" | "manifest", contentLength?: number) {
    const parser = intakeParser(route), counter = new WireCounter(route), decoder = new TextDecoder("utf-8", { fatal: true });
    let window: Uint8Array<ArrayBuffer> = new Uint8Array(musicCoverInputLimits.backing);
    try {
      for (;;) {
        this.check();
        if (++this.reads > musicCoverInputLimits.reads) invalid();
        // No per-read race. The public result is separate from physical work.
        this.pending = this.reader!.read(window).then(part => part, () => { throw failure("invalid"); });
        const part = await this.pending; this.pending = undefined;
        this.check();
        if (part.value) {
          if (!(part.value instanceof Uint8Array) || part.value.buffer.byteLength > musicCoverInputLimits.backing) invalid();
          this.maxBacking = Math.max(this.maxBacking, part.value.buffer.byteLength);
          for (let offset = 0; offset < part.value.byteLength; offset += musicCoverInputLimits.feed) {
            const feed = part.value.subarray(offset, Math.min(part.value.byteLength, offset + musicCoverInputLimits.feed));
            counter.inspect(feed); this.wire = counter.raw; this.nonAudio = counter.nonAudio;
            this.maxFeed = Math.max(this.maxFeed, feed.length);
            parser.push(decoder.decode(feed, { stream: true }));
          }
          window = new Uint8Array(part.value.buffer);
        }
        if (part.done) break;
        if (!window.buffer.byteLength) invalid();
      }
      parser.push(decoder.decode());
      if (contentLength !== undefined && contentLength !== this.wire) invalid();
      const value = parser.end();
      this.reader!.releaseLock(); this.reader = undefined;
      return value;
    } finally { parser.discard(); }
  }
  private async run(route: "native" | "manifest", contentLength?: number): Promise<void> {
    try {
      const value = await this.intake(route, contentLength);
      this.bytes = value.bytes;
      this.check();
      this.phase = "hash"; this.digestStarted = true;
      // WebCrypto owns its snapshot. Pass the populated original view directly;
      // no slice, encoded archive, manual crypto or abort-race copy.
      this.digest = crypto.subtle.digest("SHA-256", this.bytes).then(hash => hash, () => { throw failure("hash"); });
      const hash = new Uint8Array(await this.digest); this.digest = undefined;
      this.check();
      if (hash.byteLength !== 32 || hash.buffer.byteLength !== 32) throw failure("hash");
      let sha256 = ""; for (let i = 0; i < hash.length; i++) sha256 += hash[i].toString(16).padStart(2, "0");
      this.metadata = Object.freeze({ ...value.plan, bytes: this.bytes.length, sha256 });
      const sealed: SealedMusicCoverInput = Object.freeze({ kind: "minimax-cover-input.v1" });
      sealedOwners.set(sealed, this);
      this.phase = "sealed"; this.settled = true; this.resolveResult(sealed);
      await this.terminal;
    } catch {
      this.fail(this.stopped ?? (this.phase === "hash" ? "hash" : "invalid")); this.cancelReader();
    }
  }
  private async complete(): Promise<void> {
    // Initiate cancellation before joining. No root waits for this completion.
    this.cancelReader();
    try { await this.pending; } catch { /* sanitized primary failure already recorded */ }
    try { await this.digest; } catch { /* actual digest settlement, never early release */ }
    await this.cancellation;
    try { this.reader?.releaseLock(); } catch { this.cleanupFailed = true; }
    this.reader = undefined; this.pending = undefined; this.digest = undefined;
    this.bytes = undefined; this.metadata = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.abort); this.signal = undefined;
    this.phase = "retired"; this.lease.release();
    if (this.cleanupFailed) this.rejectRetired(failure("cleanup")); else this.resolveRetired();
  }
  claim(): MusicCoverInputMetadata {
    this.check();
    if (this.claimed || this.phase !== "sealed" || this.stopped || !this.metadata) throw failure("used");
    this.claimed = true; return this.metadata;
  }
  discard(): Promise<void> { if (this.phase !== "retired") this.stop("cancelled"); return this.retired; }
  snapshot() { return Object.freeze({ phase: this.phase, reads: this.reads, wire: this.wire, nonAudio: this.nonAudio,
    maxBacking: this.maxBacking, maxFeed: this.maxFeed, digestStarted: this.digestStarted,
    claimed: this.claimed, cleanupFailed: this.cleanupFailed }); }
}

export function beginMiniMaxMusicCoverInput(source: MusicCoverInputSource): MusicCoverInputOperation {
  const owner = new CoverInputOwner(source);
  return Object.freeze({ result: owner.result, retired: owner.retired,
    discard: () => owner.discard(), snapshot: () => owner.snapshot() });
}
export function claimMiniMaxMusicCoverInput(input: SealedMusicCoverInput): MusicCoverInputMetadata {
  const owner = sealedOwners.get(input); if (!owner) throw failure("used");
  return owner.claim();
}
