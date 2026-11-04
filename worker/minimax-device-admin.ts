import { sameOrigin } from "./request-origin.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, sha256Hex } from "./utils.ts";

export type MiniMaxDeviceInput =
  | { flow: "minimax-device.v1"; provider: "minimax"; operation: "begin"; region: "global" | "cn";
      intentId: string; expectedGeneration: number; replacesAttemptId?: string; priority: number; weight: number }
  | { flow: "minimax-device.v1"; provider: "minimax"; operation: "poll" | "cancel" | "status"; attemptId: string };

export function readMiniMaxDeviceInput(value: Record<string, unknown>): MiniMaxDeviceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const begin = value.operation === "begin";
  const allowed = begin ? ["flow", "provider", "operation", "region", "intentId", "expectedGeneration", "replacesAttemptId", "priority", "weight"]
    : ["flow", "provider", "operation", "attemptId"];
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
  if (value.flow !== "minimax-device.v1" || value.provider !== "minimax" || Object.keys(value).some(key => !allowed.includes(key))
    || !["begin", "poll", "cancel", "status"].includes(value.operation as string)) invalid();
  if (!begin) {
    if (!id(value.attemptId)) invalid();
    return value as MiniMaxDeviceInput;
  }
  const priority = value.priority ?? 100, weight = value.weight ?? 1;
  if (!["global", "cn"].includes(value.region as string) || !id(value.intentId)
    || !Number.isSafeInteger(value.expectedGeneration) || (value.expectedGeneration as number) < 0
    || value.replacesAttemptId !== undefined && !id(value.replacesAttemptId)
    || !Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000
    || typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) invalid();
  return { ...value, priority, weight } as MiniMaxDeviceInput;
}

function invalid(): never { throw new HttpError(400, "invalid_minimax_device_request", "Invalid MiniMax device operation"); }

// Re-verify the original signed Access session and current user authority at
// each owner phase. An admin token, proxy key or caller-supplied actor is not it.
export async function miniMaxDeviceAdmin(request: Request, env: Env, expected?: string): Promise<string> {
  request.signal.throwIfAborted();
  if (!request.headers.has("origin") || !sameOrigin(request, env))
    throw new HttpError(403, "access_csrf_required", "Same-origin browser request required");
  const { authorizeAdmin } = await import("./access.ts");
  const session = await authorizeAdmin(request, env);
  if (session instanceof Response || session.auth !== "cloudflare_access" || session.role !== "admin")
    throw new HttpError(403, "access_admin_required", "Verified Access administrator required");
  const actor = await sha256Hex(JSON.stringify([session.auth, session.email, session.subject, new URL(request.url).origin]));
  request.signal.throwIfAborted();
  if (expected !== undefined && actor !== expected) throw new HttpError(403, "minimax_device_owner_mismatch", "Device attempt belongs to another administrator");
  return actor;
}

export async function miniMaxDeviceAuthorize(request: Request, env: Env, key: string, value: Record<string, unknown>): Promise<Response> {
  const input = readMiniMaxDeviceInput(value);
  await miniMaxDeviceAdmin(request, env);
  const headers = new Headers();
  for (const name of ["cf-access-jwt-assertion", "origin", "sec-fetch-site", "x-forwarded-host", "x-forwarded-proto"])
    if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
  const owner = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(key));
  const response = await owner.fetch("https://clawrouter.internal/minimax-device", { method: "POST", headers,
    body: JSON.stringify({ key, sourceUrl: request.url, input }), signal: request.signal });
  // The owner returns only a closed, secret-free projection, including errors.
  await miniMaxDeviceAdmin(request, env);
  return new Response(response.body, { status: response.status, headers: privateJson({}).headers });
}
