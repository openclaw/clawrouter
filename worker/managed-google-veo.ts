import type { ManagedLifecycleAdapter, ManagedObservation, ManagedReadContext } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery } from "./managed-media-json.ts";
import { canonicalGoogleVeoBytes, googleVeoAssets, readGoogleVeoBytes } from "./provider-google-veo-files.ts";

export const googleVeoModels = ["veo-3.1-fast-generate-preview", "veo-3.1-generate-preview", "veo-3.1-lite-generate-preview"] as const;
export const googleVeoTiming = { requestTimeoutMs: 180_000, pollIntervalMs: 10_000, maxPollAttempts: 120 } as const;
export const googleVeoOperationMaxBytes = 16 * 1024 * 1024;
const models: ReadonlySet<string> = new Set(googleVeoModels);
type VeoAdapter = Omit<ManagedLifecycleAdapter, "protocol"> & { protocol: "google.veo" };
function requireVeo(value: unknown, field: string): asserts value { if (!value) throw new Error(`invalid_google_veo_${field}`); }
function only(value: Record<string, unknown>, keys: string[]): void { requireVeo(Object.keys(value).every(key => keys.includes(key)), "field"); }
export function googleVeoModel(value: unknown): string {
  requireVeo(typeof value === "string" && models.has(value), "model"); return value;
}

export function validateGoogleVeoOperation(value: unknown, model?: string): string {
  requireVeo(typeof value === "string", "operation");
  const match = /^(?:models\/([A-Za-z0-9_.-]+)\/)?operations\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  requireVeo(match && (!match[1] || (models.has(match[1]) && (model === undefined || match[1] === model))), "operation");
  return value;
}

/** Native REST body after frozen client duration/size and SDK input conversion. */
export function prepareGoogleVeoCreate(value: unknown, model: unknown): Record<string, unknown> {
  googleVeoModel(model);
  requireVeo(mediaObject(value), "request"); only(value, ["instances", "parameters"]);
  requireVeo(Array.isArray(value.instances) && value.instances.length === 1 && mediaObject(value.instances[0]), "instances");
  const instance = value.instances[0]; only(instance, ["prompt", "image", "video"]);
  requireVeo(typeof instance.prompt === "string" && instance.prompt.trim().length > 0 && instance.prompt.length <= 32_000, "prompt");
  requireVeo(!(instance.image !== undefined && instance.video !== undefined), "mixed_inputs");
  if (instance.image !== undefined) {
    requireVeo(mediaObject(instance.image), "image"); only(instance.image, ["bytesBase64Encoded", "mimeType"]);
    requireVeo(typeof instance.image.mimeType === "string" && /^image\/[A-Za-z0-9.+-]{1,64}$/.test(instance.image.mimeType), "image_mime");
    canonicalGoogleVeoBytes(instance.image.bytesBase64Encoded, googleVeoOperationMaxBytes);
  }
  if (instance.video !== undefined) {
    requireVeo(mediaObject(instance.video), "video"); only(instance.video, ["encodedVideo", "encoding"]);
    requireVeo(typeof instance.video.encoding === "string" && /^video\/[A-Za-z0-9.+-]{1,64}$/.test(instance.video.encoding), "video_mime");
    canonicalGoogleVeoBytes(instance.video.encodedVideo, googleVeoOperationMaxBytes);
  }
  if (value.parameters !== undefined) {
    requireVeo(mediaObject(value.parameters), "parameters"); only(value.parameters, ["durationSeconds", "aspectRatio", "resolution"]);
    const params = value.parameters;
    if (params.durationSeconds !== undefined) requireVeo([4, 6, 8].includes(params.durationSeconds as number), "duration");
    if (params.aspectRatio !== undefined) requireVeo(params.aspectRatio === "16:9" || params.aspectRatio === "9:16", "aspect_ratio");
    if (params.resolution !== undefined) requireVeo(params.resolution === "720p" || params.resolution === "1080p", "resolution");
  }
  return value;
}

export async function readGoogleVeo(response: Response, context: ManagedReadContext): Promise<ManagedObservation> {
  requireVeo(context.action === "create" || context.action === "retrieve", "control");
  const model = googleVeoModel(context.requestedVersion);
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mime !== "application/json") { void response.body?.cancel().catch(() => undefined); throw new Error("invalid_google_veo_response"); }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readGoogleVeoBytes(response, googleVeoOperationMaxBytes))); }
  catch { throw new Error("invalid_google_veo_response"); }
  requireVeo(mediaObject(parsed), "envelope"); const body = parsed;
  const id = validateGoogleVeoOperation(body.name, model);
  if (context.action === "retrieve") requireVeo(id === validateGoogleVeoOperation(context.expectedId, model), "identity_mismatch");
  requireVeo(body.done === undefined || typeof body.done === "boolean", "done");
  let terminal: ManagedObservation["terminal"] = null;
  if (body.done === true) {
    if (body.error !== undefined) {
      requireVeo(mediaObject(body.error) && Number.isInteger(body.error.code) && Number(body.error.code) > 0 && Number(body.error.code) <= 16 && body.response === undefined, "terminal_error");
      terminal = "failed";
    } else {
      googleVeoAssets(body, googleVeoOperationMaxBytes);
      terminal = "succeeded";
    }
  } else requireVeo(body.error === undefined && body.response === undefined, "pending_result");
  return { id, nativeStatus: body.done === true ? "done" : "pending", terminal, body,
    ...(context.action === "create" && terminal === null ? { followUp: "retrieve" as const } : {}) };
}

// Registry/schema and M02 credential/job/accounting activation stay with their
// shared owners. This adapter performs no fetch and never receives a secret.
export const googleVeoManagedAdapter: VeoAdapter = {
  protocol: "google.veo", requestFormats: ["google.veo_create"], supportsResult: false, supportsCancel: false,
  validateId: validateGoogleVeoOperation,
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, ["model"]);
    const model = googleVeoModel(pathParams.model);
    return { body: prepareGoogleVeoCreate(body, model), headers: new Headers({ "content-type": "application/json" }), requestedVersion: model, pathParams: { model } };
  },
  identify(action, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, ["operation_name"]);
    requireVeo(action === "retrieve", "control"); return validateGoogleVeoOperation(pathParams.operation_name);
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, ["model"]); const model = googleVeoModel(pathParams.model);
    requireVeo(action === "retrieve" && endpoint.method === "GET" && endpoint.path === "/${operation_name}", "control_endpoint");
    return { path: `/${validateGoogleVeoOperation(id, model)}`, query: new URLSearchParams() };
  },
  read: readGoogleVeo,
  rewrite(observation) { return dropMediaControlUrls(observation.body); },
};
