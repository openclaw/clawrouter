// Token responses are private, bounded and fully consumed before decoding.
// Never expose provider text through an error or release a refresh fence on a
// malformed response: the provider may already have rotated the token.
export async function readMiniMaxTokenBody(response: Response, signal: AbortSignal): Promise<string> {
  const fail = () => { throw new Error("invalid_minimax_token_response"); };
  const length = response.headers.get("content-length"), limit = 8192;
  if (!response.body || response.redirected || response.status >= 300 && response.status < 400
    || response.headers.has("content-range") || ![null, "identity"].includes(response.headers.get("content-encoding"))
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined); return fail();
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, reads = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      if (++reads > 8192 || size + chunk.value.byteLength > limit) fail();
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (length !== null && Number(length) !== size) fail();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch {
    await reader.cancel().catch(() => undefined); return fail();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
