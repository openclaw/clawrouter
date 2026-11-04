import { inputRetirement } from "./input-retirement.ts";

// Protocol validation stays inside the reader lifetime so rejected envelopes
// cancel delivery before the lock and abort listener are released.
export async function readGoogleJson<T>(
  response: Response, signal: AbortSignal, maxBytes: number,
  observe: (body: unknown) => T, fail: () => never,
): Promise<T> {
  if (!response.body) fail();
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > maxBytes) {
    await input.retire("cancel", signal.reason); return fail();
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", bytes = 0, eof = false;
  try {
    for (;;) {
      const part = await input.read(() => reader.read());
      if (signal.aborted) fail();
      if (part.done) { eof = true; break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return observe(JSON.parse(text));
  } catch {
    await input.retire(eof ? "eof" : "cancel", signal.reason); return fail();
  } finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}
