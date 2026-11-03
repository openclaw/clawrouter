import type { ManagedLifecycleAdapter, ManagedObservation, ManagedReadContext } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery } from "./managed-media-json.ts";
import { canonicalGoogleVeoBytes } from "./provider-google-veo-files.ts";
import { googleOmniEnvelopeBytes, googleOmniVideos, readGoogleOmniJson, requireOmni } from "./provider-google-omni-files.ts";

export const googleOmniVideoModel = "gemini-omni-1.1-flash";
type OmniAdapter = Omit<ManagedLifecycleAdapter, "protocol"> & { protocol: "google.omni_video" };
export interface GoogleOmniObservation extends ManagedObservation { observationUnavailable?: "expired_or_unknown" }
const resolutions = new Set(["360p", "720p", "1080p", "4k"]);
function only(value: Record<string, unknown>, keys: string[]): void { requireOmni(Object.keys(value).every(key => keys.includes(key)), "field"); }
function text(value: unknown): void { requireOmni(typeof value === "string" && value.trim().length > 0 && value.length <= 32_000, "text"); }
export function validateGoogleOmniInteractionId(value: unknown): string {
  requireOmni(typeof value === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(value), "interaction_id"); return value;
}

/** Native Interactions input, limited to the audited text/single-reference modes. */
export function prepareGoogleOmniVideoCreate(value: unknown): Record<string, unknown> {
  requireOmni(mediaObject(value) && value.model === googleOmniVideoModel, "model");
  only(value, ["model", "input", "response_format", "generation_config", "background", "store", "stream"]);
  let images = 0, videos = 0, prompts = 0;
  if (typeof value.input === "string") { text(value.input); prompts = 1; }
  else {
    requireOmni(Array.isArray(value.input) && value.input.length > 0 && value.input.length <= 8, "input");
    for (const content of value.input) {
      requireOmni(mediaObject(content), "input_content");
      if (content.type === "text") { only(content, ["type", "text"]); text(content.text); prompts++; }
      else {
        requireOmni(content.type === "image" || content.type === "video", "input_type");
        only(content, ["type", "data", "mime_type"]);
        const mimes = content.type === "image" ? ["image/png", "image/jpeg", "image/webp"] : ["video/mp4", "video/webm"];
        requireOmni(typeof content.mime_type === "string" && mimes.includes(content.mime_type), "input_mime");
        canonicalGoogleVeoBytes(content.data, googleOmniEnvelopeBytes);
        if (content.type === "image") images++; else videos++;
      }
    }
  }
  requireOmni(prompts > 0 && images + videos <= 1, "input_mode");
  if (value.generation_config !== undefined) {
    requireOmni(mediaObject(value.generation_config), "generation_config"); only(value.generation_config, ["video_config"]);
    const config = value.generation_config.video_config;
    requireOmni(mediaObject(config), "video_config"); only(config, ["task"]);
    requireOmni(config.task === "text_to_video" && images + videos === 0 || config.task === "image_to_video" && images === 1
      || (config.task === "edit" || config.task === "extend") && videos === 1, "task");
  }
  const format = value.response_format ?? { type: "video" };
  requireOmni(mediaObject(format) && format.type === "video", "response_format"); only(format, ["type", "delivery", "aspect_ratio", "resolution", "duration"]);
  if (format.delivery !== undefined) requireOmni(format.delivery === "inline" || format.delivery === "uri", "delivery");
  if (format.aspect_ratio !== undefined) requireOmni(format.aspect_ratio === "16:9" || format.aspect_ratio === "9:16", "aspect_ratio");
  if (format.resolution !== undefined) requireOmni(typeof format.resolution === "string" && resolutions.has(format.resolution), "resolution");
  // The reference specifies a string, not a numeric range/unit. Preserve it;
  // never translate Veo durationSeconds or infer billed seconds from this hint.
  if (format.duration !== undefined) requireOmni(typeof format.duration === "string" && format.duration.length > 0 && format.duration.length <= 32 && /^[\x20-\x7e]+$/.test(format.duration) && format.duration.trim() === format.duration, "duration");
  for (const key of ["background", "store"]) if (value[key] !== undefined) requireOmni(typeof value[key] === "boolean", key);
  requireOmni(value.stream === undefined || value.stream === false, "stream");
  const background = value.background ?? false, store = value.store ?? false;
  requireOmni(background !== true || store === true, "background_storage");
  return { ...value, response_format: format, background, store, stream: false };
}

function originalFlags(params: Record<string, string>): { background: boolean; store: boolean } {
  exactMediaParams(params, ["background", "store"]);
  requireOmni(["true", "false"].includes(params.background) && ["true", "false"].includes(params.store), "job_flags");
  requireOmni(params.background !== "true" || params.store === "true", "job_flags");
  return { background: params.background === "true", store: params.store === "true" };
}

