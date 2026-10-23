import { authorityCall } from "./authority.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

// Compaction windows and standalone search references cannot cross accounts.
// Count resolved pool members, not currently available candidates:
// cooldown and expiry must not silently qualify a multi-account pool. Detached
// inactive grants cannot route; a later activation is checked on the next request.
export async function assertSingleOpenAiAccount(auth: AuthorizedIdentity, env: Env, upstream: Pick<UpstreamAuth, "transport" | "grantKey" | "grant">, operation: "compact" | "search" = "compact"): Promise<void> {
  const defaultKeys = [`oauth/${auth.policyId}/openai`, `oauth/tenants/${auth.policy.tenantId ?? "default"}/openai`];
  const records = await env.POLICY_KV.get<UpstreamGrant>(defaultKeys, "json");
  const attachments = await Promise.all(defaultKeys.map(key => authorityCall<{ attached: boolean; pending: boolean }>(env, "/grant-pools/attachment", { key })));
  // Read membership after projection/attachment awaits, never from admission.
  // Empty defaultKeys excludes synthetic lookup keys: every returned key is
  // actual active/legacy membership, including a default-named member.
  const pool = await authorityCall<{ keys: string[]; unavailable?: boolean }>(env, "/grant-pools/resolve", { providerId: "openai", policyId: auth.policyId, tenantId: auth.policy.tenantId ?? "default", defaultKeys: [] });
  if (pool.unavailable) throw new HttpError(503, `${operation}_account_unavailable`, `${operation} account qualification is unavailable`);
  const keys = [...new Set([...defaultKeys, ...pool.keys])];
  const configured = keys.filter(key => pool.keys.includes(key) || records.get(key) != null && records.get(key)?.enabled !== false || attachments[defaultKeys.indexOf(key)]?.attached || attachments[defaultKeys.indexOf(key)]?.pending);
  const qualified = upstream.transport === null && (configured.length === 0 ? upstream.grantKey === null
    : configured.length === 1 && upstream.grantKey === configured[0] && upstream.grant?.kind === "api_key" && auth.policy.grantRouting?.environmentFallback !== true);
  if (!qualified) throw new HttpError(409, `${operation}_account_unqualified`, `${operation} currently requires one public OpenAI API account without account fallback; multi-account continuity is not supported`);
}

