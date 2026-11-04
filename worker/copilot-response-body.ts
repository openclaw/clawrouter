import type { HttpOperation } from "./http-operation.ts";

const limits = { catalog: 2 * 1024 * 1024, device: 8 * 1024 } as const;
const windowBytes = 16 * 1024;
const maximumReads = 8192;
const invalid = () => new Error("invalid_copilot_response_body");

// Transport only. The caller owns capacity, destination/credential authority,
// decoding and fresh authorization through final publication of the result.
export async function readCopilotResponseText(response: Response, input: Readonly<{
  operation: HttpOperation;
  expectedUrl: string;
  profile: "catalog" | "device";
}>): Promise<string> {
  const { operation, expectedUrl, profile } = input;
  const body = response.body;
  // Never cancel or release another consumer's body ownership.
  if (!body || response.bodyUsed || body.locked) throw invalid();
  let reader: ReadableStreamBYOBReader | undefined;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cancellation: Promise<void> | undefined;
  let complete = false;
  const cancel = () => {
    cancellation ??= (reader ? reader.cancel(invalid()) : body.cancel(invalid())).catch(() => undefined);
  };
  try {
    const maximum = profile === "catalog" ? limits.catalog : profile === "device" ? limits.device : 0;
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const mime = response.headers.get("content-type") ?? "";
    if (!maximum || !expectedUrl || response.url !== expectedUrl || !response.url || response.redirected
      || (profile === "catalog" ? response.status !== 200 : response.status < 200 || response.status >= 300)
      || response.headers.has("content-range") || (encoding !== null && encoding.toLowerCase() !== "identity")
      || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(mime)
      || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum))) throw invalid();
    operation.signal.throwIfAborted();
    reader = body.getReader({ mode: "byob" });
    operation.signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(maximum);
    const bound = Math.min(windowBytes, maximum);
    let window = new Uint8Array(bound), size = 0, reads = 0;
    for (;;) {
      operation.signal.throwIfAborted();
      // Empty results and the final EOF read consume the same finite allowance.
      if (++reads > maximumReads) throw invalid();
      pending = reader.read(window);
      const next = await operation.wait(pending);
      pending = undefined;
      operation.signal.throwIfAborted();
      if (next.value) {
        if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer)
          || next.value.buffer.byteLength > bound || next.value.byteLength > maximum - size) throw invalid();
        bytes.set(next.value, size);
        size += next.value.byteLength;
        // BYOB transfers the window, never the retained response buffer.
        window = new Uint8Array(next.value.buffer);
      }
      if (next.done) { complete = true; break; }
      if (!window.byteLength) throw invalid();
    }
    if (length !== null && Number(length) !== size) throw invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch {
    throw invalid();
  } finally {
    operation.signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    // HttpOperation.wait may reject before read/cancel settle. Keep ownership
    // until both have retired; the caller must retain its capacity meanwhile.
    await pending?.catch(() => undefined);
    await cancellation;
    reader?.releaseLock();
  }
}
