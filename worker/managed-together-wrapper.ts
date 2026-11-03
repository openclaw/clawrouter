import type { ManagedLifecycleAdapter } from "./managed-lifecycle-types.ts";
import { managedMediaEnvelopeBytes, mediaPublicPath } from "./managed-media-json.ts";
import { togetherVideoManagedAdapter } from "./managed-together.ts";
import { readNativeJson } from "./native-json.ts";

function invalid(reason: string): never { throw new Error(`invalid_together_managed_${reason}`); }

// The shared controller owns original-job credentials, policy and settlement.
// This wrapper qualifies the frozen codec for dispatch through that controller.
export const togetherManagedAdapter: ManagedLifecycleAdapter = {
  ...togetherVideoManagedAdapter,
  assertDispatch(request) {
    const url = new URL(request.url);
    if (!["https://api.together.xyz", "https://api.together.ai"].includes(url.origin)
      || url.username || url.password || url.search || url.hash
      || !/^Bearer [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? "")) invalid("dispatch");
    if (request.method === "POST" && url.pathname === "/v2/videos") {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") invalid("content_type");
      return;
    }
    if (request.method !== "GET" || !/^\/v2\/videos\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) invalid("route");
  },
  prepare(body, headers, pathParams, query) {
    const prepared = togetherVideoManagedAdapter.prepare(body, headers, pathParams, query);
    return { ...prepared, body: structuredClone(prepared.body) };
  },
  async read(response, context) {
    // The controller owns request cancellation. Validate the complete native
    // transport before giving the codec a bounded, internal JSON response.
    const body = await readNativeJson(response, new AbortController().signal,
      managedMediaEnvelopeBytes, value => value, invalid);
    return togetherVideoManagedAdapter.read(Response.json(body), context);
  },
  rewrite(observation, paths) {
    mediaPublicPath(paths.retrieve);
    if (paths.cancel !== undefined || paths.result !== undefined) invalid("public_controls");
    return togetherVideoManagedAdapter.rewrite(observation, paths);
  },
};
