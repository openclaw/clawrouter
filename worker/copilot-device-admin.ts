import { authorizeAdmin } from "./access.ts";
import { sameOrigin } from "./request-origin.ts";
import { copilotGithubDomain } from "./provider-copilot.ts";
import { inspectCopilotJsonText } from "./copilot-json-guard.ts";
import { inputRetirement } from "./input-retirement.ts";
import { BodyLease } from "./body-budget.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, sha256Hex } from "./utils.ts";

export const copilotDeviceFlow = "copilot-device.v1";
export type CopilotDeviceInput =
  | { flow: typeof copilotDeviceFlow; provider: "github-copilot"; operation: "begin"; githubDomain: string;
      intentId: string; expectedGeneration: number; replacesAttemptId?: string; priority: number; weight: number }
  | { flow: typeof copilotDeviceFlow; provider: "github-copilot"; operation: "poll" | "cancel" | "status"; attemptId: string };
const invalid = () => new HttpError(400, "invalid_copilot_device_request", "Invalid Copilot device operation");

export function readCopilotDeviceInput(value: unknown): CopilotDeviceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>, begin = v.operation === "begin";
  const fields = begin ? ["flow", "provider", "operation", "githubDomain", "intentId", "expectedGeneration", "replacesAttemptId", "priority", "weight"]
    : ["flow", "provider", "operation", "attemptId"];
  const id = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(x);
  if (v.flow !== copilotDeviceFlow || v.provider !== "github-copilot" || Object.keys(v).some(k => !fields.includes(k))
    || !["begin", "poll", "cancel", "status"].includes(v.operation as string)) throw invalid();
  if (!begin) { if (!id(v.attemptId)) throw invalid(); return v as CopilotDeviceInput; }
  const priority = v.priority ?? 100, weight = v.weight ?? 1;
  if (typeof v.githubDomain !== "string" || v.githubDomain.length > 253 || !id(v.intentId)
    || !Number.isSafeInteger(v.expectedGeneration) || (v.expectedGeneration as number) < 0
    || v.replacesAttemptId !== undefined && !id(v.replacesAttemptId)
    || !Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000
    || typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) throw invalid();
  let githubDomain: string;
  try { githubDomain = copilotGithubDomain(v.githubDomain); } catch { throw invalid(); }
  return { ...v, githubDomain, priority, weight } as CopilotDeviceInput;
}

export async function copilotDeviceAdmin(request: Request, env: Env, expected?: string): Promise<string> {
  request.signal.throwIfAborted();
  if (!request.headers.get("origin") || !sameOrigin(request, env)) throw new HttpError(403, "access_csrf_required", "Same-origin browser request required");
  const session = await authorizeAdmin(request, env);
  if (session instanceof Response || session.auth !== "cloudflare_access" || session.role !== "admin")
    throw new HttpError(403, "access_admin_required", "Verified Access administrator required");
  const actor = await sha256Hex(JSON.stringify([session.auth, session.email, session.subject, new URL(request.url).origin]));
  request.signal.throwIfAborted();
  if (expected !== undefined && actor !== expected) throw new HttpError(403, "copilot_device_owner_mismatch", "Device attempt belongs to another administrator");
  return actor;
}

