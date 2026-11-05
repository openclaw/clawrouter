import { HttpOperation } from "./http-operation.ts";
import { inputRetirement } from "./input-retirement.ts";
import { HttpError, errorResponse, sha256Hex } from "./utils.ts";
import { copilotInferencePaths, copilotInferenceInput, type CopilotInferenceInput } from "./copilot-inference-dispatch.ts";
import { currentCopilotPublicIdentity, readCopilotPublicJson, type CopilotPublicIdentityAttestation } from "./copilot-public-identity.ts";
import type { CopilotCatalogInput } from "./copilot-catalog-flow.ts";
import { reserveCopilotInference, type CopilotInferenceAdmission } from "./copilot-inference-flow.ts";
import type { ResponseControlAuthorization } from "./response-control-authorization.ts";
import type { CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import type { CopilotWireFormat } from "./provider-copilot.ts";
import { assertCopilotControlHeaders } from "./copilot-inference-control.ts";
import { disposeCopilotInferenceResponse } from "./copilot-inference-response.ts";

const unavailable = () => new HttpError(409, "copilot_public_unavailable", "Original Copilot public operation unavailable");
const providerId = "github-copilot", windowBytes = 16 * 1024;
const capabilities: Readonly<Record<CopilotWireFormat, string>> = {
  "openai.chat_completions": "llm.chat", "openai.responses": "llm.responses", "anthropic.messages": "llm.messages",
};
export interface CopilotPublicRoute { mode: "native" | "manifest" | "catalog" | "models"; endpointId: string; path: string }
export interface CopilotPublicInput {
  id: string;
  key: string;
  expectedGeneration: number;
  expectedLineage: string;
  deadline: number;
  authorization: ResponseControlAuthorization;
  route: CopilotPublicRoute;
  registryDigest?: string;
}
export interface CopilotPublicSeed {
  selected: CopilotCatalogInput;
  attestation: CopilotPublicIdentityAttestation;
  route: CopilotPublicRoute;
  registryDigest?: string;
}

export function copilotPublicEndpoint(provider: CompiledProvider, endpoint: CompiledEndpoint): CopilotWireFormat {
  const format = endpoint.request_format as CopilotWireFormat;
  const offered = provider.capabilities.filter(row => row.endpoint === endpoint.id);
  if (provider.id !== providerId || !Object.hasOwn(capabilities, format) || endpoint.response_format !== format
    || endpoint.method !== "POST" || endpoint.methods.length !== 1 || endpoint.methods[0] !== "POST"
    || endpoint.path !== copilotInferencePaths[format] || endpoint.upstreamPath !== undefined
    || endpoint.auth || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough
    || endpoint.path_params.length || Object.keys(endpoint.query).length || Object.keys(endpoint.headers).length
    || offered.length !== 1 || offered[0].id !== capabilities[format]) throw unavailable();
  return format;
}

export async function copilotPublicInferenceInput(value: unknown, seed: CopilotPublicSeed, env: Env): Promise<CopilotInferenceInput> {
  if (seed.route.mode !== "native" && seed.route.mode !== "manifest") throw unavailable();
  const { providerById } = await import("./providers.ts");
  const { prepareNativeRequest, prepareManifestRequest, manifestEnvelope } = await import("./proxy-selection.ts");
  const provider = providerById(providerId), endpoint = provider?.endpoints.find(row => row.id === seed.route.endpointId);
  if (!provider || !endpoint) throw unavailable();
  const format = copilotPublicEndpoint(provider, endpoint);
  let prepared;
  if (seed.route.mode === "native") {
    if (!endpoint.native_proxy || seed.route.path !== `/v1/native/${providerId}${endpoint.path}`) throw unavailable();
    prepared = prepareNativeRequest(provider, endpoint, value, endpoint.path, env);
  } else {
    if (seed.route.path !== `/v1/proxy/${providerId}/${endpoint.id}` || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["method", "pathParams", "query", "body"].includes(key))) throw unavailable();
    const envelope = manifestEnvelope(value);
    if (envelope.method !== undefined && envelope.method !== "POST" || Object.keys(envelope.pathParams).length || Object.keys(envelope.query).length) throw unavailable();
    prepared = prepareManifestRequest(provider, endpoint, envelope.body, {}, env);
  }
  const model = prepared.model;
  if (!model || provider.models.filter(row => row.id === model.id && row.upstream === model.upstream).length !== 1
    || model.id !== `${providerId}/${model.upstream}` || Array.isArray(prepared.body)
    || prepared.body.stream === true && endpoint.streaming !== "sse") throw unavailable();
  const selected = { ...seed.selected, selection: { modelId: model.id, format } };
  const input = copilotInferenceInput({ ...selected, initiator: seed.attestation.profile.initiator, body: prepared.body }, selected.deadline);
  input.accountingSelection = { provider, endpoint, model, capability: capabilities[format], body: prepared.body,
    pathParams: {}, method: "POST" };
  return input;
}

