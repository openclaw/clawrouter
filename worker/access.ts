import { authorityCall, resolveBindings, resolvePolicies, resolveUsers } from "./authority";
import { assignmentEvidenceFromAccessIdentity } from "./assignment-evaluator";
import { listAssignmentRules, reconcileUserAssignments } from "./assignments";
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

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }

export async function verifiedAccessSession(request: Request, env: Env): Promise<AccessSession | null> {
  const headers = request.headers;
  const assertion = headers.get("cf-access-jwt-assertion");
  if (!assertion || !env.CLAWROUTER_ACCESS_TEAM_DOMAIN || !env.CLAWROUTER_ACCESS_AUD) return null;
  const payload = await verifyAccessJwt(assertion, env.CLAWROUTER_ACCESS_TEAM_DOMAIN, env.CLAWROUTER_ACCESS_AUD);
  const email = payload?.email ? normalizeEmail(payload.email) : null;
  if (!payload || !email) return null;
  const role = adminRole(email, env) ? "admin" : "user";
  let user = (await resolveUsers(env, [email]))[0];
  if (!user) {
    user = { email, record: { role: "user", tenantId: env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default", enabled: true, groups: [], contentRetentionDisabled: false } };
    await authorityCall(env, "/users/put", user);
  }
  const rules = await listAssignmentRules(env);
  const hasGithubRules = rules.some((rule) => rule.enabled && ["github_org", "github_team"].includes(rule.kind));
  const evidence = hasGithubRules ? await verifiedGithubEvidence(request, email) : undefined;
  if (!user.record.assignmentState || evidence) user = (await reconcileUserAssignments(user, rules, env, evidence, !!evidence)).user;
  if (user.record.enabled === false) return null;
  return {
    authenticated: true,
    auth: "cloudflare_access",
    role,
    email,
    subject: payload.sub ?? null,
    tenantId: user.record.tenantId ?? env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default",
    groups: [...new Set(user.record.groups ?? [])].sort(),
    contentRetentionDisabled: user.record.contentRetentionDisabled ?? false,
  };
}

export async function accessIdentity(request: Request, env: Env, providerId?: string): Promise<AuthorizedIdentity | Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  const principals = [
    { principalType: "user" as const, principalId: session.email },
    ...session.groups.map((group) => ({ principalType: "group" as const, principalId: group })),
  ];
  const bindings = (await resolveBindings(env, principals)).filter((binding) => binding.enabled);
  const entries = await resolvePolicies(env, [...new Set(bindings.map((binding) => binding.policyId))]);
  const matching = entries.filter((entry) => entry.policy.enabled && (!providerId || !entry.policy.providers.length || entry.policy.providers.includes(providerId)));
  if (!matching.length) return errorResponse("access_policy_required", "this identity has no active access policy", 403);
  const selected = providerId ? await selectProviderPolicy(matching, providerId, session.tenantId, env) : matching[0];
  return {
    credentialId: null,
    principalId: session.email,
    authType: "access",
    policyId: selected.policyId,
    policy: selected.policy,
    contentRetentionDisabled: session.contentRetentionDisabled,
  };
}

export async function sessionPolicies(session: AccessSession, env: Env): Promise<AccessPolicyEntry[]> {
  const bindings = (await resolveBindings(env, [
    { principalType: "user", principalId: session.email },
    ...session.groups.map((group) => ({ principalType: "group" as const, principalId: group })),
  ])).filter((binding) => binding.enabled).sort((a, b) => a.priority - b.priority);
  const entries = await resolvePolicies(env, [...new Set(bindings.map((binding) => binding.policyId))]);
  const allowed = new Set(bindings.map((binding) => binding.policyId));
  return entries.filter((entry) => allowed.has(entry.policyId) && entry.policy.enabled);
}

export async function authorizeAdmin(request: Request, env: Env): Promise<AccessSession | Response> {
  const session = await verifiedAccessSession(request, env);
  if (session) {
    if (session.role !== "admin") return errorResponse("access_admin_required", "administrator access is required", 403);
    if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
    return session;
  }
  const token = parseBearer(request.headers);
  const expected = env.CLAWROUTER_ADMIN_TOKEN_SHA256?.toLowerCase();
  if (!token || !expected || !safeEqual(await sha256Hex(token), expected)) return errorResponse("admin_unauthorized", "administrator authentication required", 401);
  return {
    authenticated: true,
    auth: "cloudflare_access",
    role: "admin",
    email: "token-admin",
    subject: null,
    tenantId: "default",
    groups: [],
    contentRetentionDisabled: true,
  };
}

export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === url.origin || (!origin && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none"));
}

export function publicSession(session: AccessSession): Omit<AccessSession, "contentRetentionDisabled"> {
  const { contentRetentionDisabled: _, ...visible } = session;
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
    const response = await fetch(url, { headers: { accept: "application/json", cookie }, redirect: "manual" });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.length > 64 * 1024) return undefined;
    return assignmentEvidenceFromAccessIdentity(JSON.parse(body), email);
  } catch {
    return undefined;
  }
}

async function selectProviderPolicy(entries: AccessPolicyEntry[], providerId: string, tenantId: string, env: Env): Promise<AccessPolicyEntry> {
  for (const entry of entries) {
    const tenant = entry.policy.tenantId ?? tenantId;
    for (const key of [`oauth/${entry.policyId}/${providerId}`, `oauth/tenants/${tenant}/${providerId}`]) {
      const grant = await env.POLICY_KV.get<{ enabled?: boolean; credential?: string; accessToken?: string; credentials?: Record<string, string> }>(key, "json");
      if (grant?.enabled !== false && !!(grant?.credential || grant?.accessToken || Object.keys(grant?.credentials ?? {}).length)) return entry;
    }
  }
  return entries[0];
}

async function verifyAccessJwt(token: string, teamDomain: string, expectedAud: string): Promise<AccessJwtPayload | null> {
  teamDomain = teamDomain.trim().replace(/^https?:\/\//i, "").split(/[/?#]/)[0].toLowerCase();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, payload: AccessJwtPayload;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid || !validPayload(payload, teamDomain, expectedAud)) return null;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) return null;
  const key = (await response.json<{ keys: Jwk[] }>()).keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!key) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = base64UrlBytes(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature.buffer as ArrayBuffer, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid ? payload : null;
  } catch { return null; }
}

function validPayload(payload: AccessJwtPayload, teamDomain: string, expectedAud: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  const issuer = payload.iss?.replace(/\/$/, "");
  return audiences.includes(expectedAud) && issuer === `https://${teamDomain}` && !!payload.exp && payload.exp > now && (!payload.nbf || payload.nbf <= now + 30) && (!payload.iat || payload.iat <= now + 300);
}

function decodeBase64Url(value: string): string { return new TextDecoder().decode(base64UrlBytes(value)); }
function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}
