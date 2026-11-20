import { falQueuePaths, parseFalCancelAcknowledgement, parseFalQueueObservation, parseFalResult, parseFalSubmission,
  prepareFalQueueSubmit, validateFalRequestId } from "./fal-queue.ts";
import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { isFalPromptVideoModel, prepareFalPromptVideo } from "./fal-prompt-video.ts";
import { isFalHostedWanModel, prepareFalHostedWan } from "./fal-hosted-wan.ts";
import { isFalSeedanceModel, prepareFalSeedance } from "./fal-seedance.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, mediaPublicPath, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

function endpointId(params: Record<string, string>): string {
  exactMediaParams(params, ["owner", "app"], ["variant", "subvariant"]);
  if (params.subvariant !== undefined && params.variant === undefined) throw new Error("invalid_fal_endpoint_id");
  const id = [params.owner, params.app, ...(params.variant === undefined ? [] : [params.variant]),
    ...(params.subvariant === undefined ? [] : [params.subvariant])].join("/");
  // Dots and fourth segments belong only to exact qualified frozen products.
  const wan = isFalHostedWanModel(id), seedance = isFalSeedanceModel(id);
  if (params.subvariant !== undefined && !isFalPromptVideoModel(id) && !wan && !seedance) throw new Error("invalid_fal_endpoint_id");
  const segment = wan || seedance ? /^[a-zA-Z0-9_.-]{1,64}$/ : /^[a-zA-Z0-9_-]{1,64}$/;
  if (Object.values(params).some(value => !segment.test(value))) throw new Error("invalid_fal_endpoint_id");
  falQueuePaths(id);
  return id;
}

function falPublicPath(path: string | undefined): string {
  // This exact public control root is the only dotted-path exception. Keep
  // other protocols and arbitrary fal paths on the shared strict validator.
  if (typeof path === "string" && /^\/v1\/native\/fal\/bytedance\/seedance-2\.0\/requests\/[a-zA-Z0-9_-]{1,128}(?:\/(?:status|cancel))?$/.test(path)) return path;
  return mediaPublicPath(path);
}

export const falManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "fal.queue", requestFormats: ["fal.queue_submit"], supportsResult: true, supportsCancel: true,
  validateId: validateFalRequestId,
  prepare(body, _headers, pathParams, query) {
    if (!mediaObject(body)) throw new Error("invalid_fal_create");
    const id = endpointId(pathParams), prepared = prepareFalQueueSubmit(id, query);
    // The synchronous codec's unqualified generation path must not gain
    // authority through the generic queue route. Existing jobs keep controls.
    if (id === "xai/grok-imagine-image/quality") throw new Error("fal_grok_quality_native_contract_unqualified");
    return { body: isFalPromptVideoModel(id) ? prepareFalPromptVideo(id, body) : isFalHostedWanModel(id) ? prepareFalHostedWan(id, body).body
      : isFalSeedanceModel(id) ? prepareFalSeedance(id, body).body : body,
      headers: prepared.headers, requestedVersion: id, pathParams: { ...pathParams } };
  },
  identify(_action, pathParams, query) {
    noMediaQuery(query);
    exactMediaParams(pathParams, ["owner", "app", "request_id"]);
    // Identity lookup is not control authority. The runtime resolves the
    // original create parameters before control(), including fast/mode fields.
    if (pathParams.owner !== "bytedance" || pathParams.app !== "seedance-2.0") {
      endpointId({ owner: pathParams.owner, app: pathParams.app });
    }
    return validateFalRequestId(pathParams.request_id);
  },
  control(action, endpoint, id, pathParams) {
    const paths = falQueuePaths(endpointId(pathParams), id);
    const suffix = action === "retrieve" ? "/status" : action === "cancel" ? "/cancel" : "";
    if (endpoint.method !== (action === "cancel" ? "PUT" : "GET")
      || endpoint.path !== "/${owner}/${app}/requests/${request_id}" + suffix) throw new Error("invalid_fal_control_endpoint");
    return { path: (action === "retrieve" ? paths.status : action === "cancel" ? paths.cancel : paths.result)!, query: new URLSearchParams() };
  },
  async read(response, context) {
    const expectedId = context.action === "create" ? undefined : validateFalRequestId(context.expectedId);
    const allowed = context.action === "cancel" ? (status: number) => [200, 202, 400, 404].includes(status)
      : context.action === "result" ? (status: number) => status >= 200 && status < 300 || status === 422
      : undefined;
    const { text, body } = await readMediaJson(response, allowed);
    if (context.action === "create") {
      return { id: parseFalSubmission(text).id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
    }
    if (context.action === "cancel") {
      const ack = parseFalCancelAcknowledgement(response.status, text);
      return { id: expectedId!, nativeStatus: String(body.status), terminal: ack.queueTerminal ? "canceled" : null,
        body, ...(ack.observeStatus ? { followUp: "retrieve" as const } : {}) };
    }
    if (context.action === "result") {
      // Result has no ID: it inherits only the already-authorized bound request.
      // Gateway/auth/rate-limit errors never become a terminal model failure.
      if (response.status === 422 && !body.error && !body.error_type
        && typeof body.detail !== "string" && !Array.isArray(body.detail)) throw new Error("invalid_fal_result_failure");
      const result = parseFalResult(text, response.status);
      return { id: expectedId!, nativeStatus: "COMPLETED", terminal: result.httpSucceeded ? "succeeded" : "failed", body };
    }
    const observation = parseFalQueueObservation(text, expectedId);
    return { id: observation.id, nativeStatus: observation.status, terminal: observation.failed ? "failed" : null, body,
      ...(observation.resultRequired && !observation.failed ? { followUp: "result" as const } : {}) };
  },
  rewrite(observation, paths) {
    const body = dropMediaControlUrls(observation.body);
    // Model result payloads are opaque; do not inject control fields into them.
    if (!Object.hasOwn(body, "request_id")) return body;
    return { ...body, status_url: falPublicPath(paths.retrieve), response_url: falPublicPath(paths.result), cancel_url: falPublicPath(paths.cancel) };
  },
};
