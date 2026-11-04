import { BodyLease } from "./body-budget.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { HttpOperation } from "./http-operation.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { freezeInlineMusicInput } from "./openrouter-music-input.ts";
import { prepareOpenRouterMusicBorrowed } from "./openrouter-music.ts";
import { musicPolicyBinding } from "./openrouter-music-owner.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { configuredUpstream } from "./providers.ts";
import { authorizePublishedInputCaller, assertPublishedInputCredential, assertPublishedInputGrant } from "./published-input-authority.ts";
import { parsePublishedInputUrl, publishedInputCall } from "./published-input-archive.ts";
import { assertPublishedInputLive, publishedInputUnavailable, samePublishedInput, validatePublishedAttempt,
  type PublishedInputAttempt, type PublishedInputBinding, type PublishedInputReceipt } from "./published-input-receipt.ts";
import { publishedMusicRequestDigest } from "./published-music.ts";
import { publishedMusicBodyBytes, publishedMusicDispatchBytes, publishedMusicDispatchHeader, publishedMusicReference } from "./published-music-runtime.ts";
import type { Env, UpstreamGrant } from "./types.ts";
import { errorResponse, HttpError, sha256Hex } from "./utils.ts";

interface Input { binding: PublishedInputBinding; attempt: PublishedInputAttempt; body: string; deadline: number }
export interface PreparedPublishedMusicForward {
  input: Input;
  operation: HttpOperation;
  lease: BodyLease;
  attempted: boolean;
}

export async function preparePublishedMusicForward(request: Request): Promise<PreparedPublishedMusicForward> {
  const operation = new HttpOperation(request.signal, 120_000), lease = new BodyLease();
  if (!lease.grow(2 * 1024 * 1024)) { operation.stop("complete"); throw new HttpError(503, "server_overloaded", "published music dispatch capacity is busy"); }
  try {
    const input = await readDispatch(request, operation);
    if (!input || Object.keys(input).sort().join(",") !== "attempt,binding,body,deadline" || typeof input.body !== "string"
      || new TextEncoder().encode(input.body).byteLength > publishedMusicBodyBytes) publishedInputUnavailable();
    assertPublishedInputLive(input.binding); validatePublishedAttempt(input.attempt);
    assertDeadline(input);
    assertDispatchStructure(input.body, 64);
    let body = JSON.parse(input.body) as Record<string, unknown>;
    freezeInlineMusicInput(body); prepareOpenRouterMusicBorrowed(input.binding.upstreamModel, body);
    const locator = parsePublishedInputUrl(publishedMusicReference(body) ?? "", input.binding.publicOrigin);
    if (locator.scope !== input.binding.scope || locator.id !== input.binding.id
      || await sha256Hex(locator.verifier) !== input.binding.verifierDigest) publishedInputUnavailable();
    if (await publishedMusicRequestDigest(body, input.binding) !== input.binding.requestDigest) publishedInputUnavailable();
    body = {}; operation.signal.throwIfAborted();
    return { input, operation, lease, attempted: false };
  } catch (error) { operation.stop("upstream", error); lease.release(); throw error; }
}

// This private envelope has one small native JSON string, never image bytes.
// Own cancellation through its actual settlement before releasing the 4 MiB
// preparation charge. No change to general-purpose JSON ingress is needed.
async function readDispatch(request: Request, operation: HttpOperation): Promise<Input> {
  if (!request.body) publishedInputUnavailable();
  let reader: ReadableStreamBYOBReader;
  try { reader = request.body.getReader({ mode: "byob" }); }
  catch (error) { await request.body.cancel().catch(() => undefined); throw error; }
  let raw: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(publishedMusicDispatchBytes);
  let window: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(16 * 1024), text = "", size = 0, reads = 0, complete = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel(operation.signal.reason).catch(() => undefined); };
  operation.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      operation.signal.throwIfAborted(); if (++reads > 8192) publishedInputUnavailable();
      const part = await reader.read(window); operation.signal.throwIfAborted();
      if (part.value) {
        if (part.value.buffer.byteLength > 16 * 1024 || part.value.byteLength > raw.length - size) publishedInputUnavailable();
        raw.set(part.value, size); size += part.value.byteLength; window = new Uint8Array(part.value.buffer);
      }
      if (part.done) { complete = true; break; }
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, size)); raw = undefined;
    assertDispatchStructure(text, 256);
    return JSON.parse(text) as Input;
  } finally {
    if (!complete) cancel(); await cancellation;
    reader.releaseLock(); operation.signal.removeEventListener("abort", cancel);
    raw = undefined; window = undefined; text = "";
  }
}
function assertDispatchStructure(text: string, maximumNodes: number): void {
  let nodes = 0, depth = 0, units = 0;
  const tokenizer = createJsonTokenizer(token => {
    if (["startObject", "startArray", "startString", "startNumber", "trueValue", "falseValue", "nullValue"].includes(token.name)
      && ++nodes > maximumNodes) publishedInputUnavailable();
    if (["startObject", "startArray"].includes(token.name) && ++depth > 16) publishedInputUnavailable();
    if (["endObject", "endArray"].includes(token.name)) depth--;
    if ((token.name === "stringChunk" || token.name === "numberChunk") && (units += token.value.length) > publishedMusicDispatchBytes) publishedInputUnavailable();
  });
  for (let offset = 0; offset < text.length; offset += 1024) tokenizer.push(text.slice(offset, offset + 1024));
  tokenizer.end();
}

