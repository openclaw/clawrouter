import type { ManagedLifecycleAdapter, ManagedObservation } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const wanModels = ["wan2.6-t2v", "wan2.6-i2v", "wan2.6-r2v", "wan2.6-r2v-flash", "wan2.7-r2v"] as const;
const models: ReadonlySet<string> = new Set(wanModels);
const sizes = new Set(["1280*720", "720*1280", "960*960", "1088*832", "832*1088", "1920*1080", "1080*1920", "1440*1440", "1632*1248", "1248*1632"]);
const ratios = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const statuses = new Set(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

export interface WanObservation extends ManagedObservation {
  // Requires the shared owner to freeze observation loss conservatively, without
  // claiming upstream failure, success or refund. Never poll this state again.
  observationUnavailable?: "expired_or_unknown";
}

export function validateWanTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_wan_task_id");
  return value;
}

// Called by the credential owner before egress, never with a caller-supplied key.
// No secret is returned, retained or interpolated into an error.
export function assertWanStandardCredential(secret: string, baseUrl: string): void {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("wan_requires_same_region_standard_api_credential"); }
  const host = url.hostname;
  const origin = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(host)
    || /^(?!token-plan\.)[a-zA-Z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1)\.maas\.aliyuncs\.com$/.test(host);
  if (!secret.trim() || secret.trim().startsWith("sk-sp-") || !origin || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("wan_requires_same_region_standard_api_credential");
}

export const wanManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "dashscope.video", requestFormats: ["dashscope.video_create"], supportsResult: false, supportsCancel: false,
  validateId: validateWanTaskId,
  assertDispatch(request) {
    const authorization = request.headers.get("authorization");
    const bearer = authorization === null ? null : /^Bearer ([^\s,]+)$/i.exec(authorization);
    if (!bearer) throw new Error("wan_requires_same_region_standard_api_credential");
    assertWanStandardCredential(bearer[1], new URL(request.url).origin);
  },
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    if (!mediaObject(body) || Object.keys(body).some(key => !["model", "input", "parameters"].includes(key))
      || typeof body.model !== "string" || !models.has(body.model) || !mediaObject(body.input)) throw new Error("invalid_wan_create");
    const input = body.input, parameters = body.parameters ?? {};
    if (!mediaObject(parameters) || typeof input.prompt !== "string" || !input.prompt.trim() || [...input.prompt].length > (body.model === "wan2.7-r2v" ? 5000 : 1500)) throw new Error("invalid_wan_input");
    const v27 = body.model === "wan2.7-r2v", image = body.model === "wan2.6-i2v", reference = body.model.includes("-r2v");
    const allowedInput = ["prompt", ...(image ? ["img_url"] : reference ? [v27 ? "media" : "reference_urls"] : [])];
    if (Object.keys(input).some(key => !allowedInput.includes(key))) throw new Error("unsupported_wan_input");
    if (image) mediaUrl(input.img_url, true);
    let videoCount = 0;
    if (reference) {
      const media = input[v27 ? "media" : "reference_urls"];
      if (!Array.isArray(media) || !media.length || media.length > 5) throw new Error("invalid_wan_references");
      let firstFrames = 0;
      for (const item of media) {
        if (!v27) { mediaUrl(item, false); continue; }
        if (!mediaObject(item) || Object.keys(item).some(key => !["type", "url"].includes(key)) || !["reference_image", "reference_video", "first_frame"].includes(String(item.type))) throw new Error("invalid_wan_media");
        if (item.type === "reference_video") videoCount++;
        if (item.type === "first_frame") firstFrames++;
        mediaUrl(item.url, item.type !== "reference_video");
      }
      if (videoCount > 3 || firstFrames > 1 || v27 && media.length === firstFrames) throw new Error("invalid_wan_media_count");
    }
    const allowedParameters = ["duration", "watermark", ...(v27 ? ["resolution", "ratio"] : image ? ["resolution", "audio"] : ["size", "audio"])];
    if (Object.keys(parameters).some(key => !allowedParameters.includes(key))) throw new Error("unsupported_wan_parameters");
    const duration = parameters.duration ?? 5;
    // The frozen reference-mode catalog bounds the first slice to 10 seconds.
    if (!Number.isInteger(duration) || Number(duration) < 2 || Number(duration) > (reference ? 10 : 15)) throw new Error("invalid_wan_duration");
    if (parameters.size !== undefined && !sizes.has(String(parameters.size))) throw new Error("invalid_wan_size");
    if (parameters.resolution !== undefined && !["720P", "1080P"].includes(String(parameters.resolution))) throw new Error("invalid_wan_resolution");
    if (parameters.ratio !== undefined && !ratios.has(String(parameters.ratio))) throw new Error("invalid_wan_ratio");
    for (const name of ["audio", "watermark"]) if (parameters[name] !== undefined && typeof parameters[name] !== "boolean") throw new Error("invalid_wan_boolean");
    return { body, headers: new Headers({ "content-type": "application/json", "x-dashscope-async": "enable" }), requestedVersion: body.model, pathParams: {} };
  },
  identify(action, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, ["task_id"]);
    if (action !== "retrieve") throw new Error("unsupported_wan_control");
    return validateWanTaskId(pathParams.task_id);
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    if (action !== "retrieve" || endpoint.method !== "GET" || endpoint.path !== "/api/v1/tasks/${task_id}") throw new Error("unsupported_wan_control");
    return { path: `/api/v1/tasks/${validateWanTaskId(id)}`, query: new URLSearchParams() };
  },
  async read(response, context) {
    if (!["create", "retrieve"].includes(context.action)) throw new Error("unsupported_wan_control");
    const { body } = await readMediaJson(response), output = body.output;
    if (!mediaObject(output) || body.code !== undefined && body.code !== "") throw new Error("invalid_wan_response");
    const id = validateWanTaskId(output.task_id), status = output.task_status;
    if (context.action !== "create" && id !== validateWanTaskId(context.expectedId)) throw new Error("wan_identity_mismatch");
    if (typeof status !== "string" || !statuses.has(status)) throw new Error("invalid_wan_status");
    if (status === "UNKNOWN") return { id, nativeStatus: status, terminal: null, body, observationUnavailable: "expired_or_unknown" };
    return { id, nativeStatus: status, terminal: status === "SUCCEEDED" ? "succeeded" : status === "FAILED" ? "failed" : status === "CANCELED" ? "canceled" : null,
      body, ...(context.action === "create" && ["PENDING", "RUNNING"].includes(status) ? { followUp: "retrieve" as const } : {}) };
  },
  rewrite(observation) {
    const body = dropMediaControlUrls(observation.body);
    return { ...body, ...(mediaObject(body.output) ? { output: dropMediaControlUrls(body.output) } : {}) };
  },
};

function mediaUrl(value: unknown, inlineImage: boolean): void {
  if (typeof value !== "string" || !value.length || value.length > 28_000_000) throw new Error("invalid_wan_media_url");
  if (inlineImage && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const encoded = value.slice(value.indexOf(",") + 1), padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (encoded.length % 4 || encoded.length / 4 * 3 - padding > 20 * 1024 * 1024) throw new Error("invalid_wan_inline_image");
    return;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_wan_media_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || value.length > 8192) throw new Error("invalid_wan_media_url");
}
