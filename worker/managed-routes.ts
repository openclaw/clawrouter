import { managedCreateAdapter } from "./managed-lifecycle-adapters.ts";
import type { ManagedControlAction, ManagedLifecycleAdapter, ManagedPublicPaths } from "./managed-lifecycle-types.ts";
import type { CompiledEndpoint, CompiledProvider } from "./types.ts";
import { HttpError } from "./utils.ts";

export function managedRoute(provider: CompiledProvider, create: CompiledEndpoint): {
  adapter: ManagedLifecycleAdapter; controls: Partial<Record<ManagedControlAction, CompiledEndpoint>>;
} {
  const lifecycle = create.lifecycle, adapter = lifecycle && managedCreateAdapter(lifecycle.protocol, create.request_format);
  if (!adapter || !lifecycle || typeof lifecycle.retrieve !== "string" || !lifecycle.retrieve || create.modelPassthrough || create.method !== "POST"
    || adapter.protocol === "dashscope.video" && !adapter.assertDispatch
    || adapter.supportsCancel !== !!lifecycle.cancel || adapter.supportsResult !== !!lifecycle.result) unavailable();
  const controls: Partial<Record<ManagedControlAction, CompiledEndpoint>> = {};
  for (const action of ["retrieve", "result", "cancel"] as const) {
    const id = lifecycle[action];
    if (id === undefined) continue;
    const endpoint = provider.endpoints.find(endpoint => endpoint.id === id);
    if (!endpoint || !endpoint.native_proxy || endpoint.lifecycle || endpoint.modelPassthrough || Object.keys(endpoint.query).length) unavailable();
    controls[action] = endpoint;
  }
  return { adapter, controls };
}

export function managedPaths(provider: CompiledProvider, create: CompiledEndpoint, id: string, pathParams: Record<string, string>): ManagedPublicPaths {
  const { adapter, controls } = managedRoute(provider, create);
  const paths: Partial<ManagedPublicPaths> = {};
  for (const action of ["retrieve", "result", "cancel"] as const) {
    const endpoint = controls[action];
    if (!endpoint) continue;
    const target = adapter.control(action, endpoint, id, pathParams), query = target.query.toString();
    paths[action] = `/v1/native/${provider.id}${target.path}${query ? `?${query}` : ""}`;
  }
  return paths as ManagedPublicPaths;
}

function unavailable(): never { throw new HttpError(409, "response_owner_unavailable", "the managed lifecycle declaration is unavailable or unsupported"); }

export async function managedControlIdentity(protocol: string, action: ManagedControlAction, pathParams: Record<string, string>,
  queryInput: import("./proxy-query.ts").ProxyQuery): Promise<string> {
  const { managedLifecycleAdapter } = await import("./managed-lifecycle-adapters.ts");
  const { applyProxyQuery } = await import("./proxy-query.ts");
  const adapter = managedLifecycleAdapter(protocol), query = new URLSearchParams();
  if (!adapter) unavailable();
  try { applyProxyQuery(query, queryInput); return adapter.identify(action, pathParams, query); }
  catch { throw new HttpError(400, "invalid_prediction_query", "managed controls require the exact native identity and route parameters"); }
}
