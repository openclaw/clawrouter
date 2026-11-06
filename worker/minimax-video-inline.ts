import { createJsonTokenizer } from "./json-tokens.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { assertVideoHeaders, videoJsonBytes, videoReadLimit, videoUnavailable, videoWindowBytes,
  type MiniMaxVideoOperation, type VideoUpload } from "./minimax-video-operation.ts";
import { qualifyMiniMaxFirstFrameBytes, type MiniMaxFirstFrame } from "./minimax-video-first-frame.ts";
import { prepareMiniMaxInlineVideoScalars } from "./minimax-video.ts";
import type { MiniMaxVideoBinding } from "../shared/minimax-video-binding.ts";

const MiB = 1024 * 1024, imageLimit = 8 * MiB, scalarLimit = 64 * 1024;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const prefixes = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"] as const;
type JsonObject = Record<string, unknown>;
type Frame = { array: boolean; path: string; key?: string; keys: Set<string>; index: number; value?: JsonObject | unknown[] };
type InlineState = { image?: MiniMaxFirstFrame; plan?: JsonObject; digest?: string; context?: string;
  authority?: string; used: boolean; released: boolean };
const states = new WeakMap<MiniMaxVideoOperation, InlineState>();
const plans = new WeakMap<object, InlineState>();

// Only this writer can mutate the backing. It is revoked before qualification,
// hashing or dispatch; neither bytes nor a caller-reconstructible permit escape.
class ImageWriter {
  private bytes: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(imageLimit);
  private prefix = "";
  private mime?: MiniMaxFirstFrame["mimeType"];
  private quartet: number[] = [];
  private padded = false;
  private offset = 0;
  private pending = new Uint8Array(1024);
  private count = 0;
  credits = 0;
  push(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (!this.mime) {
        this.prefix += char;
        if (!prefixes.some(prefix => prefix.startsWith(this.prefix))) videoUnavailable();
        const index = prefixes.indexOf(this.prefix as typeof prefixes[number]);
        if (index >= 0) this.mime = (["image/png", "image/jpeg", "image/webp"] as const)[index];
        continue;
      }
      if (this.padded) videoUnavailable();
      const digit = char === "=" ? 64 : alphabet.indexOf(char);
      if (digit < 0) videoUnavailable();
      this.credits++;
      this.quartet.push(digit);
      if (this.quartet.length !== 4) continue;
      const [a, b, c, d] = this.quartet;
      if (a === 64 || b === 64 || c === 64 && (d !== 64 || b & 15) || d === 64 && c !== 64 && (c & 3)) videoUnavailable();
      const size = c === 64 ? 1 : d === 64 ? 2 : 3;
      if (this.offset + this.count + size > imageLimit || this.count + size > this.pending.length) videoUnavailable();
      this.pending[this.count++] = a << 2 | b >>> 4;
      if (size > 1) this.pending[this.count++] = b << 4 | c >>> 2;
      if (size > 2) this.pending[this.count++] = c << 6 | d;
      this.padded = size !== 3; this.quartet.length = 0;
    }
  }
  commit(): void {
    if (!this.bytes) videoUnavailable();
    this.bytes.set(this.pending.subarray(0, this.count), this.offset);
    this.offset += this.count; this.count = 0;
  }
  close(): MiniMaxFirstFrame {
    if (!this.bytes || !this.mime || !this.offset || this.count || this.quartet.length) videoUnavailable();
    const bytes = this.bytes; this.bytes = undefined;
    return qualifyMiniMaxFirstFrameBytes(bytes.subarray(0, this.offset), this.mime);
  }
  discard(): void { this.bytes = undefined; this.pending = new Uint8Array(0); this.quartet.length = 0; }
}