export async function readGoogleOmniVideo(response: Response, context: ManagedReadContext): Promise<GoogleOmniObservation> {
  requireOmni(context.requestedVersion === googleOmniVideoModel, "requested_model");
  const flags = originalFlags(context.pathParams);
  requireOmni(context.action === "create" || context.action === "retrieve" && flags.store || context.action === "cancel" && flags.background, "control");
  const body = await readGoogleOmniJson(response), id = validateGoogleOmniInteractionId(body.id);
  if (context.action !== "create") requireOmni(id === validateGoogleOmniInteractionId(context.expectedId), "identity_mismatch");
  requireOmni(body.object === "interaction" && body.model === googleOmniVideoModel, "response_model");
  const status = body.status;
  requireOmni(typeof status === "string" && ["in_progress", "completed", "failed", "cancelled", "incomplete", "requires_action", "requires_continuation"].includes(status), "status");
  requireOmni(body.error === undefined || status === "failed", "api_error");
  let terminal: ManagedObservation["terminal"] = null;
  if (status === "completed") { requireOmni(googleOmniVideos(body, googleOmniEnvelopeBytes).length > 0, "missing_video"); terminal = "succeeded"; }
  else if (status === "failed") terminal = "failed";
  else if (status === "cancelled") terminal = "canceled";
  if (status === "in_progress") requireOmni(flags.store, "unretrievable_job");
  const observationUnavailable = status === "incomplete" || status === "requires_action" || status === "requires_continuation" ? status : undefined;
  return { id, nativeStatus: status, terminal, body, ...(observationUnavailable ? { observationUnavailable: "expired_or_unknown" as const } : {}),
    ...(status === "in_progress" && context.action !== "retrieve" ? { followUp: "retrieve" as const } : {}) };
}

export interface GoogleOmniUsage {
  inputTokens: number; outputTokens: number; totalTokens: number | null; cachedTokens: number | null; thoughtTokens: number | null;
  inputByModality: Record<string, number> | null; outputByModality: Record<string, number> | null;
}
/** Preserve native modality counters separately; these are not a video tariff. */
export function googleOmniUsage(value: unknown): GoogleOmniUsage | null {
  if (!mediaObject(value)) return null;
  const counter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!counter(value.total_input_tokens) || !counter(value.total_output_tokens) || !Number.isSafeInteger(value.total_input_tokens + value.total_output_tokens)) return null;
  for (const key of ["total_tokens", "total_cached_tokens", "total_thought_tokens"]) if (value[key] !== undefined && !counter(value[key])) return null;
  if (typeof value.total_tokens === "number" && value.total_tokens < value.total_input_tokens + value.total_output_tokens) return null;
  if (typeof value.total_cached_tokens === "number" && value.total_cached_tokens > value.total_input_tokens) return null;
  function modality(raw: unknown): Record<string, number> | null | false {
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || raw.length > 5) return false;
    const result: Record<string, number> = {};
    for (const item of raw) {
      if (!mediaObject(item) || typeof item.modality !== "string" || !["text", "image", "audio", "video", "document"].includes(item.modality) || Object.hasOwn(result, item.modality) || !counter(item.tokens)) return false;
      result[item.modality] = item.tokens;
    }
    return result;
  }
  const inputByModality = modality(value.input_tokens_by_modality), outputByModality = modality(value.output_tokens_by_modality);
  if (inputByModality === false || outputByModality === false) return null;
  for (const [counts, total] of [[inputByModality, value.total_input_tokens], [outputByModality, value.total_output_tokens]] as const) {
    if (counts !== null) { const sum = Object.values(counts).reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(sum) || sum > total) return null; }
  }
  return { inputTokens: value.total_input_tokens, outputTokens: value.total_output_tokens, totalTokens: typeof value.total_tokens === "number" ? value.total_tokens : null,
    cachedTokens: typeof value.total_cached_tokens === "number" ? value.total_cached_tokens : null, thoughtTokens: typeof value.total_thought_tokens === "number" ? value.total_thought_tokens : null, inputByModality, outputByModality };
}

export const googleOmniVideoManagedAdapter: OmniAdapter = {
  protocol: "google.omni_video", requestFormats: ["google.omni_video_create"], supportsResult: false, supportsCancel: true,
  validateId: validateGoogleOmniInteractionId,
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    const prepared = prepareGoogleOmniVideoCreate(body);
    return { body: prepared, headers: new Headers({ "content-type": "application/json" }), requestedVersion: googleOmniVideoModel,
      pathParams: { background: String(prepared.background), store: String(prepared.store) } };
  },
  identify(action, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, ["interaction_id"]);
    requireOmni(action === "retrieve" || action === "cancel", "control"); return validateGoogleOmniInteractionId(pathParams.interaction_id);
  },
  control(action, endpoint, id, pathParams) {
    const flags = originalFlags(pathParams), expected = action === "retrieve" ? "/interactions/${interaction_id}" : "/interactions/${interaction_id}/cancel";
    requireOmni(action === "retrieve" && flags.store && endpoint.method === "GET" || action === "cancel" && flags.background && endpoint.method === "POST", "control");
    requireOmni(endpoint.path === expected, "control_endpoint");
    return { path: `/interactions/${validateGoogleOmniInteractionId(id)}${action === "cancel" ? "/cancel" : ""}`, query: new URLSearchParams() };
  },
  read: readGoogleOmniVideo,
  rewrite(observation) { return dropMediaControlUrls(observation.body); },
};
