import { hasProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

// This is a qualified protocol value, never an arbitrary URL/query override.
export type NativeQueryBinding = Readonly<{
  protocol: "elevenlabs.speech";
  outputFormat: "mp3_44100_128";
  optimizeStreamingLatency?: "0" | "1" | "2" | "3" | "4";
}>;

export function nativeQuerySearch(query: NativeQueryBinding | undefined): string {
  if (query === undefined) return "";
  if (!query || query.protocol !== "elevenlabs.speech" || query.outputFormat !== "mp3_44100_128"
    || Object.keys(query).some(key => !["protocol", "outputFormat", "optimizeStreamingLatency"].includes(key))
    || query.optimizeStreamingLatency !== undefined && !["0", "1", "2", "3", "4"].includes(query.optimizeStreamingLatency)) invalid();
  return `?output_format=mp3_44100_128${query.optimizeStreamingLatency === undefined ? "" : `&optimize_streaming_latency=${query.optimizeStreamingLatency}`}`;
}

export function qualifyNativeQuery(selection: ProxySelection, input: ProxyQuery, requestUrl: URL): NativeQueryBinding | undefined {
  const { endpoint } = selection;
  if (endpoint.request_format !== "elevenlabs.speech") return undefined;
  if (selection.provider.id !== "elevenlabs" || selection.capability !== "audio.speech" || selection.model !== null
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/text-to-speech/${voice_id}"
    || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "voice_id" || endpoint.response_format !== "audio.binary"
    || endpoint.upstreamPath || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough
    || Object.keys(endpoint.query).length) invalid();
  // Native uses the URL query; manifest uses its envelope. Never accept both.
  if (requestUrl.search.length > 256 || requestUrl.search && (!(input instanceof URLSearchParams) || input.toString() !== requestUrl.searchParams.toString())) invalid();
  const entries = input instanceof URLSearchParams ? [...input] : Object.entries(input);
  if (entries.length > 2) invalid();
  const values = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!["output_format", "optimize_streaming_latency"].includes(key) || values.has(key) || typeof value !== "string") invalid();
    values.set(key, value);
  }
  const output = values.get("output_format") ?? "mp3_44100_128", latency = values.get("optimize_streaming_latency");
  if (output !== "mp3_44100_128" || latency !== undefined && !["0", "1", "2", "3", "4"].includes(latency)) invalid();
  return Object.freeze({ protocol: "elevenlabs.speech", outputFormat: output,
    ...(latency === undefined ? {} : { optimizeStreamingLatency: latency as NativeQueryBinding["optimizeStreamingLatency"] }) });
}

export function nativeDispatchQuery(selection: ProxySelection, input: ProxyQuery, requestUrl: URL): ProxyQuery {
  const qualified = qualifyNativeQuery(selection, input, requestUrl);
  if (qualified) {
    // A declaration alone does not qualify output delivery or enable a route.
    if (!selection.nativeResponse || nativeQuerySearch(selection.nativeQuery) !== nativeQuerySearch(qualified)
      || nativeQuerySearch(selection.nativeResponse.query) !== nativeQuerySearch(qualified)) invalid();
    return new URLSearchParams(nativeQuerySearch(qualified));
  }
  if (selection.nativeQuery || selection.nativeResponse?.query
    || selection.nativeResponse && (hasProxyQuery(input) || requestUrl.search)) invalid();
  return input;
}

function invalid(): never {
  throw new HttpError(400, "invalid_native_response_query", "native query options require a qualified protocol, route and response binding");
}
