import type { ManagedLifecycleAdapter, ManagedObservation, ManagedReadContext } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const togetherVideoModels = ["Wan-AI/wan2.7-t2v", "Wan-AI/wan2.7-i2v", "minimax/hailuo-02"] as const;
const models: ReadonlySet<string> = new Set(togetherVideoModels);
export const togetherVideoTiming = { requestTimeoutMs: 120_000, operationTimeoutMs: 1_200_000, pollIntervalMs: 5000, maxPollAttempts: 240 } as const;
const ratios = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const imageLimit = 20 * 1024 * 1024;

// Pending common protocol/schema/registry qualification. Reuse the existing M02
// controller; this focused module owns neither admission nor durable identity.
type TogetherAdapter = Omit<ManagedLifecycleAdapter, "protocol"> & { protocol: "together.video" };

export function validateTogetherVideoId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_together_video_id");
  return value;
}
function requireTogether(value: unknown, field: string): asserts value { if (!value) throw new Error(`invalid_together_video_${field}`); }
function imageSource(value: unknown): void {
  requireTogether(typeof value === "string" && value.length > 0 && value.length <= 28_000_000, "image_source");
  if (value.startsWith("data:")) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    requireTogether(match, "inline_image");
    const encoded = match[1], padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    requireTogether(encoded.length % 4 === 0 && encoded.length / 4 * 3 - padding <= imageLimit, "inline_image");
    // Check the unused pad bits without decoding/copying the entire image.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if (padding) requireTogether((alphabet.indexOf(encoded[encoded.length - padding - 1]) & (padding === 2 ? 15 : 3)) === 0, "inline_image");
    return;
  }
  externalAssetUrl(value);
}
function externalAssetUrl(value: unknown): string {
  requireTogether(typeof value === "string" && value.length > 0 && value.length <= 8192, "asset_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_together_video_asset_url"); }
  requireTogether(url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port, "asset_url");
  // This is syntax admission only. The downloader must enforce public-network
  // SSRF policy on DNS/redirects and must never attach the Together API credential.
  return value;
}

/** Native /v2/videos body, after the client converts frozen duration/size options. */
export function prepareTogetherVideoCreate(value: unknown): Record<string, unknown> {
  requireTogether(mediaObject(value) && typeof value.model === "string" && models.has(value.model), "model");
  const wan = value.model !== "minimax/hailuo-02", image = value.model === "Wan-AI/wan2.7-i2v";
  const allowed = ["model", "prompt", "seconds", ...(wan ? ["resolution", "ratio"] : ["width", "height"]), ...(image ? ["media"] : [])];
  requireTogether(Object.keys(value).every(key => allowed.includes(key)), "field");
  requireTogether(typeof value.prompt === "string" && value.prompt.trim().length > 0 && [...value.prompt].length <= (wan ? 5000 : 32000), "prompt");
  if (value.seconds !== undefined) requireTogether(typeof value.seconds === "string" && /^(?:[1-9]|10)$/.test(value.seconds) && Number(value.seconds) >= (wan ? 2 : 1), "duration");
  if (wan) {
    if (value.resolution !== undefined) requireTogether(value.resolution === "720P" || value.resolution === "1080P", "resolution");
    if (value.ratio !== undefined) requireTogether(typeof value.ratio === "string" && ratios.has(value.ratio), "ratio");
  } else if (value.width !== undefined || value.height !== undefined) {
    // Local parsing bound, not a claim that every Hailuo dimension is supported.
    requireTogether([value.width, value.height].every(number => typeof number === "number" && Number.isSafeInteger(number) && number > 0 && number <= 8192), "dimensions");
  }
  if (image) {
    requireTogether(mediaObject(value.media) && Object.keys(value.media).length === 1 && Array.isArray(value.media.frame_images) && value.media.frame_images.length === 1, "first_frame");
    const frame = value.media.frame_images[0];
    requireTogether(mediaObject(frame) && Object.keys(frame).length === 2 && frame.frame === "first", "first_frame");
    imageSource(frame.input_image);
  }
  return value;
}

/** Returns the first qualified asset in the frozen object-or-array output envelope. */
export function togetherVideoOutput(body: Record<string, unknown>): string | null {
  if (body.outputs === undefined || body.outputs === null) return null;
  const outputs = Array.isArray(body.outputs) ? body.outputs : [body.outputs];
  requireTogether(outputs.length <= 64, "outputs");
  let selected: string | null = null;
  for (const entry of outputs) {
    requireTogether(mediaObject(entry), "output");
    for (const key of ["video_url", "url"]) if (entry[key] !== undefined && entry[key] !== null) requireTogether(typeof entry[key] === "string", "output_url");
    const video = typeof entry.video_url === "string" ? entry.video_url.trim() : "", fallback = typeof entry.url === "string" ? entry.url.trim() : "";
    if (video || fallback) {
      const url = externalAssetUrl(video || fallback);
      selected ??= url;
    }
  }
  return selected;
}

export async function readTogetherVideo(response: Response, context: ManagedReadContext): Promise<ManagedObservation> {
  requireTogether(context.action === "create" || context.action === "retrieve", "control");
  requireTogether(models.has(context.requestedVersion), "requested_model");
  const { body } = await readMediaJson(response);
  const id = validateTogetherVideoId(body.id);
  if (context.action === "retrieve") requireTogether(id === validateTogetherVideoId(context.expectedId), "identity_mismatch");
  if (body.model !== undefined) requireTogether(body.model === context.requestedVersion, "model_mismatch");
  const status = body.status;
  // The frozen client polls an ID-only create acknowledgment. Unknown statuses
  // and missing status on later reads are not terminal evidence.
  requireTogether(status === "in_progress" || status === "completed" || status === "failed" || (context.action === "create" && status === undefined), "status");
  if (status !== "failed") requireTogether(body.error === undefined || body.error === null, "api_error");
  if (status === "completed") requireTogether(togetherVideoOutput(body), "missing_output");
  return { id, nativeStatus: typeof status === "string" ? status : null, terminal: status === "completed" ? "succeeded" : status === "failed" ? "failed" : null,
    body, ...(context.action === "create" && status !== "completed" && status !== "failed" ? { followUp: "retrieve" as const } : {}) };
}

export const togetherVideoManagedAdapter: TogetherAdapter = {
  protocol: "together.video", requestFormats: ["together.video_create"], supportsResult: false, supportsCancel: false,
  validateId: validateTogetherVideoId,
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    const prepared = prepareTogetherVideoCreate(body);
    return { body: prepared, headers: new Headers({ "content-type": "application/json" }), requestedVersion: prepared.model as string, pathParams: {} };
  },
  identify(action, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, ["video_id"]);
    requireTogether(action === "retrieve", "control"); return validateTogetherVideoId(pathParams.video_id);
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    requireTogether(action === "retrieve" && endpoint.method === "GET" && endpoint.path === "/v2/videos/${video_id}", "control_endpoint");
    return { path: `/v2/videos/${validateTogetherVideoId(id)}`, query: new URLSearchParams() };
  },
  read: readTogetherVideo,
  rewrite(observation) { return dropMediaControlUrls(observation.body); },
};
