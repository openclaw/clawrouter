import snapshot from "../../worker/generated/provider-snapshot.json";
import type { ProviderRow, RouteCatalog } from "./ui-types";

interface CatalogSnapshot {
  providers: Array<{
    id: string;
    display_name: string;
    class: string;
    service_kind: string;
    meter?: string | null;
    capabilities: Array<{ id: string; endpoint: string }>;
    auth: { authorization?: { grantKind?: "oauth" | "subscription" } | null };
    quota?: { probes?: Array<{ grantKinds?: Array<"api_key" | "oauth" | "subscription"> }> };
    routing: { modelPrefixes?: string[] };
    models: Array<{ id: string; capabilities: string[] }>;
    endpoints: Array<{ id: string; methods: string[]; path_params: string[]; request_format?: string | null; response_format?: string | null; streaming?: string | null }>;
  }>;
}

const catalogSnapshot = snapshot as unknown as CatalogSnapshot;

export function demoCatalog(): { providers: ProviderRow[]; routes: RouteCatalog } {
  const providers: ProviderRow[] = catalogSnapshot.providers.map((provider) => ({
    id: provider.id,
    display_name: provider.display_name,
    class: provider.class,
    service_kind: provider.service_kind,
    meter: provider.meter,
    capabilities: provider.capabilities.map((capability) => ({ id: capability.id })),
    auth: provider.auth.authorization ? { authorization: { grantKind: provider.auth.authorization.grantKind } } : undefined,
    quota: provider.quota,
  }));
  const routes: RouteCatalog = {
    openaiCompatible: catalogSnapshot.providers.filter((provider) => provider.class === "openai_compatible").map((provider) => ({
      provider: provider.id,
      models: provider.models.map((model) => ({
        id: model.id,
        capabilities: model.capabilities,
        endpoints: model.capabilities.map(unifiedPathForCapability).filter(Boolean),
      })),
      modelPrefixes: provider.routing.modelPrefixes,
      endpoints: provider.capabilities.map((capability) => unifiedPathForCapability(capability.id)).filter(Boolean),
    })),
    manifestProxy: catalogSnapshot.providers.flatMap((provider) => provider.endpoints.map((endpoint) => ({
      provider: provider.id,
      endpoint: endpoint.id,
      route: `/v1/proxy/${provider.id}/${endpoint.id}`,
      methods: endpoint.methods,
      pathParams: endpoint.path_params,
      requestFormat: endpoint.request_format ?? undefined,
      responseFormat: endpoint.response_format ?? undefined,
      sampleModel: provider.models.find((model) => model.capabilities.some((capability) => provider.capabilities.find((item) => item.id === capability)?.endpoint === endpoint.id))?.id ?? null,
      models: provider.models.map((model) => ({ id: model.id, capabilities: model.capabilities })),
      streaming: endpoint.streaming != null,
    }))),
  };
  return { providers, routes };
}

function unifiedPathForCapability(capability: string): string {
  return capability === "llm.chat" ? "/v1/chat/completions" : capability === "llm.responses" ? "/v1/responses" : capability === "llm.embeddings" ? "/v1/embeddings" : "";
}
