import type { SessionResponse } from "./ui-types";

export interface SessionScope {
  origin: string;
  demo: boolean;
  session: SessionResponse;
  epoch: number;
}

export type CapturedSessionScope = SessionScope & { isCurrent: () => boolean };

export function sessionScopeKey({ origin, demo, session }: Omit<SessionScope, "epoch">): string {
  return JSON.stringify([origin, demo, session.auth, session.subject ?? null, session.email ?? null, session.tenantId ?? null, session.role, session.authenticated]);
}

export function browserSession(value: unknown): value is SessionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return session.authenticated === true
    && (session.auth === "local" || session.auth === "cloudflare_access")
    && (session.role === "admin" || session.role === "user")
    && typeof session.email === "string" && Boolean(session.email.trim())
    && (session.subject == null || typeof session.subject === "string")
    && (session.tenantId == null || typeof session.tenantId === "string");
}
