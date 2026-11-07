import { videoJsonBytes, type MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { isMiniMaxVideoOrigin } from "./minimax-video.ts";
import type { BackgroundRecord } from "./background-store.ts";
import { BodyLease } from "./body-budget.ts";
import { backgroundCall } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement } from "./input-retirement.ts";
import { managedJobKey } from "./managed-prediction-identity.ts";
import { managedRoute } from "./managed-routes.ts";
import type { ManagedFileAction, ManagedFileAdapter, ManagedFileDescriptor, ManagedFileState, ManagedObservation } from "./managed-lifecycle-types.ts";
import { applyProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import { assertProviderAccess } from "./providers.ts";
import { observeUsage } from "./proxy-response.ts";
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
    || !(provider.id === "minimax" ? isMiniMaxVideoOrigin(value) : Object.values(provider.base_urls).some(declared => { try { return new URL(declared).origin === base.origin; } catch { return false; } }))) unavailable();
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
    if (create.lifecycle?.protocol === "minimax.video" && adapter.publicControl) {
      if (!endpoint || prediction.terminal !== "succeeded" || prediction.observationUnavailable) unavailable();
      const control = adapter.publicControl(action, endpoint, file);
      if (!control.path.startsWith("/") || /[\\%?#\s]/.test(control.path) || control.path !== endpoint.path
        || control.query.size !== 1 || control.query.getAll("file_id").length !== 1 || control.query.get("file_id") !== file.id) unavailable();
      return `/v1/native/${provider.id}${control.path}?${control.query.toString()}`;
    }
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
  mode: "proxy_key" | "access", preauthenticated?: AuthorizedIdentity, session?: AccessSession, context?: ExecutionContext, video?: MiniMaxVideoOperation): Promise<Response> {
  if (matches.some(match => match.create.lifecycle?.protocol === "minimax.video") && (!video || !preauthenticated || mode !== "proxy_key")) unavailable();
  const identities = await responseControlIdentities(request, env, mode, preauthenticated, session);
  if (identities instanceof Response) return identities;
  const operation = video?.operation ?? new HttpOperation(request.signal, 30_000), deadline = video?.deadline ?? Date.now() + 30_000, lease = video ? undefined : new BodyLease();
  const fetching: Promise<void>[] = [], reading: Promise<void>[] = [];
  const inputs: ReturnType<typeof boundedFileResponse>[] = [];
  const unclaimed = new Set<Response>(), discarded = new WeakMap<Response, Promise<void>>();
  let delivery: Promise<void> | undefined;
  const discard = (response: Response): Promise<void> => {
    const existing = discarded.get(response); if (existing) return existing;
    const pending = (async () => {
      if (!response.body) return;
      if (response.body.locked || response.bodyUsed) throw new Error("managed file response is already owned");
      await inputRetirement(response.body.getReader()).retire("cancel", operation.signal.reason);
    })();
    discarded.set(response, pending); unclaimed.delete(response); void pending.catch(() => undefined); return pending;
  };
  const deliver = (response: Response): Response => {
    operation.stop("complete");
    const observed = observeUsage(response, new HttpOperation(request.signal));
    delivery = observed.retired; return observed.response;
  };
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
      provider.id, candidates.map(match => ({ createId: match.create.id, pathParams: match.pathParams })), undefined, video);
    if (!binding.background) unavailable();
    const match = candidates.find(candidate => candidate.create.id === binding.owner.endpointId)!;
    const { adapter } = managedFileRoute(provider, match.create), fileId = match.fileId;
    const job = await operation.wait(backgroundCall<BackgroundRecord | null>(env, binding.scope, { action: "get", id: binding.background.id }, video));
    const managed = job?.managed, file = managed?.files?.find(file => file.id === fileId);
    if (!job || !managed || managed.protocol !== protocol || managed.providerId !== provider.id || managed.upstreamId !== jobId
      || managed.policyGeneration !== binding.auth.policy.generation || managed.submission !== "bound" || managed.terminal !== "succeeded"
      || managed.observationUnavailable || !managed.route || !file || Date.now() >= job.replayUntil) unavailable();
    validateManagedFile(file);
    await operation.wait(assertProviderAccess(provider, binding.auth, env, undefined, undefined, video));
    // Reserve one bounded response allocation before either upstream read.
    if (lease && !lease.grow(managedFileLimit)) throw new HttpError(503, "server_overloaded", "file delivery capacity is busy; retry shortly");
    const input: ResponseControlDispatch = { owner: binding.owner, route: managed.route, responseId: jobId, action: "retrieve", query: "", stream: false,
      protocol, requestedVersion: managed.requestedVersion, deadline: Math.min(deadline, job.replayUntil), authorization: publicControlAuthorization(binding.auth) };
    const fetchFile = async (action: ManagedFileAction, state?: ManagedFileState) => {
      operation.signal.throwIfAborted();
      const pending = dispatchResponseControl(env, { ...input, file: { action, descriptor: file, state } }, operation.signal, undefined, video);
      const settled = pending.then(async response => {
        unclaimed.add(response);
        if (operation.signal.aborted) await (video ? video.discard(response) : discard(response));
      }, () => undefined);
      fetching.push(settled); void settled.catch(() => undefined);
      const response = await operation.wait(video ? video.track(pending) : pending, "upstream", late => { void (video ? video.discard(late) : discard(late)).catch(() => undefined); });
      if (video) {
        // The codec acquires and registers the ORIGINAL body before all header gates.
        unclaimed.delete(response); return response;
      }
      if (response.status !== 200 || response.redirected) throw new HttpError(502, "managed_file_unavailable", "original file delivery failed; do not resubmit generation");
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (action === "download" && ![file.mimeType, "application/octet-stream", "binary/octet-stream"].includes(mime ?? "")) {
        throw new HttpError(502, "managed_file_unavailable", "file content type does not match its original descriptor");
      }
      const bounded = boundedFileResponse(response, action === "metadata" ? 64 * 1024 : managedFileLimit, operation.signal);
      unclaimed.delete(response); inputs.push(bounded);
      return bounded.response;
    };
    const headers = { "cache-control": "no-store", "x-clawrouter-content-retention": "off", "x-clawrouter-upstream-provider": provider.id, "x-clawrouter-job-id": jobId };
    let state: ManagedFileState | undefined;
    if (adapter.mode !== "download_only") {
      const metadataResponse = await fetchFile("metadata");
      const pending = adapter.readState(metadataResponse, file, video ? { signal: operation.signal, registerInput: video.registerInput } : undefined);
      if (video) { video.track(pending); void pending.finally(() => video.discardUnclaimed(metadataResponse)).catch(() => undefined); }
      reading.push(pending.then(() => undefined, () => undefined));
      state = await operation.wait(pending, "upstream");
      if (state.id !== file.id || !["processing", "active", "failed"].includes(state.status) || JSON.stringify(state.body).length > 16 * 1024) unavailable();
      if (video) videoJsonBytes(state.body, "metadata");
      if (match.action === "metadata") return video ? video.publish(state.body, 200, { ...headers, "content-type": "application/json" }) : deliver(json(state.body, 200, headers));
      if (video && state.status !== "active") return video.publish({ error: { code: state.status === "processing" ? "managed_file_processing" : "managed_file_failed" } }, 409, { ...headers, "content-type": "application/json" });
      if (state.status !== "active") return errorResponse(state.status === "processing" ? "managed_file_processing" : "managed_file_failed",
        state.status === "processing" ? "file is still processing; retry this file request" : "file processing failed; generation settlement is unchanged", 409, undefined,
        { ...headers, ...(state.status === "processing" ? { "retry-after": "5" } : {}) });
    } else if (match.action !== "download") unavailable();
    const downloadResponse = await fetchFile("download", state);
    const pending = adapter.readFile(downloadResponse, file, managedFileLimit, video ? { signal: operation.signal, registerInput: video.registerInput } : undefined);
    if (video) { video.track(pending); void pending.finally(() => video.discardUnclaimed(downloadResponse)).catch(() => undefined); }
    reading.push(pending.then(() => undefined, () => undefined));
    const bytes = await operation.wait(pending, "upstream");
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > managedFileLimit) unavailable();
    if (video) return video.publishFile(bytes, { ...headers, "content-type": file.mimeType, "content-length": String(bytes.byteLength), "x-content-type-options": "nosniff" });
    let output: Uint8Array | undefined = bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (output) { const chunk = output; output = undefined; controller.enqueue(chunk); }
        else controller.close();
      }, cancel() { output = undefined; },
    }, { highWaterMark: 0 });
    return deliver(new Response(body, { headers: { ...headers, "content-type": file.mimeType, "content-length": String(bytes.byteLength), "x-content-type-options": "nosniff" } }));
  } catch (error) {
    operation.stop("upstream", error);
    throw error instanceof HttpError ? error : new HttpError(request.signal.aborted ? 499 : 502, "managed_file_unavailable", "original file delivery failed; retry file retrieval without resubmitting generation");
  } finally {
    if (video) {
      // The outer invocation owns retirement through unclaimed output/deadline.
      for (const response of unclaimed) video.track(video.discardUnclaimed(response));
    } else {
    operation.stop("complete");
    const retirement = (async () => {
      // Start source cancellation before joining adapter work: the adapter can
      // be waiting on that very reader. Each metadata/download owner survives.
      const retiring = inputs.map(input => input.retire(operation.signal.reason));
      const fetched = await Promise.allSettled(fetching);
      const disposed = await Promise.allSettled([...unclaimed].map(discard));
      await Promise.allSettled(reading);
      const retired = await Promise.allSettled(retiring);
      if ([...fetched, ...disposed, ...retired].some(result => result.status === "rejected")
        || inputs.some(input => input.response.body?.locked)) throw new Error("managed file input retirement failed");
      await delivery;
      lease!.release();
    })();
    if (context) context.waitUntil(retirement);
    else if (!delivery) await retirement;
    else void retirement.catch(() => undefined);
    }
  }
}

