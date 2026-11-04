import { inputRetirement } from "./input-retirement.ts";

// Keep protocol observation inside the reader lifetime so invalid envelopes
// cancel delivery before releasing the lock and abort listener.
export async function readNativeJson<T>(
  response: Response, signal: AbortSignal, maxBytes: number,
  observe: (body: unknown) => T, fail: (reason: string) => never,
): Promise<T> {
  if (!response.body) fail("http");
  const reader = response.body.getReader(), input = inputRetirement(reader);
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    await input.retire("cancel", signal.reason); return fail("http");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, body = "", eof = false;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await input.read(() => reader.read()); signal.throwIfAborted(); if (chunk.done) { eof = true; break; }
      size += chunk.value.byteLength; if (size > maxBytes) fail("size");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    return observe(JSON.parse(body));
  } catch { await input.retire(eof ? "eof" : "cancel", signal.reason); return fail("response"); }
  finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}
