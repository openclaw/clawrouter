// Operational quarantine bounds, not provider model or billing facts. The
// established 32 MiB NativeResponse lease charges 64 MiB in the shared pool.
export const decisionResponseBytes = 2 * 1024 * 1024;
const responseChunks = 8192;
const responseContainers = 4096;

export function boundedDecisionJson(value: unknown, depth = 0, count = { containers: 0 }): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ++count.containers > responseContainers) return false;
  if (Array.isArray(value)) return value.every(item => boundedDecisionJson(item, depth + 1, count));
  for (const key in value) {
    if (Object.hasOwn(value, key) && !boundedDecisionJson(Reflect.get(value, key), depth + 1, count)) return false;
  }
  return true;
}

export function boundedDecisionResponse(response: Response, signal: AbortSignal, fail: () => never): Response {
  const mime = response.headers.get("content-type"), encoding = response.headers.get("content-encoding");
  if (signal.aborted || response.status !== 200 || response.redirected || !response.body
    || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
    || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    void response.body?.cancel().catch(() => undefined); fail();
  }
  let bytes = 0, chunks = 0, containers = 0, depth = 0, quoted = false, escaped = false;
  // A demand-driven counting transform retains no chunk archive. Count empty
  // chunks too; a zero-byte producer cannot evade the bounded read work.
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (++chunks > responseChunks || bytes > decisionResponseBytes) fail();
      // Bound structural allocations before JSON.parse. This is only a limit
      // scanner; readNativeJson still owns fatal UTF-8 and complete JSON syntax.
      for (const byte of chunk) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quoted = false;
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
          if (depth++ > 64 || ++containers > responseContainers) fail();
        } else if (byte === 125 || byte === 93) depth--;
      }
      controller.enqueue(chunk);
    },
  }), { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, headers });
}
