import { cerebrasPublicCatalogRequest, readCerebrasPublicCatalog } from "./cerebras-model-catalog.ts";
import { chutesCatalogRequest, readChutesModels } from "./chutes-model-catalog.ts";
import type { HttpOperation } from "./http-operation.ts";
import { nvidiaPublicCatalogRequests, readNvidiaPublicCatalog } from "./nvidia-model-catalog.ts";
import { HttpError } from "./utils.ts";
import { readVeniceModels, veniceCatalogRequest } from "./venice-model-catalog.ts";

export type PublicModelDiscoveryResult =
  | { providerId: "cerebras"; catalog: Awaited<ReturnType<typeof readCerebrasPublicCatalog>> }
  | { providerId: "nvidia"; catalog: Awaited<ReturnType<typeof readNvidiaPublicCatalog>> }
  | { providerId: "chutes"; catalog: Awaited<ReturnType<typeof readChutesModels>> }
  | { providerId: "venice"; catalog: Awaited<ReturnType<typeof readVeniceModels>> };

// The caller owns admission, the original grant and operation lifetime. Public
// factories receive only the selected base and signal, never credential headers.
export async function fetchPublicModelDiscovery(input: Readonly<{
  providerId: "cerebras" | "nvidia" | "chutes" | "venice";
  operation: HttpOperation;
  inferenceBaseUrl: string;
  revalidateAccount: (signal: AbortSignal) => Promise<void>;
  allows: (upstreamId: string) => boolean;
  permittedModelIds: ReadonlySet<string>;
}>): Promise<PublicModelDiscoveryResult> {
  const { operation } = input, signal = operation.signal;
  const responses: Response[] = [];
  const discard = (response: Response) => { void response.body?.cancel(signal.reason).catch(() => undefined); };
  const revalidate = async () => {
    signal.throwIfAborted();
    await operation.wait(input.revalidateAccount(signal));
    signal.throwIfAborted();
  };
  const request = async (native: Request) => {
    await revalidate();
    const response = await operation.wait(fetch(native), "upstream", discard);
    responses.push(response);
    signal.throwIfAborted();
    return response;
  };
  const allows = (id: string) => input.permittedModelIds.has(id) && input.allows(id);
  const permitted = () => new Set([...input.permittedModelIds].filter(allows));
  try {
    signal.throwIfAborted();
    let result: PublicModelDiscoveryResult;
    switch (input.providerId) {
      case "cerebras": {
        const response = await request(cerebrasPublicCatalogRequest(input.inferenceBaseUrl, signal));
        result = { providerId: "cerebras", catalog: await operation.wait(readCerebrasPublicCatalog(response, signal, permitted()), "upstream") };
        break;
      }
      case "nvidia": {
        const native = nvidiaPublicCatalogRequests(input.inferenceBaseUrl, signal);
        const inventory = await request(native.inventory);
        // Recheck the same owner between physical requests. The reader owns the
        // fresh-inventory intersection, including authoritative empty inventory.
        const featured = await request(native.featured);
        result = { providerId: "nvidia", catalog: await operation.wait(readNvidiaPublicCatalog(inventory, featured, signal, permitted()), "upstream") };
        break;
      }
      case "chutes": {
        const response = await request(chutesCatalogRequest(input.inferenceBaseUrl, signal));
        result = { providerId: "chutes", catalog: await operation.wait(readChutesModels(response, signal, allows), "upstream") };
        break;
      }
      case "venice": {
        const response = await request(veniceCatalogRequest(input.inferenceBaseUrl, signal));
        result = { providerId: "venice", catalog: await operation.wait(readVeniceModels(response, signal, allows), "upstream") };
        break;
      }
      default:
        throw new HttpError(400, "public_catalog_not_supported", "the selected provider has no public catalog contract");
    }
    await revalidate();
    // Fresh authorization can tighten the policy behind allows. Reader-time
    // filtering is provisional until this final intersection succeeds.
    switch (result.providerId) {
      case "cerebras": result.catalog = result.catalog.filter(row => allows(row.id)); break;
      case "nvidia": result.catalog = result.catalog.filter(row => allows(row.id)); break;
      case "chutes": result.catalog = { ...result.catalog, data: result.catalog.data.filter(row => allows(row.id)) }; break;
      case "venice": result.catalog = { ...result.catalog, data: result.catalog.data.filter(row => allows(row.id)) }; break;
    }
    return result;
  } finally {
    for (const response of responses) discard(response);
  }
}
