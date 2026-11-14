import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const pixVerseOrigins = {
  international: "https://app-api.pixverse.ai",
  cn: "https://app-api.pixverseai.cn",
} as const;
const qualities = new Set(["360p", "540p", "720p", "1080p"]);
const ratios = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"]);
const encoder = new TextEncoder();

export function validatePixVerseId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  throw new Error("invalid_pixverse_id");
}

export function pixVerseRequestHeaders(json = false): Headers {
  const headers = new Headers({ "Ai-trace-id": crypto.randomUUID() });
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

// boundImageId is supplied ONLY after the runtime resolves its durable upload
// binding under the caller, policy, provider, region and original credential.
// Never pass a caller-provided img_id as this argument.
export function createPixVerseManagedAdapter(mode: "text" | "image", boundImageId?: string): ManagedLifecycleAdapter {
  const imageId = boundImageId === undefined ? undefined : validatePixVerseId(boundImageId);
  return {
    protocol: "pixverse.video", requestFormats: [mode === "text" ? "pixverse.text_video" : "pixverse.image_video"],
    supportsResult: false, supportsCancel: false, validateId: validatePixVerseId,
    identityProbe: "1",
    prepare(body, _headers, pathParams, query) {
      noMediaQuery(query); exactMediaParams(pathParams, []);
      if (!mediaObject(body) || !["v6", "c1"].includes(String(body.model))) throw new Error("invalid_pixverse_create");
      const allowed = ["model", "prompt", "duration", "quality", "seed", "negative_prompt", "camera_movement", "template_id", "generate_audio_switch",
        ...(mode === "text" ? ["aspect_ratio"] : ["img_id", "motion_mode"])];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error("unsupported_pixverse_input");
      boundedText(body.prompt, 2048, false);
      if (!Number.isInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 15 || !qualities.has(String(body.quality))) throw new Error("invalid_pixverse_duration_or_quality");
      if (body.negative_prompt !== undefined) boundedText(body.negative_prompt, 2048, true);
      if (body.camera_movement !== undefined) boundedText(body.camera_movement, 128, false);
      if (body.seed !== undefined && (!Number.isSafeInteger(body.seed) || Number(body.seed) < 0 || Number(body.seed) > 2147483647)) throw new Error("invalid_pixverse_seed");
      if (body.template_id !== undefined && (!Number.isSafeInteger(body.template_id) || Number(body.template_id) < 0)) throw new Error("invalid_pixverse_template");
      if (body.generate_audio_switch !== undefined && typeof body.generate_audio_switch !== "boolean") throw new Error("invalid_pixverse_audio");
      if (mode === "text") {
        if (!ratios.has(String(body.aspect_ratio))) throw new Error("invalid_pixverse_ratio");
      } else {
        if (imageId === undefined) throw new Error("pixverse_upload_scope_required");
        if (typeof body.img_id !== "number" || validatePixVerseId(body.img_id) !== imageId) throw new Error("pixverse_upload_identity_mismatch");
        if (body.motion_mode !== undefined) boundedText(body.motion_mode, 64, false);
      }
      return { body, headers: pixVerseRequestHeaders(true), requestedVersion: String(body.model), pathParams: {} };
    },
    identify(action, pathParams, query) {
      noMediaQuery(query); exactMediaParams(pathParams, ["video_id"]);
      if (action !== "retrieve") throw new Error("unsupported_pixverse_control");
      return validatePixVerseId(pathParams.video_id);
    },
    control(action, endpoint, id, pathParams) {
      exactMediaParams(pathParams, []);
      if (action !== "retrieve" || endpoint.method !== "GET" || endpoint.path !== "/openapi/v2/video/result/${video_id}") throw new Error("unsupported_pixverse_control");
      return { path: "/openapi/v2/video/result/" + validatePixVerseId(id), query: new URLSearchParams(),
        headers: pixVerseRequestHeaders(), transientHeaders: ["ai-trace-id"] };
    },
    async read(response, context) {
      const { body, result } = await readPixVerseEnvelope(response);
      if (context.action === "create") {
        const id = validatePixVerseId(result.video_id);
        return { id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
      }
      if (context.action !== "retrieve") throw new Error("unsupported_pixverse_control");
      const id = validatePixVerseId(context.expectedId);
      // Native results may omit identity; the authenticated bound GET owns it.
      for (const field of ["id", "video_id"]) if (result[field] !== undefined && validatePixVerseId(result[field]) !== id) throw new Error("pixverse_identity_mismatch");
      const status = result.status;
      if (typeof status !== "number" || ![1, 5, 6, 7, 8].includes(status)) throw new Error("invalid_pixverse_status");
      if (status === 6) return { id, nativeStatus: "6", terminal: null, body, observationUnavailable: "deleted" };
      return { id, nativeStatus: String(status), terminal: status === 1 ? "succeeded" : status === 7 || status === 8 ? "failed" : null, body };
    },
    rewrite(observation) {
      const body = dropMediaControlUrls(observation.body);
      return { ...body, ...(mediaObject(body.Resp) ? { Resp: dropMediaControlUrls(body.Resp) } : {}) };
    },
  };
}

// Validate the entire planned create before allocating or uploading bytes.
// The sentinel is local validation only; it is never persisted or dispatched.
export function preparePixVerseImagePlan(value: unknown): Record<string, unknown> {
  if (!mediaObject(value) || Object.hasOwn(value, "img_id")) throw new Error("pixverse_input_receipt_required");
  const body = { ...value, img_id: 1 };
  createPixVerseManagedAdapter("image", "1").prepare(body, new Headers(), {}, new URLSearchParams());
  const { img_id: _sentinel, ...plan } = body;
  return plan;
}

export function preparePixVerseImageUpload(input: {
  file?: { bytes: Uint8Array; type: string; name: string };
  url?: string;
}): { body: FormData; headers: Headers } {
  if (Object.keys(input).some(key => !["file", "url"].includes(key)) || (input.file === undefined) === (input.url === undefined)) throw new Error("invalid_pixverse_upload");
  const body = new FormData();
  if (input.file !== undefined) {
    const file = input.file;
    if (!(file.bytes instanceof Uint8Array) || !file.bytes.byteLength || file.bytes.byteLength >= 20_000_000
      || !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      || !/^[a-zA-Z0-9_.-]{1,128}$/.test(file.name) || file.name === "." || file.name === "..") throw new Error("invalid_pixverse_image");
    body.set("image", new Blob([Uint8Array.from(file.bytes)], { type: file.type }), file.name);
  } else {
    let url: URL;
    try { url = new URL(input.url!); } catch { throw new Error("invalid_pixverse_image_url"); }
    if (input.url!.length > 8192 || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("invalid_pixverse_image_url");
    body.set("image_url", input.url!);
  }
  // Fetch owns the multipart boundary; never retain a caller's Content-Type.
  return { body, headers: pixVerseRequestHeaders() };
}

export async function readPixVerseImageUpload(response: Response): Promise<{ id: string }> {
  const { result } = await readPixVerseEnvelope(response);
  return { id: validatePixVerseId(result.img_id) };
}

async function readPixVerseEnvelope(response: Response): Promise<{ body: Record<string, unknown>; result: Record<string, unknown> }> {
  const { body } = await readMediaJson(response);
  if (body.ErrCode !== 0 || !mediaObject(body.Resp)) throw new Error("pixverse_api_error");
  return { body, result: body.Resp };
}

function boundedText(value: unknown, maxBytes: number, empty: boolean): void {
  if (typeof value !== "string" || !empty && !value.trim() || encoder.encode(value).byteLength > maxBytes) throw new Error("invalid_pixverse_text");
}
