import type { ManagedFileAdapter, ManagedFileDescriptor } from "./managed-lifecycle-types.ts";
import { exactMediaParams, mediaPublicPath } from "./managed-media-json.ts";
import { observeOpenRouterVideo, openRouterVideoModels, readOpenRouterVideoContent, validateOpenRouterVideoId } from "./openrouter-video.ts";

const contentPath = "/v1/videos/${video_id}/content", fileLimit = 16 * 1024 * 1024;
function requireFile(value: unknown, reason: string): asserts value { if (!value) throw new Error("invalid_managed_openrouter_file_" + reason); }
function base(value: string): void { requireFile(value === "https://openrouter.ai/api" || value === "https://openrouter.ai/api/", "base"); }
function descriptor(file: ManagedFileDescriptor): void {
  validateOpenRouterVideoId(file.id);
  requireFile(file.mimeType === "video/mp4" && Object.keys(file).every(key => key === "id" || key === "mimeType"), "descriptor");
}
function query(value: URLSearchParams): void { requireFile(value.size === 1 && value.get("index") === "0", "index"); }

// Current official SDK pins video/mp4. A body URL or filename cannot select MIME.
export const openRouterVideoFiles: ManagedFileAdapter = {
  protocol: "openrouter.video", mode: "download_only",
  describe(observation, selectedBaseUrl) {
    base(selectedBaseUrl);
    if (observation.terminal !== "succeeded" || observation.observationUnavailable) return [];
    const native = observeOpenRouterVideo(observation.body, "retrieve", openRouterVideoModels[0], observation.id);
    requireFile(native.terminal === "succeeded" && native.contentAvailable, "observation");
    return [{ id: native.id, mimeType: "video/mp4" }];
  },
  identify(action, pathParams, values) {
    requireFile(action === "download", "action"); exactMediaParams(pathParams, ["video_id"]); query(values);
    return validateOpenRouterVideoId(pathParams.video_id);
  },
  control(action, endpoint, file, selectedBaseUrl, state) {
    requireFile(action === "download" && state === undefined, "action"); descriptor(file); base(selectedBaseUrl);
    requireFile(endpoint.method === "GET" && endpoint.path === contentPath, "endpoint"); query(new URLSearchParams(endpoint.query));
    return { path: `/v1/videos/${file.id}/content`, query: new URLSearchParams({ index: "0" }), headers: new Headers({ accept: "video/mp4" }) };
  },
  async readFile(response, file, maxBytes) {
    descriptor(file);
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > fileLimit || mime !== file.mimeType
      || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_openrouter_file_content");
    }
    // Shared dispatch supplies bounded/cancelable transport and the original
    // credential. This reader performs no fetch or separate metadata request.
    const content = await readOpenRouterVideoContent(response, new AbortController().signal, maxBytes);
    requireFile(content.mimeType === file.mimeType && (length === null || Number(length) === content.video.byteLength), "length");
    return content.video;
  },
  rewrite(body, paths) {
    requireFile(paths.length <= 1, "paths");
    const { unsigned_urls: _unsigned, urls: _signed, expires_at: _expiry, ...safe } = body;
    if (body.status !== "completed") { requireFile(paths.length === 0, "nonterminal_paths"); return safe; }
    requireFile(paths.length === 1 && paths[0].metadata === undefined
      && validateOpenRouterVideoId(body.id) === validateOpenRouterVideoId(paths[0].id), "binding");
    return { ...safe, unsigned_urls: [mediaPublicPath(paths[0].download)] };
  },
};
