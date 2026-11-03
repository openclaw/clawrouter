import type { BackgroundRecord } from "./background-store.ts";
import { BodyLease } from "./body-budget.ts";
import { backgroundCall } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { managedJobKey } from "./managed-prediction-identity.ts";
import { managedRoute } from "./managed-routes.ts";
import type { ManagedFileAction, ManagedFileAdapter, ManagedFileDescriptor, ManagedFileState, ManagedObservation } from "./managed-lifecycle-types.ts";
import { applyProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import { assertProviderAccess } from "./providers.ts";
import { publicControlAuthorization } from "./response-control-authorization.ts";
import { responseControlIdentities, resolveResponseControlOwner } from "./response-controls.ts";
import { dispatchResponseControl, type ResponseControlDispatch } from "./responses-control-dispatch.ts";
import type { AccessSession, AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { errorResponse, HttpError, json } from "./utils.ts";

export const managedFileLimit = 16 * 1024 * 1024;
export interface ManagedFileMatch { create: CompiledEndpoint; action: ManagedFileAction; endpoint: CompiledEndpoint; pathParams: Record<string, string> }

export function managedFileRoute(provider: CompiledProvider, create: CompiledEndpoint): {
  adapter: ManagedFileAdapter; endpoints: { metadata?: CompiledEndpoint; download: CompiledEndpoint };
} {
  const adapter = managedRoute(provider, create).adapter.files, links = create.lifecycle?.files;
  if (!adapter || adapter.protocol !== create.lifecycle?.protocol || !links
    || (links.mode ?? "metadata") !== (adapter.mode ?? "metadata")
    || !["metadata", "download_only"].includes(links.mode ?? "metadata")) unavailable();
  if (links.mode === "download_only" ? links.metadata !== undefined || adapter.readState !== undefined
    : links.metadata === links.download || typeof adapter.readState !== "function") unavailable();
  const endpoints = {} as Record<ManagedFileAction, CompiledEndpoint>;
  const actions: ManagedFileAction[] = links.mode === "download_only" ? ["download"] : ["metadata", "download"];
  for (const action of actions) {
    const endpoint = provider.endpoints.find(candidate => candidate.id === links[action]);
    if (!endpoint || !endpoint.native_proxy || endpoint.method !== "GET" || endpoint.methods.some(method => method !== "GET")
      || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || Object.keys(endpoint.headers).length
      || provider.capabilities.some(capability => capability.endpoint === endpoint.id)
      || [create.id, create.lifecycle?.retrieve, create.lifecycle?.result, create.lifecycle?.cancel].includes(endpoint.id)) unavailable();
    endpoints[action] = endpoint;
  }
  return { adapter, endpoints };
}

// First activation permits only a declared HTTPS provider origin. Custom proxy
// origins need their own qualified file contract; response URLs never add one.
export function managedFileBase(provider: CompiledProvider, value: string | undefined): string {
  if (!value || value.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[a-zA-Z0-9_/-]*)?$/.test(value)) unavailable();
  const base = new URL(value);
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(base.hostname) || /^[\d.]+$/.test(base.hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(base.hostname)
    || !Object.values(provider.base_urls).some(declared => { try { return new URL(declared).origin === base.origin; } catch { return false; } })) unavailable();
  return value.replace(/\/$/, "");
}

export function qualifyManagedFiles(provider: CompiledProvider, create: CompiledEndpoint, prediction: ManagedObservation, base: string | undefined): ManagedObservation {
  if (!create.lifecycle?.files) return prediction;
  const { adapter } = managedFileRoute(provider, create);
  // No file claim on pending/failed/lost jobs, even if a native payload has URIs.
  if (prediction.terminal !== "succeeded" || prediction.observationUnavailable) return { ...prediction, files: undefined };
  const files = adapter.describe(prediction, managedFileBase(provider, base));
  if (!Array.isArray(files) || files.length > 64) unavailable();
  for (const file of files) validateManagedFile(file);
  return { ...prediction, files };
}

export function validateManagedFile(file: ManagedFileDescriptor): void {
  if (!file || Object.keys(file).some(key => key !== "id" && key !== "mimeType")
    || typeof file.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(file.id)
    || typeof file.mimeType !== "string" || !/^(?:video|audio|image)\/[a-z0-9.+-]{1,64}$/.test(file.mimeType)) unavailable();
}

export function managedFilePublicBody(provider: CompiledProvider, create: CompiledEndpoint, prediction: ManagedObservation,
  body: Record<string, unknown>): Record<string, unknown> {
  if (!create.lifecycle?.files) return body;
  const { adapter, endpoints } = managedFileRoute(provider, create);
  const path = (action: ManagedFileAction, file: ManagedFileDescriptor) => {
    const endpoint = endpoints[action];
    // Public paths use schema templates, never a Host header or native URI.
    if (!endpoint || endpoint.path_params.length !== 1) unavailable();
    const route = endpoint.path.replace(`\${${endpoint.path_params[0]}}`, encodeURIComponent(file.id));
    if (!route.startsWith("/") || route.includes("${")) unavailable();
    const query = new URLSearchParams(endpoint.query).toString();
    return `/v1/native/${provider.id}${route}${query ? `?${query}` : ""}`;
  };
  return adapter.rewrite(body, (prediction.files ?? []).map(file => ({ id: file.id,
    ...(endpoints.metadata ? { metadata: path("metadata", file) } : {}), download: path("download", file) })));
}

export async function proxyManagedFile(request: Request, env: Env, provider: CompiledProvider, matches: ManagedFileMatch[], queryInput: ProxyQuery,
  mode: "proxy_key" | "access", preauthenticated?: AuthorizedIdentity, session?: AccessSession): Promise<Response> {
  const identities = await responseControlIdentities(request, env, mode, preauthenticated, session);
  if (identities instanceof Response) return identities;
  const operation = new HttpOperation(request.signal, 30_000), deadline = Date.now() + 30_000, lease = new BodyLease();
  let response: Response | undefined, handedOff = false;
  try {
    const query = new URLSearchParams(); applyProxyQuery(query, queryInput);
    // A broad /files/${id} template also matches /files/${id}:download.
    // Only the wrapper's exact native selector can distinguish these actions.
    const candidates = matches.flatMap(match => {
      const { adapter, endpoints } = managedFileRoute(provider, match.create);
      if (!endpoints[match.action]) return [];
      try { return [{ ...match, fileId: adapter.identify(match.action, match.pathParams, new URLSearchParams(query)) }]; }
      catch { return []; }
    });
    const first = candidates[0], protocol = first?.create.lifecycle?.protocol;
    if (!first) throw new HttpError(400, "managed_file_invalid", "provide the exact declared file path and query");
    if (!protocol || candidates.some(match => match.action !== first.action || match.create.lifecycle?.protocol !== protocol || match.fileId !== first.fileId)) unavailable();
    const nativeId = request.headers.get("x-clawrouter-job-id");
    // This selector is not authority. Resolve only the authenticated scope.
    const lifecycle = managedRoute(provider, first.create).adapter;
    let jobId: string;
    try { jobId = lifecycle.validateId(nativeId); } catch { unavailable(); }
    const binding = await resolveResponseControlOwner(env, identities, await managedJobKey(protocol, provider.id, jobId), operation,
      provider.id, candidates.map(match => ({ createId: match.create.id, pathParams: match.pathParams })));
    if (!binding.background) unavailable();
    const match = candidates.find(candidate => candidate.create.id === binding.owner.endpointId)!;
    const { adapter } = managedFileRoute(provider, match.create), fileId = match.fileId;
    const job = await operation.wait(backgroundCall<BackgroundRecord | null>(env, binding.scope, { action: "get", id: binding.background.id }));
    const managed = job?.managed, file = managed?.files?.find(file => file.id === fileId);
    if (!job || !managed || managed.protocol !== protocol || managed.providerId !== provider.id || managed.upstreamId !== jobId
      || managed.policyGeneration !== binding.auth.policy.generation || managed.submission !== "bound" || managed.terminal !== "succeeded"
      || managed.observationUnavailable || !managed.route || !file || Date.now() >= job.replayUntil) unavailable();
    validateManagedFile(file);
    await operation.wait(assertProviderAccess(provider, binding.auth, env));
    // Reserve one bounded response allocation before either upstream read.
    if (!lease.grow(managedFileLimit)) throw new HttpError(503, "server_overloaded", "file delivery capacity is busy; retry shortly");
    const input: ResponseControlDispatch = { owner: binding.owner, route: managed.route, responseId: jobId, action: "retrieve", query: "", stream: false,
      protocol, requestedVersion: managed.requestedVersion, deadline: Math.min(deadline, job.replayUntil), authorization: publicControlAuthorization(binding.auth) };
    const fetchFile = async (action: ManagedFileAction, state?: ManagedFileState) => {
      operation.signal.throwIfAborted();
      response = await operation.wait(dispatchResponseControl(env, { ...input, file: { action, descriptor: file, state } }, operation.signal), "upstream",
        late => { void late.body?.cancel().catch(() => undefined); });
      if (response.status !== 200 || response.redirected) throw new HttpError(502, "managed_file_unavailable", "original file delivery failed; do not resubmit generation");
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (action === "download" && ![file.mimeType, "application/octet-stream", "binary/octet-stream"].includes(mime ?? "")) {
        throw new HttpError(502, "managed_file_unavailable", "file content type does not match its original descriptor");
      }
      response = boundedFileResponse(response, action === "metadata" ? 64 * 1024 : managedFileLimit, operation.signal);
      return response;
    };
    const headers = { "cache-control": "no-store", "x-clawrouter-content-retention": "off", "x-clawrouter-upstream-provider": provider.id, "x-clawrouter-job-id": jobId };
    let state: ManagedFileState | undefined;
    if (adapter.mode !== "download_only") {
      state = await operation.wait(adapter.readState(await fetchFile("metadata"), file), "upstream");
      if (state.id !== file.id || !["processing", "active", "failed"].includes(state.status) || JSON.stringify(state.body).length > 16 * 1024) unavailable();
      if (match.action === "metadata") return json(state.body, 200, headers);
      if (state.status !== "active") return errorResponse(state.status === "processing" ? "managed_file_processing" : "managed_file_failed",
        state.status === "processing" ? "file is still processing; retry this file request" : "file processing failed; generation settlement is unchanged", 409, undefined,
        { ...headers, ...(state.status === "processing" ? { "retry-after": "5" } : {}) });
    } else if (match.action !== "download") unavailable();
    const bytes = await operation.wait(adapter.readFile(await fetchFile("download", state), file, managedFileLimit), "upstream");
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > managedFileLimit) unavailable();
    operation.stop("complete");
    let sent = false, closed = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const release = () => { closed = true; request.signal.removeEventListener("abort", canceled); lease.release(); };
    const canceled = () => { if (!closed) { release(); output.error(request.signal.reason); } };
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; request.signal.addEventListener("abort", canceled, { once: true }); if (request.signal.aborted) canceled(); },
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); }
        else { controller.close(); release(); }
      }, cancel() { release(); },
    });
    handedOff = true;
    return new Response(body, { headers: { ...headers, "content-type": file.mimeType, "content-length": String(bytes.byteLength), "x-content-type-options": "nosniff" } });
  } catch (error) {
    operation.stop("upstream", error);
    throw error instanceof HttpError ? error : new HttpError(request.signal.aborted ? 499 : 502, "managed_file_unavailable", "original file delivery failed; retry file retrieval without resubmitting generation");
  } finally {
    operation.stop("complete"); void response?.body?.cancel().catch(() => undefined);
    if (!handedOff) lease.release();
  }
}

// Cancel the actual source reader even while a codec holds its outer reader.
// The common runtime enforces its envelope independently of a wrapper's parser.
function boundedFileResponse(response: Response, limit: number, signal: AbortSignal): Response {
  if (!response.body) unavailable();
  const reader = response.body.getReader(); let size = 0, done = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { done = true; signal.removeEventListener("abort", abort); };
  const abort = () => { if (!done) { cleanup(); void reader.cancel(signal.reason).catch(() => undefined); controller.error(signal.reason); } };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(value) {
      try {
        const chunk = await reader.read(); if (done) return;
        if (chunk.done) { cleanup(); reader.releaseLock(); value.close(); return; }
        size += chunk.value.byteLength;
        if (size > limit) throw new HttpError(502, "managed_file_too_large", "file delivery exceeds its bounded envelope");
        value.enqueue(chunk.value);
      } catch (error) { if (!done) { cleanup(); void reader.cancel(error).catch(() => undefined); value.error(error); } }
    },
    cancel(reason) { cleanup(); return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

function unavailable(): never { throw new HttpError(409, "managed_file_owner_unavailable", "file delivery requires the original authorized job, descriptor and qualified route"); }
