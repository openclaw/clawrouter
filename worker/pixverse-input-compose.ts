import { backgroundCall } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputUnavailable, sameManagedInput, type ManagedInputState, type ManagedInputReceipt } from "./managed-input-receipt.ts";
import { createPixVerseManagedAdapter, pixVerseRequestHeaders, preparePixVerseImagePlan, readPixVerseImageUpload, validatePixVerseId } from "./managed-pixverse.ts";
import { assertInputDeadline, inputBytesDigest, inputPlanDigest, type PixVerseInputDispatch, type PreparedInputDispatch } from "./pixverse-input-dispatch.ts";
import { assertPixVerseResponseStructure, pixVerseByteStream, pixVerseInputLease, pixVerseInputLimits, pixVerseMultipart,
  readPixVerseBytes, readPixVerseResponseBytes, inspectPixVerseBytes, type PixVerseByteStream } from "./pixverse-input-body.ts";
import { assertControlCallerLive, publicControlScope } from "./response-control-authorization.ts";
import type { Env } from "./types.ts";
import { errorResponse } from "./utils.ts";

export const pixVerseInputProfile = "clawrouter.pixverse-image-input.v1" as const;
const contentType = "application/vnd.clawrouter.pixverse-input";
const encoder = new TextEncoder();
type OwnerStart = (prepared: PreparedInputDispatch, signal: AbortSignal) => Promise<{ response: Promise<Response> }>;
type OwnerInspect = (input: PixVerseInputDispatch, signal: AbortSignal) => Promise<ManagedInputReceipt | ManagedInputState>;

// One binary private RPC, not JSON/base64 or a public body-override interface.
export function pixVerseComposeBody(input: PixVerseInputDispatch, bytes: Uint8Array): PixVerseByteStream {
  const metadata = encoder.encode(JSON.stringify(input));
  if (input.action !== "upload" || input.binding.inputProfile !== pixVerseInputProfile
    || metadata.length > pixVerseInputLimits.metadata || bytes.length !== input.binding.size) inputUnavailable();
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, metadata.length);
  return pixVerseByteStream([prefix, metadata, bytes]);
}
export const pixVerseComposeContentType = contentType;

async function prepare(request: Request, operation: HttpOperation): Promise<{ input: PixVerseInputDispatch; bytes: Uint8Array<ArrayBuffer> }> {
  if (request.headers.get("content-type") !== contentType || request.headers.has("content-encoding")
    || new URL(request.url).search) inputUnavailable();
  const raw = await readPixVerseBytes(request.body, pixVerseInputLimits.image + pixVerseInputLimits.metadata + 4, operation);
  if (raw.length < 5) inputUnavailable();
  const size = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0);
  if (size < 1 || size > pixVerseInputLimits.metadata || size + 4 >= raw.length) inputUnavailable();
  const metadata = raw.subarray(4, size + 4); assertPixVerseResponseStructure(metadata);
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)) as PixVerseInputDispatch;
  if (!input || Object.keys(input).sort().join() !== "action,authorization,binding,deadline,plan"
    || input.action !== "upload" || input.binding?.inputProfile !== pixVerseInputProfile) inputUnavailable();
  assertInputDeadline(input);
  const plan = preparePixVerseImagePlan(input.plan), bytes = raw.subarray(size + 4);
  if (plan.model !== input.binding.model || await inputPlanDigest(plan) !== input.binding.createDigest
    || await publicControlScope(input.authorization) !== input.binding.scope
    || bytes.length !== input.binding.size || await inputBytesDigest(bytes) !== input.binding.digest) inputUnavailable();
  return { input: { ...input, plan }, bytes };
}

