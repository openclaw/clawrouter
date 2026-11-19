// Host-owned qualifications for schema-validated provider declarations.

export function validateDeepSeekSearch(manifest) {
  const format = "deepseek.search";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "deepseek" && (endpoint.path === "/v1/tools/search"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "search.web")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("deepseek.search requires model-less native search, canonical origin, original Bearer auth and a qualified optional native-result tariff"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "deepseek" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.deepseek.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "search.web"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
    || manifest.models?.entries?.some(model => model.capabilities?.includes("search.web"))) fail();
}
