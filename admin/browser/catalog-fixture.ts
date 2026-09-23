import type { ClientCatalog } from "../../shared/contracts";

export function fixtureCatalog(principalId: string, policyId = "test_policy"): ClientCatalog {
  const offer = { transport: "http" as const, policyId, policyGeneration: "fixture-generation", eligible: true, affordability: "request-dependent" as const };
  return {
    version: "clawrouter.client-catalog.v1", observedAt: "2026-07-06T12:00:00.000Z",
    scope: { authType: "access", credentialId: null, principalId },
    providers: ["test-model", "test-service"].map((id) => ({
      id, displayName: id, allowed: true, executable: true, openaiCompatible: id === "test-model", nativeBaseUrl: null, policies: [policyId], connectionTypes: [], routes: [],
      readiness: { id, displayName: id, class: "test", serviceKind: "model_provider", requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: id === "test-model", manifestRoutes: 1, modelCount: id === "test-model" ? 3 : 0, executable: true, status: "configured", reasons: [] },
      models: id === "test-model" ? [
        { id: "test-model/example", upstream: "example", capabilities: ["llm.chat"], pricing_ref: null, pricing: null },
        { id: "test-model/reasoning", upstream: "reasoning", capabilities: ["llm.responses"], pricing_ref: null, pricing: null, requestParameters: { responses: { sources: [], checkedAt: "2026-07-06", temperature: "unsupported" } } },
        { id: "test-model/embedding", upstream: "embedding", capabilities: ["llm.embeddings"], pricing_ref: null, pricing: null },
      ] : [],
      offers: id === "test-model" ? [
        { ...offer, endpoint: "chat_completions", modelId: "test-model/example", routeKind: "unified", route: "/v1/playground/v1/chat/completions" },
        { ...offer, endpoint: "responses", modelId: "test-model/reasoning", routeKind: "unified", route: "/v1/playground/v1/responses" },
        { ...offer, endpoint: "embeddings", modelId: "test-model/embedding", routeKind: "playground", route: "/v1/playground/proxy/test-model/embeddings" },
        { ...offer, endpoint: "embeddings", modelId: null, routeKind: "playground", route: "/v1/playground/proxy/test-model/embeddings" },
      ] : [{ ...offer, endpoint: "search", modelId: null, routeKind: "playground", route: "/v1/playground/proxy/test-service/search" }],
    })),
  };
}

export function embeddingCatalog(principalId: string): ClientCatalog {
  const catalog = fixtureCatalog(principalId);
  const provider = catalog.providers[0];
  catalog.providers = [
    { id: "openai", modelId: "openai/text-embedding-3-large", upstream: "text-embedding-3-large" },
    { id: "azure-openai", modelId: "azure-openai/deployment", upstream: "${deployment}" },
  ].map(({ id, modelId, upstream }) => ({
    ...provider, id, displayName: id, readiness: { ...provider.readiness, id, displayName: id },
    models: [{ id: modelId, upstream, capabilities: ["llm.embeddings"], pricing_ref: null, pricing: null }],
    offers: [
      { ...provider.offers[0], endpoint: "embeddings", modelId, route: "/v1/playground/v1/embeddings" },
      { ...provider.offers[0], endpoint: "embeddings", modelId, routeKind: "playground", route: `/v1/playground/proxy/${id}/embeddings` },
    ],
  }));
  return catalog;
}
