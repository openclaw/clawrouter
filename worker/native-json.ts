import { inputRetirement, type InputRetirement } from "./input-retirement.ts";

export interface NativeJsonInputHooks {
  registerInput?: (owner: InputRetirement, response: Response) => void;
  // Borrowed only for synchronous counting; callers must not retain the chunk.
  observeChunk?: (chunk: Uint8Array) => void;
}

// Keep protocol observation inside the reader lifetime so invalid envelopes
// cancel delivery before releasing the lock and abort listener.
export async function readNativeJson<T>(
  response: Response, signal: AbortSignal, maxBytes: number,
  observe: (body: unknown) => T, fail: (reason: string) => never,
  hooks?: NativeJsonInputHooks,
): Promise<T> {
  if (!response.body) fail("http");
  if (hooks?.registerInput && (response.bodyUsed || response.body.locked)) fail("http");
  const reader = response.body.getReader(), input = inputRetirement(reader);
  try { hooks?.registerInput?.(input, response); }
  catch (error) { await input.retire("cancel", error); throw error; }
  const retire = (kind: "eof" | "cancel", reason: unknown, preserveFailure: boolean) => input.retire(kind, reason).catch(error => {
    // Registered owners retain the separate failed retirement certificate.
    // Cleanup must not replace an already-known parsing/header/read rejection.
    if (!preserveFailure || !hooks?.registerInput) throw error;
  });
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    await retire("cancel", signal.reason, true); return fail("http");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, body = "", eof = false, failed = false;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await input.read(() => reader.read()); signal.throwIfAborted(); if (chunk.done) { eof = true; break; }
      hooks?.observeChunk?.(chunk.value);
      size += chunk.value.byteLength; if (size > maxBytes) fail("size");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    return observe(JSON.parse(body));
  } catch { failed = true; await retire(eof ? "eof" : "cancel", signal.reason, true); return fail("response"); }
  finally { signal.removeEventListener("abort", abort); await retire(eof ? "eof" : "cancel", signal.reason, failed); }
}
