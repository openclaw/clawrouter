// Exact existing discovery/codec pairs, not a naming convention for future
// formats. Provider-specific validators retain their stricter route/auth rules.
const catalogContracts = [
  ["openai.models", "openai.models", true],
  ["anthropic.models", "anthropic.models", true],
  ["ollama.models", "ollama.models", false],
  ["synthetic.models", "synthetic.models", false],
  ["baseten.models", "baseten.models", false],
  ["arcee.models", "arcee.models", false],
  ["novita.models", "novita.models", false],
  ["requesty.models_managed", "requesty.models_managed", false],
  ["chutes.models", "chutes.models", false],
  ["venice.models", "venice.models", false],
  ["featherless.models", "featherless.models", false],
  ["featherless.catalog", "featherless.catalog", false],
  ["cerebras.public_catalog", "cerebras.public_catalog", false],
  ["nvidia.public_catalog", "nvidia.public_catalog", false],
];

export function validateCatalogEndpoint(manifest, id, endpoint) {
  if (!catalogContracts.some(([request, response]) => endpoint.requestFormat === request || endpoint.responseFormat === response)) return;
  const contract = catalogContracts.find(([request, response]) => endpoint.requestFormat === request && endpoint.responseFormat === response);
  const fail = message => { throw new Error(`provider ${manifest.id} endpoint ${id} catalog protocol ${message}`); };
  if (!contract) fail("requires a registered request/response pair");
  if (endpoint.method !== "GET") fail("requires explicit GET");
  if (Object.hasOwn(endpoint, "streaming") || Object.hasOwn(endpoint, "websocket"))
    fail("requires an omitted streaming property and no WebSocket transport");
  const params = endpoint.pathParams ?? [];
  const retrieve = params.length === 1 && params[0] === "model_id" && contract[2];
  if (params.length && !retrieve || retrieve && endpoint.path.split("${model_id}").length !== 2)
    fail("allows only its qualified model_id retrieval variant");
  const expected = retrieve ? "models.retrieve" : "models.list";
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (!capabilities.length || capabilities.some(capability => capability.id !== expected)) fail(`requires canonical ${expected}`);
  if (capabilities.some(capability => (capability.methods?.length ? capability.methods : [endpoint.method]).some(method => method !== "GET")))
    fail("requires GET-only capability methods");
}

export function validatePublicCatalog(manifest) {
  const bases = { cerebras: "https://api.cerebras.ai/v1", nvidia: "https://integrate.api.nvidia.com/v1" };
  const formats = Object.keys(bases).map(provider => `${provider}.public_catalog`);
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => formats.some(format => value.startsWith(format)))
    || Object.hasOwn(bases, manifest.id) && id === "public_models");
  if (!endpoints.length) return;
  const fail = () => { throw new Error("public_catalog requires its manifest-only public_models GET selector, canonical inference origin and original private caller binding"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (!Object.hasOwn(bases, manifest.id) || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== bases[manifest.id])
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0], format = `${manifest.id}.public_catalog`;
  if (id !== "public_models" || endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || endpoint.nativeProxy !== false || endpoint.method !== "GET" || endpoint.path !== "/models") fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "models.list"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "GET"
    || manifest.models?.entries?.some(model => model.capabilities?.includes("models.list"))) fail();
}

export function validateNativeModels(manifest, providerId, baseUrl, contract = { format: `${providerId}.models`, path: "/models" }) {
  const { format, path } = contract;
  const catalogFormat = providerId === "featherless" ? "featherless.catalog" : null;
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format) || catalogFormat && value.startsWith(catalogFormat))
    || manifest.id === providerId && (endpoint.path === path || contract.id && id === contract.id || catalogFormat && id === "catalog"
      || manifest.capabilities.some(capability => capability.endpoint === id && capability.id === "models.list")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error(`${format}${catalogFormat ? ` or ${catalogFormat}` : ""} requires its qualified GET ${path} route, canonical inference origin and original Bearer API-key binding`); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== providerId || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== baseUrl)
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  const projection = catalogFormat !== null && id === "catalog", expectedFormat = projection ? catalogFormat : format;
  if (projection && (endpoint.nativeProxy !== false || manifest.models?.entries?.some(model => model.capabilities?.includes("models.list")))) fail();
  if (contract.id && (id !== contract.id || manifest.models?.entries?.some(model => model.capabilities?.includes("models.list")))) fail();
  if (endpoint.requestFormat !== expectedFormat || endpoint.responseFormat !== expectedFormat
    || endpoint.method !== "GET" || endpoint.path !== path || endpoint.upstreamPath !== undefined
    || endpoint.auth !== undefined || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "accept" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "models.list"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "GET") fail();
}

export function validateSyntheticModels(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("synthetic.")));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("synthetic.models upstreamPath requires the qualified Synthetic GET metadata route and original Bearer API-key binding"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "synthetic" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://api.synthetic.new")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "bearer" || scheme.header?.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || Object.keys(adapter?.injectHeaders ?? {}).length
    || Object.keys(adapter?.injectQuery ?? {}).length || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "synthetic.models" || endpoint.responseFormat !== "synthetic.models"
    || endpoint.method !== "GET" || endpoint.path !== "/models" || endpoint.upstreamPath !== "/openai/v1/models"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.keys(endpoint.query ?? {}).length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["accept", "content-type"].includes(name.toLowerCase()) || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "models.list"
    || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "GET") fail();
}
