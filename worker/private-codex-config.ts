import { verifyAccessJwt } from "./access";
import { boundedJson } from "./private-codex-io";
import type { Env, ProviderReasoningEffort } from "./types";
import { safeEqual, sha256Hex } from "./utils";

export interface PrivatePolicy {
  version: 1;
  enabled: true;
  alias: { id: string; name: string; supportedReasoningEfforts?: ProviderReasoningEffort[] };
  auth: { mode: "access"; issuer: string; audience: string; githubAccountId: number; identityProviderId: string }
    | { mode: "workload"; credentialSha256: string };
}

const reasoningEfforts: readonly ProviderReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PrivateUpstream {
  version: 1;
  target: string;
  fallbackTarget?: string;
  accountId: string;
  accessToken: string;
  expiresAt: number;
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function bindingJson(binding: Env["PRIVATE_CODEX_POLICY"]): Promise<unknown> {
  if (!binding || typeof binding.get !== "function") return null;
  const value = await binding.get();
  return typeof value === "string" && value.length <= 16_384 ? JSON.parse(value) : null;
}

export async function privatePolicy(env: Env): Promise<PrivatePolicy | null> {
  const value = await bindingJson(env.PRIVATE_CODEX_POLICY);
  if (!record(value) || !exactKeys(value, ["version", "enabled", "alias", "auth"]) || value.version !== 1 || value.enabled !== true) return null;
  const { alias, auth } = value;
  if (!record(alias)) return null;
  const aliasKeys = ["id", "name"];
  if (Object.hasOwn(alias, "supportedReasoningEfforts")) aliasKeys.push("supportedReasoningEfforts");
  if (!exactKeys(alias, aliasKeys) || typeof alias.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(alias.id)
    || typeof alias.name !== "string" || !/^[\x20-\x7e]{1,80}$/.test(alias.name)) return null;
  if (Object.hasOwn(alias, "supportedReasoningEfforts")) {
    const efforts = alias.supportedReasoningEfforts;
    if (!Array.isArray(efforts) || efforts.length === 0 || efforts.length > reasoningEfforts.length
      || efforts.some((effort) => !reasoningEfforts.includes(effort)) || new Set(efforts).size !== efforts.length) return null;
  }
  if (!record(auth)) return null;
  if (auth.mode === "workload") {
    if (!exactKeys(auth, ["mode", "credentialSha256"]) || typeof auth.credentialSha256 !== "string" || !/^[a-f0-9]{64}$/.test(auth.credentialSha256)) return null;
  } else if (auth.mode === "access") {
    if (!exactKeys(auth, ["mode", "issuer", "audience", "githubAccountId", "identityProviderId"]) || typeof auth.issuer !== "string"
      || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(auth.issuer)
      || typeof auth.githubAccountId !== "number" || !Number.isSafeInteger(auth.githubAccountId) || auth.githubAccountId <= 0
      || typeof auth.identityProviderId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(auth.identityProviderId)
      || typeof auth.audience !== "string" || !/^[\x21-\x7e]{1,256}$/.test(auth.audience)) return null;
  } else return null;
  return value as unknown as PrivatePolicy;
}

interface PrivateAuthorization { current(): boolean }

function conflictingAuth(headers: Headers): boolean {
  return ["x-api-key", "api-key", "x-goog-api-key", "proxy-authorization", "cf-access-client-id", "cf-access-client-secret"].some((name) => headers.has(name));
}

function correlatedEmail(value: unknown): string | null {
  return typeof value === "string" && value.length <= 1024 && value.trim() ? value.trim().toLowerCase() : null;
}

export async function privateAuthorized(request: Request, policy: PrivatePolicy): Promise<PrivateAuthorization | null> {
  const headers = request.headers;
  if (request.signal.aborted || conflictingAuth(headers)) return null;
  const assertion = headers.get("cf-access-jwt-assertion");
  const authorization = headers.get("authorization");
  if (policy.auth.mode === "workload") {
    // A dedicated namespace prevents ordinary issued proxy credentials from being accepted.
    const credential = authorization?.match(/^Bearer (private-workload-[A-Za-z0-9_-]{32,128})$/)?.[1];
    if (headers.has("cf-access-jwt-assertion") || !credential || !safeEqual(await sha256Hex(credential), policy.auth.credentialSha256)) return null;
    return { current: () => !request.signal.aborted && !conflictingAuth(headers) && !headers.has("cf-access-jwt-assertion") && headers.get("authorization") === authorization };
  }
  if (headers.has("authorization") || !assertion || assertion.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) return null;
  const auth = policy.auth;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  try {
    const payload = await verifyAccessJwt(assertion, new URL(auth.issuer).hostname, auth.audience, signal);
    if (!payload || payload.iss !== auth.issuer || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)
      || (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)))
      || (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)))) return null;
    const email = correlatedEmail(payload.email);
    const expiresAt = payload.exp;
    // Keep the verifier's clock tolerances, but recheck after every awaited auth/policy phase.
    const current = () => {
      const now = Math.floor(Date.now() / 1000);
      return !request.signal.aborted && !conflictingAuth(headers) && !headers.has("authorization") && headers.get("cf-access-jwt-assertion") === assertion
        && expiresAt > now && (payload.nbf === undefined || payload.nbf <= now + 30) && (payload.iat === undefined || payload.iat <= now + 300);
    };
    if (!email || !current() || signal.aborted) return null;
    // The destination is policy-pinned, never selected from unverified claims or a redirect.
    const response = await fetch(`${auth.issuer}/cdn-cgi/access/get-identity`, {
      headers: { Cookie: `CF_Authorization=${assertion}`, "accept-encoding": "identity" }, redirect: "manual", cache: "no-store", signal,
    });
    const encoding = response.headers.get("content-encoding");
    if (response.status !== 200 || (encoding && encoding !== "identity") || signal.aborted) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const identity = await boundedJson(response.body, 64 * 1024, signal);
    // Email correlates this assertion's lookup; only the numeric GitHub account and IdP authorize.
    if (!current() || signal.aborted || !record(identity) || correlatedEmail(identity.email) !== email
      || !record(identity.idp) || identity.idp.type !== "github" || identity.idp.id !== auth.identityProviderId
      || typeof identity.id !== "number" || !Number.isSafeInteger(identity.id) || identity.id <= 0 || identity.id !== auth.githubAccountId) return null;
    return { current };
  } catch {
    // Fetch errors can retain the assertion cookie; never log, attach, or return their contents.
    return null;
  }
}

