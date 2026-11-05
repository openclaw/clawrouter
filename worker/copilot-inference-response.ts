import { HttpOperation } from "./http-operation.ts";
import { inputRetirement } from "./input-retirement.ts";
import { inspectCopilotInferenceJson, copilotInferenceUnavailable } from "./copilot-inference-dispatch.ts";

const KiB = 1024, windowBytes = 16 * KiB;
const invalid = () => new Error("invalid_copilot_inference_body");

// Own the ORIGINAL reader. Public failure races the enclosing operation, never
// an individual read. Cancellation settlement is separate from cleanup success.
function source(body: ReadableStream<Uint8Array>, operation: HttpOperation, maximum: number) {
  if (body.locked) throw invalid();
  let reader: ReadableStreamBYOBReader | undefined, window = new Uint8Array(windowBytes), size = 0, reads = 0;
  let cleanupFailed = false, eof = false;
  const owner = inputRetirement({
    async cancel(reason) { try { await (reader ? reader.cancel(reason) : body.cancel(reason)); } catch (error) { cleanupFailed = true; throw error; } },
    releaseLock() { reader?.releaseLock(); if (body.locked) { cleanupFailed = true; throw invalid(); } },
  });
  const abort = () => { void owner.retire("cancel", operation.signal.reason).catch(() => undefined); };
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  const retired = owner.retired.finally(() => { operation.signal.removeEventListener("abort", abort); window = new Uint8Array(0); });
  void retired.catch(() => undefined);
  return {
    retired,
    get size() { return size; },
    get eof() { return eof; },
    async read() {
      operation.signal.throwIfAborted();
      if (++reads > 8192) throw invalid(); // Includes empty results and EOF.
      reader ??= body.getReader({ mode: "byob" });
      const next = await owner.read(() => reader!.read(window));
      operation.signal.throwIfAborted();
      if (next.value) {
        if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer)
          || next.value.buffer.byteLength > windowBytes || next.value.byteLength > maximum - size) throw invalid();
        size += next.value.byteLength;
      }
      if (next.done) eof = true;
      else {
        if (!next.value?.buffer.byteLength) throw invalid();
        window = new Uint8Array(next.value.buffer); // Only returned ownership is reusable.
      }
      return next;
    },
    async retire(kind: "eof" | "cancel", reason?: unknown) {
      await owner.retire(kind, reason); await retired;
      if (cleanupFailed) throw invalid();
    },
  };
}

function length(headers: Headers, maximum: number): number | null {
  const value = headers.get("content-length"), encoding = headers.get("content-encoding");
  if (headers.has("content-range") || encoding !== null && encoding.toLowerCase() !== "identity"
    || value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)) throw invalid();
  return value === null ? null : Number(value);
}
function json(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  inspectCopilotInferenceJson(text);
  return JSON.parse(text);
}

export async function readCopilotInferenceInput(request: Request, operation: HttpOperation): Promise<unknown> {
  if (!request.body || request.bodyUsed) throw copilotInferenceUnavailable();
  const input = source(request.body, operation, 256 * KiB);
  try {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get("content-type") ?? "")) throw invalid();
    const expected = length(request.headers, 256 * KiB), bytes = new Uint8Array(256 * KiB);
    let offset = 0;
    for (;;) {
      const next = await input.read();
      if (next.value) { bytes.set(next.value, offset); offset += next.value.byteLength; }
      if (next.done) break;
    }
    if (!offset || expected !== null && expected !== offset) throw invalid();
    const value = json(bytes.subarray(0, offset));
    await input.retire("eof"); operation.signal.throwIfAborted(); return value;
  } catch (error) { await input.retire(input.eof ? "eof" : "cancel", error); throw error; }
}

export async function disposeCopilotInferenceResponse(response: Pick<Response, "body" | "bodyUsed">, reason?: unknown): Promise<void> {
  if (!response.body) return;
  if (response.bodyUsed || response.body.locked) throw invalid();
  const reader = response.body.getReader();
  let failed = false;
  const owner = inputRetirement({ async cancel(value) { try { await reader.cancel(value); } catch (error) { failed = true; throw error; } }, releaseLock: () => reader.releaseLock() });
  await owner.retire("cancel", reason);
  if (failed) throw invalid();
}

