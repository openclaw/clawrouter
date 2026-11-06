import { isMiniMaxVideoModel, miniMaxVideoRequiresInline } from "../shared/minimax-video-binding.ts";
import { miniMaxInlineScalars } from "./minimax-video-inline.ts";
import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery } from "./managed-media-json.ts";
import { miniMaxVideoFileAdapter } from "./managed-minimax-video-files.ts";
import { miniMaxVideoOrigins, prepareMiniMaxVideo, prepareMiniMaxInlineVideoScalars, prepareMiniMaxVideoControl, readMiniMaxVideo,
  validateMiniMaxMediaId } from "./minimax-video.ts";

import { videoJsonBytes, discardVideoInput } from "./minimax-video-operation.ts";

function requireVideo(value: unknown): asserts value { if (!value) throw new Error("invalid_managed_minimax_video"); }

// The common owner qualifies regional video authority and owns physical retirement.
export const miniMaxVideoManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "minimax.video", requestFormats: ["minimax.video_create"], supportsResult: false, supportsCancel: false,
  files: miniMaxVideoFileAdapter, identityProbe: "1", validateId: validateMiniMaxMediaId,
  assertDispatch(request) {
    const url = new URL(request.url);
    requireVideo(Object.values(miniMaxVideoOrigins).some(origin => origin === url.origin) && !url.username && !url.password && !url.hash);
    if (request.method === "POST") requireVideo(url.pathname === "/v1/video_generation" && !url.search);
    else {
      requireVideo(request.method === "GET");
      const field = url.pathname === "/v1/query/video_generation" ? "task_id"
        : ["/v1/files/retrieve", "/v1/files/retrieve_content"].includes(url.pathname) ? "file_id" : null;
      requireVideo(field && url.searchParams.size === 1 && url.searchParams.getAll(field).length === 1);
      validateMiniMaxMediaId(url.searchParams.get(field));
    }
    // Destination shape is not product entitlement or credential authority.
  },
  prepare(value, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    requireVideo(mediaObject(value) && isMiniMaxVideoModel(value.model)
      && (!miniMaxVideoRequiresInline(value.model) || miniMaxInlineScalars(value))
      && !Object.hasOwn(value, "first_frame_image")
      && (value.prompt === undefined && miniMaxVideoRequiresInline(value.model)
        || typeof value.prompt === "string" && !/[\uD800-\uDFFF]/u.test(value.prompt))
      && value.duration !== undefined && value.resolution !== undefined);
    // Regional request shapes are identical. This codec origin is discarded;
    // only the future common original-owner binding can choose a destination.
    const prepared = miniMaxInlineScalars(value) ? prepareMiniMaxInlineVideoScalars(value) : prepareMiniMaxVideo("global", value);
    requireVideo(videoJsonBytes(prepared.body, "input") <= 16 * 1024);
    return { body: prepared.body, headers: prepared.headers, requestedVersion: prepared.requestedVersion, pathParams: {} };
  },
  identify(action, pathParams, query) {
    exactMediaParams(pathParams, []);
    requireVideo(action === "retrieve" && query.size === 1 && query.getAll("task_id").length === 1);
    return validateMiniMaxMediaId(query.get("task_id"));
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    requireVideo(action === "retrieve" && endpoint.method === "GET" && endpoint.path === "/v1/query/video_generation");
    const target = prepareMiniMaxVideoControl(action, id);
    return { path: target.path, query: target.query };
  },
  async read(response, context) {
    try {
      requireVideo(context.signal instanceof AbortSignal && isMiniMaxVideoModel(context.requestedVersion)
        && (context.action === "create" || context.action === "retrieve"));
      exactMediaParams(context.pathParams, []);
      if (context.action === "create") requireVideo(context.expectedId === undefined);
      else validateMiniMaxMediaId(context.expectedId);
      return await readMiniMaxVideo(response, context.action, context.expectedId, context.signal, context.registerInput);
    } catch {
      await discardVideoInput(response, context.registerInput).catch(() => undefined);
      throw new Error("invalid_managed_minimax_video_response");
    }
  },
  rewrite(observation, paths) {
    requireVideo(paths.retrieve && !paths.cancel && !paths.result);
    const id = validateMiniMaxMediaId(observation.id);
    requireVideo(validateMiniMaxMediaId(observation.body.task_id) === id);
    requireVideo(paths.retrieve === `/v1/native/minimax/v1/query/video_generation?task_id=${id}`);
    const { video_url: _video, download_url: _download, ...body } = dropMediaControlUrls(observation.body);
    return body;
  },
};
