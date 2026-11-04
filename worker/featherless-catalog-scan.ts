import { featherlessCatalogRequest, filterFeatherlessModels, type FeatherlessModelRow } from "./featherless-model-catalog.ts";
import type { HttpOperation } from "./http-operation.ts";
import { readNativeJson } from "./native-json.ts";
import { HttpError } from "./utils.ts";

const PAGE_BYTES = 2 * 1024 * 1024;
const WIRE_BYTES = 8 * 1024 * 1024;
const RESULT_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_CHUNKS = 8192;
const encoder = new TextEncoder();

function invalid(): never {
  throw new HttpError(502, "invalid_model_discovery_response", "Featherless catalog scan is invalid or exceeds the discovery bound");
}
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

// The caller owns capacity through result serialization/publication, and owns
// operation completion. This leaf neither releases that lease nor ends delivery.
export async function fetchFeatherlessModelCatalog(input: Readonly<{
  operation: HttpOperation;
  inferenceBaseUrl: string;
  selectedApiKey: string;
  revalidateAccount: (signal: AbortSignal) => Promise<void>;
  allows: (upstreamId: string) => boolean;
  permittedModelIds: ReadonlySet<string>;
}>): Promise<{ providerId: "featherless"; catalog: FeatherlessModelRow[] }> {
  const { operation, inferenceBaseUrl, selectedApiKey, revalidateAccount, allows, permittedModelIds } = input;
  const { signal } = operation;
  const allowed = (id: string) => permittedModelIds.has(id) && allows(id);
  const seen = new Set<string>(), rows: FeatherlessModelRow[] = [];
  let wireBytes = 0, resultBytes = encoder.encode(JSON.stringify({ providerId: "featherless", catalog: [] })).byteLength;
  let totals: { items: number; pages: number } | undefined;
  let active: Response | undefined;
  async function revalidate(): Promise<void> {
    signal.throwIfAborted();
    await operation.wait(revalidateAccount(signal));
    signal.throwIfAborted();
  }
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const request = featherlessCatalogRequest(inferenceBaseUrl, selectedApiKey, page, signal);
      await revalidate();
      active = await operation.wait(fetch(request), "upstream", discard);
      signal.throwIfAborted();
      // A new Response cannot preserve the readonly redirected flag.
      if (active.redirected) invalid();
      if (active.body) {
        let chunks = 0, pageBytes = 0;
        const body = active.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            signal.throwIfAborted();
            chunks++; pageBytes += chunk.byteLength; wireBytes += chunk.byteLength;
            if (chunks > MAX_CHUNKS || pageBytes > PAGE_BYTES || wireBytes > WIRE_BYTES) invalid();
            controller.enqueue(chunk);
          },
        }));
        active = new Response(body, { status: active.status, statusText: active.statusText, headers: active.headers });
      }
      const parsed = await operation.wait(readNativeJson(active, signal, PAGE_BYTES, payload => {
        const result = filterFeatherlessModels(payload, () => true, page);
        // The codec validates every raw ID, including unavailable/filtered rows.
        // Its projected data omits those rows, so track raw IDs only after validation.
        if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) invalid();
        for (const row of payload.data) {
          if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || seen.has(row.id)) invalid();
          seen.add(row.id);
        }
        return result;
      }, invalid), "upstream");
      active = undefined;
      await revalidate();
      const { total_items: items, total_pages: pages } = parsed.pagination;
      if (pages > MAX_PAGES || totals && (totals.items !== items || totals.pages !== pages)) invalid();
      totals ??= { items, pages };
      for (const row of parsed.data) {
        if (!allowed(row.id)) continue;
        resultBytes += encoder.encode(JSON.stringify(row)).byteLength + (rows.length ? 1 : 0);
        if (resultBytes > RESULT_BYTES) invalid();
        rows.push(row);
      }
      if (page >= pages) {
        // Later page authorization can tighten policy for already retained rows.
        const catalog = rows.filter(row => allowed(row.id));
        signal.throwIfAborted();
        return { providerId: "featherless", catalog };
      }
    }
    return invalid();
  } finally {
    if (active) discard(active);
  }
}
