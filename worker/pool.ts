import { accessSessionIdentity, sessionPolicies, sessionPolicyIdentity, verifiedAccessSession } from "./access";
import { upstreamGrantResponses } from "./admin";
import { grantRoutingPolicy } from "./grant-selection";
import { grantUsageSnapshot } from "./ledgers";
import { policyAllowsModel } from "./policy-models";
import { authenticateProxyKey, hasProxyKeyIntent } from "./proxy-auth";
import { snapshot } from "./providers";
import { modelEligibility, planLabel, policyGrants, quotaFree } from "../shared/subscription-pool.ts";
import type { Env, UpstreamGrant } from "./types";
import { errorResponse, HttpError, privateJson, sha256Hex } from "./utils";

export async function poolResponse(request: Request, env: Env): Promise<Response> {
  const hasKey = hasProxyKeyIntent(request.headers);
  const session = hasKey ? null : await verifiedAccessSession(request, env);
  const policyId = new URL(request.url).searchParams.get("policyId");
  const entry = session && policyId ? (await sessionPolicies(session, env)).find(entry => entry.policyId === policyId) : null;
  const auth = hasKey ? await authenticateProxyKey(request.headers, env)
    : session ? policyId ? entry ? sessionPolicyIdentity(session, entry) : errorResponse("access_policy_required", "this identity has no active access policy", 403)
      : await accessSessionIdentity(session, env) : await authenticateProxyKey(request.headers, env);
  if (auth instanceof Response) return auth;
  if (auth.policy.poolStatus !== "visible") return poolJson({ error: { code: "pool_status_hidden", message: "pool status is hidden for this policy" } }, 404);

  const routing = grantRoutingPolicy(auth.policy.grantRouting);
  const policy = { ...auth.policy, policyId: auth.policyId, grantRouting: routing };
  const models = snapshot.providers.flatMap(provider => provider.models.filter(model => policyAllowsModel(policy, provider.id, model.id)).map(model => ({ provider: provider.id, ...model })));
  let scanned = 0;
  const records: Array<{ key: string; grant: UpstreamGrant }> = [];
  // Read only the caller's two scopes and explicit shared owners.
  const prefixes = [`oauth/${auth.policyId}/`, `oauth/tenants/${auth.policy.tenantId ?? "default"}/`];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.POLICY_KV.list({ prefix, cursor, limit: 100 });
      if ((scanned += page.keys.length) > 1024) throw new HttpError(422, "pool_too_large", "pool inventory exceeds 1024 grants");
      const grants = page.keys.length ? await env.POLICY_KV.get<UpstreamGrant>(page.keys.map(key => key.name), "json") : new Map<string, UpstreamGrant | null>();
      for (const key of page.keys) { const grant = grants.get(key.name); if (grant) records.push({ key: key.name, grant }); }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  const sharedKeys = [...new Set(Object.entries(routing.sharedGrants ?? {}).filter(([provider]) => !policy.providers.length || policy.providers.includes(provider)).flatMap(([, keys]) => keys))]
    .filter(key => !prefixes.some(prefix => key.startsWith(prefix)));
  for (let offset = 0; offset < sharedKeys.length; offset += 100) {
    const grants = await env.POLICY_KV.get<UpstreamGrant>(sharedKeys.slice(offset, offset + 100), "json");
    for (const [key, grant] of grants) if (grant) records.push({ key, grant });
  }
  // Stable opaque IDs keep foreign scope names private and distinguish owners
  // whose token references happen to collide. Usage retains original keys inside the ledger.
  const publicKey = async (key: string | null) => !key ? null : prefixes.some(prefix => key.startsWith(prefix))
    ? key.split("/").at(-1)! : `shared-${(await sha256Hex(key)).slice(0, 16)}`;
  const now = Date.now();
  const rows = policyGrants(policy, await upstreamGrantResponses(env, records));
  const grants = await Promise.all(rows.map(async grant => ({
    key: await publicKey(grant.key), label: grant.label, provider: grant.provider, kind: grant.kind, enabled: grant.enabled,
    credentialStatus: grant.credentialStatus ?? null, plan: grant.subscription?.plan ?? planLabel(grant.account?.rateLimitTier),
    account: grant.account ? { email: grant.account.email ?? null, rateLimitTier: grant.account.rateLimitTier ?? null, subscriptionStatus: grant.account.subscriptionStatus ?? null } : null,
    windows: grant.quotaWindows.map(window => ({ id: window.id, window: window.window, models: window.models ?? null, remainingPercent: quotaFree(window, now), resetAt: window.resetAt, observedAt: window.observedAt ?? grant.quotaObservedAt })),
    extraUsage: grant.extraUsage ? { enabled: grant.extraUsage.enabled ?? null, usedCredits: grant.extraUsage.usedCredits ?? null, monthlyLimit: grant.extraUsage.monthlyLimit ?? null, currency: grant.extraUsage.currency ?? null, spendLimitReached: grant.extraUsage.spendLimitReached ?? null } : null,
    eligibility: Object.fromEntries(models.map(model => [model.id, model.provider === grant.provider ? modelEligibility(grant, model.upstream, policy, now) : "exhausted"])),
    lastSelectedAt: grant.lastSelectedAt, selectedCount: grant.selectedCount,
  })));
  const usage = await grantUsageSnapshot(env, auth.policy.tenantId ?? "default", auth.policyId, 7);
  return poolJson({ version: "clawrouter.pool.v1", observedAt: new Date(now).toISOString(), policyId: auth.policyId,
    routing: { strategy: routing.strategy, includedQuotaReservePercent: routing.includedQuotaReservePercent, environmentFallback: routing.environmentFallback },
    models: models.map(model => model.id), grants,
    usage: { days: 7, lanes: usage.lanes, grants: await Promise.all(usage.grants.map(async row => ({ ...row, grantKey: await publicKey(row.grantKey) }))) },
  });
}

function poolJson(value: unknown, status = 200): Response {
  const response = privateJson(value, status);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
