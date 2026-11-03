import { resolveConnection } from "./authority.ts";
import type { BackgroundAdmission } from "./background-store.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { applyManagedHeaders, assertManagedDispatch, managedHeaderIdentity, managedProbeId } from "./managed-dispatch.ts";
import { HttpOperation } from "./http-operation.ts";
import { applyTransportHeaders, assertOperationConfiguration, providerCredentialScheme } from "./provider-auth.ts";
import { resolveTemplate } from "./provider-templates.ts";
import { configuredUpstream, copyRequestHeaders, providerById, upstreamPath, type UpstreamAuth } from "./providers.ts";
import { responseIdentity } from "./response-identities.ts";
import { assertControlCallerLive, authorizeResponseControl, type ResponseControlAuthorization } from "./response-control-authorization.ts";
import { responsesControlQuery, type ResponsesControlAction } from "./responses-lifecycle.ts";
import type { CompiledEndpoint, CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

export interface ResponseControlDispatch {
  owner: ContinuationOwner;
  route: BackgroundAdmission["route"];
  responseId: string;
  action: ResponsesControlAction;
  query: string;
  stream: boolean;
  protocol?: import("./managed-lifecycle-types.ts").ManagedProtocol;
  requestedVersion?: string;
  deadline?: number;
  // Per-call diagnostics, not persisted ownership or an idempotency promise.
  clientRequestId?: string;
  authorization: ResponseControlAuthorization;
}

export async function responseRouteDigest(provider: CompiledProvider, upstream: UpstreamAuth, url: URL, headers: Headers, grantKey: string | null, lifecycle?: CompiledEndpoint["lifecycle"], env?: Env, pathParams: Record<string, string> = {}): Promise<string> {
  const routeUrl = new URL(url), scheme = providerCredentialScheme(provider, upstream.grant);
  if (grantKey && scheme.type === "query_api_key") routeUrl.searchParams.delete(scheme.param);
  const identity = upstream.grant?.credentialLineage ?? await sha256Hex(JSON.stringify([[...upstream.headers], [...upstream.query]]));
  const passthrough = provider.adapter.passthroughHeaders.map(name => [name.toLowerCase(), headers.get(name)]).sort();
  const parts: unknown[] = ["POST", routeUrl.href, identity, passthrough];
  if (lifecycle) {
    const create = provider.endpoints.find(endpoint => endpoint.lifecycle === lifecycle);
    if (!create || !env) unavailable();
    const { managedRoute } = await import("./managed-routes.ts");
    const { adapter, controls, retained } = managedRoute(provider, create, pathParams);
    if (retained) parts.push(["managed-job-params", retained]);
    parts.push(lifecycle.protocol, ...(["retrieve", "result", "cancel"] as const).flatMap(action => {
      const endpoint = controls[action];
      if (!endpoint) return [];
      const control = adapter.control(action, endpoint, managedProbeId(adapter), pathParams);
      // Transport overrides must not silently move a declared managed control.
      if (upstream.transport?.endpointPaths[endpoint.id]) unavailable();
      const headers = managedHeaderIdentity(provider, control);
      return [[endpoint.method, control.path,
        Object.entries(endpoint.headers).map(([name, value]) => [name, resolveTemplate(provider, value, env)]), [...control.query], ...(headers.length ? [headers] : [])]];
    }));
  }
  return sha256Hex(JSON.stringify(parts));
}

export function retainedResponseRoute(pathParams: Record<string, string>, headers: Headers): BackgroundAdmission["route"] {
  const route = { pathParams, organization: headers.get("openai-organization"), project: headers.get("openai-project") };
  validateRoute(route); return route;
}

// The credential owner invokes fetch immediately after this preparation while
// still holding its mutation tail. No credential leaves that owner for a poll.
export async function prepareResponseControl(env: Env, input: ResponseControlDispatch, grant: UpstreamGrant | null): Promise<Request> {
  assertControlDeadline(input);
  const provider = providerById(input.owner.providerId), create = provider?.endpoints.find(endpoint => endpoint.id === input.owner.endpointId);
  const managed = input.protocol !== undefined;
  const contract = managed && provider && create ? (await import("./managed-routes.ts")).managedRoute(provider, create, input.route.pathParams) : null;
  const lifecycle = managed ? create?.lifecycle : create?.responsesLifecycle;
  const id = managed ? { value: contract?.adapter.validateId(input.responseId) } : responseIdentity("response", input.responseId);
  if (!provider || !create || !lifecycle || managed && create.lifecycle?.protocol !== input.protocol || !id || !(managed ? ["retrieve", "result", "cancel"] : ["retrieve", "cancel"]).includes(input.action)) unavailable();
  validateRoute(input.route);
  if (typeof input.query !== "string" || input.query.length > 8192) unavailable();
  if (managed && input.query !== "") unavailable();
  const query = managed ? new URLSearchParams() : responsesControlQuery(input.action, new URLSearchParams(input.query));
  if (query.get("stream") === "true" && !input.stream) throw new HttpError(409, "response_resume_unavailable", "stream resumption requires an originally streamed response");
  if (!contract?.retained && Object.keys(input.route.pathParams).some(name => !create.path_params.includes(name))) unavailable();
  assertOperationConfiguration({ provider, endpoint: create, mode: "http", responsesLifecycle: !managed, managedLifecycle: managed }, grant, env);
  const connection = await resolveConnection(env, provider.id);
  if (connection?.enabled === false) throw new HttpError(503, "provider_disabled", "response provider is disabled");
  const upstream = configuredUpstream(provider, grant, env), incoming = new Headers();
  if (input.route.organization !== null) incoming.set("openai-organization", input.route.organization);
  if (input.route.project !== null) incoming.set("openai-project", input.route.project);
  const headers = new Headers(upstream.headers);
  copyRequestHeaders(incoming, provider, create, headers, env);
  applyTransportHeaders(headers, upstream.transport, grant);
  const urlFor = (endpoint: typeof create, params: Record<string, string>) => {
    const url = new URL(`${upstream.baseUrl.replace(/\/$/, "")}${upstreamPath(provider, endpoint, params, env, upstream)}`);
    upstream.query.forEach((value, name) => url.searchParams.set(name, value));
    for (const [name, value] of Object.entries(endpoint.query)) url.searchParams.set(name, resolveTemplate(provider, value, env));
    return url;
  };
  // Compare the original create route, not the necessarily different control
  // URL. Environment credential/configuration changes also invalidate the pin.
  if (await responseRouteDigest(provider, upstream, urlFor(create, input.route.pathParams), headers, input.owner.grantKey, managed ? create.lifecycle : undefined, env, input.route.pathParams) !== input.owner.routeSha256) unavailable();
  const endpoint = managed ? contract?.controls[input.action]
    : provider.endpoints.find(endpoint => endpoint.id === create.responsesLifecycle![input.action as "retrieve" | "cancel"]);
  if (!endpoint) unavailable();
  const control = managed ? contract!.adapter.control(input.action, endpoint, id.value!, input.route.pathParams) : null;
  const url = control ? new URL(`${upstream.baseUrl.replace(/\/$/, "")}${control.path}`) : urlFor(endpoint, { response_id: id.value! });
  if (control) {
    upstream.query.forEach((value, name) => url.searchParams.set(name, value));
    control.query.forEach((value, name) => { if (url.searchParams.has(name)) unavailable(); url.searchParams.set(name, value); });
  }
  for (const [name, value] of query) url.searchParams.append(name, value);
  if (input.clientRequestId) incoming.set("x-client-request-id", input.clientRequestId);
  copyRequestHeaders(incoming, provider, endpoint, headers, env);
  applyTransportHeaders(headers, upstream.transport, grant);
  if (control) applyManagedHeaders(provider, headers, control);
  return new Request(url, { method: endpoint.method, headers, redirect: "manual" });
}

export async function dispatchResponseControl(env: Env, input: ResponseControlDispatch, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  if (input.owner.grantKey) {
    const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(input.owner.grantKey));
    // The owner returns the upstream response unchanged. Its internal transport
    // must not follow that response before the public boundary can reject it.
    return stub.fetch("https://clawrouter.internal/responses/control", { method: "POST", body: JSON.stringify(input), signal, redirect: "manual" });
  }
  const preparation = new HttpOperation(signal, 10_000);
  try {
    const request = await preparation.wait(prepareResponseControl(env, input, null));
    await preparation.wait(authorizeResponseControl(env, input.authorization, input.owner, preparation.signal));
    preparation.signal.throwIfAborted();
    assertControlDeadline(input);
    assertControlCallerLive(input.authorization);
    assertManagedDispatch(input.protocol, request);
    return fetch(request, { signal });
  } finally { preparation.stop("complete"); }
}

export function assertControlDeadline(input: ResponseControlDispatch): void {
  if (input.authorization?.kind === "collection" && ((input.action !== "retrieve" && !(input.protocol && input.action === "result")) || input.query !== "" || input.deadline === undefined)) unavailable();
  if (input.deadline !== undefined && (!Number.isSafeInteger(input.deadline) || Date.now() >= input.deadline)) {
    throw new HttpError(409, "response_observation_expired", "automatic response observation has ended; authenticated controls remain available");
  }
}

function validateRoute(route: BackgroundAdmission["route"]): void {
  if (!route || !route.pathParams || typeof route.pathParams !== "object" || Array.isArray(route.pathParams)
    || Object.keys(route.pathParams).length > 16 || Object.values(route.pathParams).some(value => typeof value !== "string" || !value || new TextEncoder().encode(value).length > 1024)
    || [route.organization, route.project].some(value => value !== null && (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value)))) {
    throw new HttpError(400, "background_route_invalid", "background path and organization/project metadata exceed the supported scalar bounds");
  }
}
function unavailable(): never { throw new HttpError(409, "response_owner_unavailable", "the original response route is unavailable or changed"); }
