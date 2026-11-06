import { effectiveBudgetPolicy } from "./budget-overrides.ts";
import { recordAdmissionDuration } from "./admission-timing.ts";
import { policyAllowsModel } from "./policy-models.ts";
import { fetchTimeoutSignal } from "../shared/fetch-timeout.ts";
import { admitAccessBase64, accessBase64Bytes, accessBase64Size, accessDenial, accessJwtParts, accessLimits, isAccessDenial, parseAccessJson } from "./access-json.ts";
import { readAccessJwks } from "./access-response.ts";
import { HttpOperation } from "./http-operation.ts";
import { authorityCall, resolveBindings, resolvePolicies, resolveUsers } from "./authority";
import { assignmentEvidenceFromAccessIdentity } from "./assignment-evaluator";
import { listAssignmentRules, reconcileUserAssignments } from "./assignments";
import { selectProviderPolicy } from "./grant-selection";
import { localSession, localSessionVerification, type LocalSessionVerification } from "./local-auth";
import { sameOrigin } from "./request-origin";
import type { AccessControlUser, AccessPolicyEntry, AccessSession, AuthorizedIdentity, Env } from "./types";
import { commaSet, errorResponse, normalizeEmail, parseBearer, safeEqual, sha256Hex } from "./utils";

interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}

export type AccessVerification = LocalSessionVerification | { readonly kind: "cloudflare_access"; readonly email: string; readonly expiresAtMs: number };
const verifiedSessions = new WeakMap<AccessSession, AccessVerification>();
const verifiedIdentities = new WeakMap<AuthorizedIdentity, AccessVerification>();
export function accessIdentityVerification(identity: AuthorizedIdentity): AccessVerification | undefined { return verifiedIdentities.get(identity); }

export async function verifiedAccessSession(request: Request, env: Env): Promise<AccessSession | null> {
  return (await cloudflareAccessSession(request, env)) ?? localSession(request, env);
}

