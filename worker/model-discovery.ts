import type { AccessPolicy, CompiledEndpoint, CompiledModel, CompiledProvider } from "./types.ts";
import type { HttpOperation } from "./http-operation.ts";
import { errorResponse, HttpError } from "./utils.ts";

// These formats are metadata, not inference or a permission to delete models.
export function isModelDiscovery(endpoint: Pick<CompiledEndpoint, "request_format">): boolean {
  return ["openai.models", "anthropic.models"].includes(endpoint.request_format);
}
export function discoveryModelId(provider: CompiledProvider, upstream: string): string {
  return provider.models.find(model => model.upstream === upstream)?.id ?? provider.routing.modelPrefixes[0] + upstream;
}
export function discoveryAllows(policy: AccessPolicy, provider: CompiledProvider, upstream: string): boolean {
  return policy.models == null || policy.models.includes(discoveryModelId(provider, upstream));
}
export function prepareModelDiscovery(provider: CompiledProvider, endpoint: CompiledEndpoint, body: Record<string, unknown>, pathParams: Record<string, string>): { model: CompiledModel | null; body: Record<string, unknown>; pathParams: Record<string, string> } {
  if (Object.keys(body).length) throw new HttpError(400, "invalid_model_discovery", "model discovery does not accept a request body");
  if (Object.keys(pathParams).some(name => !endpoint.path_params.includes(name))) throw new HttpError(400, "invalid_model_discovery", "unknown discovery path parameter");
  const id = pathParams.model_id;
  if (endpoint.path_params.includes("model_id") && (typeof id !== "string" || !id.length || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))) throw new HttpError(400, "invalid_model_id", "a bounded nonempty model_id is required");
  // Metadata pricing must never inherit the selected model's inference tariff.
  const model: CompiledModel | null = id ? { id: discoveryModelId(provider, id), upstream: id, capabilities: [], pricing: null, pricing_ref: null } : null;
  return { model, body: {}, pathParams };
}
export function discoveryQuery(params: URLSearchParams | Record<string, unknown>): Record<string, unknown> {
  if (!(params instanceof URLSearchParams)) return params;
  const query: Record<string, unknown> = {};
  params.forEach((value, name) => { query[name] = name === "lifecycle[]" ? params.getAll(name) : value; });
  return query;
}
export function validateDiscoveryQuery(provider: CompiledProvider, endpoint: CompiledEndpoint, policy: AccessPolicy, query: Record<string, unknown>): void {
  if (query.lifecycle !== undefined && Array.isArray(query.lifecycle)) {
    if (query["lifecycle[]"] !== undefined) throw new HttpError(400, "invalid_model_discovery_query", "use one lifecycle query representation");
    query["lifecycle[]"] = query.lifecycle; delete query.lifecycle;
  }
  for (const [name, value] of Object.entries(query)) {
    if (provider.id !== "anthropic" || endpoint.path_params.length || !["after_id", "before_id", "limit", "lifecycle[]"].includes(name)) throw new HttpError(400, "invalid_model_discovery_query", "unsupported model discovery query parameter");
    if (name === "lifecycle[]") {
      const values = Array.isArray(value) ? value : [value];
      if (!values.length || values.length > 3 || values.some(v => typeof v !== "string" || !["active", "deprecated", "retired"].includes(v))) throw new HttpError(400, "invalid_model_discovery_query", "invalid model lifecycle filter");
    } else if (name === "limit") {
      if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 1000) throw new HttpError(400, "invalid_model_discovery_query", "model list limit must be between 1 and 1000");
    } else if (typeof value !== "string" || !value.length || value.length > 512) throw new HttpError(400, "invalid_model_discovery_query", "invalid model list cursor");
    else if (!discoveryAllows(policy, provider, value)) throw new HttpError(403, "model_not_allowed", "model list cursor is not allowed by this policy");
  }
  if (query.after_id != null && query.before_id != null) throw new HttpError(400, "invalid_model_discovery_query", "use only one model list cursor direction");
}

function metadataResponse(value: unknown, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "last-modified", "location"]) headers.delete(name);
  headers.set("cache-control", "private, no-store");
  headers.set("content-type", "application/json");
  return Response.json(value, { status: response.status, headers });
}

const malformed = () => new HttpError(502, "invalid_model_discovery_response", "upstream model metadata is invalid or exceeds the discovery scan bound");
async function readMetadata(response: Response, operation: HttpOperation): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw malformed();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await operation.wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw malformed();
      chunks.push(value);
    }
  } catch (error) { void reader.cancel(error).catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed();
    return value as Record<string, unknown>;
  } catch { throw malformed(); }
}

// Filtered pages expose only permitted model IDs, including first/last cursors.
// An all-hidden page is scanned internally on the SAME selected grant; never
// repick/fail over to a different account to manufacture a combined inventory.
export async function modelDiscoveryResponse(response: Response, provider: CompiledProvider, endpoint: CompiledEndpoint, policy: AccessPolicy, query: Record<string, unknown>, operation: HttpOperation, next: (cursor: string, before: boolean) => Promise<Response>): Promise<Response> {
  const restricted = policy.models != null, seen = new Set<string>();
  for (let pages = 0; pages < 32; pages++) {
    if (!response.ok) {
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        return errorResponse("provider_unavailable", `upstream request to provider ${provider.id} failed`, 502);
      }
      if (!restricted) { const headers = new Headers(response.headers); headers.set("cache-control", "private, no-store"); return new Response(response.body, { status: response.status, headers }); }
      void response.body?.cancel().catch(() => undefined);
      return errorResponse("model_discovery_rejected", "upstream rejected model discovery", response.status, undefined, { "retry-after": response.headers.get("retry-after") ?? "0" });
    }
    const metadata = await readMetadata(response, operation);
    const valid = (value: unknown): value is Record<string, unknown> & { id: string } => !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string" && !!(value as { id: string }).id && (value as { id: string }).id.length <= 512 && !/[\u0000-\u001f\u007f]/.test((value as { id: string }).id);
    if (endpoint.path_params.includes("model_id")) {
      if (!valid(metadata)) throw malformed();
      if (!discoveryAllows(policy, provider, metadata.id)) throw new HttpError(403, "model_not_allowed", "resolved model is not allowed by this policy");
      return metadataResponse(metadata, response);
    }
    if (!Array.isArray(metadata.data) || !metadata.data.every(valid)) throw malformed();
    if (provider.id === "anthropic" && typeof metadata.has_more !== "boolean" || provider.id === "openai" && metadata.object !== "list") throw malformed();
    if (!restricted) return metadataResponse(metadata, response);
    const data = metadata.data.filter(model => discoveryAllows(policy, provider, model.id));
    if (provider.id === "openai") return metadataResponse({ object: "list", data }, response);
    if (data.length || !metadata.has_more) return metadataResponse({ data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: metadata.has_more }, response);
    const before = query.before_id != null;
    const cursor = before ? metadata.first_id : metadata.last_id;
    if (typeof cursor !== "string" || !cursor.length || seen.has(cursor) || pages === 31) throw malformed();
    seen.add(cursor);
    response = await next(cursor, before);
  }
  void response.body?.cancel().catch(() => undefined);
  throw malformed();
}
