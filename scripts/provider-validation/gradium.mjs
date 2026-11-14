// Host-owned qualifications for schema-validated provider declarations.

export function validateGradiumSpeech(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("gradium."))
    || manifest.id === "gradium" && endpoint.path === "/api/post/speech/tts");
  if (!endpoints.length) return;
  const fail = () => { throw new Error("gradium.speech requires model-less native unary speech, canonical origin and original x-api-key auth without inferred tariffs"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "gradium" || manifest.class !== "rest_json" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.gradium.ai")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "api_key" || scheme.header?.toLowerCase() !== "x-api-key" || scheme.secretKind !== "api_key"
    || Object.keys(manifest.auth.grantTransports ?? {}).length || (manifest.models?.entries ?? []).length
    || manifest.routing?.modelPrefixes?.length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || (adapter?.request ?? "rest_json") !== "rest_json" || (adapter?.response ?? "rest_json") !== "rest_json" || adapter?.stream
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "gradium.speech" || endpoint.responseFormat !== "audio.binary"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "audio.speech" || capabilities[0].methods?.some(method => method !== "POST")) fail();
}
