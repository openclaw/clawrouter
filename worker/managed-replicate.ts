import { parseReplicatePrediction, prepareReplicateCreate, readReplicatePrediction, replicateControlPath,
  rewriteReplicatePredictionUrls, validateReplicatePredictionId } from "./replicate-lifecycle.ts";
import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, noMediaQuery } from "./managed-media-json.ts";

export const replicateManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "replicate.predictions", requestFormats: ["replicate.prediction_create"], supportsResult: false, supportsCancel: true,
  validateId: validateReplicatePredictionId,
  prepare(body, headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    return { ...prepareReplicateCreate(body, headers), pathParams: {} };
  },
  identify(action, pathParams, query) {
    if (action === "result") throw new Error("unsupported_replicate_control");
    noMediaQuery(query); exactMediaParams(pathParams, ["prediction_id"]);
    return validateReplicatePredictionId(pathParams.prediction_id);
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    const path = "/v1/predictions/${prediction_id}" + (action === "cancel" ? "/cancel" : "");
    if (action === "result" || endpoint.method !== (action === "cancel" ? "POST" : "GET") || endpoint.path !== path) {
      throw new Error("invalid_replicate_control_endpoint");
    }
    return { path: replicateControlPath(path, id), query: new URLSearchParams() };
  },
  async read(response, context) {
    if (context.action === "result") throw new Error("unsupported_replicate_control");
    if (response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("invalid_replicate_prediction_response");
    }
    const prediction = await readReplicatePrediction(response,
      context.action === "create" ? undefined : validateReplicatePredictionId(context.expectedId));
    const observation = prediction.observation;
    return { id: observation.id, nativeStatus: observation.status, terminal: observation.status === "starting" || observation.status === "processing" ? null : observation.status,
      body: prediction.body };
  },
  rewrite(observation, paths) {
    if (!paths.retrieve) throw new Error("missing_replicate_retrieve_path");
    if (!paths.cancel) throw new Error("missing_replicate_cancel_path");
    return rewriteReplicatePredictionUrls(parseReplicatePrediction(JSON.stringify(dropMediaControlUrls(observation.body)), observation.id),
      { get: paths.retrieve, cancel: paths.cancel });
  },
};
