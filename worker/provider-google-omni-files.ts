import { mediaObject } from "./managed-media-json.ts";
import { canonicalGoogleVeoBytes, googleVeoApiBase, readGoogleVeoBytes, readGoogleVeoFile } from "./provider-google-veo-files.ts";

export const googleOmniEnvelopeBytes = 16 * 1024 * 1024;
export const googleOmniFilePollIntervalMs = 5000;
export type GoogleOmniVideo = { kind: "inline"; base64: string; decodedBytes: number; mimeType: string }
  | { kind: "file"; resource: string; mimeType: string };
export interface GoogleOmniFileState { name: string; state: "PROCESSING" | "ACTIVE" | "FAILED"; ready: boolean; failed: boolean }
export function requireOmni(value: unknown, field: string): asserts value { if (!value) throw new Error(`invalid_google_omni_${field}`); }
export function googleOmniFileName(value: unknown): string {
  requireOmni(typeof value === "string" && /^files\/[A-Za-z0-9_-]{1,128}$/.test(value), "file_name"); return value;
}
function fileUri(value: unknown): string {
  requireOmni(typeof value === "string" && value.length > 0 && value.length <= 8192, "file_uri");
  if (value.startsWith("files/")) return googleOmniFileName(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_google_omni_file_uri"); }
  requireOmni(url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
    && !/[\\%\s]/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
    && /\/files\/[A-Za-z0-9_-]{1,128}(?::download)?$/.test(url.pathname)
    && url.searchParams.size <= 1 && [...url.searchParams].every(([key, val]) => key === "alt" && val === "media"), "file_uri");
  return url.toString();
}

/** Inspect only native model_output steps; SDK output_video is a convenience getter. */
export function googleOmniVideos(body: Record<string, unknown>, maxBytes: number): GoogleOmniVideo[] {
  requireOmni(Number.isSafeInteger(maxBytes) && maxBytes > 0, "byte_limit");
  requireOmni(Array.isArray(body.steps) && body.steps.length <= 256, "steps");
  const videos: GoogleOmniVideo[] = []; let parts = 0;
  for (const step of body.steps) {
    requireOmni(mediaObject(step) && typeof step.type === "string", "step");
    if (step.type !== "model_output") continue;
    requireOmni(Array.isArray(step.content) && step.content.length <= 64, "content");
    parts += step.content.length; requireOmni(parts <= 4096, "content_limit");
    for (const content of step.content) {
      requireOmni(mediaObject(content) && typeof content.type === "string", "content");
      if (content.type !== "video") continue;
      requireOmni(content.mime_type === undefined || content.mime_type === "video/mp4", "output_mime");
      requireOmni((content.data !== undefined) !== (content.uri !== undefined), "video_source");
      const mimeType = "video/mp4";
      if (content.data !== undefined) videos.push({ kind: "inline", ...canonicalGoogleVeoBytes(content.data, maxBytes), mimeType });
      else videos.push({ kind: "file", resource: fileUri(content.uri), mimeType });
      requireOmni(videos.length <= 64, "video_limit");
    }
  }
  return videos;
}

/** Trusted M02-selected server base; never select it from an output URI. */
export function googleOmniApiBase(value: string): string {
  const base = googleVeoApiBase(value);
  requireOmni(new URL(base).pathname.endsWith("/v1beta"), "api_version"); return base;
}

export function prepareGoogleOmniFileControl(action: "metadata" | "download", video: GoogleOmniVideo,
  trustedApiBase: string, observed?: GoogleOmniFileState): {
    url: string; method: "GET"; redirect: "error"; credential: "original_job"; fileName: string;
  } {
  requireOmni(action === "metadata" || action === "download", "file_action");
  requireOmni(video.kind === "file", "file_source");
  const base = googleOmniApiBase(trustedApiBase), resource = fileUri(video.resource);
  const url = new URL(resource.startsWith("files/") ? `${base}/${resource}` : resource), root = new URL(base);
  requireOmni(url.origin === root.origin && url.pathname.startsWith(`${root.pathname}/files/`), "file_origin");
  const fileName = googleOmniFileName(url.pathname.slice(root.pathname.length + 1).replace(/:download$/, ""));
  if (action === "download") requireOmni(observed?.name === fileName && observed.state === "ACTIVE" && observed.ready === true && observed.failed === false, "file_not_ready");
  return { url: `${base}/${fileName}${action === "download" ? ":download?alt=media" : ""}`, method: "GET", redirect: "error", credential: "original_job", fileName };
}

export async function readGoogleOmniJson(response: Response): Promise<Record<string, unknown>> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mime !== "application/json") { void response.body?.cancel().catch(() => undefined); throw new Error("invalid_google_omni_response"); }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readGoogleVeoBytes(response, googleOmniEnvelopeBytes)));
    requireOmni(mediaObject(value), "envelope"); return value;
  } catch { throw new Error("invalid_google_omni_response"); }
}

/** File processing failure is not proof of an unbilled/failed interaction. */
export async function readGoogleOmniFileState(response: Response, expectedFileName: string): Promise<GoogleOmniFileState> {
  const expected = googleOmniFileName(expectedFileName), body = await readGoogleOmniJson(response);
  requireOmni(googleOmniFileName(body.name) === expected, "file_identity");
  requireOmni(body.state === "PROCESSING" || body.state === "ACTIVE" || body.state === "FAILED", "file_state");
  requireOmni(body.state === "FAILED" || body.error === undefined, "file_error");
  if (body.mimeType !== undefined) requireOmni(body.mimeType === "video/mp4", "file_mime");
  // Never follow metadata.uri/downloadUri; rebuild the selected-origin request.
  return { name: expected, state: body.state, ready: body.state === "ACTIVE", failed: body.state === "FAILED" };
}

export const readGoogleOmniFile = readGoogleVeoFile;
