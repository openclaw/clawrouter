export const vertexModel = "claude-opus-4-5@20251101";
export const vertexModelId = "anthropic-vertex/" + vertexModel;
export const vertexAuthorization = (location = "us-east5", project = "fixture-project") => ({ version: "clawrouter.vertex-anthropic.v1", source: "access_token", project, location });
export const vertexBody = (stream = false) => ({ model: vertexModel, messages: [{ role: "user", content: "synthetic request" }], max_tokens: 16, stream });
export function configureVertex(provider) {
  const model = provider.models[0], endpoint = provider.endpoints.find(e => e.request_format === "anthropic.messages");
  provider.id = "anthropic-vertex"; provider.base_urls = { default: "https://aiplatform.googleapis.com" };
  provider.config_keys = []; provider.optional_config_keys = [];
  provider.auth = { schemes: [{ type: "bearer", header: "authorization", format: "Bearer ${secret}", secretKind: "api_token" }], authorization: null, refresh: null, grantTransports: {} };
  provider.adapter = { ...provider.adapter, injectHeaders: {}, injectQuery: {}, forwardHeaders: [], stripHeaders: [] };
  provider.routing = { ...provider.routing, modelPrefixes: ["anthropic-vertex/"], aliases: [] };
  provider.endpoints = [{ ...endpoint, id: "messages", method: "POST", path: "/v1/messages", path_params: [], query: {}, headers: {},
    request_format: "anthropic.messages", response_format: "anthropic.messages", streaming: "sse", native_proxy: true,
    upstreamPath: undefined, modelPassthrough: undefined, auth: undefined }];
  provider.capabilities = [{ id: "llm.chat", endpoint: "messages", methods: ["POST"] }];
  provider.models = [{ ...model, id: vertexModelId, upstream: vertexModel, capabilities: ["llm.chat"], pricing: null,
    endpointPricing: undefined, availability: undefined }];
}
export const vertexJson = () => ({ id: "synthetic-message", type: "message", role: "assistant", model: vertexModel,
  content: [{ type: "text", text: "synthetic reply" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } });
export const vertexSse = () => `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...vertexJson(), content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } })}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"synthetic reply"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