export async function privateAuthorizationCurrent(authorization: PrivateAuthorization, policy: PrivatePolicy, env: Env): Promise<boolean> {
  // Workload revocation must also win while an upstream binding read is pending.
  const current = await privatePolicy(env);
  if (!current || JSON.stringify(current) !== JSON.stringify(policy)) return false;
  return authorization.current();
}

export async function privateUpstream(env: Env, policy: PrivatePolicy): Promise<PrivateUpstream | null> {
  const value = await bindingJson(env.PRIVATE_CODEX_UPSTREAM);
  if (!record(value)) return null;
  const keys = ["version", "target", "accountId", "accessToken", "expiresAt"];
  if (Object.hasOwn(value, "fallbackTarget")) keys.push("fallbackTarget");
  if (!exactKeys(value, keys) || value.version !== 1
    || typeof value.target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.target)
    || typeof value.accountId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value.accountId)
    || typeof value.accessToken !== "string" || !/^[A-Za-z0-9._~-]{16,8192}$/.test(value.accessToken)
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() + 30_000) return null;
  if (Object.hasOwn(value, "fallbackTarget") && (typeof value.fallbackTarget !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.fallbackTarget) || value.fallbackTarget === value.target)) return null;
  const sensitive = [value.target, value.accountId, value.accessToken, ...(typeof value.fallbackTarget === "string" ? [value.fallbackTarget] : [])];
  if (sensitive.some((secret) => policy.alias.id.includes(secret) || policy.alias.name.includes(secret))) return null;
  return value as unknown as PrivateUpstream;
}
