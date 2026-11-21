import { nativeMp3ResponseLimit as outputLimit, readNativeMp3Response } from "./native-mp3-response.ts";
import { azureSpeechRegionalOrigin, azureSpeechSsmlLimit, prepareAzureSpeechSsml } from "./azure-speech-ssml.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const speechPath = "/cognitiveservices/v1";
const responseErrors = { invalid: "invalid_azure_speech_binary_response", limit: "azure_speech_binary_limit", incomplete: "azure_speech_binary_incomplete" };

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
    read: (response, signal) => readNativeMp3Response(response, signal, responseErrors),
  };
}
