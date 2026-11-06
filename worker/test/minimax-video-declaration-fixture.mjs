// Synthetic declarations only. No public YAML or snapshot activation.
export const hailuoModels = ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"];
export function configureVideo(provider) {
  const template = provider.endpoints[0], model = provider.models[0];
  provider.id = "minimax";
  provider.base_urls = { default: "https://api.minimax.io", cn: "https://api.minimaxi.com" };
  provider.auth = { ...provider.auth, schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} };
  provider.adapter = { ...provider.adapter, injectHeaders: {}, injectQuery: {}, passthroughHeaders: [], removeHeaders: [] };
  const endpoint = (id, method, path, request_format, response_format) => ({ ...template, id, method, methods: [method], path,
    request_format, response_format, path_params: [], query: {}, headers: {}, native_proxy: true, timeout_ms: 10000,
    streaming: undefined, upstreamPath: undefined, modelPassthrough: undefined, inputProfile: undefined, requestPricing: undefined,
    auth: undefined, websocket: undefined, lifecycle: undefined, responsesLifecycle: undefined });
  provider.endpoints = [endpoint("video", "POST", "/v1/video_generation", "minimax.video_create", "minimax.video"),
    endpoint("task", "GET", "/v1/query/video_generation", "minimax.video_get", "minimax.video"),
    endpoint("file", "GET", "/v1/files/retrieve", "minimax.file_get", "minimax.file"),
    endpoint("file_content", "GET", "/v1/files/retrieve_content", "minimax.file_content", "binary.file")];
  provider.endpoints[0].lifecycle = { protocol: "minimax.video", retrieve: "task", files: { metadata: "file", download: "file_content" } };
  provider.capabilities = [{ id: "media.predict", endpoint: "video", methods: ["POST"] }];
  provider.models = hailuoModels.map(upstream => ({ ...model, id: "minimax/" + upstream, upstream, capabilities: ["media.predict"], pricing: null }));
}
export const videoInput = (model = hailuoModels[0]) => ({ model, prompt: "Synthetic quiet landscape", duration: 6, resolution: "768P" });
export const submitted = { task_id: "9007199254740993", base_resp: { status_code: 0, status_msg: "success" } };
export const completed = { ...submitted, status: "Success", file_id: "9007199254740995" };
export const metadata = { file: { file_id: completed.file_id, purpose: "video_generation", bytes: 16 }, base_resp: { status_code: 0 } };
export function mp4(size = 16) {
  const bytes = new Uint8Array(size); new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode("ftypisom"), 4); return bytes;
}