// The frontend owns its ORIGINAL input and DO-returned response. Each relay has
// one original 16 KiB backing and one fresh output, HWM 0, no retained history.
// Never lend the source backing to a detachable output BYOB request.
export function copilotPublicRelay(body: ReadableStream<Uint8Array>, operation: HttpOperation, maximum: number, downstream = false) {
  if (body.locked) throw unavailable();
  let reader: ReadableStreamBYOBReader | undefined, window = new Uint8Array(windowBytes), total = 0, reads = 0;
  let eof = false, failed = false, pulling: Promise<void> | undefined;
  let output: ReadableByteStreamController | undefined;
  const owner = inputRetirement({
    async cancel(reason) { try { await (reader ? reader.cancel(reason) : body.cancel(reason)); } catch (error) { failed = true; throw error; } },
    releaseLock() { reader?.releaseLock(); if (body.locked) { failed = true; throw unavailable(); } },
  });
  const retire = (kind: "eof" | "cancel", reason?: unknown) => owner.retire(kind, reason);
  const abort = () => { try { output?.error(operation.signal.reason); } catch {} void retire("cancel", operation.signal.reason).catch(() => undefined); };
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  const retired = owner.retired.then(async () => {
    await pulling; if (failed) throw unavailable();
  }).finally(() => { operation.signal.removeEventListener("abort", abort); window = new Uint8Array(0); });
  void retired.catch(() => undefined);
  const stream = new ReadableStream<Uint8Array>({ type: "bytes", autoAllocateChunkSize: windowBytes,
    start(controller) { if (!("byobRequest" in controller)) throw unavailable(); output = controller; },
    pull(controller) {
      const work = (async () => {
        try {
          if (!("byobRequest" in controller)) throw unavailable();
          operation.signal.throwIfAborted();
          reader ??= body.getReader({ mode: "byob" });
          const offered = Math.min(windowBytes, controller.byobRequest?.view?.byteLength ?? windowBytes);
          let next: ReadableStreamReadResult<Uint8Array>;
          do {
            if (++reads > 8192) throw unavailable();
            next = await owner.read(() => reader!.read(window.subarray(0, offered)));
            operation.signal.throwIfAborted();
            if (next.value) {
              if (!(next.value.buffer instanceof ArrayBuffer) || next.value.buffer.byteLength > windowBytes
                || next.value.byteLength > maximum - total) throw unavailable();
              total += next.value.byteLength;
            }
            if (next.done) { eof = true; await retire("eof"); }
            else {
              if (!(next.value?.buffer instanceof ArrayBuffer) || !next.value.buffer.byteLength) throw unavailable();
              window = new Uint8Array(next.value.buffer);
            }
          } while (!eof && !next.value?.byteLength);
          if (next.value?.byteLength) {
            const request = controller.byobRequest;
            if (request?.view) {
              if (request.view.byteLength < next.value.byteLength) throw unavailable();
              new Uint8Array(request.view.buffer, request.view.byteOffset, next.value.byteLength).set(next.value);
              request.respond(next.value.byteLength);
            } else controller.enqueue(new Uint8Array(next.value));
          }
          if (eof) { controller.close(); controller.byobRequest?.respond(0); }
        } catch (error) {
          controller.error(error); await retire(eof ? "eof" : "cancel", error); throw error;
        }
      })();
      pulling = work; void work.catch(() => undefined); return work;
    },
    cancel(reason) {
      if (downstream) operation.stop("caller", reason);
      void retire("cancel", reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
  return { stream, retired, discard: (reason?: unknown) => retire(eof ? "eof" : "cancel", reason).then(() => retired) };
}

export interface CopilotPublicOwnerHooks {
  begin(pin: Readonly<{ key: string; expectedGeneration?: number }>, operation: HttpOperation): Promise<void>;
  prepare(input: CopilotPublicInput, operation: HttpOperation): Promise<CopilotPublicSeed>;
  execute(request: Request, seed: CopilotPublicSeed, admission: CopilotInferenceAdmission, frontendRetired: Promise<void>, completed: () => void): Promise<Response>;
  observe?(seed: CopilotPublicSeed, operation: HttpOperation): Promise<Uint8Array>;
  close(operation: HttpOperation): Promise<void>;
  retain(work: Promise<void>): void;
}

const headers = { id: "x-clawrouter-copilot-public-id", key: "x-clawrouter-copilot-public-key", deadline: "x-clawrouter-copilot-deadline" } as const;
function privateHeaders(source: Headers): { id: string; key: string; deadline: number } {
  assertCopilotControlHeaders(source);
  const id = source.get(headers.id), key = source.get(headers.key), raw = source.get(headers.deadline), deadline = Number(raw);
  if (!id || !/^[a-f0-9]{32}$/.test(id) || !key || key.length > 512 || !/^oauth\/(?:tenants\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(key)
    || !raw || !/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(deadline)) throw unavailable();
  return { id, key, deadline };
}
function readPublicInput(value: unknown, pin: ReturnType<typeof privateHeaders>, catalog: boolean): CopilotPublicInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== (catalog ? 8 : 7) || Object.keys(row).some(key => !["id", "key", "expectedGeneration", "expectedLineage", "deadline", "authorization", "route", ...(catalog ? ["registryDigest"] : [])].includes(key))
    || row.id !== pin.id || row.key !== pin.key || row.deadline !== pin.deadline
    || !Number.isSafeInteger(row.expectedGeneration) || (row.expectedGeneration as number) < 1
    || typeof row.expectedLineage !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(row.expectedLineage)) throw unavailable();
  const route = row.route as Record<string, unknown> | undefined;
  if (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).length !== 3
    || !(catalog ? ["catalog", "models"] : ["native", "manifest"]).includes(route.mode as string) || typeof route.endpointId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(route.endpointId)
    || typeof route.path !== "string" || route.path.length > 512) throw unavailable();
  if (catalog && (typeof row.registryDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.registryDigest)
    || route.endpointId !== route.mode || route.path !== `/v1/${route.mode}`)) throw unavailable();
  return row as unknown as CopilotPublicInput;
}
type PublicState = {
  id: string; key: string; deadline: number; admission: CopilotInferenceAdmission; operation: HttpOperation;
  catalog: boolean;
  seed?: CopilotPublicSeed; closed: boolean; started: boolean; frontendAcknowledged: boolean;
  reservePhysical: Promise<void>; frontendRetired: Promise<void>; retireFrontend(): void;
  retired: Promise<void>; settleRetired(): void; finishing?: Promise<void>; producers: Promise<void>[];
};

// One owner-instance continuation, not a token or module-global permit. No
// request-context I/O is suspended across reserve/execute: execution starts its
// own physical HTTP continuation after consuming this admission once.
export class CopilotPublicOwner {
  private active?: PublicState;
  private readonly hooks: CopilotPublicOwnerHooks;
  constructor(hooks: CopilotPublicOwnerHooks) { this.hooks = hooks; }

  invalidate(): void {
    const active = this.active;
    if (!active) return;
    active.closed = true; active.operation.stop("caller");
    this.hooks.retain(this.finish(active));
  }

  async fetch(request: Request): Promise<Response> {
    let pin: ReturnType<typeof privateHeaders>;
    try { pin = privateHeaders(request.headers); }
    catch { return errorResponse("copilot_public_unavailable", "Original Copilot public operation unavailable", 409); }
    const phase = new URL(request.url).pathname;
    if (phase === "/copilot-public/reserve" || phase === "/copilot-public/catalog-reserve") return this.reserve(request, pin, phase.endsWith("catalog-reserve"));
    const active = this.active;
    if (!active || active.id !== pin.id || active.key !== pin.key || active.deadline !== pin.deadline) return errorResponse("copilot_public_unavailable", "Original Copilot public operation unavailable", 409);
    if (phase === "/copilot-public/retire" && request.body === null) {
      if (active.frontendAcknowledged) return Response.json({ retired: true }, { headers: { "cache-control": "private, no-store" } });
      // Register this producer BEFORE publishing frontend retirement. Its EOF
      // never waits for the allocation that joins it.
      const response = this.reply({ retired: true }, 200, active);
      active.closed = true; active.frontendAcknowledged = true; active.retireFrontend();
      if (!active.started) active.operation.stop("caller");
      this.hooks.retain(this.finish(active));
      return response;
    }
    if (phase === "/copilot-public/observe" && active.catalog && request.body === null && !active.closed && !active.started
      && active.seed && !active.operation.signal.aborted && Date.now() < active.deadline && this.hooks.observe) {
      active.started = true; active.operation.stop("complete");
      active.operation = new HttpOperation(request.signal, active.deadline - Date.now());
      const work = this.hooks.observe(active.seed, active.operation);
      active.reservePhysical = Promise.allSettled([active.reservePhysical, work]).then(() => undefined);
      this.hooks.retain(active.reservePhysical);
      try { return this.binaryReply(await active.operation.wait(work, "upstream"), active); }
      catch (error) {
        active.closed = true; active.operation.stop("upstream", error);
        this.hooks.retain(this.finish(active));
        return this.reply({ error: { code: "copilot_public_unavailable" } }, 409, active);
      }
    }
    if (phase !== "/copilot-public/execute" || active.catalog || active.closed || active.started || !active.seed
      || active.operation.signal.aborted || Date.now() >= active.deadline) return errorResponse("copilot_public_unavailable", "Original Copilot public operation unavailable", 409);
    active.started = true; active.operation.stop("complete");
    return this.hooks.execute(request, active.seed, active.admission, active.retired, () => {
      if (this.active === active) this.active = undefined;
    });
  }

  private async reserve(request: Request, pin: ReturnType<typeof privateHeaders>, catalog: boolean): Promise<Response> {
    if (this.active || pin.deadline <= Date.now() || pin.deadline - Date.now() > 120_000) return errorResponse("copilot_public_unavailable", "Original Copilot public operation unavailable", 409);
    let admission: CopilotInferenceAdmission;
    try { admission = reserveCopilotInference(); }
    catch { return errorResponse("body_capacity_exhausted", "Request capacity unavailable", 503); }
    let retireFrontend!: () => void, settleRetired!: () => void;
    const active: PublicState = { ...pin, admission, catalog, operation: new HttpOperation(request.signal, pin.deadline - Date.now()),
      closed: false, started: false, frontendAcknowledged: false, reservePhysical: Promise.resolve(), producers: [],
      frontendRetired: new Promise(resolve => { retireFrontend = resolve; }), retireFrontend: () => retireFrontend(),
      retired: new Promise(resolve => { settleRetired = resolve; }), settleRetired: () => settleRetired() };
    this.active = active;
    const work = (async () => {
      try {
        await this.hooks.begin(pin, active.operation);
        const input = readPublicInput(await readCopilotPublicJson(request, active.operation.signal), pin, catalog);
        active.seed = await this.hooks.prepare(input, active.operation);
        active.operation.signal.throwIfAborted(); if (active.closed) throw unavailable();
      } catch (error) {
        if (!request.bodyUsed && request.body && !request.body.locked) await disposeCopilotInferenceResponse(request, error);
        throw error;
      }
    })();
    active.reservePhysical = work.then(() => undefined, () => undefined);
    this.hooks.retain(active.reservePhysical);
    try {
      await active.operation.wait(work, "upstream");
      return this.reply({ id: active.id, revision: active.seed!.attestation.revision }, 200, active);
    } catch (error) {
      active.closed = true; active.operation.stop("upstream", error);
      this.hooks.retain(this.finish(active));
      return this.reply({ error: { code: error instanceof HttpError ? error.code : "copilot_public_unavailable" } }, error instanceof HttpError ? error.status : 503, active);
    }
  }

  private finish(active: PublicState): Promise<void> {
    return active.finishing ??= (async () => {
      // Frontend ACK is only its OWN original-reader/returned-body retirement;
      // it does not attest the upstream producer behind DO transport.
      await active.reservePhysical;
      await active.frontendRetired;
      await Promise.allSettled(active.producers);
      active.settleRetired();
      if (!active.started || active.catalog) {
        await this.hooks.close(active.operation);
        active.admission.discard();
        if (this.active === active) this.active = undefined;
      }
    })();
  }

  private reply(value: unknown, status: number, active: PublicState): Response {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > 2048) throw unavailable();
    return this.binaryReply(bytes, active, status, "application/json");
  }

  private binaryReply(bytes: Uint8Array, active: PublicState, status = 200, mime = "application/octet-stream"): Response {
    if (active.producers.length >= 3 || bytes.byteLength > 2048 || bytes.buffer.byteLength > 2048) throw unavailable();
    let done!: () => void, sent = false;
    active.producers.push(new Promise(resolve => { done = resolve; }));
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes); } else { controller.close(); done(); } },
      cancel() { done(); },
    }, { highWaterMark: 0 }), { status, headers: { "content-type": mime, "content-length": String(bytes.byteLength), "cache-control": "private, no-store" } });
  }
}

