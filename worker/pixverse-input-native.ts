import { modelExecutable, modelSupportsEndpoint } from "../shared/route-catalog.ts";
import { HttpOperation } from "./http-operation.ts";
import { allocatePixVerseInput } from "./pixverse-inputs.ts";
import { inputUnavailable, sameManagedInput, type ManagedInputState } from "./managed-input-receipt.ts";
import { pixVerseInputPaths, type PixVerseInputDispatch } from "./pixverse-input-dispatch.ts";
import { pixVerseByteStream, pixVerseInputLease, pixVerseInputLimits, readPixVerseBytes, readPixVerseResponseBytes, inspectPixVerseBytes, type PixVerseByteStream } from "./pixverse-input-body.ts";
import { pixVerseComposeBody, pixVerseComposeContentType, pixVerseInputProfile } from "./pixverse-input-compose.ts";
import { parsePixVerseImageMultipart } from "./pixverse-image-multipart.ts";
import { publicControlAuthorization } from "./response-control-authorization.ts";
import { createPixVerseManagedAdapter, validatePixVerseId } from "./managed-pixverse.ts";
import { managedPaths } from "./managed-routes.ts";
import { backgroundCall } from "./http-background.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, Env } from "./types.ts";
import { errorResponse, HttpError } from "./utils.ts";

// Registered multipart ingress only. Vendor JSON img_id preparation and generic
// manifest JSON routes never enter this profile or gain input-receipt authority.
export async function proxyPixVerseImageInput(request: Request, env: Env, context: ExecutionContext, provider: CompiledProvider,
  endpoint: CompiledEndpoint, initialAuth: AuthorizedIdentity,
  authenticate: (selection: ProxySelection) => Promise<AuthorizedIdentity | Response | null>): Promise<Response> {
  publicControlAuthorization(initialAuth);
  const url = new URL(request.url);
  if (provider.id !== "pixverse" || endpoint.inputProfile !== pixVerseInputProfile || endpoint.path !== pixVerseInputPaths.create
    || endpoint.request_format !== "pixverse.image_video" || endpoint.response_format !== "pixverse.video" || endpoint.lifecycle?.protocol !== "pixverse.video"
    || !endpoint.native_proxy || endpoint.method !== "POST" || endpoint.methods.join() !== "POST" || request.method !== "POST"
    || url.pathname !== `/v1/native/pixverse${pixVerseInputPaths.create}` || url.search || endpoint.path_params.length
    || endpoint.upstreamPath !== undefined || endpoint.modelPassthrough || endpoint.websocket || endpoint.streaming || endpoint.auth
    || Object.keys(endpoint.headers).length || Object.keys(endpoint.query).length || request.headers.has("content-encoding"))
    throw new HttpError(400, "invalid_pixverse_input", "composed image input requires its exact registered multipart route");
  const contentType = request.headers.get("content-type"), length = request.headers.get("content-length");
  if (!contentType || contentType.length > 256 || length !== null && (!/^[0-9]+$/.test(length)
    || !Number.isSafeInteger(Number(length)) || Number(length) > pixVerseInputLimits.ingress))
    throw new HttpError(400, "invalid_pixverse_input", "invalid bounded multipart envelope");
  const lease = pixVerseInputLease("public"), deadline = Date.now() + 30_000, operation = new HttpOperation(request.signal, 30_000);
  let outbound: PixVerseByteStream | undefined, reply: PixVerseByteStream | undefined, response: Response | undefined, delivered = false;
  try {
    const raw = await readPixVerseBytes(request.body, pixVerseInputLimits.ingress, operation);
    if (length !== null && raw.length !== Number(length)) throw new HttpError(400, "invalid_pixverse_input", "incomplete multipart envelope");
    let parsed: ReturnType<typeof parsePixVerseImageMultipart>;
    try { parsed = parsePixVerseImageMultipart(raw, contentType); }
    catch { throw new HttpError(400, "invalid_pixverse_input", "invalid composed image plan or file"); }
    const model = provider.models.find(model => ["pixverse/v6", "pixverse/c1"].includes(model.id)
      && model.id === `pixverse/${parsed.plan.model}` && model.upstream === parsed.plan.model);
    if (!model || !model.capabilities.includes("video.generate") || !modelExecutable(provider, model)
      || !modelSupportsEndpoint(provider, model, endpoint) || !provider.capabilities.some(item => item.id === "video.generate" && item.endpoint === endpoint.id))
      throw new HttpError(403, "model_not_allowed", "composed image input requires an explicitly eligible image model");
    const selection: ProxySelection = { provider, endpoint, model, capability: "video.generate", body: parsed.plan, pathParams: {}, method: "POST" };
    const auth = await authenticate(selection); operation.signal.throwIfAborted();
    if (auth instanceof Response) return auth;
    if (!auth) inputUnavailable();
    const authorization = publicControlAuthorization(auth);
    const binding = await allocatePixVerseInput(request, env, context, auth, selection, parsed.file); operation.signal.throwIfAborted();
    const input: PixVerseInputDispatch = { binding, authorization, plan: parsed.plan, action: "upload", deadline: Math.min(binding.expiresAt, deadline) };
    outbound = pixVerseComposeBody(input, parsed.file.bytes);
    response = await operation.wait(env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(binding.owner.grantKey!))
      .fetch("https://clawrouter.internal/managed-input/compose", { method: "POST", body: outbound.body, signal: operation.signal,
        headers: { "content-type": pixVerseComposeContentType }, redirect: "manual", duplex: "half" } as RequestInit),
      undefined, value => { void value.body?.cancel().catch(() => undefined); });
    if (!outbound.complete) { outbound.cancel("early owner response"); inputUnavailable(); }
    await outbound.done;
    const id = response.headers.get("x-clawrouter-managed-job-id");
    if (response.status === 409 && id) {
      const job = await operation.wait(backgroundCall<ManagedInputState>(env, binding.scope, { action: "input_get", binding, summary: true }));
      if (!job || !sameManagedInput(job.binding, binding) || job.upstreamId !== validatePixVerseId(id)) inputUnavailable();
      const location = managedPaths(provider, endpoint, id, {}).retrieve;
      if (!location) inputUnavailable();
      const recovery = errorResponse("managed_create_response_unavailable", "use the original owned job's retrieval route; creation is never replayed", 409);
      recovery.headers.set("location", location); return recovery;
    }
    if (response.status !== 200 || !id) inputUnavailable();
    const native = await readPixVerseResponseBytes(response, operation);
    const observation = await inspectPixVerseBytes(native, operation, response => createPixVerseManagedAdapter("image").read(response,
      { action: "create", requestedVersion: binding.model, pathParams: {} }));
    if (observation.id !== validatePixVerseId(id)) inputUnavailable();
    operation.signal.throwIfAborted();
    reply = pixVerseByteStream([native]);
    const onAbort = () => reply!.cancel(operation.signal.reason);
    operation.signal.addEventListener("abort", onAbort, { once: true });
    void reply.done.then(() => { operation.signal.removeEventListener("abort", onAbort); operation.stop("complete"); lease.release(); });
    delivered = true;
    return new Response(reply.body, { headers: { "content-type": "application/json", "content-length": String(native.length) } });
  } finally {
    outbound?.cancel("complete"); void response?.body?.cancel().catch(() => undefined);
    if (!delivered) { reply?.cancel("incomplete"); operation.stop("complete"); lease.release(); }
  }
}
