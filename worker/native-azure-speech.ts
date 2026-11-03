import { azureSpeechRegionalOrigin, azureSpeechSsmlLimit, prepareAzureSpeechSsml } from "./azure-speech-ssml.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const speechPath = "/cognitiveservices/v1";
const outputLimit = 16 * 1024 * 1024;

// The dispatcher supplies authenticated raw SSML and the selected destination's
// original region. This wrapper neither selects credentials nor replaces a body.
export function prepareNativeAzureSpeech(
  selection: ProxySelection,
  input: { body: string; contentType: string; outputFormat: string; region: string },
): NativeResponse | undefined {
  const { endpoint } = selection;
  if (endpoint.request_format !== "azure_speech.ssml") return;
  if (selection.provider.id !== "azure-speech" || selection.model !== null || selection.method !== "POST" || endpoint.method !== "POST"
    || selection.capability !== "audio.speech" || endpoint.path !== speechPath || endpoint.upstreamPath !== undefined
    || endpoint.response_format !== "audio.binary" || endpoint.path_params.length || Object.keys(selection.pathParams).length
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined
    || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough) {
    throw new HttpError(400, "invalid_native_azure_speech_route", "Azure Speech requires its qualified model-less regional SSML route");
  }
  let origin: string;
  try {
    if (typeof input.body !== "string" || input.body.length > azureSpeechSsmlLimit || input.body.startsWith("\uFEFF")
      || typeof input.contentType !== "string" || !/^application\/ssml\+xml(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i.test(input.contentType.trim())
      || input.outputFormat !== "audio-24khz-48kbitrate-mono-mp3" || typeof input.region !== "string") throw new Error("invalid_input");
    prepareAzureSpeechSsml(input.body, input.contentType, input.outputFormat);
    origin = azureSpeechRegionalOrigin(input.region);
  } catch {
    throw new HttpError(400, "invalid_native_azure_speech_request", "Azure Speech requires bounded UTF-8 SSML, a selected region and qualified MP3 output");
  }
  return {
    origin, path: speechPath,
    acquire: () => nativeResponseLease(outputLimit),
    async read(response, signal) {
      const bytes = await readAudio(response, signal);
      const audio = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      return { response: new Response(audio, { status: 200, headers: {
        "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), "cache-control": "no-store", "x-content-type-options": "nosniff",
      } }), usage: { tokens: null, outcome: "success" } };
    },
  };
}

async function readAudio(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > outputLimit)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_azure_speech_binary_response");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    const bytes = new Uint8Array(declared === null ? outputLimit : Number(declared));
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) throw new Error("azure_speech_binary_limit");
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (!size || declared !== null && Number(declared) !== size) throw new Error("azure_speech_binary_incomplete");
    return bytes.subarray(0, size);
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("invalid_azure_speech_binary_response");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
