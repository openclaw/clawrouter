import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { MiniMaxMusicCoverJson, musicCoverResponseLimits, observeMiniMaxMusic, prepareMiniMaxMusic, readMiniMaxMusicStream, type MiniMaxMusicRequest } from "./minimax-music.ts";
import { consumeMiniMaxMusicCoverResponse, type MusicCoverResponseCapability } from "./minimax-music-cover-input.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";
import { inputRetirement } from "./input-retirement.ts";

const audioLimit = 4 * 1024 * 1024, responseLimit = audioLimit * 2 + 65536;

// Common dispatch must separately qualify original global music authority.
// A speech grant, OAuth/Plan/CN credential or this leaf supplies no entitlement.
export function prepareNativeMiniMaxMusic(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.music") return;
  const streaming = mediaObject(body) && body.stream === true;
  if (provider.id !== "minimax" || provider.base_urls.default !== "https://api.minimax.io"
    || selection.capability !== "music.generate" || !model || !model.capabilities.includes("music.generate")
    || !["music-2.6", "music-2.6-free"].includes(model.upstream)
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/music_generation"
    || endpoint.response_format !== "minimax.music" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || (streaming ? endpoint.streaming !== "sse" : endpoint.streaming != null && endpoint.streaming !== "sse") || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_minimax_music_route", "MiniMax music requires its selected model and qualified global native path");
  }
  try {
    if (jsonBodyBytes(body) > 65536 || !mediaObject(body) || body.model !== model.upstream || body.stream !== false && body.stream !== true) invalid();
    if (streaming && ["audio_url", "audio_base64"].some(key => Object.hasOwn(body, key))) invalid();
    prepareMiniMaxMusic("global", body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_music_request", "MiniMax music input must match its frozen native model and explicit hex mode");
  }
  return musicResponse(model.upstream, streaming);
}

// Separate closure scope: retain primitive response context, never selection/body.
function musicResponse(model: string, streaming: boolean): NativeResponse {
  const origin = "https://api.minimax.io", path = "/v1/music_generation";
  return {
    origin, path,
    // BodyLease charges 64 MiB for JSON, hex and decoded-audio copies.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      if (streaming) {
        try {
          const observed = await readMiniMaxMusicStream(response, model, signal);
          signal.throwIfAborted();
          return { response: new Response(musicReplay(observed.audio, observed.terminal, signal), { status: 200, headers: {
            "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
          } }), usage: { tokens: null, outcome: "success" as const } };
        } catch { invalid(); }
      }
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (response.status !== 200 || response.redirected
        || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        if (response.body && !response.bodyUsed && !response.body.locked)
          await inputRetirement(response.body.getReader()).retire("cancel", signal.reason);
        invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, responseLimit, value => {
        // Bound full-file hex before the codec allocates decoded bytes.
        if (!mediaObject(value) || !mediaObject(value.data) || typeof value.data.audio !== "string"
          || value.data.audio.length > audioLimit * 2 + 2 || value.data.audio.trim().length > audioLimit * 2) invalid();
        for (const envelope of [value, value.data]) {
          if (["audio_url", "audio_base64", "file_id", "file", "url", "task_id"].some(key => Object.hasOwn(envelope, key))) invalid();
        }
        const context: MiniMaxMusicRequest = { origin, path, model, body: { stream: false }, headers: new Headers() };
        const observed = observeMiniMaxMusic([value], context, true);
        if (observed.audio.length > audioLimit) invalid();
        return { response: nativeJsonResponse(observed.frames[0], new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

// Replay one complete native terminal aggregate: the frozen consumer otherwise
// drops a longer terminal aggregate after deltas. Never retain full-file hex.
function musicReplay(audio: Uint8Array<ArrayBuffer>, terminal: Record<string, unknown>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const { data, ...rest } = terminal;
  if (!mediaObject(data)) invalid();
  const metadata = JSON.stringify({ ...rest, data: { ...data, status: 2 } });
  const encoder = new TextEncoder(), hex = "0123456789abcdef", window = 64 * 1024;
  let prefix: Uint8Array | null = encoder.encode("data: " + metadata.slice(0, -2) + ',"audio":"');
  if (prefix.byteLength > 1024 * 1024) invalid();
  const suffix = encoder.encode('"}}\n\ndata: [DONE]\n\n');
  let retained: Uint8Array | null = audio, before = 0, offset = 0, after = 0;
  // Do not keep an additional parameter reference after the owned slot retires.
  audio = new Uint8Array(0);
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const retire = () => { retained = null; prefix = null; control = undefined; signal.removeEventListener("abort", abort); };
  const abort = () => { control?.error(signal.reason); retire(); };
  return new ReadableStream<Uint8Array>({
    start(controller) { control = controller; if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); },
    pull(controller) {
      if (!retained || !prefix) { controller.close(); retire(); return; }
      if (before < prefix.length) {
        const end = Math.min(prefix.length, before + window); controller.enqueue(prefix.slice(before, end)); before = end; return;
      }
      if (offset < retained.length) {
        const count = Math.min(window / 2, retained.length - offset), chunk = new Uint8Array(count * 2);
        for (let i = 0; i < count; i++) { const byte = retained[offset++]; chunk[i * 2] = hex.charCodeAt(byte >>> 4); chunk[i * 2 + 1] = hex.charCodeAt(byte & 15); }
        controller.enqueue(chunk); return;
      }
      if (!after) { after = suffix.length; controller.enqueue(suffix); }
      controller.close(); retire();
    },
    cancel() { retire(); },
  }, { highWaterMark: 0 });
}

function invalid(): never { throw new Error("invalid_native_minimax_music_response"); }


const coverDestination = "https://api.minimax.io/v1/music_generation";
const coverFailure = () => new Error("invalid_minimax_music_cover_response");
const coverCleanup = () => Object.assign(new Error("music cover response cleanup failed"), { cleanupFailed: true });

// Register the ORIGINAL reader before headers, including failure-only disposal.
// Default readers may cancel but may never acquire an unqualified backing.
function ownCoverResponse(response: Response) {
  if (!response.body) return undefined;
  if (response.body.locked || response.bodyUsed) return { blocked: true as const };
  let byob: ReadableStreamBYOBReader | undefined, regular: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try { byob = response.body.getReader({ mode: "byob" }); }
  catch { try { regular = response.body.getReader(); } catch { return { blocked: true as const }; } }
  let reader = byob ?? regular!, first: Promise<void> | undefined, cleanupFailed = false;
  const owner = inputRetirement({ cancel() {
    if (!first) {
      let resolve!: () => void;
      first = new Promise<void>(yes => { resolve = yes; });
      try { void Promise.resolve(reader.cancel("cover response discarded")).then(resolve, () => { cleanupFailed = true; resolve(); }); }
      catch { cleanupFailed = true; resolve(); }
    }
    return first;
  }, releaseLock() { reader.releaseLock(); } });
  const retired = owner.retired.then(() => {
    byob = undefined; regular = undefined; reader = undefined!; first = undefined;
    if (cleanupFailed) throw coverCleanup();
  }, () => { throw coverCleanup(); });
  void retired.catch(() => undefined);
  return { blocked: false as const, byob: !!byob,
    read: (window: Uint8Array<ArrayBuffer>) => owner.read(() => byob ? byob.read(window) : Promise.reject(coverFailure())),
    retire(kind: "eof" | "cancel") { void owner.retire(kind).catch(() => undefined); return retired; }, retired };
}

// Failure disposal never waits for a successful allocation transfer.
export async function disposeMiniMaxMusicCoverResponse(response: Response): Promise<void> {
  const input = ownCoverResponse(response);
  if (input?.blocked) await new Promise<void>(() => undefined);
  else if (input) await input.retire("cancel");
}

export async function readNativeMiniMaxMusicCover(response: Response, successor: MusicCoverResponseCapability, signal: AbortSignal) {
  const release = consumeMiniMaxMusicCoverResponse(successor);
  let input: ReturnType<typeof ownCoverResponse>, scanner: MiniMaxMusicCoverJson | undefined;
  let eof = false, handed = false;
  const abort = () => { if (input && !input.blocked) void input.retire("cancel").catch(() => undefined); };
  try {
    input = ownCoverResponse(response);
    if (input?.blocked) await new Promise<void>(() => undefined);
    if (!input || input.blocked) throw coverFailure();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); signal.throwIfAborted(); }
    let headerCount = 0, headerBytes = 0;
    for (const [name, value] of response.headers) {
      if (++headerCount > 32) throw coverFailure();
      for (const part of [name, value]) for (let i = 0; i < part.length; i++) {
        const n = part.charCodeAt(i);
        if ((headerBytes += n < 128 ? 1 : n < 2048 ? 2 : 3) > 4096) throw coverFailure();
      }
    }
    const mime = response.headers.get("content-type"), encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
    if (!input.byob || response.status !== 200 || response.redirected || response.url !== coverDestination
      || response.headers.has("content-range") || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
      || encoding !== null && encoding.trim().toLowerCase() !== "identity"
      || length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > musicCoverResponseLimits.wire)) throw coverFailure();
    scanner = new MiniMaxMusicCoverJson();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let window: Uint8Array<ArrayBuffer> = new Uint8Array(16384), wire = 0, reads = 0;
    for (;;) {
      signal.throwIfAborted();
      if (++reads > musicCoverResponseLimits.reads) throw coverFailure();
      const part = await input.read(window);
      signal.throwIfAborted();
      if (part.value) {
        if (!(part.value instanceof Uint8Array) || !(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > 16384
          || (wire += part.value.byteLength) > musicCoverResponseLimits.wire) throw coverFailure();
        for (let offset = 0; offset < part.value.byteLength; offset += 1024) {
          const decoded = decoder.decode(part.value.subarray(offset, Math.min(part.value.length, offset + 1024)), { stream: true });
          // A carried UTF-8 prefix can produce one extra UTF-16 unit. Keep
          // scanner feeds bounded independently of decoder byte windows.
          for (let start = 0; start < decoded.length; start += 1024) scanner.push(decoded.slice(start, start + 1024));
        }
        window = new Uint8Array(part.value.buffer);
      }
      if (part.done) { eof = true; break; }
      if (!window.buffer.byteLength) throw coverFailure();
    }
    scanner.push(decoder.decode());
    if (length !== null && Number(length) !== wire) throw coverFailure();
    const audio = scanner.finish(); scanner = undefined;
    await input.retire("eof"); signal.throwIfAborted();
    signal.removeEventListener("abort", abort);
    const output = coverHexDelivery(audio, signal, release);
    handed = true;
    return { ...output, usage: { tokens: null, outcome: "success" as const }, reads, wire };
  } catch (error) {
    if (input && !input.blocked) {
      try { await input.retire(eof ? "eof" : "cancel"); } catch { throw coverCleanup(); }
    }
    throw error === signal.reason ? error : coverFailure();
  } finally {
    scanner?.discard(); signal.removeEventListener("abort", abort);
    if (!handed) release();
  }
}

function coverHexDelivery(audio: Uint8Array<ArrayBuffer>, signal: AbortSignal, release: () => void) {
  const encoder = new TextEncoder(), prefix = encoder.encode('{"base_resp":{"status_code":0},"data":{"status":2,"audio":"'), suffix = encoder.encode('"}}');
  const length = prefix.length + audio.length * 2 + suffix.length, hex = "0123456789abcdef";
  let bytes: Uint8Array<ArrayBuffer> | undefined = audio, offset = 0, phase = 0;
  audio = new Uint8Array(0);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined, resolve!: () => void;
  const retired = new Promise<void>(yes => { resolve = yes; });
  const finish = () => { bytes = undefined; controller = undefined; signal.removeEventListener("abort", abort); release(); resolve(); };
  const abort = () => { controller?.error(new Error("music cover delivery stopped")); finish(); };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    pull(value) {
      if (!bytes) return;
      if (!phase) { phase = 1; value.enqueue(prefix); return; }
      if (offset < bytes.length) {
        const count = Math.min(8192, bytes.length - offset), chunk = new Uint8Array(count * 2);
        for (let i = 0; i < count; i++) { const byte = bytes[offset++]; chunk[i * 2] = hex.charCodeAt(byte >>> 4); chunk[i * 2 + 1] = hex.charCodeAt(byte & 15); }
        value.enqueue(chunk); return;
      }
      if (phase === 1) { phase = 2; value.enqueue(suffix); return; }
      value.close(); finish();
    },
    cancel() { finish(); },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { "content-type": "application/json", "content-length": String(length),
    "cache-control": "no-store", "x-content-type-options": "nosniff" } }), retired };
}
