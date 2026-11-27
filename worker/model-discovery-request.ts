import { modelExecutable } from "../shared/route-catalog.ts";
import { HttpError } from "./http-error.ts";
import type { AccessPolicy, CompiledEndpoint, CompiledModel, CompiledProvider } from "./types.ts";

export function discoveryModelId(provider: CompiledProvider, upstream: string): string {
  return provider.models.find(model => model.upstream === upstream)?.id ?? provider.routing.modelPrefixes[0] + upstream;
}
export function discoveryAllows(policy: AccessPolicy, provider: CompiledProvider, upstream: string): boolean {
  return modelExecutable(provider, { id: discoveryModelId(provider, upstream), upstream })
    && (policy.models == null || policy.models.includes(discoveryModelId(provider, upstream)));
}
export function prepareModelDiscovery(provider: CompiledProvider, endpoint: CompiledEndpoint, body: Record<string, unknown>, pathParams: Record<string, string>): { model: CompiledModel | null; body: Record<string, unknown>; pathParams: Record<string, string> } {
  if (Object.keys(body).length) throw new HttpError(400, "invalid_model_discovery", "model discovery does not accept a request body");
  if (Object.keys(pathParams).some(name => !endpoint.path_params.includes(name))) throw new HttpError(400, "invalid_model_discovery", "unknown discovery path parameter");
  const id = pathParams.model_id;
  if (endpoint.path_params.includes("model_id") && (typeof id !== "string" || !id.length || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))) throw new HttpError(400, "invalid_model_id", "a bounded nonempty model_id is required");
  if (id && !modelExecutable(provider, { id: discoveryModelId(provider, id), upstream: id }))
    throw new HttpError(400, "model_unavailable", "the selected model identity is stopped");
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
    if (endpoint.request_format !== "anthropic.models" || endpoint.path_params.length || !["after_id", "before_id", "limit", "lifecycle[]"].includes(name)) throw new HttpError(400, "invalid_model_discovery_query", "unsupported model discovery query parameter");
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