// Cancel the actual source reader even while a codec holds its outer reader.
// The common runtime enforces its envelope independently of a wrapper's parser.
function boundedFileResponse(response: Response, limit: number, signal: AbortSignal): { response: Response; retire(reason?: unknown): Promise<void> } {
  if (!response.body) unavailable();
  const reader = response.body.getReader(), input = inputRetirement(reader); let size = 0, done = false;
  let pulling: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { done = true; signal.removeEventListener("abort", abort); };
  const abort = () => { if (!done) { cleanup(); void input.retire("cancel", signal.reason).catch(() => undefined); controller.error(signal.reason); } };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    pull(value) { return pulling = (async () => {
      try {
        const chunk = await input.read(() => reader.read()); if (done) return;
        if (chunk.done) { cleanup(); await input.retire("eof"); value.close(); return; }
        size += chunk.value.byteLength;
        if (size > limit) throw new HttpError(502, "managed_file_too_large", "file delivery exceeds its bounded envelope");
        value.enqueue(chunk.value);
      } catch (error) { if (!done) { cleanup(); void input.retire("cancel", error).catch(() => undefined); value.error(error); } }
    })(); },
    cancel(reason) { cleanup(); return input.retire("cancel", reason); },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, headers: response.headers }),
    async retire(reason) {
      cleanup(); const retiring = input.retire("cancel", reason);
      await Promise.allSettled([pulling, retiring]); await retiring;
    } };
}

function unavailable(): never { throw new HttpError(409, "managed_file_owner_unavailable", "file delivery requires the original authorized job, descriptor and qualified route"); }
