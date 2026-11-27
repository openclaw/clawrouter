// Synthetic endpoint only; production activation remains separately owned.
export function configureSearch(provider, region = "global") {
  provider.id = "minimax"; provider.base_urls = { default: region === "global" ? "https://api.minimax.io" : "https://api.minimaxi.com" };
  provider.auth = { ...provider.auth, schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }], grantTransports: {} };
  provider.adapter = { ...provider.adapter, injectHeaders: {}, injectQuery: {}, removeHeaders: [] };
  provider.endpoints = [{ ...provider.endpoints[0], id: "search", method: "POST", path: "/v1/coding_plan/search", path_params: [], query: {}, headers: {},
    request_format: "minimax.search", response_format: "minimax.search", native_proxy: true, timeout_ms: 10000, streaming: undefined,
    upstreamPath: undefined, modelPassthrough: undefined, inputProfile: undefined, requestPricing: undefined, auth: undefined,
    websocket: undefined, lifecycle: undefined, responsesLifecycle: undefined }];
  provider.capabilities = [{ id: "search.web", endpoint: "search", methods: ["POST"] }]; provider.models = [];
}
