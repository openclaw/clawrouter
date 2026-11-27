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
