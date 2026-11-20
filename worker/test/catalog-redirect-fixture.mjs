import { arceeCatalogRequest, readArceeModels } from "../arcee-model-catalog.ts";
import { basetenCatalogRequest, readBasetenModels } from "../baseten-model-catalog.ts";
import { cerebrasPublicCatalogRequest, readCerebrasPublicCatalog } from "../cerebras-model-catalog.ts";
import { chutesCatalogRequest, readChutesModels } from "../chutes-model-catalog.ts";
import { deepinfraCatalogRequests, readDeepInfraCatalog } from "../deepinfra-model-catalog.ts";
import { featherlessCatalogRequest, readFeatherlessModels } from "../featherless-model-catalog.ts";
import { novitaCatalogRequest, readNovitaModels } from "../novita-model-catalog.ts";
import { nvidiaPublicCatalogRequests, readNvidiaPublicCatalog } from "../nvidia-model-catalog.ts";
import { veniceCatalogRequest, readVeniceModels } from "../venice-model-catalog.ts";

const key = "synthetic-original-key", allows = () => true, permitted = new Set();
const empty = { object: "list", data: [] };
export const catalogFixtures = [
  { id: "arcee", url: "https://api.arcee.ai/api/v1/models", keyed: true, payload: empty },
  { id: "baseten", url: "https://inference.baseten.co/v1/models", keyed: true, payload: empty },
  { id: "cerebras", url: "https://api.cerebras.ai/public/v1/models", payload: empty },
  { id: "chutes", url: "https://llm.chutes.ai/v1/models", payload: empty },
  { id: "deepinfra-metadata", url: "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta", keyed: true, payload: empty },
  { id: "deepinfra-pricing", url: "https://api.deepinfra.com/models/list", payload: [] },
  { id: "featherless", url: "https://api.featherless.ai/v1/models?capabilities=chat&page=1&per_page=100", keyed: true,
    payload: { data: [], pagination: { current_page: 1, per_page: 100, total_items: 0, total_pages: 0 }, total: 0 } },
  { id: "novita", url: "https://api.novita.ai/openai/v1/models", keyed: true, payload: { data: [] } },
  { id: "nvidia-inventory", url: "https://integrate.api.nvidia.com/v1/models", payload: empty },
  { id: "nvidia-featured", url: "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json", payload: { "featured-models": [] } },
  { id: "venice", url: "https://api.venice.ai/api/v1/models?type=text", payload: { ...empty, type: "text" } },
];

// Both runtimes call the actual factories/readers. Empty companion inventories
// deliberately exercise the exceptional NVIDIA/DeepInfra publication paths.
export function catalogCases(signal) {
  const deepinfra = () => deepinfraCatalogRequests("https://api.deepinfra.com/v1/openai", key, signal);
  const nvidia = () => nvidiaPublicCatalogRequests("https://integrate.api.nvidia.com/v1", signal);
  const pairs = [
    [() => arceeCatalogRequest("https://api.arcee.ai/api/v1", key, signal), r => readArceeModels(r, signal, allows)],
    [() => basetenCatalogRequest("https://inference.baseten.co/v1", key, signal), r => readBasetenModels(r, signal, allows)],
    [() => cerebrasPublicCatalogRequest("https://api.cerebras.ai/v1", signal), r => readCerebrasPublicCatalog(r, signal, permitted)],
    [() => chutesCatalogRequest("https://llm.chutes.ai/v1", signal), r => readChutesModels(r, signal, allows)],
    [() => deepinfra().metadata, r => readDeepInfraCatalog({ metadata: r, pricing: Response.json([]) }, signal, permitted)],
    [() => deepinfra().pricing, r => readDeepInfraCatalog({ metadata: Response.json(empty), pricing: r }, signal, permitted)],
    [() => featherlessCatalogRequest("https://api.featherless.ai/v1", key, 1, signal), r => readFeatherlessModels(r, signal, allows, 1)],
    [() => novitaCatalogRequest("https://api.novita.ai/openai/v1", key, signal), r => readNovitaModels(r, signal, allows)],
    [() => nvidia().inventory, r => readNvidiaPublicCatalog(r, Response.json({ "featured-models": [] }), signal, permitted)],
    [() => nvidia().featured, r => readNvidiaPublicCatalog(Response.json(empty), r, signal, permitted)],
    [() => veniceCatalogRequest("https://api.venice.ai/api/v1", signal), r => readVeniceModels(r, signal, allows)],
  ];
  return catalogFixtures.map((fixture, index) => ({ ...fixture, request: pairs[index][0], read: pairs[index][1] }));
}
