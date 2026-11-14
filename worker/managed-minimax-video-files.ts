import { discardVideoInput } from "./minimax-video-operation.ts";
import type { ManagedControl, ManagedFileAction, ManagedFileAdapter, ManagedFileDescriptor } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject } from "./managed-media-json.ts";
import { isMiniMaxVideoOrigin, miniMaxVideoFiles, miniMaxVideoOrigins, observeMiniMaxVideo, prepareMiniMaxVideoFile, readMiniMaxVideoFile,
  readMiniMaxVideoFileState, validateMiniMaxMediaId } from "./minimax-video.ts";
import type { CompiledEndpoint } from "./types.ts";

const fileLimit = 16 * 1024 * 1024;
const downloadMimeTypes = Object.freeze(["video/mp4", "application/octet-stream", "application/json"]);
function requireFile(value: unknown): asserts value { if (!value) throw new Error("invalid_managed_minimax_file"); }
function descriptor(file: ManagedFileDescriptor): void {
  validateMiniMaxMediaId(file.id);
  requireFile(file.mimeType === "video/mp4" && Object.keys(file).every(key => key === "id" || key === "mimeType"));
}
function origin(value: string): void { requireFile(isMiniMaxVideoOrigin(value)); }
function control(action: ManagedFileAction, endpoint: Pick<CompiledEndpoint, "method" | "path" | "query">,
  file: ManagedFileDescriptor): Pick<ManagedControl, "path" | "query"> {
  descriptor(file);
  requireFile((action === "metadata" || action === "download") && endpoint.method === "GET" && Object.keys(endpoint.query).length === 0);
  const target = prepareMiniMaxVideoFile(action, miniMaxVideoOrigins.global, file.id);
  requireFile(endpoint.path === target.path);
  return { path: target.path, query: target.query };
}

export const miniMaxVideoFileAdapter: ManagedFileAdapter = {
  protocol: "minimax.video", downloadMimeTypes, publicControl: control,
  describe(observation, selectedBaseUrl) {
    origin(selectedBaseUrl);
    if (observation.observationUnavailable || observation.terminal !== "succeeded") return [];
    return miniMaxVideoFiles(observation);
  },
  identify(action, pathParams, query) {
    exactMediaParams(pathParams, []);
    requireFile((action === "metadata" || action === "download") && query.size === 1 && query.getAll("file_id").length === 1);
    return validateMiniMaxMediaId(query.get("file_id"));
  },
  control(action, endpoint, file, selectedBaseUrl, state) {
    origin(selectedBaseUrl);
    if (action === "download") {
      requireFile(state?.id === file.id && state.status === "active" && mediaObject(state.body.file)
        && state.body.file.file_id === file.id && state.body.file.purpose === "video_generation"
        && mediaObject(state.body.base_resp) && state.body.base_resp.status_code === 0);
      const bytes = state.body.file.bytes;
      requireFile(bytes === undefined || Number.isSafeInteger(bytes) && Number(bytes) >= 0 && Number(bytes) <= fileLimit);
    }
    return control(action, endpoint, file);
  },
  async readState(response, file, context) {
    try {
      descriptor(file);
      // The registered runtime supplies direct original-reader custody.
      const state = await readMiniMaxVideoFileState(response, file.id, context?.signal ?? new AbortController().signal, context?.registerInput);
      requireFile(!Object.hasOwn(state.body, "error"));
      // Project identity/state only: never return a native CDN URL or arbitrary
      // metadata that could become an input or credential destination.
      return { id: state.id, status: state.status, body: { file: { file_id: state.id, purpose: "video_generation",
        ...(state.byteSize === null ? {} : { bytes: state.byteSize }) }, base_resp: { status_code: 0 } } };
    } catch {
      await discardVideoInput(response, context?.registerInput).catch(() => undefined);
      throw new Error("invalid_managed_minimax_file_response");
    }
  },
  async readFile(response, file, maxBytes, context) {
    try {
      descriptor(file); requireFile(Number.isSafeInteger(maxBytes) && maxBytes >= 16 && maxBytes <= fileLimit);
      return await readMiniMaxVideoFile(response, maxBytes, context?.signal ?? new AbortController().signal, context?.registerInput);
    } catch {
      await discardVideoInput(response, context?.registerInput).catch(() => undefined);
      throw new Error("invalid_managed_minimax_file_response");
    }
  },
  rewrite(value, paths) {
    const { video_url: _video, download_url: _download, ...body } = dropMediaControlUrls(value);
    if (body.status !== "Success") { requireFile(paths.length === 0); return body; }
    observeMiniMaxVideo(body, "retrieve", validateMiniMaxMediaId(body.task_id));
    const id = validateMiniMaxMediaId(body.file_id);
    requireFile(paths.length === 1 && paths[0].id === id
      && paths[0].metadata === `/v1/native/minimax/v1/files/retrieve?file_id=${id}`
      && paths[0].download === `/v1/native/minimax/v1/files/retrieve_content?file_id=${id}`);
    return { ...body, video_url: paths[0].download };
  },
};
