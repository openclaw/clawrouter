import type { Env } from "./types";

export function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  if (origin === new URL(request.url).origin) return true;
  const externalOrigin = trustedExternalOrigin(request, env);
  return externalOrigin !== null && origin === externalOrigin;
}

export function trustedExternalOrigin(request: Request, env: Env): string | null {
  const configured = configuredPublicOrigin(env);
  if (!configured) return null;
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  if (!forwardedProto || !forwardedHost || !["http", "https"].includes(forwardedProto)) return null;
  try {
    const forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
    if (forwarded.username || forwarded.password || forwarded.pathname !== "/" || forwarded.search || forwarded.hash) return null;
    return forwarded.origin === configured ? configured : null;
  } catch {
    return null;
  }
}

function configuredPublicOrigin(env: Env): string | null {
  const value = typeof env.CLAWROUTER_PUBLIC_ORIGIN === "string" ? env.CLAWROUTER_PUBLIC_ORIGIN.trim() : "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim().toLowerCase();
  return first || null;
}