export async function dispatchPublishedMusicUnderOwner(env: Env, prepared: PreparedPublishedMusicForward,
  record: CredentialRecord | undefined, grant: UpstreamGrant | undefined): Promise<{ response: Promise<Response> }> {
  const { input, operation } = prepared, { binding } = input;
  assertPublishedInputCredential(binding, record); assertPublishedInputGrant(binding, grant);
  assertDeadline(input);
  const { provider, policy } = await authorizePublishedInputCaller(env, binding, operation.signal);
  if (await sha256Hex(musicPolicyBinding(policy)) !== input.attempt.admissionDigest) publishedInputUnavailable();
  if (!filterGrantCandidates("openrouter", [{ key: binding.owner.grantKey, grant, runtimeState: null }], new Set(),
    grantRoutingPolicy(policy.grantRouting), binding.owner.grantKey, undefined, Date.now()).available.length
    || policyRequestCost(policy, "music.generate") !== input.attempt.reservedMicros) publishedInputUnavailable();
  const upstream = configuredUpstream(provider, grant, env);
  if (upstream.transport !== null || upstream.query.size || upstream.baseUrl !== "https://openrouter.ai/api"
    || upstream.headers.get("authorization") !== `Bearer ${record.credential}`) publishedInputUnavailable();
  const headers = new Headers(upstream.headers); headers.set("content-type", "application/json"); headers.set("accept", "text/event-stream");
  // The private operation reconstructs server headers from the ORIGINAL record;
  // no caller headers, URL, alternate grant or environment secret are inputs.
  if ([...headers.keys()].some(name => !["authorization", "content-type", "accept", "http-referer", "x-title"].includes(name))) publishedInputUnavailable();
  const request = new Request(binding.origin + binding.path, { method: "POST", headers, body: input.body, redirect: "manual", signal: operation.signal });
  prepared.attempted = true;
  let ack: { acknowledged: true; receipt: PublishedInputReceipt };
  try {
    ack = await publishedInputCall(env, binding.scope, { action: "asset_claim_forward", binding, attempt: input.attempt }, operation.signal);
  } catch (error) {
    // A definitive losing CAS is known-unsent. Missing/invalid acknowledgments
    // remain uncertain; the original durable attempt is never reset.
    if (error instanceof HttpError && error.status === 409) prepared.attempted = false;
    throw error;
  }
  // This receipt call is the LAST await under the original credential tail.
  operation.signal.throwIfAborted(); assertDeadline(input); assertPublishedInputLive(binding);
  assertPublishedInputCredential(binding, record);
  if (env.CLAWROUTER_PUBLIC_ORIGIN !== binding.publicOrigin || ack.acknowledged !== true || ack.receipt.state !== "forwarding_unknown"
    || !samePublishedInput(ack.receipt.binding, binding) || ack.receipt.attempt?.eventId !== input.attempt.eventId) publishedInputUnavailable();
  input.body = "";
  return { response: fetch(request, { signal: operation.signal }) };
}

export function publishedMusicDispatchFailure(error: unknown, attempted: boolean): Response {
  const response = errorResponse("published_input_unavailable", "the original published input dispatch could not be confirmed", error instanceof HttpError ? error.status : 503);
  response.headers.set(publishedMusicDispatchHeader, attempted ? "attempted" : "unsent"); return response;
}
function assertDeadline(input: Input): void {
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > input.binding.expiresAt
    || input.deadline > Date.now() + 120_000) publishedInputUnavailable();
}

// Preserve a byte stream through the DO hop for the existing native music
// quarantine. Never detach an upstream-owned backing or retain past EOF/cancel.
export async function publishedMusicOwnerResponse(response: Response, prepared: PreparedPublishedMusicForward): Promise<Response> {
  const { lease, operation } = prepared;
  prepared.input.body = "";
  const headers = new Headers(response.headers); headers.set(publishedMusicDispatchHeader, "attempted");
  if (!response.body) { lease.release(); operation.stop("complete"); return new Response(null, { status: response.status, headers }); }
  let reader: ReadableStreamBYOBReader;
  try { reader = response.body.getReader({ mode: "byob" }); }
  catch (error) { operation.stop("upstream", error); try { await response.body.cancel(); } finally { lease.release(); } throw error; }
  let window = new Uint8Array(16 * 1024), pending: Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>> | undefined;
  let reads = 0, bytes = 0, eof = false, cleanup: Promise<void> | undefined;
  const aborted = () => { void finish(operation.signal.reason ?? new Error("published music transport canceled")); };
  const finish = (reason?: unknown): Promise<void> => cleanup ??= Promise.resolve().then(async () => {
    operation.stop(reason === undefined ? "complete" : "upstream", reason);
    try { if (!eof) await reader.cancel(reason).catch(() => undefined); await pending?.catch(() => undefined); }
    finally { reader.releaseLock(); window = new Uint8Array(0); operation.signal.removeEventListener("abort", aborted); lease.release(); }
  });
  operation.signal.addEventListener("abort", aborted, { once: true });
  const body = new ReadableStream<Uint8Array>({ type: "bytes", async pull(controller) {
    try {
      operation.signal.throwIfAborted(); assertDeadline(prepared.input);
      if (++reads > 262144) publishedInputUnavailable();
      pending = reader.read(window);
      const part = await operation.wait(pending); pending = undefined;
      if (part.value) {
        if (part.value.buffer.byteLength > 16 * 1024 || bytes + part.value.byteLength > 32 * 1024 * 1024) publishedInputUnavailable();
        window = new Uint8Array(part.value.buffer); bytes += part.value.byteLength;
        if (part.value.byteLength) controller.enqueue(part.value.slice());
      }
      if (part.done) { eof = true; await finish(); controller.close(); controller.byobRequest?.respond(0); }
    } catch (error) { await finish(error); controller.error(error); }
  }, async cancel(reason) { operation.cancel(reason); await finish(reason ?? new Error("published music transport canceled")); } }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
