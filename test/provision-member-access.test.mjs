import assert from "node:assert/strict";
import test from "node:test";
import { memberAccessRequests, memberAccessDiff, provisionMemberAccess } from "../scripts/provision-member-access.mjs";

test("offline dry run prints exact default requests and never credentials", async () => {
  const lines = [];
  const requests = await provisionMemberAccess([], { env: { CLAWROUTER_ADMIN_TOKEN: "synthetic-token-never-print" }, fetchImpl: () => { throw new Error("dry run contacted network"); }, log: line => lines.push(line) });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, "/v1/admin/assignment-rules/github_org_openclaw");
  assert.deepEqual(requests[0].body.models, ["openai/gpt-6.1-sol"]);
  assert.equal(requests[0].path, "/v1/admin/policies/member_weekly");
  assert.equal(requests[0].body.weeklyBudgetMicros, 5_000_000_000);
  assert.equal(requests[0].body.dailyBudgetMicros, null);
  assert.equal(requests[0].body.monthlyBudgetMicros, null);
  assert.equal(requests[0].body.retainRequestContent, false);
  assert.match(lines.join("\n"), /Bearer \[REDACTED\]/);
  assert.doesNotMatch(lines.join("\n"), /synthetic-token-never-print|secretSha256/);
});
test("configuration, exact USD parsing, and team model override", () => {
  const { requests } = memberAccessRequests(["--policy-id", "personal", "--rule-id", "org", "--github-org", "Example", "--model", "openai/a", "--model", "openai/b", "--daily-usd", "1.234567", "--monthly-usd", "50", "--hint", "Use team", "--team-server"]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.dailyBudgetMicros, 1_234_567);
  assert.equal(requests[0].body.monthlyBudgetMicros, 50_000_000);
  assert.equal(requests[1].body.dailyBudgetMicros, null);
  assert.deepEqual(requests[1].body.serviceTiers.models, { "openai/gpt-6.1-sol": ["default", "flex", "priority", "ultrafast"] });
  assert.equal(requests[2].body.subject, "example");
  for (const args of [["--daily-usd", "NaN"], ["--daily-usd", "-1"], ["--weekly-usd", "NaN"], ["--weekly-usd", "-1"], ["--apply", "--dry-run"], ["--hint", "bad\ntext"]]) assert.throws(() => memberAccessRequests(args));
});
test("mocked admin writes are idempotent and preserve unrelated server fields", async () => {
  const stored = new Map(), writes = [], seen = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    seen.push([path, options.method]);
    assert.equal(options.headers.authorization, "Bearer synthetic-admin");
    if (options.method === "GET") return Response.json(path.endsWith("policies") ? { policies: [...stored.values()].filter(v => v.policyId) } : { rules: [...stored.values()].filter(v => v.ruleId) });
    const body = JSON.parse(options.body), id = path.split("/").at(-1);
    stored.set(path, { ...body, ...(path.includes("assignment-rules") ? { ruleId: id, generatedGroup: "internal" } : { policyId: id, generation: "v1", grantRouting: {} }) });
    writes.push(path);
    return Response.json(stored.get(path));
  };
  const options = { env: { CLAWROUTER_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "synthetic-admin" }, fetchImpl, log() {} };
  await provisionMemberAccess(["--apply", "--team-server"], options);
  assert.equal(writes.length, 3);
  assert.deepEqual(await provisionMemberAccess(["--apply", "--team-server"], options), []);
  assert.equal(writes.length, 3);
  assert.equal(memberAccessDiff(memberAccessRequests(["--daily-usd", "5"]).requests, stored).length, 1);
  assert.ok(seen.every(([path]) => !path.includes("credentials")));
});

test("invalid assignment ID is rejected before any read or write", async () => {
  await assert.rejects(provisionMemberAccess(["--apply", "--rule-id", "github-org-openclaw"], { env: { CLAWROUTER_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "synthetic-admin" }, fetchImpl: () => { throw new Error("must not contact API"); }, log() {} }), /invalid --rule-id/);
});

test("repeatable ultrafast patch previews existing policies, preserves fields, and applies idempotently", async () => {
  const stored = new Map([
    ["team_server", { policyId: "team_server", enabled: false, tenantId: "team", weeklyBudgetMicros: 123, models: ["openai/gpt-6.1-sol"], grantRouting: { strategy: "priority" }, serviceTiers: { allowed: ["default"], models: { "openai/gpt-6-astra": ["flex"], "openai/gpt-6.1-sol": ["default"] } } }],
    ["openclaw_stable", { policyId: "openclaw_stable", enabled: true, limitHint: "Keep this", dailyBudgetMicros: 10 }],
  ]);
  const before = structuredClone(stored), writes = [], reads = [], lines = [];
  const options = {
    env: { CLAWROUTER_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "synthetic-secret" },
    log: line => lines.push(line),
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname;
      if (request.method === "GET") {
        reads.push(path);
        assert.equal(path, "/v1/admin/policies");
        return Response.json({ policies: [...stored.values()] });
      }
      const body = JSON.parse(request.body);
      writes.push(body);
      stored.set(body.policyId, body);
      return Response.json(body);
    },
  };
  const args = ["--ultrafast-policy", "team_server", "--ultrafast-policy", "openclaw_stable", "--ultrafast-policy", "team_server"];
  const preview = await provisionMemberAccess(args, options);
  assert.equal(preview.length, 2);
  assert.equal(writes.length, 0);
  assert.deepEqual(stored, before);
  assert.deepEqual(preview[0].body, { ...before.get("team_server"), serviceTiers: { allowed: ["default"], models: { "openai/gpt-6-astra": ["flex"], "openai/gpt-6.1-sol": ["default", "flex", "priority", "ultrafast"] } } });
  assert.deepEqual(preview[1].body.serviceTiers, { allowed: ["default", "flex", "priority"], models: { "openai/gpt-6.1-sol": ["default", "flex", "priority", "ultrafast"] } });
  await provisionMemberAccess([...args, "--apply"], options);
  assert.equal(writes.length, 2);
  assert.deepEqual(await provisionMemberAccess([...args, "--apply"], options), []);
  assert.equal(writes.length, 2);
  assert.doesNotMatch(lines.join("\n"), /synthetic-secret|assignment-rules/);
});

test("ultrafast patch fails closed for a missing policy or credentials", async () => {
  await assert.rejects(provisionMemberAccess(["--ultrafast-policy", "missing"], { env: {}, log() {} }), /requires/);
  let writes = 0;
  const options = { env: { CLAWROUTER_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "synthetic" }, log() {}, fetchImpl: async (_url, request) => { if (request.method !== "GET") writes++; return Response.json({ policies: [{ policyId: "present" }] }); } };
  await assert.rejects(provisionMemberAccess(["--apply", "--ultrafast-policy", "present", "--ultrafast-policy", "missing"], options), /policy not found/);
  assert.equal(writes, 0);
  assert.throws(() => memberAccessRequests(["--ultrafast-policy", "bad/id"]), /invalid/);
});
