// Synthetic declaration only: production YAML and source-owned leaf stay unchanged.
export const imageModel = "minimax/image-01";
export const imageBody = () => ({ model: "image-01", prompt: "Synthetic paper boat", response_format: "base64", n: 1, aspect_ratio: "1:1" });
export const imageResult = () => ({ base_resp: { status_code: 0, status_msg: "success" }, id: "synthetic-image-request",
  data: { image_base64: ["iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC"] },
  metadata: { success_count: 1, failed_count: 0 } });
export function configureImage(provider) {
  const endpoint = provider.endpoints[0], model = provider.models[0];
  provider.id = "minimax"; provider.base_urls = { default: "https://api.minimax.io" };
  provider.auth = { ...provider.auth, schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} };
  provider.adapter = { ...provider.adapter, injectHeaders: {}, injectQuery: {}, removeHeaders: [] };
  provider.endpoints = [{ ...endpoint, id: "images", method: "POST", path: "/v1/image_generation", path_params: [], query: {}, headers: {},
    request_format: "minimax.images", response_format: "minimax.images", streaming: null, native_proxy: true, timeout_ms: 2000,
    upstreamPath: undefined, modelPassthrough: undefined, auth: undefined, websocket: undefined, lifecycle: undefined, responsesLifecycle: undefined }];
  provider.capabilities = [{ id: "image.generate", endpoint: "images", methods: ["POST"] }];
  // Tempting Chat price is deliberate: it must never price the image operation.
  provider.models = [{ ...model, id: imageModel, upstream: "image-01", capabilities: ["image.generate"], endpointPricing: undefined, availability: undefined }];
}