async function cloudflareAccessSession(request: Request, env: Env): Promise<AccessSession | null> {
  const headers = request.headers;
  const assertion = headers.get("cf-access-jwt-assertion");
  if (assertion === null) return null;
  const payload = await verifyAccessJwt(assertion, env.CLAWROUTER_ACCESS_TEAM_DOMAIN ?? "", env.CLAWROUTER_ACCESS_AUD ?? "", request.signal);
  const email = payload?.email ? normalizeEmail(payload.email) : null;
  if (!payload || !email) return null;
  const role = adminRole(email, env) ? "admin" : "user";
  let user = (await resolveUsers(env, [email]))[0];
  if (!user) {
    user = await authorityCall<AccessControlUser>(env, "/users/create", { email, record: { role: "user", tenantId: env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default", enabled: true, groups: [], contentRetentionDisabled: false } });
  }
  const rules = await listAssignmentRules(env);
  const hasGithubRules = rules.some((rule) => rule.enabled && ["github_org", "github_team"].includes(rule.kind));
  const evidence = hasGithubRules ? await verifiedGithubEvidence(request, email) : undefined;
  if (!user.record.assignmentState || evidence) user = (await reconcileUserAssignments(user, rules, env, evidence, !!evidence)).user;
  if (user.record.enabled === false) return null;
  const session: AccessSession = {
    authenticated: true,
    auth: "cloudflare_access",
    role,
    email,
    subject: payload.sub ?? null,
    tenantId: user.record.tenantId ?? env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default",
    groups: [...new Set(user.record.groups ?? [])].sort(),
    contentRetentionDisabled: user.record.contentRetentionDisabled ?? false,
    budgetOverrides: user.record.budgetOverrides,
  };
  verifiedSessions.set(session, Object.freeze({ kind: "cloudflare_access", email, expiresAtMs: payload.exp! * 1000 }));
  return session;
}

export async function accessIdentity(request: Request, env: Env, providerId?: string, requirement?: import("./provider-auth").GrantRequirement): Promise<AuthorizedIdentity | Response> {
  const started = performance.now();
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  const identity = await accessSessionIdentity(session, env, providerId, requirement);
  if (!(identity instanceof Response)) recordAdmissionDuration(identity, started);
  return identity;
}

export async function accessSessionIdentity(session: AccessSession, env: Env, providerId?: string, requirement?: import("./provider-auth").GrantRequirement): Promise<AuthorizedIdentity | Response> {
  const started = performance.now();
  const matching = (await sessionPolicies(session, env)).filter((entry) => !providerId || !entry.policy.providers.length || entry.policy.providers.includes(providerId));
  if (!matching.length) return errorResponse("access_policy_required", "this identity has no active access policy", 403);
  const modelId = requirement?.model ? requirement.provider.models.find(model => model.id === requirement.model || model.upstream === requirement.model)?.id ?? requirement.model : null;
  const requiresModel = requirement && (requirement.endpoint.request_format === "cloudflare_ai_gateway.universal"
    || requirement.provider.capabilities.some(capability => capability.endpoint === requirement.endpoint.id && capability.id.startsWith("llm.")));
  const eligible = modelId ? matching.filter(entry => policyAllowsModel(entry.policy, providerId!, modelId))
    : requiresModel ? matching.filter(entry => entry.policy.models == null) : matching;
  if (!eligible.length) return errorResponse("model_not_allowed", "model is not allowed by this identity's policies", 403);
  const selected = providerId ? await selectProviderPolicy(eligible, providerId, env, requirement) : eligible[0];
  const identity = sessionPolicyIdentity(session, selected);
  recordAdmissionDuration(identity, started);
  return identity;
}

export function sessionPolicyIdentity(session: AccessSession, entry: AccessPolicyEntry): AuthorizedIdentity {
  const identity: AuthorizedIdentity = { ...entry, credentialId: null, principalId: session.email, authType: "access", contentRetentionDisabled: session.contentRetentionDisabled };
  const proof = verifiedSessions.get(session) ?? localSessionVerification(session);
  if (proof) verifiedIdentities.set(identity, proof);
  return identity;
}

export async function sessionPolicies(session: AccessSession, env: Env): Promise<AccessPolicyEntry[]> {
  const bindings = (await resolveBindings(env, [
    { principalType: "user", principalId: session.email },
    ...session.groups.map((group) => ({ principalType: "group" as const, principalId: group })),
  ])).filter((binding) => binding.enabled).sort((a, b) => a.priority - b.priority);
  const entries = await resolvePolicies(env, [...new Set(bindings.map((binding) => binding.policyId))]);
  const byId = new Map(entries.map((entry) => [entry.policyId, entry]));
  return [...new Set(bindings.map((binding) => binding.policyId))].flatMap((id) => {
    const entry = byId.get(id);
    return entry?.policy.enabled ? [{ ...entry, policy: effectiveBudgetPolicy(id, entry.policy, session.budgetOverrides) }] : [];
  });
}

export async function authorizeAdmin(request: Request, env: Env): Promise<AccessSession | Response> {
  const session = await verifiedAccessSession(request, env);
  if (session) {
    if (session.role !== "admin") return errorResponse("access_admin_required", "administrator access is required", 403);
    if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request, env)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
    return session;
  }
  const token = parseBearer(request.headers);
  const expected = env.CLAWROUTER_ADMIN_TOKEN_SHA256?.toLowerCase();
  if (!token || !expected || !safeEqual(await sha256Hex(token), expected)) return errorResponse("admin_unauthorized", "administrator authentication required", 401);
  return {
    authenticated: true,
    auth: "admin_token",
    role: "admin",
    email: "token-admin",
    subject: null,
    tenantId: "default",
    groups: [],
    contentRetentionDisabled: true,
  };
}

export function publicSession(session: AccessSession): Omit<AccessSession, "contentRetentionDisabled"> {
  const { contentRetentionDisabled: _, budgetOverrides: _overrides, ...visible } = session;
  return visible;
}

function adminRole(email: string, env: Env): boolean {
  if (commaSet(env.CLAWROUTER_ACCESS_ADMIN_EMAILS).has(email)) return true;
  const domain = email.split("@")[1];
  return !!domain && commaSet(env.CLAWROUTER_ACCESS_ADMIN_DOMAINS).has(domain);
}

async function verifiedGithubEvidence(request: Request, email: string) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  const url = new URL("/cdn-cgi/access/get-identity", request.url);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", cookie }, redirect: "manual", signal: fetchTimeoutSignal(request.signal) });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.length > 64 * 1024) return undefined;
    return assignmentEvidenceFromAccessIdentity(JSON.parse(body), email);
  } catch {
    return undefined;
  }
}

function inspectAssertion(token: string): { parts: readonly [string, string, string]; header: Record<string, unknown>; payload: AccessJwtPayload } | null {
  const offsets = accessJwtParts(token);
  if (!offsets) return null;
  const parts = [token.slice(0, offsets[0]), token.slice(offsets[0] + 1, offsets[1]), token.slice(offsets[1] + 1)] as const;
  // All three resource admissions precede ANY malformed-credential return.
  admitAccessBase64(parts[0], accessLimits.header);
  admitAccessBase64(parts[1], accessLimits.payload);
  admitAccessBase64(parts[2], accessLimits.signature);
  let header: unknown, payload: unknown, invalid = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try { header = parseAccessJson(decoder.decode(accessBase64Bytes(parts[0], accessLimits.header)), "header"); }
  catch (error) { if (isAccessDenial(error)) throw error; invalid = true; }
  try { payload = parseAccessJson(decoder.decode(accessBase64Bytes(parts[1], accessLimits.payload)), "payload"); }
  catch (error) { if (isAccessDenial(error)) throw error; invalid = true; }
  try { accessBase64Size(parts[2], accessLimits.signature); }
  catch (error) { if (isAccessDenial(error)) throw error; invalid = true; }
  if (invalid || !record(header) || !record(payload)) return null;
  return { parts, header, payload };
}

