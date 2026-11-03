// Protocol validation stays inside the reader lifetime so rejected envelopes
// cancel delivery before the lock and abort listener are released.
export async function readGoogleJson<T>(
  response: Response, signal: AbortSignal, maxBytes: number,
  observe: (body: unknown) => T, fail: () => never,
): Promise<T> {
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => undefined); fail();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) fail();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return observe(JSON.parse(text));
  } catch {
    void reader.cancel().catch(() => undefined); fail();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
