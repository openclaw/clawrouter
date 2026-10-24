#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adminRequest } from "./admin-api.mjs";

const help = `Usage: pnpm cf:budget-mode -- (--policy ID ... | --all) [--mode soft|reserve] [--apply]

Switch existing policies between soft budgets (no foreground ledger calls; small
overspend possible) and reserve budgets (authoritative pre-dispatch caps).
Reads CLAWROUTER_BASE_URL and CLAWROUTER_ADMIN_TOKEN (plus CF_ACCESS_CLIENT_ID /
CF_ACCESS_CLIENT_SECRET behind Cloudflare Access). Without --apply it only prints
the plan. Every other policy field is written back unchanged.

  --policy ID   target one policy; repeatable
  --all         target every policy not already in --mode
  --mode MODE   soft (default) or reserve
  --apply       write the changes`;

export function budgetModePlan(argv) {
  const { values } = parseArgs({ args: argv, options: { policy: { type: "string", multiple: true }, all: { type: "boolean" }, mode: { type: "string", default: "soft" }, apply: { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) return { help: true };
  if (!["soft", "reserve"].includes(values.mode)) throw new Error("--mode must be soft or reserve");
  const policies = [...new Set(values.policy ?? [])];
  for (const id of policies) if (!/^[a-zA-Z0-9_]{1,128}$/.test(id)) throw new Error("invalid --policy");
  if (!policies.length === !values.all) throw new Error("choose --policy ID or --all");
  return { mode: values.mode, policies, all: values.all === true, apply: values.apply === true };
}

// A stored policy without budgetMode is a reserve policy.
export const effectiveBudgetMode = policy => policy.budgetMode === "soft" ? "soft" : "reserve";

export function budgetModeRequests(plan, policies) {
  const byId = new Map(policies.map(policy => [policy.policyId, policy]));
  for (const id of plan.policies) if (!byId.has(id)) throw new Error(`policy not found: ${id}`);
  const targets = plan.all ? policies : plan.policies.map(id => byId.get(id));
  return targets.filter(policy => effectiveBudgetMode(policy) !== plan.mode).map(policy => ({
    method: "PUT", path: `/v1/admin/policies/${policy.policyId}`, policy,
    body: { ...policy, ...(policy.providers?.length === 0 ? { allProviders: true } : {}), budgetMode: plan.mode },
  }));
}

const limits = policy => ["monthlyBudgetMicros", "weeklyBudgetMicros", "dailyBudgetMicros"].filter(key => policy[key] != null).map(key => `${key.replace("BudgetMicros", "")}=${policy[key]}`).join(" ") || "no policy limits";

export async function applyBudgetMode(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const plan = budgetModePlan(argv);
  if (plan.help) { log(help); return []; }
  const call = (path, options) => adminRequest(path, { ...options, env, fetchImpl });
  const { policies } = await call("/v1/admin/policies", { method: "GET" });
  const requests = budgetModeRequests(plan, policies);
  for (const request of requests) log(`${plan.apply ? "apply" : "plan"}: ${request.policy.policyId} ${effectiveBudgetMode(request.policy)} -> ${plan.mode} (${limits(request.policy)}; tenant ${request.policy.tenantId ?? "default"})`);
  if (plan.apply) for (const request of requests) await call(request.path, { method: request.method, body: request.body, responseMode: "ack" });
  log(plan.apply ? `${requests.length} policies changed` : `${requests.length} policies would change. Dry run only; add --apply to write.`);
  return requests;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyBudgetMode(process.argv.slice(2)).catch(error => { console.error(`Budget mode change failed: ${error.message}`); process.exitCode = 1; });
}