// Bounded from the first byte. The fixed URL discriminator selects this reader
// before the ordinary admin JSON parser; it grants no authority.
export async function readCopilotDeviceJson(request: Pick<Request, "body" | "bodyUsed" | "headers" | "signal">): Promise<unknown> {
  const body = request.body;
  if (!body || body.locked || request.bodyUsed) throw invalid();
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  let byob = true;
  try { reader = body.getReader({ mode: "byob" }); } catch { byob = false; reader = body.getReader(); }
  let cleanupFailed = false;
  const owner = inputRetirement({
    async cancel(reason) { try { await reader.cancel(reason); } catch (error) { cleanupFailed = true; throw error; } },
    releaseLock() { reader.releaseLock(); if (body.locked) throw invalid(); },
  }), abort = () => { void owner.retire("cancel", request.signal.reason).catch(() => undefined); };
  let eof = false, bytes: Uint8Array | undefined = new Uint8Array(8192);
  try {
    const length = request.headers.get("content-length");
    if (request.headers.has("content-encoding") || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
      || length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) throw invalid();
    request.signal.addEventListener("abort", abort, { once: true }); request.signal.throwIfAborted();
    let size = 0, window = new Uint8Array(8192);
    for (let reads = 0;;) {
      if (++reads > 8192) throw invalid();
      const part = await owner.read(() => byob ? (reader as ReadableStreamBYOBReader).read(window) : (reader as ReadableStreamDefaultReader<Uint8Array>).read());
      request.signal.throwIfAborted();
      if (part.value) {
        if (!(part.value instanceof Uint8Array) || part.value.buffer.byteLength > 8192 || part.value.length > 8192 - size) throw invalid();
        bytes.set(part.value, size); size += part.value.length;
      }
      if (part.done) { eof = true; break; }
      if (byob) { if (!part.value?.buffer.byteLength) throw invalid(); window = new Uint8Array(part.value.buffer); }
    }
    if (length !== null && Number(length) !== size) throw invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    inspectCopilotJsonText(text, "device");
    const value: unknown = JSON.parse(text);
    if (cleanupFailed) throw invalid();
    return value;
  } finally {
    request.signal.removeEventListener("abort", abort);
    await owner.retire(eof ? "eof" : "cancel", request.signal.reason); bytes = undefined;
  }
}

// The lease has two independent ends: physical work and this bounded producer.
// Producer EOF is not a claim about the remote client's or another DO's buffers.
export function copilotDeviceReply(value: unknown, status: number, lease: BodyLease, retired: Promise<void>, retain: (work: Promise<void>) => void): Response {
  let bytes: Uint8Array | undefined = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 2048) { bytes = undefined; retain(retired.then(() => lease.release())); throw invalid(); }
  let done!: () => void;
  const output = new Promise<void>(resolve => { done = resolve; });
  retain(Promise.all([retired, output]).then(() => lease.release()));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (bytes) { const part = bytes; bytes = undefined; controller.enqueue(part); } else { controller.close(); done(); } },
    cancel() { bytes = undefined; done(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status, headers: privateJson({}).headers });
}

export function copilotDeviceFailure(error: unknown): { value: unknown; status: number } {
  return { value: { error: { code: error instanceof HttpError ? error.code : "copilot_device_unavailable", message: "Copilot device operation unavailable" } },
    status: error instanceof HttpError ? error.status : 503 };
}

export async function copilotDeviceAuthorize(request: Request, env: Env, key: string): Promise<Response> {
  const lease = new BodyLease(); let response: Response | undefined;
  try {
    const url = new URL(request.url);
    if (url.searchParams.size !== 1 || url.searchParams.get("flow") !== copilotDeviceFlow) throw invalid();
    const actor = await copilotDeviceAdmin(request, env);
    if (!lease.grow(1024 * 1024)) throw new HttpError(503, "body_capacity_exhausted", "Request capacity unavailable");
    const input = readCopilotDeviceInput(await readCopilotDeviceJson(request));
    await copilotDeviceAdmin(request, env, actor);
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["cf-access-jwt-assertion", "origin", "sec-fetch-site", "x-forwarded-host", "x-forwarded-proto"])
      if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
    response = await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key)).fetch("https://clawrouter.internal/copilot-device", {
      method: "POST", headers, body: JSON.stringify({ key, sourceUrl: request.url, input }), signal: request.signal,
    });
    const status = response.status;
    // A private owner reply has the same small JSON envelope. Consume it while
    // preserving its producer's retirement before exposing the public copy.
    const value = await readCopilotDeviceJson({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal: request.signal });
    await copilotDeviceAdmin(request, env, actor);
    return copilotDeviceReply(value, status, lease, Promise.resolve(), work => { void work.catch(() => undefined); });
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    // A failed lock retirement is not proof that either original reader has
    // released custody. Keep its charge even while returning a sanitized error.
    const retired = request.body?.locked || response?.body?.locked
      ? Promise.reject(new Error("copilot_device_input_not_retired")) : Promise.resolve();
    const failure = copilotDeviceFailure(error);
    return copilotDeviceReply(failure.value, failure.status, lease, retired, work => { void work.catch(() => undefined); });
  }
}