// All occurrences are checked, including discarded response metadata. The
// tokenizer receives <=1KiB UTF8 feeds; no full JSON text or base64 is retained.
function projector(mode: "native" | "manifest" | "response", beginImage?: () => ImageWriter) {
  const response = mode === "response", max = response ? 4096 : 128;
  const stack: Frame[] = [];
  let root: unknown, values = 0, members = 0, entries = 0, units = 0;
  let text = "", scalarUnits = 0, key = false, number = false, path = "", keep = false;
  let image: ImageWriter | undefined, activeImage = false, imageEnded = false;
  const imagePath = mode === "manifest" ? "body.first_frame_image" : "first_frame_image";
  const retained = (name: string) => !response || ["task_id", "status", "file_id", "video_url", "error", "base_resp", "base_resp.status_code", "base_resp.status_msg"].includes(name);
  const nextPath = () => {
    const parent = stack.at(-1);
    if (!parent) return "";
    if (parent.array) return "#";
    if (parent.key === "first_frame_image") {
      if (!(stack.length === 1 && mode === "native" || stack.length === 2 && parent.path === "body" && mode === "manifest")) videoUnavailable();
      return imagePath;
    }
    if (stack.length === 1) return ["body", "task_id", "status", "file_id", "video_url", "error", "base_resp"].includes(parent.key ?? "") ? parent.key! : "#";
    return stack.length === 2 && parent.path === "base_resp" && ["status_code", "status_msg"].includes(parent.key ?? "") ? "base_resp." + parent.key : "#";
  };
  const start = () => {
    if (++values > max || stack.length + 1 > (response ? 32 : 16)) videoUnavailable();
    const parent = stack.at(-1);
    if (parent?.array && ++entries > max) videoUnavailable();
    path = nextPath(); keep = retained(path);
    if (response && path === "error") videoUnavailable();
    if (!response && path.endsWith("first_frame_image") && path !== imagePath) videoUnavailable();
  };
  const assign = (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) root = value;
    else if (parent.array) { if (parent.value) (parent.value as unknown[]).push(value); parent.index++; }
    else { if (parent.value && retained(nextPath()) && parent.key !== "first_frame_image") Object.defineProperty(parent.value, parent.key!, { value, writable: true, configurable: true, enumerable: true }); parent.key = undefined; }
  };
  const parser = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray": {
        start();
        if (path === imagePath || response && retained(path) && path !== "" && path !== "base_resp") videoUnavailable();
        const array = token.name === "startArray";
        if (!stack.length && array || response && path === "base_resp" && array) videoUnavailable();
        const value = keep || !stack.length ? array ? [] : {} : undefined;
        const currentPath = path; assign(value);
        stack.push({ array, path: currentPath, keys: new Set(), index: 0, value }); break;
      }
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": if (++members > max) videoUnavailable(); key = true; text = ""; scalarUnits = 0; break;
      case "endKey": {
        const parent = stack.at(-1)!;
        if (parent.keys.has(text)) videoUnavailable();
        parent.keys.add(text); parent.key = text; key = false; text = ""; break;
      }
      case "startString":
        start(); text = ""; scalarUnits = 0;
        activeImage = !response && path === imagePath;
        if (activeImage) { if (image || !beginImage) videoUnavailable(); image = beginImage(); }
        break;
      case "stringChunk":
        if (activeImage && !key) { image!.push(token.value); break; }
        if ((scalarUnits += token.value.length) > (response ? 65536 : 16384)
          || (units += token.value.length) > (response ? 262144 : 32768)) videoUnavailable();
        if (key || keep) text += token.value;
        break;
      case "endString":
        if (activeImage) { activeImage = false; imageEnded = true; assign(undefined); }
        else assign(text);
        text = ""; break;
      case "startNumber": start(); if (path === imagePath) videoUnavailable(); text = ""; number = true; break;
      case "numberChunk": if (text.length + token.value.length > 128) videoUnavailable(); text += token.value; break;
      case "endNumber": {
        const value = response && ["task_id", "file_id"].includes(path) ? text : Number(text);
        if (typeof value === "number" && !Number.isFinite(value)) videoUnavailable();
        assign(value); text = ""; number = false; break;
      }
      case "nullValue": case "trueValue": case "falseValue":
        start(); if (path === imagePath) videoUnavailable();
        assign(token.name === "nullValue" ? null : token.name === "trueValue"); break;
    }
  });
  return {
    push: parser.push,
    credit: () => image?.credits ?? 0,
    commit: () => image?.commit(),
    end() {
      parser.end();
      if (stack.length || number || !root || typeof root !== "object" || Array.isArray(root) || image && !imageEnded) videoUnavailable();
      if (response) {
        const body = root as JsonObject;
        if (Object.hasOwn(body, "video_url") && (body.status !== "Success" || typeof body.video_url !== "string") || videoJsonBytes(body, "native") > scalarLimit) videoUnavailable();
      }
      return { body: root as JsonObject, image: image?.close() };
    },
    discard: () => image?.discard(),
  };
}

