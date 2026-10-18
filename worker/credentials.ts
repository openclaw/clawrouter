import { normalizeTierList } from "./service-tiers.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import { authorityCall, listBindings, listCredentials, listPolicies, listUsers, selfServiceCredentialLimit } from "./authority";
import type { CredentialMutation, CredentialMutationResult } from "./authority-contracts.ts";
import type { AccessControlUser, AccessPolicyEntry, AccessSession, Env, ProxyCredential, ProxyCredentialEntry } from "./types";
import { cleanId, decodePathSegment, HttpError, normalizeEmail, privateJson, readJson } from "./utils";

export async function credentialMutationResponse(request: Request, env: Env, rest: string | null, session: AccessSession, scope: CredentialMutation["scope"]): Promise<Response> {
  const operation = rest === null ? "create" : rest.endsWith("/revoke") ? "revoke" : rest.endsWith("/rotate") ? "rotate" : "put";
  if (request.method !== (operation === "put" ? "PUT" : "POST")) throw new HttpError(405, "method_not_allowed", "credential method is not allowed");
  const body: Record<string, unknown> = operation === "revoke" ? {} : mutationObject(await readJson<unknown>(request));
  const rawId = rest === null ? body.credentialId : decodePathSegment(operation === "put" ? rest : rest.slice(0, -7));
  // New keys must satisfy proxy-key syntax; admin PUT retains its released ID contract.
  const keyIdRequired = scope === "personal" || operation === "create";
  const credentialId = typeof rawId === "string" ? (keyIdRequired ? proxyCredentialId(rawId) : cleanId(rawId)) : null;
  if (!credentialId) throw new HttpError(400, "invalid_credential", keyIdRequired ? "credential id must be 4-128 letters, digits, or underscores" : "invalid credential id");
  const actor = { auth: session.auth, email: session.email, role: session.role };
  const target = { credentialId, actor, scope };
  let mutation: CredentialMutation;
  if (operation === "revoke") mutation = { ...target, operation };
  else if (operation === "rotate") {
    if (Object.keys(body).some((key) => key !== "secretSha256")) throw new HttpError(400, "invalid_credential", "rotation accepts only secretSha256");
    mutation = { ...target, operation, secretSha256: credentialDigest(body.secretSha256) };
  } else mutation = { ...target, operation, credential: normalizeCredential(body, scope === "admin" && operation === "put") };
  // Close legacy imports before the owner checks collisions, holdings and quotas.
  // Imported snapshots never overwrite writes made while these reads are pending.
  await Promise.all([listCredentials(env), listPolicies(env), listUsers(env), ...(scope === "personal" ? [listBindings(env)] : [])]);
  const result = await authorityCall<CredentialMutationResult>(env, "/credentials/mutate", mutation);
  if (result.outcome === "invalid") throw new HttpError(result.status, result.code, result.message);
  if (result.outcome !== "updated") {
    const errors = {
      exists: [409, "credential_exists", "credential id already exists; choose another id"],
      missing: [404, "unknown_credential", "credential not found"],
      owned_elsewhere: [403, "credential_owned_elsewhere", "credential id belongs to another principal"],
      limit_reached: [409, "credential_limit_reached", `a principal may have at most ${selfServiceCredentialLimit} enabled credentials`],
      policy_not_held: [403, "credential_policy_not_held", "credential policy is not held by this session"],
      unknown_policy: [404, "unknown_policy", "credential policy does not exist"],
      inactive: [409, "credential_inactive", "only an active credential can be rotated"],
      actor_disabled: [403, "access_user_disabled", "the signed-in user is no longer enabled"],
      admin_required: [403, "access_admin_required", "administrator access is required"],
    } as const;
    const [status, code, message] = errors[result.outcome];
    throw new HttpError(status, code, message);
  }
  const response = credentialResponsesFrom(result.policy ? [result.policy] : [], [result.entry])[0];
  return privateJson({ ...response, principalEnabled: result.principalEnabled, active: response.active && result.principalEnabled }, operation === "create" ? 201 : 200);
}

export function credentialResponsesFrom(policyEntries: AccessPolicyEntry[], credentialEntries: ProxyCredentialEntry[], users: AccessControlUser[] = []) {
  const policies = new Map(policyEntries.map((entry) => [entry.policyId, entry.policy]));
  const disabled = new Set(users.filter((user) => user.record.enabled === false).map((user) => user.email));
  return credentialEntries.map((entry) => {
    const policy = policies.get(entry.credential.policyId), generationMatches = !!policy && entry.credential.policyGeneration === policy.generation;
    const principalEnabled = !entry.credential.principalId || !disabled.has(normalizeEmail(entry.credential.principalId) ?? "");
    return { credentialId: entry.credentialId, policyId: entry.credential.policyId, enabled: entry.credential.enabled, policyEnabled: policy?.enabled ?? false, generationMatches, principalEnabled, serviceTiers: entry.credential.serviceTiers ?? null, expiresAt: entry.credential.expiresAt ?? null, expired: credentialExpired(entry.credential), active: !credentialExpired(entry.credential) && entry.credential.enabled && !!policy?.enabled && generationMatches && principalEnabled, principalId: entry.credential.principalId ?? null };
  });
}

export function normalizeCredential(value: unknown, allowMissingDigest = false): Omit<ProxyCredential, "policyGeneration"> {
  const body = mutationObject(value);
  if (typeof body.policyId !== "string") throw new HttpError(400, "invalid_credential", "policyId must be a string");
  const policyId = cleanId(body.policyId);
  if (!policyId) throw new HttpError(400, "invalid_credential", "policyId is invalid");
  const secretSha256 = allowMissingDigest && body.secretSha256 === undefined ? "" : credentialDigest(body.secretSha256);
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== "boolean") throw new HttpError(400, "invalid_credential", "enabled must be a boolean");
  let principalId: string | null = null;
  if (body.principalId !== undefined && body.principalId !== null) {
    if (typeof body.principalId !== "string") throw new HttpError(400, "invalid_credential", "principalId must be an email or null");
    const candidate = body.principalId.trim();
    if (candidate) {
      principalId = normalizeEmail(candidate);
      if (!principalId) throw new HttpError(400, "invalid_credential", "principalId must be a valid email");
    }
  }
  return { enabled, secretSha256, policyId, principalId, ...(Object.hasOwn(body, "serviceTiers") ? { serviceTiers: body.serviceTiers == null ? null : normalizeTierList(body.serviceTiers, "invalid_credential") } : {}), ...(Object.hasOwn(body, "expiresAt") ? { expiresAt: body.expiresAt as string } : {}) };
}

function credentialDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new HttpError(400, "invalid_credential", "secretSha256 must be a SHA-256 hex digest");
  return value.toLowerCase();
}

function proxyCredentialId(value: string): string | null {
  const id = cleanId(value);
  return id && id.length >= 4 ? id : null;
}

function mutationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_credential", "credential must be a JSON object");
  return value as Record<string, unknown>;
}
