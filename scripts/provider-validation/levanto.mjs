// Host-owned qualifications for schema-validated provider declarations.

export function validateSageBatch(manifest) {
  const format = "levanto.sage_batch", capability = "llm.decisions.batch";
  const endpoints = Object.entries(manifest.endpoints).filter(([id, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(value => value.startsWith(format))
    || manifest.id === "levanto" && manifest.capabilities.some(item => item.endpoint === id && item.id === capability));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("levanto.sage_batch requires the finite Sage model, text/list decision metadata and exact batch endpoint"); };
  if (manifest.id !== "levanto" || endpoints.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://sage.levanto.ai")
    || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || Object.keys(manifest.adapter?.injectQuery ?? {}).length || manifest.adapter?.requestTransforms?.renameFields?.length) fail();
  const [id, endpoint] = endpoints[0];
  const capabilities = manifest.capabilities.filter(item => item.endpoint === id);
  if (id !== "decisions_batch" || endpoint.path !== "/decide/batch"
    || endpoint.requestFormat !== format || endpoint.responseFormat !== format
    || capabilities.length !== 1 || capabilities[0].id !== capability
    || capabilities[0].methods?.some(method => method !== "POST")) fail();
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes(capability));
  if (models.length !== 1) fail();
  const model = models[0], facts = model.nativeCapabilities?.endpoints?.[id];
  if (model.id !== "levanto/levanto-sage-2" || model.upstream !== "levanto-sage-2" || model.availability?.status === "upstream_alias"
    || model.capabilities.some(value => !["llm.decisions", capability].includes(value))) fail();
  // Existing singular-runtime fixtures carry the closed batch endpoint without
  // support facts. Preserve omission; it must not manufacture batch support.
  if (facts && (facts.inference?.decision?.protocol !== "levanto-sage" || facts.inference.chat === true
    || facts.input?.length !== 2 || !facts.input.includes("text") || !facts.input.includes("json")
    || facts.inference.decision.limits?.image || facts.inference.decision.questions.choice?.maxImageOptions !== undefined)) fail();
}