export async function proxyCopilotPublic(request: Request, env: Env, context: ExecutionContext,
  provider: CompiledProvider, endpoint: CompiledEndpoint, mode: "native" | "manifest"): Promise<Response> {
  const deadline = Date.now() + Math.min(endpoint.timeout_ms ?? 120_000, 120_000);
  const operation = new HttpOperation(request.signal, deadline - Date.now());
  let input: ReturnType<typeof copilotPublicRelay> | undefined, output: ReturnType<typeof copilotPublicRelay> | undefined;
  let stub: DurableObjectStub | undefined, pin: ReturnType<typeof privateHeaders> | undefined, reserved = false;
  let reserveResponse: Response | undefined, inferenceResponse: Response | undefined;
  let published!: () => void;
  const producer = new Promise<void>(resolve => { published = resolve; });
  const work = (async () => {
    assertCopilotControlHeaders(request.headers);
    copilotPublicEndpoint(provider, endpoint);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.search || !request.body || request.bodyUsed || request.body.locked
      || (mode === "native" ? !endpoint.native_proxy || url.pathname !== `/v1/native/${providerId}${endpoint.path}`
        : url.pathname !== `/v1/proxy/${providerId}/${endpoint.id}`)) throw unavailable();
    const { authenticateProxyKey, proxySessionHash } = await import("./proxy-auth.ts");
    const { publicControlAuthorization } = await import("./response-control-authorization.ts");
    const { selectCopilotPublicGrant } = await import("./grant-selection.ts");
    const tokenRef = provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? providerId;
    const auth = await authenticateProxyKey(request.headers, env, [{ id: providerId, tokenRef }], false, undefined, undefined, "authoritative");
    if (auth instanceof Response) {
      await auth.body?.cancel(); throw new HttpError(auth.status, "copilot_public_unauthorized", "Current proxy credential required");
    }
    if (auth.policy.providers.length && !auth.policy.providers.includes(providerId)) throw new HttpError(403, "provider_not_allowed", "Provider is not allowed");
    operation.signal.throwIfAborted();
    const authorization = publicControlAuthorization(auth);
    const selected = await selectCopilotPublicGrant(auth.policyId, auth.policy, env, tokenRef, proxySessionHash(auth) ?? null);
    operation.signal.throwIfAborted();
    pin = { id: crypto.randomUUID().replaceAll("-", ""), key: selected.key, deadline };
    const value: CopilotPublicInput = { ...pin, expectedGeneration: selected.grant.credentialGeneration!, expectedLineage: selected.grant.credentialLineage!,
      authorization, route: { mode, endpointId: endpoint.id, path: url.pathname } };
    const metadata = JSON.stringify(value);
    if (metadata.length > 8192 || new TextEncoder().encode(metadata).byteLength > 8192) throw unavailable();
    stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(selected.key));
    const privateInit = { [headers.id]: pin.id, [headers.key]: pin.key, [headers.deadline]: String(deadline) };
    // A lost reserve reply still owns a possible reservation. Its exact id is
    // retired after the ORIGINAL frontend body and late Response have settled.
    reserved = true;
    reserveResponse = await stub.fetch("https://clawrouter.internal/copilot-public/reserve", { method: "POST", signal: operation.signal,
      headers: { ...privateInit, "content-type": "application/json" }, body: metadata });
    const receipt = await readCopilotPublicJson(reserveResponse, operation.signal) as { id?: unknown; revision?: unknown };
    if (reserveResponse.status !== 200 || reserveResponse.redirected || !receipt || Object.keys(receipt).length !== 2
      || receipt.id !== pin.id || typeof receipt.revision !== "string") throw unavailable();
    const identity = await currentCopilotPublicIdentity(env, authorization, operation.signal);
    if (identity.attestation.revision !== receipt.revision) throw unavailable();
    operation.signal.throwIfAborted();
    // No original reader, parser or transport body exists before this ACK.
    input = copilotPublicRelay(request.body!, operation, 256 * 1024);
    const transportHeaders = new Headers({ ...privateInit, "content-type": request.headers.get("content-type") ?? "" });
    const { correlationMetadata } = await import("./correlation.ts");
    transportHeaders.set("x-request-id", correlationMetadata(request).requestId);
    for (const name of ["content-length", "content-encoding", "content-range"]) {
      const value = request.headers.get(name); if (value !== null) transportHeaders.set(name, value);
    }
    inferenceResponse = await stub.fetch("https://clawrouter.internal/copilot-public/execute", {
      method: "POST", headers: transportHeaders, body: input.stream, signal: operation.signal,
    });
    operation.signal.throwIfAborted();
    await currentCopilotPublicIdentity(env, authorization, operation.signal, identity.attestation);
    if (!inferenceResponse.body || inferenceResponse.redirected) throw unavailable();
    output = copilotPublicRelay(inferenceResponse.body, operation, 32 * 1024 * 1024, true);
    const responseHeaders = new Headers({ "content-type": inferenceResponse.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" });
    const length = inferenceResponse.headers.get("content-length");
    if (length !== null) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 32 * 1024 * 1024) throw unavailable();
      responseHeaders.set("content-length", length);
    }
    const response = new Response(output.stream, { status: inferenceResponse.status, headers: responseHeaders });
    // Only the response actually returned owns publication. Header rejection
    // instead retains the separate public error producer through its EOF.
    void output.retired.then(published, published);
    return response;
  })();
  // Register the ACTUAL fetch/read continuation before prompt cancellation.
  const discard = work.then(async () => {
    if (operation.signal.aborted) await output?.discard(operation.signal.reason);
  }, async error => { await output?.discard(error); });
  const retired = Promise.allSettled([discard]).then(async initial => {
    const cleanup: Promise<unknown>[] = [];
    if (input) cleanup.push(input.discard(operation.signal.reason));
    else if (request.body && !request.bodyUsed && !request.body.locked) cleanup.push(disposeCopilotInferenceResponse(request, operation.signal.reason));
    if (output) cleanup.push(output.retired);
    else if (inferenceResponse?.body && !inferenceResponse.bodyUsed && !inferenceResponse.body.locked) cleanup.push(disposeCopilotInferenceResponse(inferenceResponse, operation.signal.reason));
    if (reserveResponse?.body && !reserveResponse.bodyUsed && !reserveResponse.body.locked) cleanup.push(disposeCopilotInferenceResponse(reserveResponse, operation.signal.reason));
    const results = await Promise.allSettled(cleanup);
    await producer;
    if (request.body?.locked || inferenceResponse?.body?.locked || reserveResponse?.body?.locked) throw new Error("copilot_public_input_not_retired");
    if (reserved && stub && pin) {
      // Cleanup is allowed after caller expiry. It consumes only the original
      // opaque continuation and cannot qualify, execute or replace an owner.
      const response = await stub.fetch("https://clawrouter.internal/copilot-public/retire", { method: "POST",
        headers: { [headers.id]: pin.id, [headers.key]: pin.key, [headers.deadline]: String(pin.deadline) } });
      const receipt = await readCopilotPublicJson(response, new AbortController().signal);
      if (response.status !== 200 && response.status !== 409) throw unavailable();
      if (response.status === 200 && (!receipt || typeof receipt !== "object" || (receipt as { retired?: unknown }).retired !== true)) throw unavailable();
    }
    operation.stop("complete");
    // Cleanup failure is not cleanup still running. Report it only after all
    // owned sources unlock and the original continuation receives retirement.
    const failed = [...initial, ...results].find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  context.waitUntil(retired); void retired.catch(() => undefined);
  try { return await operation.wait(work, "upstream"); }
  catch (error) {
    operation.stop("upstream", error);
    const bytes = new TextEncoder().encode(JSON.stringify({ error: { code: error instanceof HttpError ? error.code : "copilot_public_unavailable", message: "Copilot public operation unavailable" } }));
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes); } else { controller.close(); published(); } },
      cancel() { published(); },
    }, { highWaterMark: 0 }), { status: error instanceof HttpError ? error.status : operation.status === "timeout" ? 504 : 503,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  }
}


