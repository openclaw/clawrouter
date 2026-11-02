import { verifiedAccessSession, sessionPolicies } from "./access.ts";
import { personalUsage } from "./usage-report.ts";
import { privateJson, errorResponse } from "./utils.ts";
import type { Env } from "./types.ts";

export async function sessionUsageReport(request: Request, env: Env, events = false): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified session is required", 401);
  const policies = await sessionPolicies(session, env);
  return privateJson(await personalUsage(env, policies.map(p => ({ tenantId: p.policy.tenantId ?? "default", policyId: p.policyId })), session.email, new URL(request.url).searchParams, events));
}
