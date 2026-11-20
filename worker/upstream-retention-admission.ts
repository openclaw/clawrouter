import { readUpstreamRetentionPolicy } from "../shared/upstream-retention.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import type { AccessPolicy, Env } from "./types.ts";
import { HttpError } from "./utils.ts";

export interface ManagedCreateAdmission { readonly upstreamRetention: "allowed" | "denied" }
const denied: ManagedCreateAdmission = Object.freeze({ upstreamRetention: "denied" });
const allowed: ManagedCreateAdmission = Object.freeze({ upstreamRetention: "allowed" });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// The existing digest pins the actual original credential, origin/API prefix,
// endpoint and control paths. The server receipt is not caller authority.
export function upstreamRetentionBindingAllowed(env: Env, owner: ContinuationOwner, protocol: string, now = Date.now()): boolean {
  const raw = env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS;
  if (typeof raw !== "string" || !raw || raw.length > 32 * 1024 || !Number.isFinite(now)) return false;
  let config: unknown;
  try { config = JSON.parse(raw); } catch { return false; }
  if (!object(config) || Object.keys(config).length !== 2 || config.version !== "clawrouter.upstream-retention-bindings.v1"
    || !Array.isArray(config.bindings) || config.bindings.length > 64) return false;
  let matches = 0;
  for (const binding of config.bindings) {
    if (!object(binding) || Object.keys(binding).length !== 6 || binding.retention !== "allow"
      || typeof binding.providerId !== "string" || binding.providerId.trim() !== binding.providerId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding.providerId)
      || typeof binding.protocol !== "string" || binding.protocol.trim() !== binding.protocol || !/^[a-z][a-z0-9_.-]{0,63}$/.test(binding.protocol)
      || binding.grantKey !== null && (typeof binding.grantKey !== "string" || !binding.grantKey || binding.grantKey.length > 256 || /[\s\x00-\x1f\x7f]/.test(binding.grantKey))
      || typeof binding.routeSha256 !== "string" || binding.routeSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(binding.routeSha256)
      || typeof binding.expiresAt !== "string" || binding.expiresAt.trim() !== binding.expiresAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(binding.expiresAt)
      || !Number.isFinite(Date.parse(binding.expiresAt))) return false;
    if (new Date(Date.parse(binding.expiresAt)).toISOString().replace(".000Z", "Z") !== binding.expiresAt.replace(".000Z", "Z")) return false;
    if (binding.providerId === owner.providerId && binding.protocol === protocol && binding.grantKey === owner.grantKey
      && binding.routeSha256 === owner.routeSha256 && Date.parse(binding.expiresAt) > now) matches++;
  }
  return matches === 1;
}

export function managedCreateAdmission(policy: AccessPolicy, env: Env, owner: ContinuationOwner | undefined, protocol: string, now = Date.now()): ManagedCreateAdmission {
  const permission = readUpstreamRetentionPolicy(policy.upstreamRetention);
  if (!owner || !policy.enabled || owner.policyGeneration !== policy.generation
    || policy.providers.length > 0 && !policy.providers.includes(owner.providerId)
    || !permission?.allow.some(entry => entry.providerId === owner.providerId && entry.protocol === protocol)
    || !upstreamRetentionBindingAllowed(env, owner, protocol, now)) return denied;
  return allowed;
}
export function requireManagedCreateAdmission(policy: AccessPolicy, env: Env, owner: ContinuationOwner | undefined, protocol: string): ManagedCreateAdmission {
  const admission = managedCreateAdmission(policy, env, owner, protocol);
  if (admission.upstreamRetention !== "allowed") throw new HttpError(403, "upstream_retention_unqualified", "upstream retention requires explicit caller-policy and original-credential qualification");
  return admission;
}