// Called by the original credential object. Preparation and response parsing do
// not hold its tail. Each start callback holds it through the final claim and
// fetch START only, so a slow provider cannot prevent revocation.
export async function composePixVerseInput(request: Request, env: Env, start: OwnerStart, inspect: OwnerInspect): Promise<Response> {
  const lease = pixVerseInputLease("owner"), operation = new HttpOperation(request.signal, 30_000);
  let uploadStream: PixVerseByteStream | undefined, reply: PixVerseByteStream | undefined, response: Response | undefined;
  let delivered = false;
  try {
    const { input, bytes } = await prepare(request, operation), { binding } = input;
    const receipt = await inspect(input, operation.signal);
    assertInputDeadline(input); assertControlCallerLive(input.authorization);
    if (!sameManagedInput(receipt.binding, binding)) inputUnavailable();
    if (receipt.createClaimed) {
      if (!("upstreamId" in receipt) || !receipt.upstreamId) inputUnavailable();
      const result = errorResponse("managed_create_response_unavailable", "the original job exists; its transient create response cannot be replayed", 409);
      result.headers.set("x-clawrouter-managed-job-id", validatePixVerseId(receipt.upstreamId));
      return result;
    }
    if (receipt.state === "pending") {
      const multipart = pixVerseMultipart({ bytes, type: binding.mime }); uploadStream = multipart.stream;
      const headers = pixVerseRequestHeaders(); headers.set("content-type", multipart.contentType);
      const upload = { body: multipart.stream.body.pipeThrough(new FixedLengthStream(multipart.stream.length)), headers, length: multipart.stream.length };
      const started = await start({ input, upload, lease }, operation.signal);
      response = await operation.wait(started.response, "upstream", value => { void value.body?.cancel().catch(() => undefined); });
      // The provider response cannot release the upload window while the
      // transport still owns borrowed input. Early responses cancel that body.
      if (!uploadStream.complete) { uploadStream.cancel("early upload response"); inputUnavailable(); }
      await uploadStream.done;
      const raw = await readPixVerseResponseBytes(response, operation);
      const result = await inspectPixVerseBytes(raw, operation, readPixVerseImageUpload);
      try {
        const ack = await operation.wait(backgroundCall<{ bound: boolean; receipt: ManagedInputState }>(env, binding.scope,
          { action: "input_bind_upload", binding, imageId: result.id, summary: true }));
        if (!ack?.bound || ack.receipt.imageId !== result.id || !sameManagedInput(ack.receipt.binding, binding)) inputUnavailable();
      } catch (error) {
        // A lost ACK can recover only the same committed row and image ID.
        const recovered = await operation.wait(backgroundCall<ManagedInputState>(env, binding.scope, { action: "input_get", binding, summary: true }));
        if (recovered.state !== "bound" || recovered.imageId !== result.id || !sameManagedInput(recovered.binding, binding)) throw error;
      }
    } else if (receipt.state !== "bound") inputUnavailable();
    const create: PixVerseInputDispatch = { ...input, action: "create" };
    const started = await start({ input: create, lease }, operation.signal);
    response = await operation.wait(started.response, "upstream", value => { void value.body?.cancel().catch(() => undefined); });
    const raw = await readPixVerseResponseBytes(response, operation);
    const observation = await inspectPixVerseBytes(raw, operation, response => createPixVerseManagedAdapter("image").read(response,
      { action: "create", requestedVersion: binding.model, pathParams: {} }));
    try {
      const ack = await operation.wait(backgroundCall<{ bound: boolean }>(env, binding.scope,
        { action: "managed_bind", id: binding.jobId, responseId: observation.id }));
      if (!ack?.bound) inputUnavailable();
    } catch (error) {
      const recovered = await operation.wait(backgroundCall<ManagedInputState>(env, binding.scope, { action: "input_get", binding, summary: true }));
      if (recovered.upstreamId !== observation.id || !sameManagedInput(recovered.binding, binding)) throw error;
    }
    operation.signal.throwIfAborted(); assertControlCallerLive(input.authorization);
    // Native bytes stay transient. The job's acknowledged owner, never an img_id
    // or a fabricated success body, is the delivery boundary.
    reply = pixVerseByteStream([raw]);
    const onAbort = () => reply!.cancel(operation.signal.reason);
    operation.signal.addEventListener("abort", onAbort, { once: true });
    void reply.done.then(() => { operation.signal.removeEventListener("abort", onAbort); operation.stop("complete"); lease.release(); });
    delivered = true;
    return new Response(reply.body, { headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-clawrouter-managed-job-id": observation.id } });
  } finally {
    uploadStream?.cancel("complete");
    void response?.body?.cancel().catch(() => undefined);
    if (!delivered) { reply?.cancel("incomplete"); operation.stop("complete"); lease.release(); }
  }
}
