import type { HttpOperation } from "./http-operation.ts";
import { inputRetirement } from "./input-retirement.ts";

const invalid = () => new Error("invalid_copilot_response_body");

// Copilot transport only. The caller retains capacity and original authority
// through parsing, fresh policy checks and publication; this owns neither.
export async function consumeCopilotResponse<T>(response: Response, input: Readonly<{
  operation: HttpOperation;
  expectedUrl: string;
  profile: "catalog" | "device" | "account";
}>, open: () => { push(bytes: Uint8Array): void; finish(): T }): Promise<T> {
  const { operation, expectedUrl, profile } = input, body = response.body;
  if (!body || response.bodyUsed || body.locked) throw invalid();
  let reader: ReadableStreamBYOBReader | undefined;
  let cleanupFailed = false, eof = false, valid = false;
  let result!: T;
  const retirement = inputRetirement({
    async cancel(reason) {
      try { await (reader ? reader.cancel(reason) : body.cancel(reason)); }
      catch (error) { cleanupFailed = true; throw error; }
    },
    releaseLock() {
      try { reader?.releaseLock(); if (reader && body.locked) throw invalid(); }
      catch (error) { cleanupFailed = true; throw error; }
    },
  });
  const abort = () => { void retirement.retire("cancel", invalid()); };
  try {
    const maximum = profile === "catalog" ? 2 * 1024 * 1024 : profile === "device" ? 8192 : profile === "account" ? 16 * 1024 * 1024 : 0;
    const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    const mime = response.headers.get("content-type") ?? "";
    if (!maximum || !expectedUrl || response.url !== expectedUrl || !response.url || response.redirected
      || (profile === "catalog" ? response.status !== 200 : response.status < 200 || response.status >= 300)
      || response.headers.has("content-range") || (encoding !== null && encoding.toLowerCase() !== "identity")
      || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(mime)
      || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum))) throw invalid();
    operation.signal.throwIfAborted();
    const ownedReader = reader = body.getReader({ mode: "byob" });
    operation.signal.addEventListener("abort", abort, { once: true });
    operation.signal.throwIfAborted();
    const sink = open(), bound = Math.min(16 * 1024, maximum);
    let window = new Uint8Array(bound), size = 0, reads = 0;
    for (;;) {
      operation.signal.throwIfAborted();
      if (++reads > 8192) throw invalid(); // Empty results AND EOF count.
      // Register the actual pending read before the deadline race can reject.
      const pending = retirement.read(() => ownedReader.read(window));
      const next = await operation.wait(pending);
      operation.signal.throwIfAborted();
      if (next.value) {
        if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer)
          || next.value.buffer.byteLength > bound || next.value.byteLength > maximum - size) throw invalid();
        size += next.value.byteLength;
        sink.push(next.value); // Synchronous borrowed bytes, before reuse.
      }
      if (next.done) { eof = true; break; }
      if (!next.value?.buffer.byteLength) throw invalid();
      // BYOB transfers ownership. Reuse returned backing, including empty reads;
      // never replenish a detached/absent window with another allocation.
      window = new Uint8Array(next.value.buffer);
    }
    if (length !== null && Number(length) !== size) throw invalid();
    operation.signal.throwIfAborted();
    result = sink.finish();
    valid = true;
  } catch { valid = false; }
  finally {
    operation.signal.removeEventListener("abort", abort);
    try { await retirement.retire(eof ? "eof" : "cancel", invalid()); }
    catch { cleanupFailed = true; }
  }
  // Retirement settlement alone does not mean cancel/unlock succeeded. Also
  // reject aborts arriving during finish or the final retirement continuation.
  if (!valid || cleanupFailed || operation.signal.aborted) throw invalid();
  return result;
}
