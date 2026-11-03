import { googleSpeechModels, observeGoogleSpeech, prepareGoogleSpeech } from "./google-speech.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const responseLimit = 8 * 1024 * 1024, audioLimit = 4 * 1024 * 1024;

export function prepareNativeGoogleSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  const format = endpoint.request_format;
  if (format !== "google.speech_generate_content" && format !== "google.speech_interactions") return;
  const interactions = format === "google.speech_interactions";
  const expectedPath = interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent";
  if (provider.id !== "google-gemini" || !model || !googleSpeechModels.some(value => value === model.upstream)
    || model.upstream.startsWith("gemini-3.8-") !== interactions || selection.capability !== "audio.speech"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== expectedPath
    || endpoint.response_format !== format || endpoint.upstreamPath !== undefined || Object.keys(endpoint.query).length
    || endpoint.path_params.length !== (interactions ? 0 : 1) || !interactions && endpoint.path_params[0] !== "model"
    || Object.keys(selection.pathParams).length !== (interactions ? 0 : 1) || !interactions && selection.pathParams.model !== model.upstream
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.websocket || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_google_speech_route", "Google speech requires its selected frozen model and unary transport");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 256 * 1024) invalid();
    // The published codec owns the trusted-clock preview qualification cutoff.
    prepared = prepareGoogleSpeech(model.upstream, body);
  } catch {
    throw new HttpError(400, "invalid_native_google_speech_request", "Google speech input or model qualification is invalid");
  }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, responseLimit, original => {
        const root = object(original), blocks: unknown[] = [];
        let output: Record<string, unknown>;
        if (interactions) {
          if (root.status !== "completed" || root.model !== prepared.model
            || root.output_audio !== undefined && root.outputAudio !== undefined) invalid();
          const direct = root.output_audio ?? root.outputAudio;
          if (direct !== undefined) {
            if (root.steps !== undefined) invalid();
            blocks.push(direct); output = root;
          } else {
            const steps = list(root.steps, 64).map(value => {
              const step = object(value);
              const content = list(step.content, 64).filter(value => !thought(value));
              for (const value of content) {
                const block = object(value), mime = block.mime_type ?? block.mimeType;
                if (block.type === "audio" || typeof mime === "string" && mime.toLowerCase().startsWith("audio/")) {
                  if (step.type !== "model_output") invalid();
                  blocks.push(block);
                }
                if (block.uri !== undefined || block.url !== undefined || block.file_uri !== undefined) invalid();
              }
              return { ...step, content };
            });
            output = { ...root, steps };
          }
        } else {
          const candidates = list(root.candidates, 16).map(value => {
            const candidate = object(value), content = object(candidate.content);
            if (candidate.finishReason !== "STOP") invalid();
            const parts = list(content.parts, 64).filter(value => !thought(value));
            for (const value of parts) {
              const part = object(value);
              if (part.fileData !== undefined || part.file_data !== undefined || part.inlineData !== undefined && part.inline_data !== undefined) invalid();
              const inline = part.inlineData ?? part.inline_data;
              if (inline !== undefined) blocks.push(inline);
            }
            return { ...candidate, content: { ...content, parts } };
          });
          output = { ...root, candidates };
        }
        if (!blocks.length || blocks.length > 32) invalid();
        let total = 0;
        for (const value of blocks) {
          const block = object(value);
          if (block.mimeType !== undefined && block.mime_type !== undefined) invalid();
          const mime = block.mimeType ?? block.mime_type;
          if (typeof mime !== "string" || !/^audio\/(?:l16|pcm|wav)(?:;|$)/i.test(mime)
            || block.uri !== undefined || block.url !== undefined || block.file_uri !== undefined || thought(block)) invalid();
          const encoded = canonicalMediaBase64(block.data, audioLimit, invalid);
          if (block.data !== encoded.base64 || (total += encoded.decodedBytes) > audioLimit) invalid();
          const prefix = atob(encoded.base64.slice(0, 16));
          // Never reinterpret a WAV container as headerless PCM or vice versa.
          if (/^audio\/wav(?:;|$)/i.test(mime) !== prefix.startsWith("RIFF")) invalid();
        }
        const observed = observeGoogleSpeech(output, prepared, true);
        return { response: nativeJsonResponse(observed.body, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function thought(value: unknown): boolean {
  const block = object(value);
  if (block.thought !== undefined && typeof block.thought !== "boolean") invalid();
  return block.thought === true || block.type === "thought";
}
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) invalid(); return value; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function invalid(): never { throw new Error("invalid_native_google_speech_response"); }
