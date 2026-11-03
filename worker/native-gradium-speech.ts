import { validateGradiumSpeech } from "./gradium-speech.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const outputLimit = 16 * 1024 * 1024;
const speechPath = "/api/post/speech/tts";

// Admission, credentials, dispatch and settlement stay in the shared runtime.
export function prepareNativeGradiumSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { endpoint, body } = selection;
  if (endpoint.request_format !== "gradium.speech") return;
  if (selection.model !== null || selection.method !== "POST" || endpoint.method !== "POST" || selection.capability !== "audio.speech"
    || endpoint.path !== speechPath || endpoint.upstreamPath !== undefined && endpoint.upstreamPath !== speechPath
    || endpoint.response_format !== "audio.binary" || Object.keys(selection.pathParams).length
    || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough) {
    throw new HttpError(400, "invalid_native_gradium_route", "Gradium unary speech requires its qualified model-less binary route");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "model")) {
    throw new HttpError(400, "invalid_native_gradium_request", "Gradium unary speech requires qualified native JSON settings");
  }
  try {
    validateGradiumSpeech(body);
  } catch {
    throw new HttpError(400, "invalid_native_gradium_request", "Gradium unary speech requires qualified native JSON settings");
  }
  // The native ulaw_8000 HTTP MIME pair is unqualified. Reject it before paid
  // dispatch instead of guessing PCM, changing the format or labeling raw bytes.
  const mime = body.output_format === "wav" ? "audio/wav" : body.output_format === "opus" ? "audio/ogg" : undefined;
  if (!mime) throw new HttpError(400, "unsupported_gradium_binary_format", "this native binary route qualifies WAV and Ogg Opus only");
  return {
    origin: "https://api.gradium.ai", path: speechPath,
    // BodyLease charges twice this size for incoming bytes plus complete output.
    // The dispatcher acquires it before egress and owns release through delivery.
    acquire: () => nativeResponseLease(outputLimit),
    async read(response, signal) {
      const bytes = await readAudio(response, mime, signal);
      // A stream avoids another full-buffer copy in Response's body constructor.
      const audio = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      return { response: new Response(audio, { status: 200, headers: {
        "content-type": mime, "content-length": String(bytes.byteLength), "cache-control": "no-store", "x-content-type-options": "nosniff",
      } }), usage: { tokens: null, outcome: "success" } };
    },
  };
}

async function readAudio(response: Response, mime: string, signal: AbortSignal): Promise<Uint8Array> {
  const contentType = response.headers.get("content-type")?.trim().toLowerCase();
  const qualifiedMime = contentType === mime || mime === "audio/ogg" && /^audio\/ogg\s*;\s*codecs\s*=\s*(?:opus|"opus")$/.test(contentType ?? "");
  const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range") || !qualifiedMime
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > outputLimit)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_gradium_binary_response");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    // One bounded buffer avoids an unbounded list of tiny transport chunks.
    const bytes = new Uint8Array(declared === null ? outputLimit : Number(declared));
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) throw new Error("gradium_binary_limit");
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (!size || declared !== null && Number(declared) !== size) throw new Error("gradium_binary_incomplete");
    return bytes.subarray(0, size);
  } catch {
    void reader.cancel().catch(() => undefined);
    // No successful usage or free/nonbillable outcome escapes an incomplete read.
    throw new Error("invalid_gradium_binary_response");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
