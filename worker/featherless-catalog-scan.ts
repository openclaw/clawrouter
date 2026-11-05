import { featherlessCatalogRequest, filterFeatherlessModels, type FeatherlessModelRow } from "./featherless-model-catalog.ts";
import type { HttpOperation } from "./http-operation.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { readNativeJson, type NativeJsonInputHooks } from "./native-json.ts";
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
// The caller owns capacity through result serialization/publication, and owns
// operation completion. This leaf neither releases that lease nor ends delivery.
export async function fetchFeatherlessModelCatalog(input: Readonly<{
  operation: HttpOperation;
  inferenceBaseUrl: string;
  selectedApiKey: string;
  revalidateAccount: (signal: AbortSignal) => Promise<void>;
  allows: (upstreamId: string) => boolean;
  permittedModelIds: ReadonlySet<string>;
  registerInput?: NativeJsonInputHooks["registerInput"];
  registerFetch?: (pending: Promise<Response>, discard: (response: Response) => Promise<void>) => void;
}>): Promise<{ providerId: "featherless"; catalog: FeatherlessModelRow[] }> {
  const { operation, inferenceBaseUrl, selectedApiKey, revalidateAccount, allows, permittedModelIds } = input;
  const { signal } = operation;
  const allowed = (id: string) => permittedModelIds.has(id) && allows(id);
  const seen = new Set<string>(), rows: FeatherlessModelRow[] = [];
  let wireBytes = 0, resultBytes = encoder.encode(JSON.stringify({ providerId: "featherless", catalog: [] })).byteLength;
  let totals: { items: number; pages: number } | undefined;
  let active: Response | undefined;
  const inputs = new WeakMap<Response, InputRetirement>();
  const registerInput: NonNullable<NativeJsonInputHooks["registerInput"]> = (owner, response) => {
    inputs.set(response, owner);
    input.registerInput?.(owner, response);
  };
  async function discard(response: Response): Promise<void> {
    if (!response.body) return;
    let owner = inputs.get(response);
    if (!owner) {
      if (response.bodyUsed || response.body.locked) invalid();
      owner = inputRetirement(response.body.getReader());
      registerInput(owner, response);
    }
    await owner.retire("cancel", signal.reason);
  }
  async function revalidate(): Promise<void> {
    signal.throwIfAborted();
    await operation.wait(revalidateAccount(signal));
    signal.throwIfAborted();
  }
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const request = featherlessCatalogRequest(inferenceBaseUrl, selectedApiKey, page, signal);
      await revalidate();
      // Registration includes late-response disposal, before the public race.
      const fetching = fetch(request);
      input.registerFetch?.(fetching, discard);
      const pending = fetching.then(async response => {
        if (signal.aborted) { await discard(response); signal.throwIfAborted(); }
        return response;
      });
      active = await operation.wait(pending, "upstream", response => { void discard(response).catch(() => undefined); });
      signal.throwIfAborted();
      let chunks = 0, pageBytes = 0;
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
      }, invalid, { registerInput, observeChunk(chunk) {
        signal.throwIfAborted();
        chunks++; pageBytes += chunk.byteLength; wireBytes += chunk.byteLength;
        if (chunks > MAX_CHUNKS || pageBytes > PAGE_BYTES || wireBytes > WIRE_BYTES) invalid();
      } }), "upstream");
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
    if (active) await discard(active);
  }
}
