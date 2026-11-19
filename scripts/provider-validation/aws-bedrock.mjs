// Host-owned qualifications for schema-validated provider declarations.

export function validateBedrockConverse(manifest) {
  const endpoints = Object.entries(manifest.endpoints).filter(([, endpoint]) =>
    [endpoint.requestFormat, endpoint.responseFormat].some(format => format.startsWith("aws_bedrock.converse"))
    || manifest.id === "aws-bedrock" && /\/converse(?:[-/]|$)/.test(endpoint.path));
  if (!endpoints.length) return;
  const fail = () => { throw new Error("aws_bedrock.converse requires an explicitly selected Chat model, original regional SigV4 route and qualified unary or buffered EventStream contract"); };
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "aws-bedrock" || manifest.class !== "custom_adapter" || endpoints.length > 2
    || new Set(endpoints.map(([, endpoint]) => endpoint.requestFormat)).size !== endpoints.length
    || Object.values(manifest.baseUrls).some(base => base !== "https://bedrock-runtime.${region}.amazonaws.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "sig_v4" || scheme.service !== "bedrock" || scheme.regionParam !== "region" || scheme.required === false
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || adapter?.request !== "aws_bedrock" || adapter?.response !== "aws_bedrock"
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  for (const [id, endpoint] of endpoints) {
    const capabilities = manifest.capabilities.filter(capability => capability.endpoint === id);
    const stream = endpoint.requestFormat === "aws_bedrock.converse_stream";
    if (capabilities.length !== 1 || capabilities[0].id !== "llm.chat" || capabilities[0].methods?.length !== 1 || capabilities[0].methods[0] !== "POST"
      || !["aws_bedrock.converse", "aws_bedrock.converse_stream"].includes(endpoint.requestFormat)
      || endpoint.responseFormat !== (stream ? "aws_bedrock.converse_eventstream" : "aws_bedrock.converse")
      || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase())
        || value !== (stream && name.toLowerCase() === "accept" ? "application/vnd.amazon.eventstream" : "application/json"))) fail();
  }
  const models = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.chat"));
  if (!models.length || models.some(model => !model.upstream || model.upstream.length > 2048 || /[\x00-\x1f\x7f]/.test(model.upstream)
    || model.upstream.includes("${") || model.availability?.status === "upstream_alias" || model.pricing
    || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
}

export function validateBedrockEmbeddings(manifest) {
  const capabilities = manifest.capabilities.filter(capability => capability.id === "llm.embeddings");
  if (!capabilities.length || manifest.id !== "aws-bedrock" && !capabilities.some(capability =>
    manifest.endpoints[capability.endpoint]?.requestFormat === "aws_bedrock.invoke")) return;
  const fail = () => { throw new Error("Bedrock embeddings require the finite registered native models, original regional SigV4 route and unpriced embedding-only cards"); };
  const models = [
    "amazon.titan-embed-text-v2:0", "amazon.titan-embed-text-v1", "amazon.titan-embed-g1-text-02", "amazon.titan-embed-image-v1",
    "cohere.embed-english-v3", "cohere.embed-multilingual-v3", "cohere.embed-v4:0", "amazon.nova-2-multimodal-embeddings-v1:0",
    "us.twelvelabs.marengo-embed-2-7-v1:0", "twelvelabs.marengo-embed-3-0-v1:0",
  ];
  const scheme = manifest.auth.schemes[0], adapter = manifest.adapter;
  if (manifest.id !== "aws-bedrock" || capabilities.length !== 1
    || Object.values(manifest.baseUrls).some(base => base !== "https://bedrock-runtime.${region}.amazonaws.com")
    || manifest.auth.schemes.length !== 1 || scheme.type !== "sig_v4" || scheme.service !== "bedrock" || scheme.regionParam !== "region"
    || Object.keys(manifest.auth.grantTransports ?? {}).length || manifest.routing?.baseUrlParam || manifest.routing?.serviceParam
    || adapter?.request !== "aws_bedrock" || adapter?.response !== "aws_bedrock"
    || Object.keys(adapter?.injectHeaders ?? {}).length || Object.keys(adapter?.injectQuery ?? {}).length
    || adapter?.passthroughHeaders?.length || adapter?.requestTransforms?.renameFields?.length) fail();
  const capability = capabilities[0], endpoint = manifest.endpoints[capability.endpoint];
  if (!endpoint || capability.methods?.length !== 1 || capability.methods[0] !== "POST"
    || manifest.capabilities.filter(value => value.endpoint === capability.endpoint).length !== 1
    || endpoint.method !== "POST" || endpoint.path !== "/model/${model}/invoke" || endpoint.nativeProxy === false
    || endpoint.requestFormat !== "aws_bedrock.invoke" || endpoint.responseFormat !== "aws_bedrock.invoke"
    || endpoint.pathParams?.length !== 1 || endpoint.pathParams[0] !== "model"
    || Object.keys(endpoint.pathParamStyles ?? {}).length !== 1 || endpoint.pathParamStyles.model !== "opaque_segment"
    || Object.keys(endpoint.query ?? {}).length || endpoint.requestHeaders?.length
    || Object.entries(endpoint.headers ?? {}).some(([name, value]) => !["content-type", "accept"].includes(name.toLowerCase()) || value !== "application/json")
    || ["auth", "upstreamPath", "streaming", "websocket", "lifecycle", "responsesLifecycle", "modelPassthrough", "outputTokenLimit", "requestPricing", "toolPricing"].some(key => endpoint[key] !== undefined)) fail();
  const entries = (manifest.models?.entries ?? []).filter(model => model.capabilities?.includes("llm.embeddings"));
  if (!entries.length || entries.some(model => !models.includes(model.upstream) || model.id !== `bedrock/${model.upstream}`
    || model.capabilities.length !== 1 || model.availability?.status === "upstream_alias"
    || model.pricing || model.pricingRef || Object.keys(model.endpointPricing ?? {}).length || Object.keys(model.requestParameters ?? {}).length)) fail();
  for (const model of entries) {
    const facts = model.nativeCapabilities?.endpoints?.[capability.endpoint];
    // This frozen slice qualifies text input, not media delivery, token bounds or dimensions as tokens.
    if (facts && (facts.input?.some(input => input !== "text") || facts.contextWindow !== undefined || facts.contextTokens !== undefined
      || facts.maxOutputTokens !== undefined || facts.inference || facts.hostedTools || facts.supportedServiceTiers)) fail();
  }
}
