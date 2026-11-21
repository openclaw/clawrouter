import type { GrantUsageSnapshot } from "../shared/contracts";
import type { Env } from "./types.ts";
import { HttpError } from "./utils.ts";
import { mergeUsageSnapshots, usageShardName, type UsageSnapshot } from "./usage-sharding.ts";

export type UsageEventScope = { kind: "admin" } | { kind: "principal" | "credential"; id: string };
export async function grantUsageSnapshot(env: Env, tenantId: string, policyId: string, days: number): Promise<GrantUsageSnapshot> {
  const url = new URL("https://clawrouter.internal/grant-usage");
  url.searchParams.set("policy_id", policyId); url.searchParams.set("days", String(days));
  const response = await usageStub(env, tenantId, policyId).fetch(url);
  if (!response.ok) throw new HttpError(response.status, "grant_usage_unavailable", response.status === 422 ? "choose a shorter usage range" : "grant usage is unavailable");
  return response.json<GrantUsageSnapshot>();
}

export async function usageSnapshot(env: Env, tenantId: string, policyId: string, scope: UsageEventScope, limit = 100): Promise<UsageSnapshot> {
  return usageSnapshots(env, [{ tenantId, policyId }], scope, limit);
}

export async function usageSnapshots(env: Env, policies: Array<{ policyId: string; tenantId: string }>, scope: UsageEventScope, limit = 100): Promise<UsageSnapshot> {
  const shards = new Map(policies.map(policy => [usageShardName(policy.tenantId, policy.policyId), policy]));
  const snapshots = await Promise.all([...shards.values()].map(policy => currentUsageSnapshot(env, policy.tenantId, policy.policyId, scope, limit)));
  return mergeUsageSnapshots(snapshots, limit);
}

async function currentUsageSnapshot(env: Env, tenantId: string, policyId: string, scope: UsageEventScope, limit: number): Promise<UsageSnapshot> {
  const url = new URL("https://clawrouter.internal/snapshot");
  url.searchParams.set("policy_id", policyId);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("events", scope.kind);
  if (scope.kind !== "admin") url.searchParams.set("event_owner", scope.id);
  const response = await usageStub(env, tenantId, policyId).fetch(url);
  if (!response.ok) throw new Error(`usage snapshot returned ${response.status}`);
  return response.json<UsageSnapshot>();
}

export function usageStub(env: Env, tenantId: string, policyId: string): DurableObjectStub { return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName(usageShardName(tenantId, policyId))); }