const wireFormats: readonly CopilotWireFormat[] = ["openai.chat_completions", "openai.responses", "anthropic.messages"];
const compactHeader = 75;
export interface CopilotPublicRegistry {
  provider: CompiledProvider;
  endpoints: readonly CompiledEndpoint[];
  digest: string;
}

// Closed records only. Count UTF-8 without first allocating an encoded copy.
// Each encoded record and each emitted backing is at most 16 KiB.
function boundedUtf8(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > 16 * 1024) throw unavailable();
  }
  return bytes;
}
export function copilotPublicRecord(value: unknown): string {
  let nodes = 0, members = 0, units = 0, wire = 0, serializedUnits = 0;
  const add = (bytes: number, characters = bytes) => {
    wire += bytes; serializedUnits += characters;
    if (wire > 16 * 1024 || serializedUnits > 8192) throw unavailable();
  };
  const quoted = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code < 32) add(6);
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4, 2); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(code < 128 ? 1 : code < 2048 ? 2 : 3, 1);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 2048 || depth > 16) throw unavailable();
    if (typeof item === "string") { units += item.length; if (item.length > 4096 || units > 8192) throw unavailable(); quoted(item); return; }
    if (item === null) { add(4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number" && Number.isFinite(item)) { add(String(item).length); return; }
    if (Array.isArray(item)) {
      if (item.length > 128) throw unavailable(); add(2 + Math.max(0, item.length - 1));
      for (const child of item) visit(child, depth + 1); return;
    }
    if (!item || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw unavailable();
    add(2); let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key) || (item as Record<string, unknown>)[key] === undefined) continue;
      if (++members > 1024 || key.length > 128) throw unavailable();
      units += key.length; if (units > 8192) throw unavailable();
      quoted(key); add(count++ ? 2 : 1); visit((item as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0); // Bound BOTH representations before stringify/UTF-8 encoding.
  const text = JSON.stringify(value);
  if (text.length !== serializedUnits || boundedUtf8(text) !== wire) throw unavailable();
  return text;
}

export async function copilotPublicRegistry(provider: CompiledProvider): Promise<CopilotPublicRegistry> {
  if (provider.id !== providerId || provider.models.length > 4096 || provider.endpoints.length !== 3) throw unavailable();
  const endpoints = wireFormats.map(format => {
    const matches = provider.endpoints.filter(endpoint => endpoint.request_format === format);
    if (matches.length !== 1) throw unavailable(); copilotPublicEndpoint(provider, matches[0]); return matches[0];
  });
  // Include ALL compiled identity, including prices and routing metadata. The
  // ordered hash chain has one bounded record/string/encoding at a time.
  const { models, ...identity } = provider;
  let digest = await sha256Hex(copilotPublicRecord({ version: 1, identity }));
  const seen = new Set<string>();
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    if (typeof model.upstream !== "string" || !model.upstream || model.upstream.length > 512
      || model.upstream.trim() !== model.upstream || model.id !== providerId + "/" + model.upstream
      || model.id.length > 512 + providerId.length + 1 || seen.has(model.id)
      || model.capabilities.length > 3 || model.capabilities.some(value => !Object.values(capabilities).includes(value))) throw unavailable();
    seen.add(model.id);
    digest = await sha256Hex(copilotPublicRecord({ previous: digest, index, model }));
  }
  seen.clear();
  return { provider, endpoints, digest };
}
function fromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16)); }
function toHex(value: Uint8Array): string { let result = ""; for (const byte of value) result += byte.toString(16).padStart(2, "0"); return result; }
export function copilotPublicObservation(registry: CopilotPublicRegistry, seed: CopilotPublicSeed,
  rows: readonly import("./provider-copilot-catalog.ts").CopilotModelRow[], policy: import("./types.ts").AccessPolicy,
  connection: import("./types.ts").ProviderConnection, now: number,
  operationAffordability: typeof import("./operation-budget.ts").operationAffordability): Uint8Array {
  const packet = new Uint8Array(compactHeader + Math.ceil(registry.provider.models.length * 3 / 8)), view = new DataView(packet.buffer);
  packet[0] = 1; view.setUint16(1, registry.provider.models.length); packet.set(fromHex(registry.digest), 3);
  packet.set(fromHex(seed.attestation.revision.replaceAll("-", "")), 35); view.setBigUint64(51, BigInt(now));
  packet.set(fromHex(crypto.randomUUID().replaceAll("-", "")), 59);
  if (seed.selected.authorization.kind !== "public") throw unavailable();
  const binding = seed.selected.authorization.binding;
  const auth: import("./types.ts").AuthorizedIdentity = { authType: "proxy_key", credentialId: binding.credentialId, principalId: binding.principalId,
    policyId: binding.policyId, policy, contentRetentionDisabled: true };
  const models = new Map(rows.map(row => [row.id, row]));
  for (let index = 0; index < registry.provider.models.length; index++) {
    const model = registry.provider.models[index], row = models.get(model.upstream);
    if (!row || row.policy?.state !== "enabled" || row.model_picker_enabled !== true) continue;
    for (let api = 0; api < 3; api++) {
      const bit = index * 3 + api;
      if (connection.enabled && qualifiedPublicModel(registry, model, api, policy) && advertisedPublicFormat(row, wireFormats[api])
        && operationAffordability(auth, connection, model, capabilities[wireFormats[api]], registry.endpoints[api], undefined, {}, providerId).status !== "exact-blocked")
        packet[compactHeader + (bit >> 3)] |= 1 << (bit & 7);
    }
  }
  models.clear(); return packet;
}
import { copilotModelFormats as advertisedFormats } from "./provider-copilot.ts";
import { modelSupportsEndpoint } from "../shared/route-catalog.ts";
import { policyAllowsModel } from "./policy-models.ts";
function advertisedPublicFormat(row: import("./provider-copilot-catalog.ts").CopilotModelRow, format: CopilotWireFormat): boolean { return advertisedFormats(row).includes(format); }
export function qualifiedPublicModel(registry: CopilotPublicRegistry, model: import("./types.ts").CompiledModel, api: number, policy: import("./types.ts").AccessPolicy): boolean {
  return policy.enabled && (!policy.providers.length || policy.providers.includes(providerId))
    && policyAllowsModel(policy, providerId, model.id) && modelSupportsEndpoint(registry.provider, model, registry.endpoints[api]);
}
export function decodeCopilotPublicObservation(packet: Uint8Array, registry: CopilotPublicRegistry, revision: string, deadline: number) {
  if (packet.byteLength < compactHeader || packet.byteLength > 2048 || packet.buffer.byteLength > 2048) throw unavailable();
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength), count = view.getUint16(1), observedAt = Number(view.getBigUint64(51));
  if (packet[0] !== 1 || count !== registry.provider.models.length || packet.byteLength !== compactHeader + Math.ceil(count * 3 / 8)
    || toHex(packet.subarray(3, 35)) !== registry.digest || toHex(packet.subarray(35, 51)) !== revision.replaceAll("-", "")
    || !Number.isSafeInteger(observedAt) || observedAt > deadline || Date.now() >= deadline) throw unavailable();
  return { observedAt, permits(index: number, api: number) {
    const bit = index * 3 + api; return index >= 0 && index < count && api >= 0 && api < 3 && !!(packet[compactHeader + (bit >> 3)] & (1 << (bit & 7)));
  } };
}

