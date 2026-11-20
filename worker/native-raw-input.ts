import { azureSpeechSsmlLimit, prepareAzureSpeechSsml } from "./azure-speech-ssml.ts";
import { HttpOperation } from "./http-operation.ts";
import { prepareNativeAzureSpeech } from "./native-azure-speech.ts";
import { assertNativeResponseDestination } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { readBounded } from "./transcription-body.ts";
import { HttpError } from "./utils.ts";

interface AzureInput { body: string; bytes: number; contentType: string; outputFormat: string }
// Only authenticated intake can establish this binding. A JSON field cannot
// override outbound bytes, headers or the selected credential's destination.
const inputs = new WeakMap<ProxySelection, AzureInput>();
export const nativeRawFormat = (format: string): boolean => format === "azure_speech.ssml";

export async function readNativeRawInput(request: Request, selection: ProxySelection): Promise<void> {
  if (!nativeRawFormat(selection.endpoint.request_format) || request.method !== "POST" || new URL(request.url).search
    || request.headers.has("content-encoding")) invalid();
  const contentType = request.headers.get("content-type") ?? "", outputFormat = request.headers.get("x-microsoft-outputformat") ?? "";
  if (!/^application\/ssml\+xml(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i.test(contentType.trim())
    || outputFormat !== "audio-24khz-48kbitrate-mono-mp3") invalid();
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) invalid();
  if (length !== null && Number(length) > azureSpeechSsmlLimit) tooLarge();
  const operation = new HttpOperation(request.signal, 30_000);
  try {
    const bytes = await readBounded(request.body, azureSpeechSsmlLimit, operation, 413);
    if (!bytes.length || length !== null && bytes.length !== Number(length)
      || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      prepareAzureSpeechSsml(body, contentType, outputFormat);
    } catch { invalid(); }
    inputs.set(selection, { body, bytes: bytes.length, contentType, outputFormat });
    // Retention, when explicitly enabled by policy, retains the actual SSML.
    // This internal record is never serialized as the upstream request body.
    selection.body = { ssml: body };
  } catch (error) {
    if (operation.status === "timeout") throw new HttpError(408, "native_upload_timeout", "native upload deadline exceeded");
    if (operation.status === "client_error") throw new HttpError(400, "native_upload_canceled", "native upload was canceled");
    if (error instanceof HttpError && error.status === 413) tooLarge();
    throw error;
  } finally { operation.stop("complete"); }
}

export function prepareNativeRawDispatch(selection: ProxySelection, url: URL, headers: Headers, nativeTransport: boolean): string | undefined {
  if (!nativeRawFormat(selection.endpoint.request_format)) return;
  const input = inputs.get(selection);
  const region = /^https:\/\/([a-z][a-z0-9]{1,31})\.tts\.speech\.microsoft\.com$/.exec(url.origin)?.[1];
  if (!input || !region || !nativeTransport || !headers.get("ocp-apim-subscription-key") || headers.has("authorization")) invalid();
  selection.nativeResponse = prepareNativeAzureSpeech(selection, { ...input, region });
  if (!selection.nativeResponse) invalid();
  assertNativeResponseDestination(selection.nativeResponse, url);
  headers.set("content-type", input.contentType);
  headers.set("x-microsoft-outputformat", input.outputFormat);
  headers.set("content-length", String(input.bytes));
  // Fatal UTF-8 decoding plus BOM rejection round-trips the original bytes;
  // no XML normalization, JSON quoting or model transformation occurs.
  return input.body;
}

function invalid(): never { throw new HttpError(400, "invalid_native_raw_input", "native speech requires qualified raw UTF-8 SSML, output format and regional destination"); }
function tooLarge(): never { throw new HttpError(413, "native_upload_too_large", "native speech upload exceeds the 65536 byte limit"); }
