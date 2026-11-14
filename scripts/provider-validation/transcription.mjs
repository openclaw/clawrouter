// Host-owned qualifications for schema-validated provider declarations.

export function validateNativeTranscription(manifest) {
  const contracts = {
    groq: { base: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", format: "groq.transcription" },
    mistral: { base: "https://api.mistral.ai", model: "voxtral-mini-latest", format: "mistral.transcription" },
    xai: { base: "https://api.x.ai", model: null, format: "xai.stt" },
  };
  const formats = Object.values(contracts).map(contract => contract.format);
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => formats.some(format => value.startsWith(format)))
    || Object.hasOwn(contracts, manifest.id) && (["/v1/audio/transcriptions", "/v1/stt"].includes(endpoint.path)
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.transcription")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("Groq/Mistral transcription or xAI STT requires its finite multipart format, original Bearer origin and unpriced model contract"); };
  const contract = Object.hasOwn(contracts, manifest.id) ? contracts[manifest.id] : null;
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (!contract || endpoints.length !== 1 || Object.values(manifest.baseUrls).some(base => base !== contract.base)
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== contract.format || endpoint.responseFormat !== contract.format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "accept" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (contract.model === null) { if (models.length) fail(); return; }
  if (models.length !== 1 || models.some(model => model.upstream !== contract.model || model.id !== `${manifest.id}/${contract.model}`
    || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
  const facts = models[0].nativeCapabilities?.endpoints?.[id];
  // Upload bytes and observed audio seconds do not establish token limits.
  if (facts && (facts.input?.some(input => input !== "audio") || facts.contextWindow !== undefined
    || facts.contextTokens !== undefined || facts.maxOutputTokens !== undefined || facts.inference
    || facts.hostedTools || facts.supportedServiceTiers)) fail();
}

export function validateOpenRouterTranscription(manifest) {
  const format = "openrouter.audio_transcription";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "openrouter" && (["/v1/audio/transcriptions", "/api/v1/audio/transcriptions"].includes(endpoint.path)
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "audio.transcription")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("OpenRouter transcription requires the finite native JSON format, canonical API base, original Bearer auth and unpriced transcription-only model"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "openrouter" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://openrouter.ai/api")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.entries(adapter?.injectHeaders ?? {}).some(([name, value]) =>
      !((name.toLowerCase() === "http-referer" && value === "${site_url}") || (name.toLowerCase() === "x-title" && value === "ClawRouter")))
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || endpoint.path !== "/v1/audio/transcriptions"
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (models.length !== 1 || models[0].upstream !== "openai/whisper-large-v3-turbo" || models[0].capabilities.length !== 1
    || models[0].availability?.status === "upstream_alias" || models[0].pricing || models[0].pricingRef
    || Object.keys(models[0].endpointPricing ?? {}).length || Object.keys(models[0].requestParameters ?? {}).length) fail();
  const facts = models[0].nativeCapabilities?.endpoints?.[id];
  // Byte limits and native seconds/cost observations are not token envelopes.
  if (facts && (facts.input?.some(input => input !== "audio") || facts.contextWindow !== undefined
    || facts.contextTokens !== undefined || facts.maxOutputTokens !== undefined || facts.inference
    || facts.hostedTools || facts.supportedServiceTiers)) fail();
}

export function validateDeepgramPrerecorded(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) => endpoint.requestFormat.startsWith("deepgram.") || endpoint.responseFormat.startsWith("deepgram."));
  if (manifest.id !== "deepgram" && !endpoints.length) return;
  const fail = () => { throw new Error("deepgram.prerecorded requires the qualified raw-audio provider, Token auth, nova-3 model and unpriced transcription contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "deepgram" || manifest.baseUrls.default !== "https://api.deepgram.com" || endpoints.length !== 1
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header.toLowerCase() !== "authorization"
    || scheme.format !== "Token ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "deepgram.prerecorded" || endpoint.responseFormat !== "deepgram.prerecorded") fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.transcription" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("audio.transcription"));
  if (models.length !== 1 || models[0].upstream !== "nova-3" || models[0].capabilities.length !== 1
    || models[0].pricing || models[0].pricingRef || Object.keys(models[0].endpointPricing ?? {}).length) fail();
}