// Complete unary quarantine, or one complete SSE frame at a time. Native DONE
// does not stop the source: its actual EOF and length are still mandatory.
export function copilotInferenceResponse(response: Response, operation: HttpOperation, expectedUrl: string, streaming: boolean, revalidate: (force?: boolean) => Promise<void>): {
  response: Response; retired: Promise<void>;
} {
  if (!response.body || response.bodyUsed) throw invalid();
  const maximum = streaming ? 32 * 1024 * KiB : 256 * KiB, input = source(response.body, operation, maximum);
  let expected: number | null = null, headerError: unknown;
  try {
    expected = length(response.headers, maximum);
    const mime = streaming ? /^text\/event-stream(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i : /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i;
    let headerUnits = 0;
    for (const [name, value] of response.headers) { headerUnits += name.length + value.length; if (headerUnits > 16 * KiB) throw invalid(); }
    if (!response.url || response.url !== expectedUrl || response.redirected || response.status !== 200 || !mime.test(response.headers.get("content-type") ?? "")) throw invalid();
  } catch (error) { headerError = error; }
  let buffer = new Uint8Array(streaming ? 64 * KiB : 256 * KiB), used = 0, offset = 0;
  let pending: Uint8Array | undefined, pendingOffset = 0, unaryReady = false, frameReady = false, ended = false, upstreamEOF = false;
  let lineSize = 0, skipLF = false, boundaryCR = false;
  const qualify = async (final = false) => {
    await revalidate(final);
    operation.signal.throwIfAborted();
  };
  let pulling: Promise<void> | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveRetired!: () => void, rejectRetired!: (error: unknown) => void;
  const retired = new Promise<void>((resolve, reject) => { resolveRetired = resolve; rejectRetired = reject; });
  void retired.catch(() => undefined);
  const finish = (kind: "eof" | "cancel", reason?: unknown) => {
    if (ended) return;
    ended = true;
    operation.signal.removeEventListener("abort", abort);
    // Start cancellation BEFORE joining the pull. A held read otherwise cannot
    // retire. This continuation must not be awaited from that same pull.
    const cleanup = input.retire(kind, reason), current = pulling;
    void Promise.allSettled([cleanup, current]).then(results => {
      buffer = new Uint8Array(0); pending = undefined; controller = undefined;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") rejectRetired(failure.reason); else resolveRetired();
    });
  };
  const abort = () => { try { controller?.error(operation.signal.reason); } catch {} finish("cancel", operation.signal.reason); };
  operation.signal.addEventListener("abort", abort, { once: true });
  const validateFrame = () => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
    const data = text.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data && data !== "[DONE]") { inspectCopilotInferenceJson(data); JSON.parse(data); }
  };
  const pull = async (output: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      operation.signal.throwIfAborted(); if (headerError) throw headerError;
      if (!streaming && !unaryReady) {
        for (;;) {
          const next = await input.read();
          if (next.value) { buffer.set(next.value, used); used += next.value.byteLength; }
          if (next.done) break;
        }
        if (!used || expected !== null && expected !== input.size) throw invalid();
        json(buffer.subarray(0, used)); await input.retire("eof"); await qualify(true); unaryReady = true;
      }
      if (!streaming) {
        if (offset < used) { const end = Math.min(used, offset + windowBytes); output.enqueue(buffer.slice(offset, end)); offset = end; }
        else { output.close(); finish("eof"); }
        return;
      }
      for (;;) {
        if (frameReady && offset < used) {
          const end = Math.min(used, offset + windowBytes); output.enqueue(buffer.slice(offset, end)); offset = end;
          if (offset === used) { used = 0; offset = 0; frameReady = false; }
          return;
        }
        let complete = false;
        while (pending && pendingOffset < pending.length) {
          // A CR delimiter may still own the next LF. Do not strand that LF as
          // an incomplete future frame or release an unvalidated partial frame.
          if (boundaryCR) {
            if (pending[pendingOffset] === 10) {
              if (used === buffer.length) throw invalid(); buffer[used++] = pending[pendingOffset++];
            }
            boundaryCR = false; skipLF = false; complete = true; break;
          }
          const byte = pending[pendingOffset++];
          if (used === buffer.length) throw invalid(); buffer[used++] = byte;
          if (skipLF) { skipLF = false; if (byte === 10) continue; }
          if (byte === 13 || byte === 10) {
            if (lineSize === 0) { if (byte === 13) boundaryCR = true; else complete = true; }
            lineSize = 0; skipLF = byte === 13;
          } else lineSize++;
          if (complete) break;
        }
        if (!complete && upstreamEOF && boundaryCR) { boundaryCR = false; skipLF = false; complete = true; }
        if (complete) { validateFrame(); await qualify(); frameReady = true; offset = 0; continue; }
        pending = undefined; pendingOffset = 0;
        if (upstreamEOF) {
          if (used || !input.size || expected !== null && expected !== input.size) throw invalid();
          await input.retire("eof"); await qualify(true); output.close(); finish("eof"); return;
        }
        const next = await input.read(); upstreamEOF = next.done;
        pending = next.value;
      }
    } catch (error) { try { output.error(error); } catch {} finish("cancel", error); }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(value) { const work = Promise.resolve().then(() => pull(value)); pulling = work; return work.finally(() => { if (pulling === work) pulling = undefined; }); },
    cancel(reason) { finish("cancel", reason); },
  }, { highWaterMark: 0 });
  if (operation.signal.aborted) abort();
  const headers = new Headers({ "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "private, no-store" });
  return { response: new Response(body, { status: 200, headers }), retired };
}
