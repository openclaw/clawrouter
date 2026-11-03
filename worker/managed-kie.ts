import { kieTaskPath, parseKieSubmission, parseKieTask, prepareKieTask, validateKieTaskId } from "./kie-jobs.ts";
import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const kieManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "kie.jobs", requestFormats: ["kie.job_create"], supportsResult: false, supportsCancel: false,
  validateId: validateKieTaskId,
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    const prepared = prepareKieTask(body);
    return { body: prepared.body, headers: new Headers({ "content-type": "application/json" }),
      requestedVersion: prepared.model, pathParams: {} };
  },
  identify(action, pathParams, query) {
    if (action !== "retrieve") throw new Error("unsupported_kie_control");
    exactMediaParams(pathParams, []);
    if (query.size !== 1 || query.getAll("taskId").length !== 1) throw new Error("invalid_kie_control_query");
    return validateKieTaskId(query.get("taskId"));
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    if (action !== "retrieve" || endpoint.method !== "GET" || endpoint.path !== "/api/v1/jobs/recordInfo") throw new Error("unsupported_kie_control");
    const [path, query] = kieTaskPath(id).split("?");
    return { path, query: new URLSearchParams(query) };
  },
  async read(response, context) {
    if (context.action !== "create" && context.action !== "retrieve") throw new Error("unsupported_kie_control");
    const { text, body } = await readMediaJson(response);
    if (context.action === "create") {
      return { id: parseKieSubmission(text, response.status).id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
    }
    const observation = parseKieTask(text, response.status, validateKieTaskId(context.expectedId));
    // The documented state establishes termination even when output/metrics are
    // absent. Output decoding is a consumer concern, never evidence of a refund.
    return { id: observation.id, nativeStatus: observation.state,
      terminal: observation.state === "success" ? "succeeded" : observation.state === "fail" ? "failed" : null, body };
  },
  rewrite(observation) {
    const body = dropMediaControlUrls(observation.body);
    return { ...body, ...(mediaObject(body.data) ? { data: dropMediaControlUrls(body.data) } : {}) };
  },
};
