// Shared only by the concrete protocol wrappers. No I/O or durable state here.
export const managedMediaEnvelopeBytes = 1024 * 1024;

export function mediaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalMediaBase64(value: unknown, limit: number, fail: () => never): { base64: string; decodedBytes: number } {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(limit / 3) * 4
    || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail();
  const standard = value.replace(/-/g, "+").replace(/_/g, "/"), unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || standard.includes("=") && standard.length % 4) fail();
  const canonical = unpadded + "=".repeat((4 - unpadded.length % 4) % 4), tail = canonical.slice(-4);
  if (standard.includes("=") && standard !== canonical || btoa(atob(tail)) !== tail) fail();
  const decodedBytes = Math.floor(unpadded.length * 3 / 4);
  if (decodedBytes > limit) fail();
  return { base64: canonical, decodedBytes };
}

export function exactMediaParams(params: Record<string, string>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(params, key))
    || Object.keys(params).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid_managed_media_params");
}

export function noMediaQuery(query: URLSearchParams): void {
  if (query.size) throw new Error("unsupported_managed_media_query");
}

export async function readMediaJson(response: Response, allowed: (status: number) => boolean = status => status >= 200 && status < 300): Promise<{
  text: string; body: Record<string, unknown>;
}> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (response.redirected || !allowed(response.status) || mime !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_managed_media_response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > managedMediaEnvelopeBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("managed_media_response_too_large");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > managedMediaEnvelopeBytes) throw new Error("managed_media_response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!mediaObject(body)) throw new Error("invalid_managed_media_envelope");
    return { text, body };
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("invalid_managed_media_envelope");
  } finally { reader.releaseLock(); }
}

export function mediaPublicPath(path: string | undefined): string {
  if (typeof path !== "string" || !/^\/(?!\/)[a-zA-Z0-9_/-]+(?:\?[a-zA-Z0-9_=&-]+)?$/.test(path)) {
    throw new Error("invalid_managed_media_public_path");
  }
  return path;
}

export function dropMediaControlUrls(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  for (const key of ["urls", "links", "_links", "status_url", "response_url", "cancel_url", "stream_url"]) delete copy[key];
  return copy;
}
