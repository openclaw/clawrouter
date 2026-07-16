import { sameOrigin, sessionPolicies, verifiedAccessSession } from "./access";
import { authorityCall, listCredentials, listPolicies } from "./authority";
import { credentialResponsesFrom, normalizeCredential, selfServiceCredentialId } from "./credentials";
import type { AccessSession, Env, ProxyCredentialEntry } from "./types";
import { errorResponse, HttpError, privateJson, readJson } from "./utils";

const selfServiceCredentialLimit = 10;
const selfServiceCredentialRetentionLimit = 100;

type GuardedCredentialPutResult = { outcome: "updated" | "owned_elsewhere" | "limit_reached" | "missing" };

export async function sessionCredentialsApi(request: Request, env: Env, path: string): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
  return sessionCredentialsRequest(request, env, path, session);
}

export async function sessionCredentialsRequest(request: Request, env: Env, path: string, session: AccessSession): Promise<Response> {
  try {
    const [policies, canonicalPolicies] = await Promise.all([sessionPolicies(session, env), listPolicies(env)]);
    // Seed legacy KV credentials before guarded writes so ownership checks see the complete set.
    const entries = await listCredentials(env);
    if (request.method === "GET" && path === "/v1/session/credentials") {
      const own = entries.filter((entry) => entry.credential.principalId === session.email);
      const credentials = credentialResponsesFrom(canonicalPolicies, own).map(({ credentialId, policyId, enabled, active }) => ({ credentialId, policyId, enabled, active }));
      return privateJson({ credentials });
    }

    const prefix = "/v1/session/credentials/";
    if (!path.startsWith(prefix)) throw new HttpError(404, "route_not_found", "session credential route not found");
    const rest = path.slice(prefix.length), revoke = rest.endsWith("/revoke");
    const encodedId = revoke ? rest.slice(0, -7) : rest;
    let decodedId: string;
    try { decodedId = decodeURIComponent(encodedId); }
    catch { throw new HttpError(400, "invalid_credential", "invalid credential id"); }
    const id = selfServiceCredentialId(decodedId);
    if (!id) throw new HttpError(400, "invalid_credential", "credential id must be 4-128 letters, digits, or underscores");

    if (revoke && request.method !== "POST") throw new HttpError(405, "method_not_allowed", "session credential revoke requires POST");
    if (revoke) {
      const existing = entries.find((entry) => entry.credentialId === id);
      if (!existing) throw new HttpError(404, "unknown_credential", "credential not found");
      const entry: ProxyCredentialEntry = { credentialId: id, credential: { ...existing.credential, enabled: false } };
      const result = await guardedPut(env, entry, session.email, true);
      assertGuardedOutcome(result);
      return privateJson(credentialResponsesFrom(canonicalPolicies, [entry])[0]);
    }

    if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "session credential method is not allowed");
    const body = normalizeCredential(await readJson<unknown>(request));
    const policy = policies.find((entry) => entry.policyId === body.policyId);
    if (!policy) throw new HttpError(403, "credential_policy_not_held", "credential policy is not held by this session");
    const entry: ProxyCredentialEntry = {
      credentialId: id,
      credential: { enabled: true, secretSha256: body.secretSha256, policyId: policy.policyId, policyGeneration: policy.policy.generation, principalId: session.email },
    };
    const result = await guardedPut(env, entry, session.email, false);
    assertGuardedOutcome(result);
    return privateJson(credentialResponsesFrom(canonicalPolicies, [entry])[0]);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
    return errorResponse("session_credential_error", "session credential request failed", 500);
  }
}

async function guardedPut(env: Env, entry: ProxyCredentialEntry, principalId: string, requireExisting: boolean): Promise<GuardedCredentialPutResult> {
  return authorityCall(env, "/credentials/put", { ...entry, guard: { principalId, maxEnabled: selfServiceCredentialLimit, maxTotal: selfServiceCredentialRetentionLimit, requireExisting } });
}

function assertGuardedOutcome(result: GuardedCredentialPutResult): void {
  if (result.outcome === "updated") return;
  if (result.outcome === "owned_elsewhere") throw new HttpError(403, "credential_owned_elsewhere", "credential id belongs to another principal");
  if (result.outcome === "limit_reached") throw new HttpError(409, "credential_limit_reached", `a principal may have at most ${selfServiceCredentialLimit} enabled credentials`);
  throw new HttpError(404, "unknown_credential", "credential not found");
}
