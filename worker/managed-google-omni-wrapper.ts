import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { googleOmniVideoManagedAdapter } from "./managed-google-omni.ts";
import { managedFileAdapter } from "./managed-file-adapters.ts";
import { exactMediaParams, mediaPublicPath } from "./managed-media-json.ts";

function flags(params: Record<string, string>): { stored: boolean; background: boolean } {
  exactMediaParams(params, ["background", "store"]);
  if (!["true", "false"].includes(params.background) || !["true", "false"].includes(params.store)
    || params.background === "true" && params.store !== "true") throw new Error("invalid_managed_omni_flags");
  return { stored: params.store === "true", background: params.background === "true" };
}

// Concrete source wrapper. Exporting it does not enable a bundled Google route.
export const googleOmniManagedAdapter: ManagedLifecycleAdapter = {
  ...googleOmniVideoManagedAdapter,
  files: managedFileAdapter("google.omni_video"),
  retainedParams: ["background", "store"],
  allowedControls(params) {
    const value = flags(params);
    return !value.stored ? [] : value.background ? ["retrieve", "cancel"] : ["retrieve"];
  },
  control(action, endpoint, id, pathParams) {
    const expected = "/v1beta/interactions/${interaction_id}" + (action === "cancel" ? "/cancel" : "");
    if (endpoint.path !== expected) throw new Error("invalid_managed_omni_endpoint");
    const target = googleOmniVideoManagedAdapter.control(action, { ...endpoint, path: endpoint.path.slice(7) }, id, pathParams);
    return { ...target, path: "/v1beta" + target.path };
  },
  rewrite(observation, paths) {
    // Stored/background flags determine which public controls actually exist.
    if (paths.retrieve !== undefined) mediaPublicPath(paths.retrieve);
    if (paths.cancel !== undefined) mediaPublicPath(paths.cancel);
    if (paths.result !== undefined) throw new Error("unsupported_managed_omni_result");
    return googleOmniVideoManagedAdapter.rewrite(observation, paths);
  },
};

