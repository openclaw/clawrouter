export async function readProviderJson<T>(
  response: Response, signal: AbortSignal, limit: number,
  observe: (value: unknown) => T, fail: () => never,
): Promise<T> {
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > limit) {
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
      if (bytes > limit) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return observe(JSON.parse(text));
  } catch { void reader.cancel().catch(() => undefined); fail(); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
