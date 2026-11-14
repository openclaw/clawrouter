// Qualified managed lifecycle declarations; called after manifest schema validation.
// Runtime job ownership, polling, cancellation, and settlement stay separate.

const managedLifecycleContracts = {
  "openrouter.video": {
    provider: "openrouter", create: ["/v1/videos"], request: "openrouter.video_create", response: "openrouter.video",
    controls: { retrieve: ["GET", "/v1/videos/${video_id}", "openrouter.video_get", "openrouter.video"] },
    files: { download: ["GET", "/v1/videos/${video_id}/content", "openrouter.video_content", "openrouter.video_content", { index: "0" }] },
  },
  "xai.video": {
    provider: "xai", create: ["/v1/videos/generations", "/v1/videos/edits", "/v1/videos/extensions"], response: "xai.video",
    requestByPath: { "/v1/videos/generations": "xai.video_generate", "/v1/videos/edits": "xai.video_edit", "/v1/videos/extensions": "xai.video_extend" },
    controls: { retrieve: ["GET", "/v1/videos/${request_id}", "xai.video_get", "xai.video"] },
  },
  "together.video": {
    provider: "together", create: ["/v2/videos"], request: "together.video_create", response: "together.video",
    controls: { retrieve: ["GET", "/v2/videos/${video_id}", "together.video_get", "together.video"] },
  },
  "runway.tasks": {
    provider: "runway", create: ["/v1/text_to_video", "/v1/image_to_video", "/v1/video_to_video"], response: "runway.task",
    requestByPath: { "/v1/text_to_video": "runway.text_video", "/v1/image_to_video": "runway.image_video", "/v1/video_to_video": "runway.video_video" },
    controls: {
      retrieve: ["GET", "/v1/tasks/${id}", "runway.task_get", "runway.task"],
      cancel: ["DELETE", "/v1/tasks/${id}", "runway.task_cancel", "runway.task_cancel"],
    },
  },
  "pixverse.video": {
    provider: "pixverse", create: ["/openapi/v2/video/text/generate"], request: "pixverse.text_video", response: "pixverse.video",
    controls: { retrieve: ["GET", "/openapi/v2/video/result/${video_id}", "pixverse.video_get", "pixverse.video"] },
  },
  "google.omni_video": {
    provider: "google-gemini", create: ["/v1beta/interactions"], request: "google.omni_video_create", response: "google.omni_video",
    controls: {
      retrieve: ["GET", "/v1beta/interactions/${interaction_id}", "google.omni_video_get", "google.omni_video"],
      cancel: ["POST", "/v1beta/interactions/${interaction_id}/cancel", "google.omni_video_cancel", "google.omni_video"],
    },
    files: {
      metadata: ["GET", "/v1beta/files/${file_id}", "google.omni_video_file_metadata", "google.omni_video_file"],
      download: ["GET", "/v1beta/files/${file_id}:download", "google.omni_video_file_download", "google.omni_video_bytes", { alt: "media" }],
    },
  },
  "dashscope.video": {
    provider: "alibaba", create: ["/api/v1/services/aigc/video-generation/video-synthesis"], request: "dashscope.video_create", response: "dashscope.video",
    controls: { retrieve: ["GET", "/api/v1/tasks/${task_id}", "dashscope.video_get", "dashscope.video"] },
  },
  "replicate.predictions": {
    provider: "replicate", create: ["/v1/predictions"], request: "replicate.prediction_create", response: "replicate.prediction",
    controls: {
      retrieve: ["GET", "/v1/predictions/${prediction_id}", "replicate.prediction_get", "replicate.prediction"],
      cancel: ["POST", "/v1/predictions/${prediction_id}/cancel", "replicate.prediction_cancel", "replicate.prediction"],
    },
  },
  "fal.queue": {
    provider: "fal", create: ["/${owner}/${app}", "/${owner}/${app}/${variant}", "/${owner}/${app}/${variant}/${subvariant}"], request: "fal.queue_submit", response: "fal.queue_submission",
    controls: {
      retrieve: ["GET", "/${owner}/${app}/requests/${request_id}/status", "fal.queue_status", "fal.queue_status"],
      result: ["GET", "/${owner}/${app}/requests/${request_id}", "fal.queue_result", "fal.queue_result"],
      cancel: ["PUT", "/${owner}/${app}/requests/${request_id}/cancel", "fal.queue_cancel", "fal.queue_cancel"],
    },
  },
  "kie.jobs": {
    provider: "kie", create: ["/api/v1/jobs/createTask"], request: "kie.job_create", response: "kie.job",
    controls: { retrieve: ["GET", "/api/v1/jobs/recordInfo", "kie.job_get", "kie.job"] },
  },
  "vydra.jobs": {
    provider: "vydra", create: ["/api/v1/jobs"], request: "vydra.job_create", response: "vydra.job",
    controls: {
      retrieve: ["GET", "/api/v1/jobs/${job_id}", "vydra.job_get", "vydra.job"],
      cancel: ["DELETE", "/api/v1/jobs/${job_id}", "vydra.job_cancel", "vydra.job_cancel"],
    },
  },
};

