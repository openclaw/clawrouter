// Host-owned qualifications for schema-validated Google provider declarations.
// Package declarations cannot load code or register new qualification rules.

export function validateGoogleUnaryMedia(manifest, kind, capabilityId, upstreams) {
  const format = `google.${kind}`;
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === capabilityId));
  if (!endpoints.length) return;
  const fail = () => { throw new Error(`Google ${kind === "image" ? "images" : "music"} require the finite native unary format, canonical API-key origin and unpriced single-capability models`); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== `${format}_generate` || endpoint.responseFormat !== format
    || endpoint.path !== "/v1beta/models/${model}:generateContent" || endpoint.method !== "POST"
    || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== capabilityId
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capabilityId));
  // Media counters and bounded bytes cannot qualify a text-token price card.
  if (!models.length || models.some(model => !upstreams.includes(model.upstream)
    || model.id !== `google/${model.upstream}` || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

export function validateGoogleSpeech(manifest) {
  const formats = ["google.speech_generate_content", "google.speech_interactions"];
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith("google.speech"))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.speech"));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google speech requires its paired unary transports, canonical API-key origin and unpriced frozen models"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== 2
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    const interactions = endpoint.requestFormat === "google.speech_interactions";
    if (!formats.includes(endpoint.requestFormat) || endpoint.responseFormat !== endpoint.requestFormat || endpoint.method !== "POST"
      || endpoint.path !== (interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent")
      || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => interactions || name !== "model" || style !== "segment")) fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech"
      || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  }
  const upstreams = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.speech"));
  // The shared nativeModelEligible contract owns transport eligibility and expiry;
  // declaration compilation preserves identities without freezing a clock verdict.
  if (!models.length || models.some(model => !upstreams.includes(model.upstream)
    || model.id !== `google/${model.upstream}` || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

export function validateGoogleGroundedSearch(manifest) {
  const format = "google.grounded_search";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "search.web"));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google grounded search requires its frozen model, explicit manifest route, canonical API-key origin and unpriced endpoint"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "search.web"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("search.web"));
  // A shared Chat identity may retain its token card; grounding has an explicit
  // unknown endpoint price until the whole inference + tool bound is qualified.
  if (models.length !== 1 || models.some(model => model.upstream !== "gemini-3.6-flash" || model.id !== `google/${model.upstream}`
    || model.availability?.status === "upstream_alias" || model.endpointPricing?.[id]?.pricing !== null
    || model.requestParameters?.[id] !== undefined)) fail();
}

export function validateGoogleUnderstanding(manifest) {
  const formats = new Map([["google.audio_understanding", "audio.transcription"], ["google.video_understanding", "video.understanding"]]);
  const reserved = value => [...formats.keys()].some(format => value.startsWith(format));
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(reserved)
    || manifest.id === "google-gemini" && manifest.capabilities.some(capability => capability.endpoint === id && [...formats.values()].includes(capability.id)));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google inline understanding requires finite manifest-only formats, the frozen model, canonical API-key origin and unknown endpoint prices"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length > 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== "google.generate_content"
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
    const capabilityId = formats.get(endpoint.requestFormat), capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== capabilityId
      || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
    const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capabilityId));
    // Input-media limits and native usage are not a whole-request price bound.
    // Keep the shared model's ordinary text card separate from each native route.
    if (models.length !== 1 || models.some(model => model.upstream !== "gemini-3-flash-preview" || model.id !== `google/${model.upstream}`
      || model.availability?.status === "upstream_alias" || model.endpointPricing?.[id]?.pricing !== null
      || model.requestParameters?.[id] !== undefined)) fail();
  }
}

export function validateGoogleEmbeddings(manifest) {
  const formats = new Map([
    ["google.embed_content", "/v1beta/models/${model}:embedContent"],
    ["google.batch_embed_contents", "/v1beta/models/${model}:batchEmbedContents"],
  ]);
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("google.embed") || format.startsWith("google.batch_embed"))
    || /:(?:embedContent|batchEmbedContents)$/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Google embeddings require paired native formats, original API-key auth, finite qualified models and unpriced accounting"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "google-gemini" || endpoints.length !== 2 || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== 2
    || Object.values(manifest.baseUrls).some(base => base !== "https://generativelanguage.googleapis.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-goog-api-key"
    || scheme.secretKind !== "api_key" || scheme.required === false || scheme.format !== undefined
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    if (!formats.has(endpoint.requestFormat) || endpoint.responseFormat !== endpoint.requestFormat || endpoint.path !== formats.get(endpoint.requestFormat)
      || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
      || Object.entries(endpoint.pathParamStyles ?? {}).some(([name, style]) => name !== "model" || style !== "segment")) fail();
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    if (capabilities.length !== 1 || capabilities[0].id !== "llm.embeddings" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.embeddings"));
  // The preview remains codec compatibility only; current live availability is
  // not established by that fixture. No native tariff/bound is qualified yet.
  if (!models.length || models.some(model => !["gemini-embedding-001", "gemini-embedding-2"].includes(model.upstream)
    || model.capabilities.length !== 1 || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length)) fail();
}
