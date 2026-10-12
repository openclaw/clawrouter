import { accessSessionIdentity, sessionPolicies, sessionPolicyIdentity, verifiedAccessSession } from "./access";
import { upstreamGrantResponses } from "./admin";
import { grantRoutingPolicy } from "./grant-selection";
import { grantUsageSnapshot } from "./ledgers";
import { policyAllowsModel } from "./policy-models";
import { authenticateProxyKey } from "./proxy-auth";
import { snapshot } from "./providers";
import { modelEligibility, planLabel, policyGrants, quotaFree } from "../shared/subscription-pool.ts";
import type { Env, UpstreamGrant } from "./types";
import { errorResponse, HttpError, privateJson } from "./utils";

export async function poolResponse(request: Request, env: Env): Promise<Response> {
  const hasKey = ["authorization", "x-api-key", "x-goog-api-key", "api-key"].some(name => /(?:clawrouter-|ocpk_)/.test(request.headers.get(name) ?? ""));
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
  // Read only the caller's two scopes, with a hard inventory bound.
  for (const prefix of [`oauth/${auth.policyId}/`, `oauth/tenants/${auth.policy.tenantId ?? "default"}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.POLICY_KV.list({ prefix, cursor, limit: 100 });
      if ((scanned += page.keys.length) > 1024) throw new HttpError(422, "pool_too_large", "pool inventory exceeds 1024 grants");
      const grants = page.keys.length ? await env.POLICY_KV.get<UpstreamGrant>(page.keys.map(key => key.name), "json") : new Map<string, UpstreamGrant | null>();
      for (const key of page.keys) { const grant = grants.get(key.name); if (grant) records.push({ key: key.name, grant }); }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  const now = Date.now();
  const rows = policyGrants(policy, await upstreamGrantResponses(env, records));
  const grants = rows.map(grant => ({
    key: grant.tokenRef, label: grant.label, provider: grant.provider, kind: grant.kind, enabled: grant.enabled,
    credentialStatus: grant.credentialStatus ?? null, plan: grant.subscription?.plan ?? planLabel(grant.account?.rateLimitTier),
    account: grant.account ? { email: grant.account.email ?? null, rateLimitTier: grant.account.rateLimitTier ?? null, subscriptionStatus: grant.account.subscriptionStatus ?? null } : null,
    windows: grant.quotaWindows.map(window => ({ id: window.id, window: window.window, models: window.models ?? null, remainingPercent: quotaFree(window, now), resetAt: window.resetAt, observedAt: window.observedAt ?? grant.quotaObservedAt })),
    extraUsage: grant.extraUsage ? { enabled: grant.extraUsage.enabled ?? null, usedCredits: grant.extraUsage.usedCredits ?? null, monthlyLimit: grant.extraUsage.monthlyLimit ?? null, currency: grant.extraUsage.currency ?? null, spendLimitReached: grant.extraUsage.spendLimitReached ?? null } : null,
    eligibility: Object.fromEntries(models.map(model => [model.id, model.provider === grant.provider ? modelEligibility(grant, model.upstream, policy, now) : "exhausted"])),
    lastSelectedAt: grant.lastSelectedAt, selectedCount: grant.selectedCount,
  }));
  const usage = await grantUsageSnapshot(env, auth.policy.tenantId ?? "default", auth.policyId, 7);
  return poolJson({ version: "clawrouter.pool.v1", observedAt: new Date(now).toISOString(), policyId: auth.policyId,
    routing: { strategy: routing.strategy, includedQuotaReservePercent: routing.includedQuotaReservePercent, environmentFallback: routing.environmentFallback },
    models: models.map(model => model.id), grants,
    usage: { days: 7, lanes: usage.lanes, grants: usage.grants.map(row => ({ ...row, grantKey: row.grantKey?.split("/").at(-1) ?? null })) },
  });
}

function poolJson(value: unknown, status = 200): Response {
  const response = privateJson(value, status);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
