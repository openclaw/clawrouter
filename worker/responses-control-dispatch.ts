import { resolveConnection } from "./authority.ts";
import type { BackgroundAdmission } from "./background-store.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { applyTransportHeaders, assertOperationConfiguration, providerCredentialScheme } from "./provider-auth.ts";
import { resolveTemplate } from "./provider-templates.ts";
import { configuredUpstream, copyRequestHeaders, providerById, upstreamPath, type UpstreamAuth } from "./providers.ts";
import { responseIdentity } from "./response-identities.ts";
import { responsesControlQuery, type ResponsesControlAction } from "./responses-lifecycle.ts";
import type { CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

export interface ResponseControlDispatch {
  owner: ContinuationOwner;
  route: BackgroundAdmission["route"];
  responseId: string;
  action: ResponsesControlAction;
  query: string;
  stream: boolean;
}

export async function responseRouteDigest(provider: CompiledProvider, upstream: UpstreamAuth, url: URL, headers: Headers, grantKey: string | null): Promise<string> {
  const routeUrl = new URL(url), scheme = providerCredentialScheme(provider, upstream.grant);
  if (grantKey && scheme.type === "query_api_key") routeUrl.searchParams.delete(scheme.param);
  const identity = upstream.grant?.credentialLineage ?? await sha256Hex(JSON.stringify([[...upstream.headers], [...upstream.query]]));
  const passthrough = provider.adapter.passthroughHeaders.map(name => [name.toLowerCase(), headers.get(name)]).sort();
  return sha256Hex(JSON.stringify(["POST", routeUrl.href, identity, passthrough]));
}

export function retainedResponseRoute(pathParams: Record<string, string>, headers: Headers): BackgroundAdmission["route"] {
  const route = { pathParams, organization: headers.get("openai-organization"), project: headers.get("openai-project") };
  validateRoute(route); return route;
}

// The credential owner invokes fetch immediately after this preparation while
// still holding its mutation tail. No credential leaves that owner for a poll.
export async function prepareResponseControl(env: Env, input: ResponseControlDispatch, grant: UpstreamGrant | null): Promise<Request> {
  const provider = providerById(input.owner.providerId), create = provider?.endpoints.find(endpoint => endpoint.id === input.owner.endpointId);
  const id = responseIdentity("response", input.responseId);
  if (!provider || !create?.responsesLifecycle || !id || !["retrieve", "cancel"].includes(input.action)) unavailable();
  validateRoute(input.route);
  if (typeof input.query !== "string" || input.query.length > 8192) unavailable();
  const query = responsesControlQuery(input.action, new URLSearchParams(input.query));
  if (query.get("stream") === "true" && !input.stream) throw new HttpError(409, "response_resume_unavailable", "stream resumption requires an originally streamed response");
  if (Object.keys(input.route.pathParams).some(name => !create.path_params.includes(name))) unavailable();
  assertOperationConfiguration({ provider, endpoint: create, mode: "http", background: true }, grant, env);
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
  if (await responseRouteDigest(provider, upstream, urlFor(create, input.route.pathParams), headers, input.owner.grantKey) !== input.owner.routeSha256) unavailable();
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === create.responsesLifecycle![input.action])!;
  const url = urlFor(endpoint, { response_id: id.value });
  for (const [name, value] of query) url.searchParams.append(name, value);
  copyRequestHeaders(incoming, provider, endpoint, headers, env);
  applyTransportHeaders(headers, upstream.transport, grant);
  return new Request(url, { method: endpoint.method, headers, redirect: "manual" });
}

export async function dispatchResponseControl(env: Env, input: ResponseControlDispatch, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  if (input.owner.grantKey) {
    const stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(input.owner.grantKey));
    return stub.fetch("https://clawrouter.internal/responses/control", { method: "POST", body: JSON.stringify(input), signal });
  }
  const request = await prepareResponseControl(env, input, null);
  signal.throwIfAborted();
  return fetch(request, { signal });
}

function validateRoute(route: BackgroundAdmission["route"]): void {
  if (!route || !route.pathParams || typeof route.pathParams !== "object" || Array.isArray(route.pathParams)
    || Object.keys(route.pathParams).length > 16 || Object.values(route.pathParams).some(value => typeof value !== "string" || !value || new TextEncoder().encode(value).length > 1024)
    || [route.organization, route.project].some(value => value !== null && (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value)))) {
    throw new HttpError(400, "background_route_invalid", "background path and organization/project metadata exceed the supported scalar bounds");
  }
}
function unavailable(): never { throw new HttpError(409, "response_owner_unavailable", "the original response route is unavailable or changed"); }
