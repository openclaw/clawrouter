import type { ManagedControl, ManagedFileAction, ManagedFileAdapter, ManagedFileDescriptor } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject } from "./managed-media-json.ts";
import { miniMaxVideoFiles, miniMaxVideoOrigins, observeMiniMaxVideo, prepareMiniMaxVideoFile, readMiniMaxVideoFile,
  readMiniMaxVideoFileState, validateMiniMaxMediaId } from "./minimax-video.ts";
import type { CompiledEndpoint } from "./types.ts";

const fileLimit = 16 * 1024 * 1024;
const downloadMimeTypes = Object.freeze(["video/mp4", "application/octet-stream", "application/json"]);
function requireFile(value: unknown): asserts value { if (!value) throw new Error("invalid_managed_minimax_file"); }
function descriptor(file: ManagedFileDescriptor): void {
  validateMiniMaxMediaId(file.id);
  requireFile(file.mimeType === "video/mp4" && Object.keys(file).every(key => key === "id" || key === "mimeType"));
}
function origin(value: string): void { requireFile(Object.values(miniMaxVideoOrigins).some(origin => origin === value)); }
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
  async readState(response, file) {
    try {
      descriptor(file);
      // Common boundedFileResponse supplies the original operation's physical
      // reader cancellation. This codec signal does not invent caller authority.
      const state = await readMiniMaxVideoFileState(boundedMiniMaxVideoResponse(response, ["application/json"], 64 * 1024),
        file.id, new AbortController().signal);
      requireFile(state.body.error === undefined);
      // Project identity/state only: never return a native CDN URL or arbitrary
      // metadata that could become an input or credential destination.
      return { id: state.id, status: state.status, body: { file: { file_id: state.id, purpose: "video_generation",
        ...(state.byteSize === null ? {} : { bytes: state.byteSize }) }, base_resp: { status_code: 0 } } };
    } catch {
      void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_minimax_file_response");
    }
  },
  async readFile(response, file, maxBytes) {
    try {
      descriptor(file); requireFile(Number.isSafeInteger(maxBytes) && maxBytes >= 16 && maxBytes <= fileLimit);
      return await readMiniMaxVideoFile(boundedMiniMaxVideoResponse(response, downloadMimeTypes, maxBytes), maxBytes, new AbortController().signal);
    } catch {
      void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_minimax_file_response");
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

// Strict transport envelope shared by these two inactive wrappers. Never fetch
// a URL, infer billing, or allocate a separate lease here. Common owns capacity.
export function boundedMiniMaxVideoResponse(response: Response, mimes: readonly string[], limit: number): Response {
  const mime = response.headers.get("content-type"), encoding = response.headers.get("content-encoding");
  const length = response.headers.get("content-length");
  const media = /^([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:\s*;\s*charset=utf-8)?$/i.exec(mime?.trim() ?? "");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || !media || !mimes.includes(media[1].toLowerCase())
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => undefined); throw new Error("invalid_managed_minimax_response");
  }
  const headers = new Headers(response.headers); headers.delete("content-encoding");
  const reader = response.body.getReader(); let reads = 0, size = 0;
  const cancel = (reason?: unknown) => reader.cancel(reason).catch(() => undefined).finally(() => reader.releaseLock());
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (++reads > 8192) throw new Error("invalid_managed_minimax_response");
        const chunk = await reader.read();
        if (chunk.done) { reader.releaseLock(); controller.close(); return; }
        size += chunk.value.byteLength;
        if (size > limit) throw new Error("invalid_managed_minimax_response");
        // Do not let a small view retain an arbitrarily large transport buffer.
        const value = chunk.value;
        controller.enqueue(value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice());
      } catch {
        void cancel(); controller.error(new Error("invalid_managed_minimax_response"));
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, headers });
}
