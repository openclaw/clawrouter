import type { Env } from "./types";

// Only public, content-hashed build artifacts. Never map request-content keys,
// arbitrary R2 paths, source maps, or HTML into this unauthenticated route.
export const consoleAssetPattern = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|gif|ico)$/;
export async function consoleAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const path = new URL(request.url).pathname;
  if (response.status !== 404 || !consoleAssetPattern.test(path) || !env.CONTENT_ARCHIVE) return response;
  const object = await env.CONTENT_ARCHIVE.get(`console-assets/v1${path}`);
  if (!object) return response;
  await response.body?.cancel();
  const headers = new Headers({ "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
