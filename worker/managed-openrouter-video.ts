import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { exactMediaParams, mediaObject, mediaPublicPath, noMediaQuery } from "./managed-media-json.ts";
import { openRouterVideoFiles } from "./managed-openrouter-video-files.ts";
import { openRouterVideoModels, prepareOpenRouterVideo, prepareOpenRouterVideoControl, readOpenRouterVideo,
  validateOpenRouterVideoId } from "./openrouter-video.ts";

function requireVideo(value: unknown, reason: string): asserts value { if (!value) throw new Error("invalid_managed_openrouter_video_" + reason); }

// Retention authority is per request, after original credential selection.
export function createOpenRouterVideoManagedAdapter(): ManagedLifecycleAdapter {
  return {
    protocol: "openrouter.video", requestFormats: ["openrouter.video_create"], supportsResult: false, supportsCancel: false,
    validateId: validateOpenRouterVideoId, files: openRouterVideoFiles,
    assertDispatch(request) {
      const url = new URL(request.url);
      requireVideo(url.origin === "https://openrouter.ai" && !url.username && !url.password && !url.hash
        && /^Bearer [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? ""), "dispatch");
      if (request.method === "POST" && url.pathname === "/api/v1/videos") {
        // Shared dispatch rechecks original-grant retention permission. This
        // pure hook only qualifies the materialized origin, path and headers.
        requireVideo(!url.search && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json", "create_dispatch");
        return;
      }
      requireVideo(request.method === "GET", "method");
      const match = /^\/api\/v1\/videos\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/content)?$/.exec(url.pathname);
      requireVideo(match, "route");
      requireVideo(match[2] ? url.searchParams.size === 1 && url.searchParams.get("index") === "0" : !url.search, "query");
    },
    prepare() { throw new Error("invalid_managed_openrouter_video_retention_admission_required"); },
    prepareAdmitted(body, _headers, pathParams, query, admission) {
      noMediaQuery(query); exactMediaParams(pathParams, []);
      const retentionAllowed = admission?.upstreamRetention === "allowed";
      requireVideo(retentionAllowed, "retention_admission_required");
      requireVideo(mediaObject(body) && !Object.hasOwn(body, "frame_images") && !Object.hasOwn(body, "input_references"), "asset_binding_required");
      const prepared = prepareOpenRouterVideo(openRouterVideoModels[0], body, { retentionAllowed });
      // The original selected request already owns its JSON headers and auth.
      // Admission allows canonical body replacement, never header/route changes.
      return { body: prepared.body, headers: new Headers(), requestedVersion: prepared.requestedVersion, pathParams: {} };
    },
    identify(action, pathParams, query) {
      requireVideo(action === "retrieve", "control"); noMediaQuery(query); exactMediaParams(pathParams, ["video_id"]);
      return validateOpenRouterVideoId(pathParams.video_id);
    },
    control(action, endpoint, id, pathParams) {
      exactMediaParams(pathParams, []);
      requireVideo(action === "retrieve" && endpoint.method === "GET" && endpoint.path === "/v1/videos/${video_id}", "control_endpoint");
      const prepared = prepareOpenRouterVideoControl(action, id);
      return { path: prepared.path.slice(4), query: prepared.query, headers: prepared.headers };
    },
    read(response, context) {
      requireVideo(context.action === "create" || context.action === "retrieve", "control"); exactMediaParams(context.pathParams, []);
      return readOpenRouterVideo(response, context.action, context.requestedVersion, context.expectedId, new AbortController().signal);
    },
    rewrite(observation, paths) {
      requireVideo(paths.result === undefined && paths.cancel === undefined, "public_controls");
      const retrieve = mediaPublicPath(paths.retrieve);
      const { polling_url: _poll, unsigned_urls: _unsigned, urls: _signed, expires_at: _expiry, ...body } = observation.body;
      // The file wrapper later supplies only the runtime-bound download link.
      return { ...body, id: observation.id, polling_url: retrieve };
    },
  };
}
export const openRouterVideoManagedAdapter = createOpenRouterVideoManagedAdapter();