async function readProjected(source: Request | Response, signal: AbortSignal, mode: "native" | "manifest" | "response",
  register: (input: InputRetirement, source: Request | Response) => void, beginImage?: () => ImageWriter) {
  if (!source.body || source.bodyUsed || source.body.locked) videoUnavailable();
  let reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>, byob = false;
  try { reader = source.body.getReader({ mode: "byob" }); byob = true; } catch { reader = source.body.getReader(); }
  let first: Promise<void> | undefined;
  const base = inputRetirement({ cancel(reason) { first ??= Promise.resolve().then(() => reader.cancel(reason)); void first.catch(() => undefined); return first; }, releaseLock: () => reader.releaseLock() });
  const retired = base.retired.then(() => first); void retired.catch(() => undefined);
  const input: InputRetirement = { read: fn => base.read(fn), retired,
    retire(kind, reason) { void base.retire(kind, reason).catch(() => undefined); return retired; } };
  const parse = projector(mode, beginImage), decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = 0, reads = 0, eof = false;
  const abort = () => { void input.retire("cancel", signal.reason).catch(() => undefined); };
  try {
    register(input, source);
    signal.addEventListener("abort", abort, { once: true }); signal.throwIfAborted();
    if (!byob) videoUnavailable();
    assertVideoHeaders(source.headers);
    const cap = mode === "response" ? MiB : 12 * MiB;
    const length = source.headers.get("content-length"), mime = source.headers.get("content-type");
    if (source instanceof Response && (source.status !== 200 || source.redirected)
      || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
      || source.headers.has("content-range") || ![null, "identity"].includes(source.headers.get("content-encoding"))
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > cap)) videoUnavailable();
    let window = new Uint8Array(videoWindowBytes);
    for (;;) {
      signal.throwIfAborted(); if (++reads > videoReadLimit) videoUnavailable();
      const result = await input.read(() => (reader as ReadableStreamBYOBReader).read(window));
      signal.throwIfAborted();
      if (result.value && (!(result.value.buffer instanceof ArrayBuffer) || result.value.buffer.byteLength > videoWindowBytes)) videoUnavailable();
      if (result.done) { if (result.value?.byteLength) videoUnavailable(); eof = true; break; }
      if (!result.value || !result.value.buffer.byteLength) videoUnavailable();
      for (let at = 0; at < result.value.length; at += 256) {
        const feed = result.value.subarray(at, at + 256);
        if ((raw += feed.length) > cap) videoUnavailable();
        parse.push(decoder.decode(feed, { stream: true }));
        // Raw whitespace, punctuation, prefix and JSON escape overhead are not
        // base64 credits. Only canonical decoded ASCII payload earns one byte.
        if (mode !== "response" && raw - parse.credit() > scalarLimit) videoUnavailable();
        parse.commit();
      }
      window = new Uint8Array(result.value.buffer);
    }
    parse.push(decoder.decode()); parse.commit();
    const value = parse.end();
    if (length !== null && Number(length) !== raw) videoUnavailable();
    await input.retire("eof"); return value;
  } catch (error) {
    parse.discard(); void input.retire(eof ? "eof" : "cancel", error).catch(() => undefined); throw error;
  } finally { signal.removeEventListener("abort", abort); }
}

export async function readMiniMaxVideoInput(request: Request, owner: MiniMaxVideoOperation, route: "native" | "manifest"): Promise<JsonObject> {
  const state: InlineState = { used: false, released: false };
  const value = await readProjected(request, owner.operation.signal, route, owner.registerInput, () => {
    owner.selectInlineProfile(() => {
      state.released = true; state.image = undefined; state.context = undefined; state.authority = undefined;
      if (state.plan) plans.delete(state.plan); state.plan = undefined; states.delete(owner);
    });
    states.set(owner, state); return new ImageWriter();
  });
  state.image = value.image;
  return value.body;
}
export function hasMiniMaxVideoInline(owner: MiniMaxVideoOperation): boolean { return states.has(owner); }
export function miniMaxInlineScalars(value: object): boolean { const state = plans.get(value); return !!state && !state.released && state.plan === value; }