async function readPublicPacket(response: Response, operation: HttpOperation): Promise<Uint8Array> {
  if (!response.body || response.bodyUsed || response.body.locked) throw unavailable();
  const relay = copilotPublicRelay(response.body, operation, 2048);
  let reader: ReadableStreamBYOBReader | undefined, window = new Uint8Array(windowBytes), length = 0;
  const packet = new Uint8Array(2048);
  try {
    if (response.status !== 200 || response.redirected || response.headers.get("content-type") !== "application/octet-stream"
      || response.headers.has("content-encoding") || response.headers.has("content-range")) throw unavailable();
    reader = relay.stream.getReader({ mode: "byob" });
    for (;;) {
      const next = await reader.read(window);
      if (next.value) { packet.set(next.value, length); length += next.value.byteLength; }
      if (next.done) break;
      window = new Uint8Array(next.value.buffer);
    }
    if (response.headers.get("content-length") !== String(length)) throw unavailable();
    await relay.retired; operation.signal.throwIfAborted(); return packet.subarray(0, length);
  } finally {
    await reader?.cancel().catch(() => undefined); reader?.releaseLock(); await relay.discard().catch(() => undefined);
    window = new Uint8Array(0);
  }
}

export interface CopilotPublicDiscoveryView {
  registry: CopilotPublicRegistry;
  observation: ReturnType<typeof decodeCopilotPublicObservation>;
  auth: import("./types.ts").AuthorizedIdentity;
  policy: import("./types.ts").AccessPolicy;
  connection: import("./types.ts").ProviderConnection;
}