export function validateManagedLifecycles(manifest) {
  const controls = new Set(), creates = new Set(), controlBindings = new Map();
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    if (!endpoint.lifecycle) continue;
    const fail = () => { throw new Error(`provider ${manifest.id} endpoint ${id} lifecycle requires distinct qualified native create/control endpoints`); };
    const protocol = endpoint.lifecycle.protocol;
    const fourSegmentFal = protocol === "fal.queue" && endpoint.path === "/${owner}/${app}/${variant}/${subvariant}";
    const contract = Object.hasOwn(managedLifecycleContracts, protocol) ? managedLifecycleContracts[protocol] : null;
    const incompatible = value => value.responsesLifecycle || value.modelPassthrough || value.streaming || value.websocket || value.nativeProxy === false;
    const methodsMatch = (endpointId, method) => !manifest.capabilities.some(capability => capability.endpoint === endpointId && capability.methods?.some(value => value !== method));
    const parametersMatch = value => {
      const names = [...value.path.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]).sort();
      return JSON.stringify([...(value.pathParams ?? [])].sort()) === JSON.stringify(names)
        && !Object.entries(value.pathParamStyles ?? {}).some(([name, style]) => !names.includes(name) || style !== "segment");
    };
    if (!contract || manifest.id !== contract.provider || incompatible(endpoint) || Object.keys(endpoint.query ?? {}).length || !parametersMatch(endpoint)
      || (endpoint.method ?? "POST") !== "POST" || !methodsMatch(id, "POST") || !contract.create.includes(endpoint.path)
      || endpoint.requestFormat !== (contract.requestByPath?.[endpoint.path] ?? contract.request) || endpoint.responseFormat !== contract.response
      || !manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "media.predict")) fail();
    if (fourSegmentFal) {
      // Concrete product/segment values are checked by the registered fal codec.
      // The new shape cannot change origin, credentials or control ownership.
      const scheme = manifest.auth.schemes[0];
      if (Object.values(manifest.baseUrls).some(base => base !== "https://queue.fal.run")
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Key ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
    }
    if (protocol === "openrouter.video") {
      // This product has authenticated content, not a file metadata endpoint.
      // Only the original succeeded job and descriptor can authorize download.
      const scheme = manifest.auth.schemes[0];
      const attribution = { "HTTP-Referer": "${site_url}", "X-Title": "ClawRouter" };
      if (Object.values(manifest.baseUrls).some(base => base !== "https://openrouter.ai/api")
        || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length
        || Object.entries(manifest.adapter?.injectHeaders ?? {}).some(([name, value]) => !Object.hasOwn(attribution, name) || attribution[name] !== value)
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || endpoint.requestPricing || endpoint.toolPricing || endpoint.outputTokenLimit
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
      if ((manifest.models?.entries ?? []).some(model => model.capabilities?.includes("media.predict")
        && (model.upstream !== "google/veo-3.1-fast" || model.capabilities.length !== 1
          || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length))) fail();
    }
    if (protocol === "xai.video") {
      const scheme = manifest.auth.schemes[0];
      if (Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
        || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
        || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length || endpoint.auth || endpoint.requestHeaders?.length
        || endpoint.requestPricing || endpoint.toolPricing || endpoint.outputTokenLimit
        || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
      // Native duration and advisory idempotency are not a qualified tariff or
      // retry guarantee. These cards cannot borrow the provider's Chat prices.
      if ((manifest.models?.entries ?? []).some(model => model.capabilities?.includes("media.predict")
        && (!["grok-imagine-video", "grok-imagine-video-1.5"].includes(model.upstream) || model.capabilities.length !== 1
          || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length))) fail();
    }
    if (protocol === "dashscope.video") {
      // The bound credential comes from the shared owner, never endpoint overrides.
      if (endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) =>
        !(["x-dashscope-async", "content-type"].includes(name.toLowerCase()) && value === (name.toLowerCase() === "x-dashscope-async" ? "enable" : "application/json")))) fail();
    }
    if (protocol === "together.video") {
      // Pin the selected Together origin and credential; no alias fallback or
      // cross-product Wan/MiniMax authorization on the native video route.
      if (Object.values(manifest.baseUrls).some(base => !["https://api.together.xyz", "https://api.together.ai"].includes(base))
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")
        || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(manifest.adapter?.injectHeaders ?? {}).length
        || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.passthroughHeaders?.length
        || manifest.adapter?.requestTransforms?.renameFields?.length) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "bearer" || schemes[0].header?.toLowerCase() !== "authorization"
        || schemes[0].format !== "Bearer ${secret}" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "runway.tasks") {
      if (Object.values(manifest.baseUrls).some(base => base !== "https://api.dev.runwayml.com")
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) =>
          !(["content-type", "x-runway-version"].includes(name.toLowerCase()) && value === (name.toLowerCase() === "content-type" ? "application/json" : "2024-11-06")))) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "bearer" || schemes[0].header?.toLowerCase() !== "authorization"
        || schemes[0].format !== "Bearer ${secret}" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "pixverse.video") {
      // Image routes remain closed until uploads have durable original-job scope.
      if (Object.values(manifest.baseUrls).some(base => !["https://app-api.pixverse.ai", "https://app-api.pixverseai.cn"].includes(base))
        || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
      const schemes = manifest.auth.schemes;
      if (schemes.length !== 1 || schemes[0].type !== "api_key" || schemes[0].header?.toLowerCase() !== "api-key" || schemes[0].secretKind !== "api_key" || schemes[0].required === false) fail();
    }
    if (protocol === "google.omni_video") {
      // Keep Google's existing origin-only base; the registered wrapper must
      // translate the codec's /v1beta-relative paths without changing that base.
      for (const base of Object.values(manifest.baseUrls)) {
        let url; try { url = new URL(base); } catch { fail(); }
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") fail();
      }
      if (endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
    }
    creates.add(id);
    for (const [action, [method, path, request, response, query = {}]] of Object.entries({ ...contract.controls, ...contract.files })) {
      const controlId = Object.hasOwn(contract.controls, action) ? endpoint.lifecycle[action] : endpoint.lifecycle.files[action];
      const control = Object.hasOwn(manifest.endpoints, controlId) ? manifest.endpoints[controlId] : null;
      const sharedControl = ["fal.queue", "xai.video"].includes(protocol) && controlBindings.get(controlId) === `${protocol}:${action}`;
      if (!control || controlId === id || controls.has(controlId) && !sharedControl || control.lifecycle || incompatible(control) || !parametersMatch(control)
        || Object.keys(control.query ?? {}).length !== Object.keys(query).length || Object.entries(query).some(([name, value]) => control.query?.[name] !== value)
        || (control.method ?? "POST") !== method || !methodsMatch(controlId, method) || control.path !== path
        || control.requestFormat !== request || control.responseFormat !== response
        || manifest.capabilities.some(capability => capability.endpoint === controlId && (protocol !== "replicate.predictions" || action !== "retrieve" || capability.id !== "media.prediction.read"))) fail();
      if ((fourSegmentFal || ["openrouter.video", "xai.video", "dashscope.video", "google.omni_video", "pixverse.video", "runway.tasks", "together.video"].includes(protocol)) && (control.auth || control.requestHeaders?.length || Object.keys(control.headers ?? {}).length)) fail();
      if (["openrouter.video", "xai.video"].includes(protocol) && (control.requestPricing || control.toolPricing || control.outputTokenLimit)) fail();
      controls.add(controlId);
      controlBindings.set(controlId, `${protocol}:${action}`);
    }
  }
  // New managed wire formats cannot accidentally expose an unbound raw control.
  // Legacy Replicate manifests retain their existing runtime ownership guard.
  const formats = new Set(Object.entries(managedLifecycleContracts).filter(([protocol]) => protocol !== "replicate.predictions")
    .flatMap(([, contract]) => [contract.request, ...Object.values(contract.requestByPath ?? {}), ...Object.values({ ...contract.controls, ...contract.files }).map(control => control[2])].filter(Boolean)));
  for (const [id, endpoint] of Object.entries(manifest.endpoints)) {
    const reservedFormat = ["openrouter.video", "xai.video", "dashscope.video", "google.omni_video", "pixverse.", "runway.", "together.video"].some(prefix => endpoint.requestFormat.startsWith(prefix) || endpoint.responseFormat.startsWith(prefix))
      || ["openrouter", "xai"].includes(manifest.id) && /^\/v1\/videos(?:\/|$)/.test(endpoint.path);
    if ((formats.has(endpoint.requestFormat) || reservedFormat) && !creates.has(id) && !controls.has(id))
      throw new Error(`provider ${manifest.id} endpoint ${id} lifecycle binding is required for a managed wire format`);
  }
}
