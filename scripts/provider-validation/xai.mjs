// Host-owned qualifications for schema-validated provider declarations.

export function validateXaiImages(manifest) {
  const formats = new Map([["xai.images_generations", "/v1/images/generations"], ["xai.images_edits", "/v1/images/edits"]]);
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("xai.images"))
    || manifest.id === "xai" && [...formats.values()].includes(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("xAI images require qualified native formats, original global Bearer auth, finite models and separate per-image accounting"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "xai" || endpoints.length > 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== "xai.images" || endpoint.path !== formats.get(endpoint.requestFormat)
      || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || endpoint.requestPricing && endpoint.requestPricing.unit !== "image") fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "image.generate" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("image.generate"));
  // These units belong to the endpoint tariff, never a fabricated token card.
  if (!models.length || models.some(model => !["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"].includes(model.upstream)
    || model.capabilities.length !== 1 || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length)) fail();
}

export function validateXaiSpeech(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("xai.tts"))
    || manifest.id === "xai" && (endpoint.path === "/v1/tts"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.speech")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("xai.tts requires model-less native unary speech, audio.binary output, canonical origin and original Bearer API-key auth without inferred tariffs"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "xai" || manifest.class !== "openai_compatible" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.x.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "xai.tts" || endpoint.responseFormat !== "audio.binary"
    || endpoint.auth || endpoint.requestHeaders?.length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
    || manifest.models?.entries?.some(model => model.capabilities?.includes("audio.speech"))) fail();
}
