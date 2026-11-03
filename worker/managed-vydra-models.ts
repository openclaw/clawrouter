import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaPublicPath, noMediaQuery } from "./managed-media-json.ts";
import { prepareVydraModel, readVydraModel } from "./vydra-models.ts";
import { validateVydraJobId, vydraJobPath } from "./vydra-jobs.ts";

function model(params: Record<string, string>): "veo3" | "kling" {
  exactMediaParams(params, ["model"]);
  if (params.model !== "veo3" && params.model !== "kling") throw new Error("unsupported_vydra_models_video");
  return params.model;
}
// Uses the existing Vydra job identity and scoped controller. Register only
// after the Models create format and original-create-route lookup are qualified.
export const vydraModelVideoAdapter: ManagedLifecycleAdapter = {
  protocol: "vydra.jobs", requestFormats: ["vydra.model_video_create"], supportsResult: false, supportsCancel: false,
  validateId: validateVydraJobId,
  assertDispatch(request) {
    const url = new URL(request.url);
    if (url.origin !== "https://www.vydra.ai" || url.username || url.password || url.search || url.hash
      || !/^Bearer [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? "")) throw new Error("invalid_vydra_models_dispatch");
    if (request.method === "POST" && /^\/api\/v1\/models\/(veo3|kling)$/.test(url.pathname)
      && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json") return;
    if (request.method !== "GET" || !/^\/api\/v1\/jobs\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) throw new Error("invalid_vydra_models_route");
  },
  prepare(body, _headers, params, query) {
    noMediaQuery(query);
    const prepared = prepareVydraModel(model(params), body);
    return { body: prepared.body, headers: prepared.headers, requestedVersion: prepared.model, pathParams: { model: prepared.model } };
  },
  identify(action, params, query) {
    if (action !== "retrieve") throw new Error("unsupported_vydra_models_control");
    noMediaQuery(query); exactMediaParams(params, ["job_id"]);
    return validateVydraJobId(params.job_id);
  },
  control(action, endpoint, id, params) {
    model(params);
    if (action !== "retrieve" || endpoint.method !== "GET" || endpoint.path !== "/api/v1/jobs/${job_id}") throw new Error("unsupported_vydra_models_control");
    return { path: vydraJobPath(id), query: new URLSearchParams() };
  },
  async read(response, context) {
    if (context.action !== "create" && context.action !== "retrieve") throw new Error("unsupported_vydra_models_control");
    const selected = model(context.pathParams);
    if (context.requestedVersion !== selected) throw new Error("vydra_models_original_model_mismatch");
    const observed = await readVydraModel(response, { model: selected, kind: "video" }, context.action, new AbortController().signal, context.expectedId);
    return { id: observed.id!, nativeStatus: observed.nativeStatus, terminal: observed.terminal, body: observed.body };
  },
  rewrite(observation, paths) {
    mediaPublicPath(paths.retrieve);
    if (paths.cancel !== undefined || paths.result !== undefined) throw new Error("unsupported_vydra_models_control");
    return dropMediaControlUrls(observation.body);
  },
};
