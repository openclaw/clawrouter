import assert from "node:assert/strict";
import { isAccessRedirect } from "./smoke-access-gate.mjs";

// Overrides can silently fall back. Every response from the Worker must prove
// the selected version, not just the release number shared by many commits.
export function createVersionFetch({ baseUrl, versionId, workerName, fetchImpl = fetch }) {
  const origin = new URL(baseUrl).origin;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(versionId)) throw new Error("invalid smoke Worker version id");
  if (!/^[a-zA-Z0-9_-]+$/.test(workerName)) throw new Error("invalid smoke Worker name");
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) return fetchImpl(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Cloudflare-Workers-Version-Overrides", `${workerName}="${versionId}"`);
    // Never follow redirects with the override (or a smoke credential). The
    // caller's normal redirect/Access assertions still validate each response.
    const response = await fetchImpl(input, { ...init, headers, redirect: "manual" });
    const actual = response.headers.get("x-clawrouter-version-id");
    const protectedPath = /^\/(?:dashboard(?:\/|$)|v1\/(?:session(?:\/|$)|playground(?:\/|$)|admin(?:\/|$)|oauth\/callback$))/.test(url.pathname);
    const accessChallenge = protectedPath && !actual && (
      (response.status >= 300 && response.status < 400 && isAccessRedirect(response.headers.get("location") ?? "", url)) ||
      ([401, 403].includes(response.status) && response.headers.get("content-type")?.includes("text/html"))
    );
    if (!accessChallenge) {
      try { assert.equal(actual, versionId, `Worker version override not honored for ${url.pathname}`); }
      catch (error) { await response.body?.cancel(); throw error; }
    }
    return response;
  };
}