export async function bindMiniMaxVideoInline(owner: MiniMaxVideoOperation, body: JsonObject, context: readonly unknown[]): Promise<void> {
  const state = states.get(owner); if (!state) return;
  if (!state.image || state.plan || state.released) videoUnavailable();
  prepareMiniMaxInlineVideoScalars(body);
  if (videoJsonBytes(body, "input") > 16 * 1024) videoUnavailable();
  videoJsonBytes(context);
  state.context = JSON.stringify(context);
  state.plan = Object.freeze(body); plans.set(body, state);
  // The writer is already revoked. WebCrypto snapshots the populated view;
  // register the ACTUAL promise before the public operation can race it.
  const hash = owner.track(crypto.subtle.digest("SHA-256", state.image.bytes));
  const digest = await hash;
  state.digest = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
export function assertMiniMaxVideoInlineOwner(owner: MiniMaxVideoOperation, binding: MiniMaxVideoBinding | null,
  context: readonly unknown[], identity: readonly unknown[]): void {
  const state = states.get(owner); if (!state) return;
  videoJsonBytes(context); videoJsonBytes(identity);
  if (state.released || !state.image || !state.plan || !state.digest || state.used
    || binding?.version !== "clawrouter.minimax-video.v2" || binding.region !== "global"
    || binding.origin !== "https://api.minimax.io" || state.context !== JSON.stringify(context)) videoUnavailable();
  const next = JSON.stringify(identity);
  if (state.authority !== undefined && state.authority !== next) videoUnavailable();
  state.authority = next;
}
export function miniMaxInlineDigest(owner: MiniMaxVideoOperation, body: object): unknown[] | undefined {
  const state = states.get(owner); if (!state) return;
  if (state.plan !== body || !state.image || !state.digest || state.released) videoUnavailable();
  return ["clawrouter.minimax-inline-first-frame.v1", state.context, "first_frame_image", state.image.mimeType,
    state.image.bytes.length, state.image.width, state.image.height, state.digest];
}

export function miniMaxVideoUpload(owner: MiniMaxVideoOperation, body: object): VideoUpload | undefined {
  const state = states.get(owner); if (!state) return;
  if (state.plan !== body || !state.authority || state.used || state.released || !state.image) videoUnavailable();
  state.used = true;
  if (videoJsonBytes(body, "input") > 16 * 1024) videoUnavailable();
  const length = videoJsonBytes(body, "input") - 1 + ',"first_frame_image":"data:'.length
    + state.image.mimeType.length + ';base64,'.length + Math.ceil(state.image.bytes.length / 3) * 4 + 2;
  if (length > 12 * MiB) videoUnavailable();
  let image: MiniMaxFirstFrame | undefined = state.image;
  let prefix = JSON.stringify(body).slice(0, -1) + ',"first_frame_image":"data:' + image.mimeType + ';base64,';
  let offset = 0, prefixAt = 0, tailAt = 0, closed = false, stopping = false, pending: Promise<void> | undefined;
  let first: Promise<void> | undefined;
  const tail = '"}', encoder = new TextEncoder();
  let resolve!: () => void, reject!: (error: unknown) => void;
  const retired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void retired.catch(() => undefined);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const end = () => { if (closed) return; closed = true; image = undefined; prefix = ""; resolve(); };
  const stop = () => {
    if (first) return first;
    first = retired; stopping = true;
    void Promise.resolve(pending).then(end, error => { reject(error); end(); });
    return first;
  };
  const discard = () => { const result = stop(); if (!closed) controller?.error(new Error("video upload discarded")); return result; };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(output) {
      if (pending || closed || stopping) return;
      pending = Promise.resolve().then(() => {
        if (closed || stopping || !image) return;
        const chunk = new Uint8Array(videoWindowBytes); let size = 0;
        if (prefixAt < prefix.length) {
          const result = encoder.encodeInto(prefix.slice(prefixAt), chunk);
          prefixAt += result.read; size += result.written;
        }
        while (prefixAt === prefix.length && offset < image.bytes.length && size + 4 <= chunk.length) {
          const a = image.bytes[offset++], hasB = offset < image.bytes.length, b = hasB ? image.bytes[offset++] : 0;
          const hasC = offset < image.bytes.length, c = hasC ? image.bytes[offset++] : 0;
          chunk[size++] = alphabet.charCodeAt(a >>> 2); chunk[size++] = alphabet.charCodeAt((a & 3) << 4 | b >>> 4);
          chunk[size++] = hasB ? alphabet.charCodeAt((b & 15) << 2 | c >>> 6) : 61;
          chunk[size++] = hasC ? alphabet.charCodeAt(c & 63) : 61;
        }
        while (offset === image.bytes.length && tailAt < tail.length && size < chunk.length) chunk[size++] = tail.charCodeAt(tailAt++);
        if (size) output.enqueue(chunk.subarray(0, size));
        else { output.close(); end(); }
      }).finally(() => { pending = undefined; });
      return pending;
    },
    cancel() { return stop(); },
  }, { highWaterMark: 0 });
  return { body: stream, retired, discard };
}

export async function readMiniMaxInlineResponse(response: Response, signal: AbortSignal,
  register: (input: InputRetirement, source: Request | Response) => void): Promise<JsonObject> {
  return (await readProjected(response, signal, "response", register)).body;
}
