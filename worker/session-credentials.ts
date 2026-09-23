import { verifiedAccessSession } from "./access";
import { listCredentials, listPolicies } from "./authority";
import { credentialMutationResponse, credentialResponsesFrom } from "./credentials";
import { sameOrigin } from "./request-origin";
import type { AccessSession, Env } from "./types";
import { errorResponse, HttpError, normalizeEmail, privateJson } from "./utils";

export async function sessionCredentialsApi(request: Request, env: Env, path: string): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request, env)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
  return sessionCredentialsRequest(request, env, path, session);
}

export async function sessionCredentialsRequest(request: Request, env: Env, path: string, session: AccessSession): Promise<Response> {
  try {
    const collection = "/v1/session/credentials";
    if (request.method === "GET" && path === collection) {
      const [entries, policies] = await Promise.all([listCredentials(env), listPolicies(env)]);
      const own = entries.filter((entry) => normalizeEmail(entry.credential.principalId ?? "") === normalizeEmail(session.email));
      const credentials = credentialResponsesFrom(policies, own).map(({ credentialId, policyId, enabled, active }) => ({ credentialId, policyId, enabled, active }));
      return privateJson({ credentials });
    }
    if (path !== collection && !path.startsWith(`${collection}/`)) throw new HttpError(404, "route_not_found", "session credential route not found");
    return await credentialMutationResponse(request, env, path === collection ? null : path.slice(collection.length + 1), session, "personal");
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
    return errorResponse("session_credential_error", "session credential request failed", 500);
  }
}
