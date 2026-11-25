// Host-owned qualifications for schema-validated provider declarations.

export function validateInputProfiles(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) => endpoint.inputProfile !== undefined);
  if (!endpoints.length) return;
  const fail = () => { throw new Error("inputProfile requires the exact PixVerse image-create contract and explicit registered video.generate models"); };
  if (manifest.id !== "pixverse" || endpoints.length !== 1) fail();
  const [id, endpoint] = endpoints[0], capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1" || capabilities.length !== 1
    || capabilities[0].id !== "video.generate" || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST") fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("video.generate"));
  if (!models.length || models.some(model => !["v6", "c1"].includes(model.upstream) || model.id !== `pixverse/${model.upstream}`
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}
