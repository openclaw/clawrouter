import { authorityCall } from "./authority.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { extractUsageTokens, type UsageTokens } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

// Until durable C-S2 witnesses exist, an opaque window cannot safely cross
// accounts. Count resolved pool members, not currently available candidates:
// cooldown and expiry must not silently qualify a multi-account pool. Detached
// inactive grants cannot route; a later activation is checked on the next request.
export async function assertCompactAccount(auth: AuthorizedIdentity, env: Env, upstream: UpstreamAuth): Promise<void> {
  const defaultKeys = [`oauth/${auth.policyId}/openai`, `oauth/tenants/${auth.policy.tenantId ?? "default"}/openai`];
  const records = await env.POLICY_KV.get<UpstreamGrant>(defaultKeys, "json");
  const attachments = await Promise.all(defaultKeys.map(key => authorityCall<{ attached: boolean; pending: boolean }>(env, "/grant-pools/attachment", { key })));
  // Read membership after projection/attachment awaits, never from admission.
  // Empty defaultKeys excludes synthetic lookup keys: every returned key is
  // actual active/legacy membership, including a default-named member.
  const pool = await authorityCall<{ keys: string[]; unavailable?: boolean }>(env, "/grant-pools/resolve", { providerId: "openai", policyId: auth.policyId, tenantId: auth.policy.tenantId ?? "default", defaultKeys: [] });
  if (pool.unavailable) throw new HttpError(503, "compact_account_unavailable", "compaction account qualification is unavailable");
  const keys = [...new Set([...defaultKeys, ...pool.keys])];
  const configured = keys.filter(key => pool.keys.includes(key) || records.get(key) != null && records.get(key)?.enabled !== false || attachments[defaultKeys.indexOf(key)]?.attached || attachments[defaultKeys.indexOf(key)]?.pending);
  const qualified = upstream.transport === null && (configured.length === 0 ? upstream.grantKey === null
    : configured.length === 1 && upstream.grantKey === configured[0] && upstream.grant?.kind === "api_key" && auth.policy.grantRouting?.environmentFallback !== true);
  if (!qualified) throw new HttpError(409, "compact_account_unqualified", "compaction currently requires one public OpenAI API account without account fallback; multi-account continuity is not supported");
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Only complete, internally consistent compaction-pass usage discounts the
// reservation. The bounded parser projects these scalars, never the output window.
export function extractCompactUsageTokens(value: unknown): UsageTokens | null {
  if (!object(value) || value.object !== "response.compaction" || !object(value.usage)) return null;
  const usage = value.usage, input = usage.input_tokens_details, output = usage.output_tokens_details;
  if (!counter(usage.input_tokens) || !counter(usage.output_tokens) || !counter(usage.total_tokens)
    || usage.input_tokens + usage.output_tokens !== usage.total_tokens || !object(input) || !object(output)
    || !counter(input.cached_tokens) || !counter(input.cache_write_tokens) || input.cached_tokens + input.cache_write_tokens > usage.input_tokens
    || !counter(output.reasoning_tokens) || output.reasoning_tokens > usage.output_tokens) return null;
  return extractUsageTokens(value);
}
