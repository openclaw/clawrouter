import { parseVydraCancelAcknowledgement, parseVydraJob, parseVydraSubmission, prepareVydraJob,
  validateVydraJobId, vydraJobPath } from "./vydra-jobs.ts";
import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const vydraManagedAdapter: ManagedLifecycleAdapter = {
  protocol: "vydra.jobs", requestFormats: ["vydra.job_create"], supportsResult: false, supportsCancel: true,
  validateId: validateVydraJobId,
  prepare(body, _headers, pathParams, query) {
    noMediaQuery(query); exactMediaParams(pathParams, []);
    const prepared = prepareVydraJob(body);
    return { body: prepared.body, headers: new Headers({ "content-type": "application/json" }),
      requestedVersion: prepared.workflow, pathParams: {} };
  },
  identify(action, pathParams, query) {
    if (action === "result") throw new Error("unsupported_vydra_control");
    noMediaQuery(query); exactMediaParams(pathParams, ["job_id"]);
    return validateVydraJobId(pathParams.job_id);
  },
  control(action, endpoint, id, pathParams) {
    exactMediaParams(pathParams, []);
    if (action === "result" || endpoint.method !== (action === "cancel" ? "DELETE" : "GET")
      || endpoint.path !== "/api/v1/jobs/${job_id}") throw new Error("invalid_vydra_control_endpoint");
    return { path: vydraJobPath(id), query: new URLSearchParams() };
  },
  async read(response, context) {
    if (context.action === "result") throw new Error("unsupported_vydra_control");
    const { text, body } = await readMediaJson(response);
    if (context.action !== "cancel" && ["workflow", "workflowSlug"].some(key =>
      body[key] !== undefined && body[key] !== context.requestedVersion)) throw new Error("vydra_job_workflow_mismatch");
    if (context.action === "create") {
      const result = parseVydraSubmission(text, response.status);
      return { id: result.observation.id, nativeStatus: result.observation.status, terminal: null, body, followUp: "retrieve" };
    }
    const id = validateVydraJobId(context.expectedId);
    if (context.action === "cancel") {
      parseVydraCancelAcknowledgement(text, response.status);
      return { id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
    }
    const observation = parseVydraJob(text, response.status, id);
    return { id, nativeStatus: observation.status, terminal: observation.status === "completed" ? "succeeded"
      : observation.status === "failed" ? "failed" : observation.status === "cancelled" ? "canceled" : null, body };
  },
  rewrite: observation => dropMediaControlUrls(observation.body),
};
