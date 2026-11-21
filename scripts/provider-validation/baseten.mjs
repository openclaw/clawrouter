import { hasOriginalBearerBinding } from "../provider-auth.mjs";

// Host-owned qualifications for schema-validated provider declarations.

export function validateBasetenSystemOne(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("baseten.systemone"))
    || manifest.id === "baseten" && /^\/(?:v1\/)?systemone(?:\/|$)/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("baseten.systemone requires its finite decision-only models, native metadata, original Bearer origin and unpriced request contract"); };
  if (manifest.id !== "baseten" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://inference.baseten.co/v1")
    || !hasOriginalBearerBinding(manifest)) fail();
  const [id, endpoint] = endpoints[0];
  if (endpoint.requestFormat !== "baseten.systemone" || endpoint.responseFormat !== "baseten.systemone"
    || endpoint.auth || endpoint.requestHeaders?.length || Object.entries(endpoint.headers ?? {}).some(([name, value]) => name.toLowerCase() !== "content-type" || value !== "application/json")) fail();
  const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
  if (capabilities.length !== 1 || capabilities[0].id !== "llm.decisions" || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const nativeIds = ["decision-models/baseten-elephant-9b-latest", "decision-models/baseten-mammoth-27b-latest", "decision-models/baseten-joey-2b-latest"];
  const models = (manifest.models?.entries ?? []).filter(model => nativeIds.includes(model.upstream) || model.capabilities?.includes("llm.decisions"));
  if (!models.length || models.some(model => {
    const facts = model.nativeCapabilities?.endpoints?.[id];
    return !nativeIds.includes(model.upstream) || model.capabilities?.length !== 1 || model.capabilities[0] !== "llm.decisions"
      || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length
      || model.codexModel || model.supportedReasoningEfforts?.length
      || !facts || facts.inference?.decision?.protocol !== "baseten-systemone" || facts.inference.chat === true
      || facts.input?.some(input => !["text", "json"].includes(input)) || facts.maxOutputTokens !== undefined
      || facts.contextTokens !== undefined || facts.contextWindow !== undefined;
  })) fail();
}
