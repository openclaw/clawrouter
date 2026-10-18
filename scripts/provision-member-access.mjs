import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { adminRequest } from "./admin-api.mjs";

export const help = `Usage: pnpm cf:members [--dry-run | --apply] [options]
  --policy-id ID       member policy (default member_weekly)
  --rule-id ID         assignment (default github_org_openclaw)
  --github-org ORG     GitHub organization (default openclaw)
  --model ID          repeatable catalog model (default openai/gpt-6.1-sol)
  --weekly-usd USD     per-principal weekly limit (default 5000)
  --daily-usd USD      optional daily limit (default none)
  --monthly-usd USD    optional monthly limit (default none)
  --hint TEXT          steering message (max 300 characters)
  --team-server        also prepare unbudgeted team_server policy
  --ultrafast-policy ID  patch existing policy only; repeatable, reads admin API
  --apply              write through admin API; default is dry-run
Environment: CLAWROUTER_URL, CLAWROUTER_ADMIN_TOKEN (apply or policy patch preview).
Rollout order: deploy the openai/gpt-6.1-sol manifest PR before --apply.
Unknown catalog models fail closed. No credentials are created.
`;
export function memberAccessRequests(argv = []) {
  const { values } = parseArgs({ args: argv.filter(value => value !== "--"), strict: true, options: {
    "policy-id": { type: "string", default: "member_weekly" }, "rule-id": { type: "string", default: "github_org_openclaw" },
    "github-org": { type: "string", default: "openclaw" }, model: { type: "string", multiple: true },
    "weekly-usd": { type: "string", default: "5000" }, "daily-usd": { type: "string" }, "monthly-usd": { type: "string" }, hint: { type: "string", default: "For heavier usage, use the OpenClaw team server, which has no personal cap." },
    "ultrafast-policy": { type: "string", multiple: true },
    "team-server": { type: "boolean" }, "dry-run": { type: "boolean" }, apply: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) return { help: true, apply: false, requests: [] };
  if (values.apply && values["dry-run"]) throw new Error("choose --apply or --dry-run");
  const micros = (value, name) => {
    if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be nonnegative USD with at most 6 decimal places`);
    const amount = Math.round(Number(value) * 1_000_000);
    if (!Number.isSafeInteger(amount)) throw new Error(`${name} is too large`);
    return amount;
  };
  for (const key of ["policy-id", "rule-id"]) if (!/^[a-zA-Z0-9_]{1,128}$/.test(values[key])) throw new Error(`invalid --${key}`);
  const ultrafastPolicies = [...new Set(values["ultrafast-policy"] ?? [])];
  for (const id of ultrafastPolicies) if (!/^[a-zA-Z0-9_]{1,128}$/.test(id)) throw new Error("invalid --ultrafast-policy");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(values["github-org"])) throw new Error("invalid --github-org");
  if (values.hint.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(values.hint)) throw new Error("hint must be at most 300 plain-text characters");
  const allowed = ["default", "flex", "priority"];
  const common = { enabled: true, providers: ["openai"], retainRequestContent: false, requestCostMicros: null, tenantId: "default", tokenRole: "member" };
  const policy = { ...common, models: [...new Set(values.model ?? ["openai/gpt-6.1-sol"])].sort(), serviceTiers: { allowed }, budgetScope: "principal", weeklyBudgetMicros: micros(values["weekly-usd"], "--weekly-usd"), dailyBudgetMicros: values["daily-usd"] === undefined ? null : micros(values["daily-usd"], "--daily-usd"), monthlyBudgetMicros: values["monthly-usd"] === undefined ? null : micros(values["monthly-usd"], "--monthly-usd"), limitHint: values.hint.trim() || null };
  const put = (path, body) => ({ method: "PUT", path, body });
  const requests = [put(`/v1/admin/policies/${values["policy-id"]}`, policy)];
  if (values["team-server"]) requests.push(put("/v1/admin/policies/team_server", { ...common, tokenRole: "team_server", models: null, budgetScope: "policy", dailyBudgetMicros: null, weeklyBudgetMicros: null, monthlyBudgetMicros: null, limitHint: null, serviceTiers: { allowed, models: { "openai/gpt-6.1-sol": [...allowed, "ultrafast"] } } }));
  requests.push(put(`/v1/admin/assignment-rules/${values["rule-id"]}`, { enabled: true, kind: "github_org", subject: values["github-org"].toLowerCase(), groups: ["members"], policyIds: [values["policy-id"]], revokeOnLoss: true, priority: 100 }));
  return { apply: values.apply === true, requests: ultrafastPolicies.length ? [] : requests, ultrafastPolicies };
}
export function ultrafastPolicyRequest(policy) {
  const tiers = policy.serviceTiers ?? { allowed: ["default", "flex", "priority"] };
  return { method: "PUT", path: `/v1/admin/policies/${policy.policyId}`, body: {
    ...policy, ...(policy.providers?.length === 0 ? { allProviders: true } : {}),
    serviceTiers: { ...tiers, models: { ...tiers.models, "openai/gpt-6.1-sol": ["default", "flex", "priority", "ultrafast"] } },
  } };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && !(item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function memberAccessDiff(requests, current) {
  return requests.filter(request => {
    const existing = current.get(request.path);
    return !existing || !isDeepStrictEqual(canonical(Object.fromEntries(Object.keys(request.body).map(key => [key, key === "allProviders" ? existing.providers?.length === 0 : existing[key]]))), canonical(request.body));
  });
}
export async function provisionMemberAccess(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const plan = memberAccessRequests(argv);
  if (plan.help) { log(help); return []; }
  const base = env.CLAWROUTER_URL?.replace(/\/$/, "") ?? "${CLAWROUTER_URL}";
  if (base !== "${CLAWROUTER_URL}") {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("CLAWROUTER_URL must be an HTTPS origin (HTTP allowed on loopback)");
  }
  let requests = plan.requests;
  if (plan.apply || plan.ultrafastPolicies.length) {
    if (!env.CLAWROUTER_URL || !env.CLAWROUTER_ADMIN_TOKEN) throw new Error("admin API access requires CLAWROUTER_URL and CLAWROUTER_ADMIN_TOKEN");
    const call = (path, options) => adminRequest(path, { ...options, env: { ...env, CLAWROUTER_BASE_URL: base }, fetchImpl });
    const current = new Map();
    const policies = await call("/v1/admin/policies", { method: "GET" });
    for (const policy of policies.policies) current.set(`/v1/admin/policies/${policy.policyId}`, policy);
    if (plan.ultrafastPolicies.length) {
      requests = plan.ultrafastPolicies.map(id => {
        const policy = current.get(`/v1/admin/policies/${id}`);
        if (!policy) throw new Error(`policy not found: ${id}`);
        return ultrafastPolicyRequest(policy);
      });
    } else {
      const rules = await call("/v1/admin/assignment-rules", { method: "GET" });
      for (const rule of rules.rules) current.set(`/v1/admin/assignment-rules/${rule.ruleId}`, rule);
    }
    requests = memberAccessDiff(requests, current);
    if (plan.apply) for (const request of requests) await call(request.path, { method: request.method, body: request.body });
  }
  for (const request of requests) log(JSON.stringify({ method: request.method, url: `${base}${request.path}`, headers: { Authorization: "Bearer [REDACTED]", "Content-Type": "application/json" }, body: request.body }, null, 2));
  log(plan.apply ? `${requests.length} changes applied` : "Dry-run only. Review requests; use --apply to write. Deploy the gpt-6.1-sol manifest PR first.");
  return requests;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  provisionMemberAccess(process.argv.slice(2)).catch(error => { console.error("Member provisioning failed; check arguments, rollout order, and admin API access. No credentials were created. Use --help for options."); process.exitCode = 1; });
}