// The renderer yields closed <=16 KiB records, not one retained output graph.
// The EXACT counting pass completes before headers and the first public byte.
export async function proxyCopilotDiscovery(request: Request, env: Env, context: ExecutionContext,
  render: (view: CopilotPublicDiscoveryView) => Iterable<string>): Promise<Response> {
  const deadline = Date.now() + 30_000, operation = new HttpOperation(request.signal, 30_000);
  let stub: DurableObjectStub | undefined, pin: ReturnType<typeof privateHeaders> | undefined, reserved = false;
  const responses: Response[] = [];
  let end!: () => void;
  const producer = new Promise<void>(resolve => { end = resolve; });
  let iterator: Iterator<string> | undefined, controller: ReadableByteStreamController | undefined;
  const work = (async () => {
    assertCopilotControlHeaders(request.headers);
    const url = new URL(request.url);
    if (request.method !== "GET" || request.body !== null || !["/v1/catalog", "/v1/models"].includes(url.pathname)
      || [...url.searchParams].length !== 1 || url.searchParams.get("provider") !== providerId) throw unavailable();
    const { providerById } = await import("./providers.ts"), provider = providerById(providerId);
    if (!provider) throw unavailable();
    const { authenticateProxyKey, proxySessionHash } = await import("./proxy-auth.ts");
    const { publicControlAuthorization } = await import("./response-control-authorization.ts");
    const { selectCopilotPublicGrant } = await import("./grant-selection.ts");
    const { resolveConnection } = await import("./authority.ts");
    const tokenRef = provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? providerId;
    const auth = await authenticateProxyKey(request.headers, env, [{ id: providerId, tokenRef }], false, undefined, undefined, "authoritative");
    if (auth instanceof Response) { await auth.body?.cancel(); throw new HttpError(403, "copilot_public_unauthorized", "Current proxy credential required"); }
    const selected = await selectCopilotPublicGrant(auth.policyId, auth.policy, env, tokenRef, proxySessionHash(auth) ?? null);
    const registry = await copilotPublicRegistry(provider);
    operation.signal.throwIfAborted();
    pin = { id: crypto.randomUUID().replaceAll("-", ""), key: selected.key, deadline };
    stub = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(selected.key));
    const privateInit = { [headers.id]: pin.id, [headers.key]: pin.key, [headers.deadline]: String(deadline) };
    const authorization = publicControlAuthorization(auth), mode = url.pathname === "/v1/catalog" ? "catalog" : "models";
    const value: CopilotPublicInput = { ...pin, expectedGeneration: selected.grant.credentialGeneration!, expectedLineage: selected.grant.credentialLineage!,
      authorization, route: { mode, endpointId: mode, path: url.pathname }, registryDigest: registry.digest };
    const metadata = copilotPublicRecord(value); if (boundedUtf8(metadata) > 8192) throw unavailable();
    reserved = true;
    const reserve = await stub.fetch("https://clawrouter.internal/copilot-public/catalog-reserve", { method: "POST", signal: operation.signal,
      headers: { ...privateInit, "content-type": "application/json" }, body: metadata }); responses.push(reserve);
    const receipt = await readCopilotPublicJson(reserve, operation.signal) as { id?: unknown; revision?: unknown };
    if (reserve.status !== 200 || reserve.redirected || !receipt || Object.keys(receipt).length !== 2 || receipt.id !== pin.id || typeof receipt.revision !== "string") throw unavailable();
    const connection = await resolveConnection(env, providerId) ?? { providerId, enabled: true };
    if (!connection.enabled) throw unavailable();
    const identity = await currentCopilotPublicIdentity(env, authorization, operation.signal);
    if (identity.attestation.revision !== receipt.revision) throw unavailable();
    operation.signal.throwIfAborted();
    const response = await stub.fetch("https://clawrouter.internal/copilot-public/observe", { method: "POST", headers: privateInit, signal: operation.signal }); responses.push(response);
    const packet = await readPublicPacket(response, operation);
    // The owner's observation can wait in transport. Recheck the ORIGINAL
    // caller/profile after that physical reader retires, before public output.
    const current = await currentCopilotPublicIdentity(env, authorization, operation.signal, identity.attestation);
    const observation = decodeCopilotPublicObservation(packet, registry, receipt.revision, deadline);
    const view = { registry, observation, auth, policy: current.policy, connection };
    let total = 0, pieces = 0;
    for (const piece of render(view)) {
      if (++pieces > 65536 || (total += boundedUtf8(piece)) > 4 * 1024 * 1024) throw unavailable();
    }
    // No asynchronous work between this final frontend authority check,
    // bounded local decoding/counting and publication. This is fresh-at-check.
    operation.signal.throwIfAborted(); if (Date.now() >= deadline) throw unavailable();
    iterator = render(view)[Symbol.iterator](); let sent = 0;
    const abort = () => { try { controller?.error(operation.signal.reason); } catch {} iterator?.return?.(); iterator = undefined; end(); };
    operation.signal.addEventListener("abort", abort, { once: true });
    const finish = () => { operation.signal.removeEventListener("abort", abort); iterator?.return?.(); iterator = undefined; controller = undefined; end(); };
    return new Response(new ReadableStream<Uint8Array>({ type: "bytes",
      start(output) { if (!("byobRequest" in output)) throw unavailable(); controller = output; },
      pull(output) {
        try {
          if (!("byobRequest" in output)) throw unavailable();
          operation.signal.throwIfAborted();
          const next = iterator!.next();
          if (next.done) { if (sent !== total) throw unavailable(); output.close(); output.byobRequest?.respond(0); finish(); return; }
          const bytes = new TextEncoder().encode(next.value); if (bytes.buffer.byteLength > windowBytes || (sent += bytes.byteLength) > total) throw unavailable();
          if (bytes.byteLength) output.enqueue(bytes);
        } catch (error) { operation.stop("publication", error); finish(); output.error(error); }
      },
      cancel(reason) { operation.stop("caller", reason); finish(); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", "content-length": String(total), "cache-control": "private, no-store" } });
  })();
  const physical = work.then(() => undefined, () => undefined).then(async () => {
    const cleanup = await Promise.allSettled(responses.map(response => !response.bodyUsed && response.body && !response.body.locked
      ? disposeCopilotInferenceResponse(response, operation.signal.reason) : Promise.resolve()));
    await producer;
    if (responses.some(response => response.body?.locked)) throw new Error("copilot_discovery_input_not_retired");
    iterator?.return?.(); iterator = undefined; controller = undefined; responses.length = 0;
    if (reserved && stub && pin) {
      const response = await stub.fetch("https://clawrouter.internal/copilot-public/retire", { method: "POST",
        headers: { [headers.id]: pin.id, [headers.key]: pin.key, [headers.deadline]: String(deadline) } });
      const result = await readCopilotPublicJson(response, new AbortController().signal);
      if (response.status !== 409 && (response.status !== 200 || (result as { retired?: unknown })?.retired !== true)) throw unavailable();
    }
    operation.stop("complete");
    const failed = cleanup.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  context.waitUntil(physical); void physical.catch(() => undefined);
  try { return await operation.wait(work, "upstream"); }
  catch (error) {
    operation.stop("upstream", error);
    const bytes = new TextEncoder().encode('{"error":{"code":"copilot_public_unavailable"}}'); let sent = false;
    return new Response(new ReadableStream<Uint8Array>({ pull(output) { if (!sent) { sent = true; output.enqueue(bytes); } else { output.close(); end(); } }, cancel() { end(); } }, { highWaterMark: 0 }),
      { status: error instanceof HttpError ? error.status : 503, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  }
}
