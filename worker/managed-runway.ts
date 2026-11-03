import type { ManagedLifecycleAdapter, ManagedObservation, ManagedReadContext } from "./managed-lifecycle-types.ts";
import { dropMediaControlUrls, exactMediaParams, mediaObject, noMediaQuery, readMediaJson } from "./managed-media-json.ts";

export const runwayApiVersion = "2024-11-06";
export const runwayModels = {
  text: ["gen4.5", "veo3.1", "veo3.1_fast", "veo3"],
  image: ["gen4.5", "gen4_turbo", "gen3a_turbo", "veo3.1", "veo3.1_fast", "veo3"],
  video: ["gen4_aleph"],
} as const;
const ratios = new Set(["1280:720", "720:1280", "960:960", "832:1104", "1104:832", "1584:672"]);
const statuses = new Set(["PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);

interface RunwayObservation extends ManagedObservation {
  observationUnavailable?: "canceled_or_deleted";
}

// Pending shared protocol, per-control headers and observation-loss support.
// An acknowledged DELETE cannot safely be represented as free execution.
type RunwayAdapter = Omit<ManagedLifecycleAdapter, "protocol" | "control" | "read"> & {
  protocol: "runway.tasks";
  control(...args: Parameters<ManagedLifecycleAdapter["control"]>): ReturnType<ManagedLifecycleAdapter["control"]> & { headers: Headers };
  read(response: Response, context: ManagedReadContext): Promise<RunwayObservation>;
};

export function validateRunwayTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error("invalid_runway_task_id");
  return value.toLowerCase();
}

export function createRunwayManagedAdapter(mode: keyof typeof runwayModels): RunwayAdapter {
  return {
    protocol: "runway.tasks", requestFormats: ["runway." + mode + "_video"],
    supportsResult: false, supportsCancel: true, validateId: validateRunwayTaskId,
    prepare(body, _headers, pathParams, query) {
      noMediaQuery(query); exactMediaParams(pathParams, []);
      if (!mediaObject(body) || typeof body.model !== "string" || !(runwayModels[mode] as readonly string[]).includes(body.model)) throw new Error("invalid_runway_model");
      const allowed = ["model", "promptText", "ratio", ...(mode === "video" ? ["videoUri"] : ["duration", ...(mode === "image" ? ["promptImage"] : [])])];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error("unsupported_runway_input");
      if (typeof body.promptText !== "string" || !body.promptText.trim() || body.promptText.length > 1000) throw new Error("invalid_runway_prompt");
      if (typeof body.ratio !== "string" || !ratios.has(body.ratio)
        || mode === "text" && !["1280:720", "720:1280"].includes(body.ratio)) throw new Error("invalid_runway_ratio");
      if (mode !== "video" && (!Number.isInteger(body.duration) || Number(body.duration) < 2 || Number(body.duration) > 10)) throw new Error("invalid_runway_duration");
      if (["veo3.1", "veo3.1_fast"].includes(body.model)
        && (![4, 6, 8].includes(Number(body.duration)) || !["1280:720", "720:1280"].includes(body.ratio))) throw new Error("invalid_runway_veo_shape");
      if (mode === "image") mediaUri(body.promptImage, "image");
      if (mode === "video") mediaUri(body.videoUri, "video");
      return { body, headers: new Headers({ "content-type": "application/json", "x-runway-version": runwayApiVersion }),
        requestedVersion: body.model, pathParams: {} };
    },
    identify(action, pathParams, query) {
      noMediaQuery(query); exactMediaParams(pathParams, ["id"]);
      if (!["retrieve", "cancel"].includes(action)) throw new Error("unsupported_runway_control");
      return validateRunwayTaskId(pathParams.id);
    },
    control(action, endpoint, id, pathParams) {
      exactMediaParams(pathParams, []);
      if (!["retrieve", "cancel"].includes(action) || endpoint.path !== "/v1/tasks/${id}"
        || endpoint.method !== (action === "retrieve" ? "GET" : "DELETE")) throw new Error("unsupported_runway_control");
      return { path: "/v1/tasks/" + validateRunwayTaskId(id), query: new URLSearchParams(),
        headers: new Headers({ "x-runway-version": runwayApiVersion, accept: action === "cancel" ? "*/*" : "application/json" }) };
    },
    async read(response, context) {
      if (context.action === "cancel") {
        const id = validateRunwayTaskId(context.expectedId);
        if (response.redirected || response.status !== 204) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("invalid_runway_cancel_ack");
        }
        await response.body?.cancel().catch(() => undefined);
        // Deleted/aborted tasks cannot be retrieved again. Freeze conservative
        // settlement once; no pointless GET loop or claim of refund/stopped work.
        return { id, nativeStatus: null, terminal: null, body: {}, observationUnavailable: "canceled_or_deleted" };
      }
      if (!["create", "retrieve"].includes(context.action)) throw new Error("unsupported_runway_control");
      const { body } = await readMediaJson(response);
      if (body.error !== undefined || body.errors !== undefined) throw new Error("runway_api_error");
      const id = validateRunwayTaskId(body.id);
      if (context.action !== "create" && id !== validateRunwayTaskId(context.expectedId)) throw new Error("runway_identity_mismatch");
      if (context.action === "create" && body.status === undefined) return { id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
      if (typeof body.status !== "string" || !statuses.has(body.status)) throw new Error("invalid_runway_status");
      const terminal = body.status === "SUCCEEDED" ? "succeeded" : body.status === "FAILED" ? "failed" : body.status === "CANCELLED" ? "canceled" : null;
      return { id, nativeStatus: body.status, terminal, body,
        ...(context.action === "create" && terminal === null ? { followUp: "retrieve" as const } : {}) };
    },
    rewrite(observation) { return dropMediaControlUrls(observation.body); },
  };
}

function mediaUri(value: unknown, kind: "image" | "video"): void {
  if (typeof value !== "string" || value.length > 7_000_000) throw new Error("invalid_runway_media");
  const inline = /^(data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,)([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (inline) {
    const encoded = inline[3], padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (!inline[2].startsWith(kind + "/") || encoded.length % 4 || encoded.length / 4 * 3 - padding > 5_000_000) throw new Error("invalid_runway_inline_media");
    return;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_runway_media"); }
  // runway:// uploads need a separate scoped asset binding; never authorize a raw
  // provider resource ID merely because it is a syntactically valid URI.
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_runway_media");
}