export async function verifyAccessJwt(token: string, teamDomain: string, expectedAud: string, signal?: AbortSignal): Promise<AccessJwtPayload | null> {
  // One original 30s deadline starts at assertion entry, before preflight,
  // configuration fallback or normalization, and includes physical retirement.
  // External error objects never become an internally classified cleanup cause.
  const deadlineAt = Date.now() + 30_000, deadline = fetchTimeoutSignal(signal), bounded = new AbortController();
  const cancel = () => bounded.abort(accessDenial("deadline"));
  if (deadline.aborted) cancel(); else deadline.addEventListener("abort", cancel, { once: true });
  const operation = new HttpOperation(bounded.signal);
  const current = () => { if (operation.signal.aborted || Date.now() >= deadlineAt) throw accessDenial("deadline"); };
  let importing: Promise<CryptoKey | null> | undefined, verifying: Promise<boolean> | undefined;
  try {
    current();
    const admitted = inspectAssertion(token);
    current();
    if (!admitted) return null;
    if (teamDomain.length > 1024 || expectedAud.length > 1024) throw accessDenial("limit");
    if (!teamDomain || !expectedAud) return null;
    const { parts, header, payload } = admitted;
    teamDomain = teamDomain.trim().replace(/^https?:\/\//i, "");
    const suffix = teamDomain.search(/[/?#]/);
    teamDomain = (suffix < 0 ? teamDomain : teamDomain.slice(0, suffix)).toLowerCase();
    current();
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || !validPayload(payload, teamDomain, expectedAud)) return null;
    let candidate: AccessJwtPayload | null = null;
    try { candidate = await (async () => {
      current();
      const jwks = await readAccessJwks(`https://${teamDomain}/cdn-cgi/access/certs`, operation);
      current();
      if (!record(jwks) || !Array.isArray(jwks.keys)) return null;
      if (jwks.keys.length > accessLimits.keys) throw accessDenial("limit");
      // Bound ALL complete rows before selecting the FIRST matching RSA key.
      for (const candidate of jwks.keys) if (record(candidate) && candidate.kty === "RSA") {
        if (typeof candidate.n === "string") accessBase64Size(candidate.n, 1024);
        if (typeof candidate.e === "string") accessBase64Size(candidate.e, 8);
      }
      const key = jwks.keys.find(candidate => record(candidate) && candidate.kid === header.kid && candidate.kty === "RSA");
      if (!key) return null;
      current();
      // Retain the COMPLETE bounded JWK, including alg/key_ops/ext. Import failure
      // cannot retry a later duplicate kid or reconstruct more permissive metadata.
      let importKey!: (key: CryptoKey | null) => void;
      importing = new Promise(resolve => { importKey = resolve; });
      try { crypto.subtle.importKey("jwk", key as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]).then(importKey, () => importKey(null)); }
      catch { importKey(null); }
      const cryptoKey = await operation.wait(importing);
      current(); if (!cryptoKey) return null;
      const signature = accessBase64Bytes(parts[2], accessLimits.signature);
      // Verification uses the original encoded segments, never reserialized JSON.
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      let verify!: (value: boolean) => void;
      verifying = new Promise(resolve => { verify = resolve; });
      try { crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signed).then(verify, () => verify(false)); }
      catch { verify(false); }
      const valid = await operation.wait(verifying);
      current();
      return valid ? payload : null;
    })(); } catch (error) {
      if (operation.signal.aborted || Date.now() >= deadlineAt) throw accessDenial("deadline");
      if (isAccessDenial(error)) throw error;
      candidate = null;
    } finally {
      // A deadline is not retirement. Import/verify may settle later; join them.
      await importing; await verifying;
    }
    current();
    return candidate && validPayload(candidate, teamDomain, expectedAud) ? candidate : null;
  } finally {
    deadline.removeEventListener("abort", cancel); operation.stop("complete");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validPayload(payload: AccessJwtPayload, teamDomain: string, expectedAud: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iss !== "string" || payload.iss.length > 1024
    || payload.sub !== undefined && (typeof payload.sub !== "string" || payload.sub.length > 1024)
    || payload.email !== undefined && (typeof payload.email !== "string" || payload.email.length > 320)
    || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || !Number.isFinite(payload.exp * 1000)
    || payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf))
    || payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat))) return false;
  const aud = payload.aud;
  if (typeof aud !== "string" && !Array.isArray(aud)) return false;
  if (Array.isArray(aud) && (aud.length > 32 || aud.some(value => typeof value !== "string" || value.length > 1024))) return false;
  if (typeof aud === "string" && aud.length > 1024) return false;
  return (typeof aud === "string" ? aud === expectedAud : aud.includes(expectedAud))
    && payload.iss.replace(/\/$/, "") === `https://${teamDomain}` && payload.exp > now
    && (payload.nbf === undefined || payload.nbf <= now + 30) && (payload.iat === undefined || payload.iat <= now + 300);
}
