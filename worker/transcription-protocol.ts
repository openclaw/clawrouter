import { groqMistralAudio, prepareGroqMistralAudio, readGroqMistralAudio } from "./groq-mistral-audio.ts";
import { inputRetirement } from "./input-retirement.ts";
import { modelSupportsEndpoint, providerById } from "./providers.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { TranscriptionUpload } from "./transcription-body.ts";
import { HttpError } from "./utils.ts";

const formats = new Set(["groq.transcription", "mistral.transcription"]);
const admitted = new WeakSet<ProxySelection>();
export function multipartFormat(format: string): boolean { return formats.has(format); }
export function assertMultipartIntake(selection: ProxySelection): void {
  if (multipartFormat(selection.endpoint.request_format) && !admitted.has(selection))
    throw new HttpError(400, "multipart_required", "native transcription requires authenticated multipart intake");
}

export function multipartRoute(path: string) {
  const match = path.match(/^\/v1\/(native|proxy)\/(groq|mistral)(\/[^?]+)$/);
  if (!match) return null;
  const providerId = match[2] as keyof typeof groqMistralAudio;
  const provider = providerById(providerId);
  const endpoints = provider?.endpoints.filter(endpoint => multipartFormat(endpoint.request_format)
    && (match[1] === "native" ? endpoint.path === match[3] : `/${endpoint.id}` === match[3])) ?? [];
  if (!provider || !endpoints.length) return null;
  return { providerId, provider, endpoints, native: match[1] === "native", contract: groqMistralAudio[providerId] };
}
export type MultipartRoute = NonNullable<ReturnType<typeof multipartRoute>>;

export function multipartSelection(route: MultipartRoute): ProxySelection {
  const { provider, providerId, endpoints, contract } = route, endpoint = endpoints[0];
  if (endpoints.length !== 1 || endpoint.request_format !== `${providerId}.transcription`
    || endpoint.response_format !== endpoint.request_format || endpoint.path !== "/v1/audio/transcriptions"
    || endpoint.method !== "POST" || endpoint.methods.length !== 1 || endpoint.methods[0] !== "POST"
    || route.native && !endpoint.native_proxy || endpoint.path_params.length || endpoint.upstreamPath !== undefined
    || endpoint.auth != null || endpoint.streaming || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.modelPassthrough || endpoint.requestPricing || endpoint.inputProfile || Object.keys(endpoint.query).length)
    throw new HttpError(400, "transcription_route_unsupported", "native transcription requires a qualified multipart route");
  const models = provider.models.filter(model => model.upstream === contract.model && modelSupportsEndpoint(provider, model, endpoint));
  if (models.length !== 1 || !provider.capabilities.some(capability => capability.id === "audio.transcription"
    && capability.endpoint === endpoint.id && capability.methods.includes("POST")))
    throw new HttpError(400, "model_capability_unsupported", "native transcription requires its declared audio model");
  return { provider, endpoint, model: models[0], capability: "audio.transcription", body: { model: contract.model }, pathParams: {}, method: "POST" };
}

export function prepareMultipart(route: MultipartRoute, selection: ProxySelection, upload: TranscriptionUpload): ReturnType<typeof prepareGroqMistralAudio> {
  if (upload.fields.model !== selection.model!.id && !(route.native && upload.fields.model === route.contract.model))
    throw new HttpError(400, "model_capability_unsupported", "multipart model does not match the selected route");
  try {
    const fields = { ...upload.fields, model: route.contract.model };
    const prepared = prepareGroqMistralAudio(route.providerId, { file: upload.file, fields });
    selection.body = fields; admitted.add(selection); return prepared;
  } catch { throw new HttpError(400, "invalid_transcription_upload", "upload is outside the selected native contract"); }
}

export function assertMultipartDestination(route: MultipartRoute, url: URL, headers: Headers): void {
  if (url.href !== route.contract.origin + route.contract.path || !headers.get("authorization")?.startsWith("Bearer "))
    throw new HttpError(400, "transcription_destination_unsupported", "native transcription requires its original credential and fixed destination");
}

export async function readMultipartResponse(route: MultipartRoute, response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing native transcription response");
  const input = inputRetirement(reader);
  if (response.redirected || response.status !== 200 || response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") {
    await input.retire("cancel"); throw new Error("invalid native transcription response");
  }
  let reads = 0, finished = false;
  const retire = (kind: "eof" | "cancel", reason?: unknown) => {
    finished = true; return input.retire(kind, reason);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return;
        if (++reads > 8192) throw new Error("native transcription chunk limit exceeded");
        const next = await input.read(() => reader.read());
        if (finished) return;
        if (next.done) { await retire("eof"); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { await retire("cancel", error); controller.error(error); }
    },
    cancel(reason) { return retire("cancel", reason); },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  if (headers.get("content-encoding") === "identity") headers.delete("content-encoding");
  try { return await readGroqMistralAudio(new Response(body, { status: response.status, headers }), route.providerId, signal); }
  finally { await retire("cancel", signal.reason); }
}
