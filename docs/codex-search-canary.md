# Codex search FakeCo canary runbook — archived

**Campaign closed; no live FakeCo deployment or pending cleanup.** The
[final cleanup record](codex-search-cleanup-20261023.md) is authoritative for
resource and credential disposition. The procedures below are historical
snapshots, not instructions to recreate this deployment or replay its runners.

Current campaign status (2026-10-23): use the [qualification and release assessment](codex-search-qualification.md).
Deployment, native canary qualification and credential revocation completed.
Fresh retrieval, cache/live semantics and upstream billing remain unqualified.
The final response-shape pair returned no `results` in either response; the Alpha
investigation is stopped. Earlier readiness/preparation instructions below are
historical and do not authorize replay, credential revival or another paid batch.
The user confirmed browser inspection complete. Approved cleanup batch 1 completed
at 2026-10-23 09:28:51 UTC: bootstrap revoked; fixture route, namespace and Worker
deleted. Batch 2 initially stopped on Worker DELETE 403/code 10064; its correction
then stopped before dispatch on authoritative FakeCo DNS NXDOMAIN. The user
approved using historical revocation/spend evidence without repairing DNS.
Core cleanup completed and passed eight final checks at 09:42:59 UTC: sole
consumer disconnected, then main Worker, five namespaces, custom domain, both
queues and Access app/policies removed. Production/shared resources preserved.
Use `cleanup-batch2-verification-20261023.json` for core removal. Approved retained
resource cleanup then passed seven checks at 09:47:08 UTC: exact empty R2 bucket,
KV namespace and GitHub Environment (nine secrets/four variables) deleted.
The user then deleted the dedicated Access token and both dedicated 1Password
items. A refreshed complete Safari list confirms token absence; Agent Secrets
active/archive metadata confirms both item names absent. The shared Cloudflare
credential item was also removed, confirmed intentional, then restored by the
user. The restored configured reference passed eight fresh Cloudflare checks at
09:52:28 UTC; all owned resources absent, production/shared resources preserved.
GitHub and local exposure/config checks also passed. Final closure recorded at
09:54:00 UTC in `cleanup-final-verification-20261023.json`; no planned cleanup
remains. See the [current cleanup handoff](codex-search-cleanup-20261023.md).
Evidence/history and shared credentials retained. No Recently Deleted purge,
DNS repair, credential switch, paid closeout call, PR or push.

The procedure snapshots below retain their original campaign stage.

The first FakeCo deployment and ordinary paid OpenAI inference smoke passed in
[run 39895613643](https://github.com/openclaw/clawrouter/actions/runs/39895613643),
with explicit user authorization. Both deployed native WebSocket modes passed:
cached Sol → Astra and live Astra → Sol, including compaction/reference reuse.
Cap denial and credential revocation also passed at 2026-10-23 03:54:29 UTC:
one 402 added zero cost, and the revoked key returns 403. Provider/policy/reporting
agreed on $3.614986 spent; both queues were empty. The policy monthly cap equaled
settled spend; daily/weekly and provider monthly limits remained $50, below the
user's $200 ceiling. The manual browser checkpoint and separately approved
cleanup subsequently completed. The reviewed tag
is published; no PR was created. Desktop and non-Lite models are excluded.
Fresh-origin retrieval, strict cache-only semantics, and upstream pricing remain
unqualified. A limited canary must explicitly accept those limits.

Before provisioning a new environment, review the
[permission qualification and complete cleanup plan](codex-search-canary-cleanup.md).
The existing teardown intentionally retains resources; the cleanup plan covers
those resources too and records the separate Access service-token permission gap.
For first-deployment history and its readiness snapshot, use the
[first-deployment operator handoff](codex-search-canary-handoff.md); its initial
deployment uses `provider_credentials=upload` and the verified explicit IdP UUID.

## Freeze and deployment source

The local tag `canary/codex-search-2026-10-22` pins the final tested candidate.
Resolve its full SHA and compare it with the handoff before any future operation:

```sh
candidate=$(git rev-parse 'canary/codex-search-2026-10-22^{commit}')
git show --no-patch --format=fuller "$candidate"
CLAWROUTER_DEPLOY_ENV=fakeco pnpm cf:target
```

`cf:target` without flags only prints and validates the local locked profile; it
does not inspect remote resources or require Cloudflare credentials. With scoped
Cloudflare account/token/KV inputs injected, this separate read-only check resolves
the remote KV namespace title without invoking the deployment preflight's write
probes:

```sh
CLAWROUTER_DEPLOY_ENV=fakeco node --input-type=module <<'JS'
import { deploymentTarget, verifyPolicyKvNamespaceTarget, verifyPolicyKvPreviewNamespaceTarget } from './scripts/deployment-profile.mjs';
const target = deploymentTarget();
await verifyPolicyKvNamespaceTarget(target);
await verifyPolicyKvPreviewNamespaceTarget(target);
console.log(JSON.stringify({ environment: target.environment, namespaceTitleVerified: true }));
JS
```

Use only FakeCo credentials mapped to the unprefixed runtime names described in
[FakeCo setup](fakeco.md). Inspect the current FakeCo deployment/version and save
its last known good source SHA and version ID before deployment. Keep existing
provider secrets; no secret rotation is needed for this campaign. Confirm one
public API account, no attached subscription/multi-account pool, and no account
fallback. Confirm a configured provider budget and a quiet provider traffic
window if provider-authority spend will be compared.

After separate authorization to deploy, dispatch
the existing locked workflow with its published tag and exact expected SHA:

```sh
gh workflow run deploy-cloudflare-fakeco.yml \
  --repo openclaw/clawrouter --ref canary/codex-search-2026-10-22 \
  -f expected_sha="$candidate" -f live_providers=openai \
  -f provider_credentials=existing
```

The reviewed tag is now published and its remote commit was verified.
`existing` requires an established FakeCo Worker with the required bindings;
do not silently switch to uploading credentials. The workflow also performs
ordinary live inference smoke outside the dedicated search canary budget.
Require its target, Access/admin, credential, and provider smoke gates to pass.

## Dedicated canary policy and credential

Registration is historical; do not rerun creation commands or revive this ID.
Credential `codex_search_canary_20261022` is now revoked; its original expiry is
2026-10-24 03:41:17.469 UTC.
Initial provider monthly and policy daily/weekly/monthly limits were $5; the
paid tests used $50 limits, with spend preserved. The final policy monthly limit
is $3.614986 (zero remaining); provider monthly and policy daily/weekly limits
remain $50. The provider baseline
begins after bootstrap smoke. The historical read-only registration receipt
is `.artifacts/fakeco-codex-search-20261022/search-registration-receipt.json`.

The completed batch used policy/credential ID `codex_search_canary_20261022`.
For a separately approved future run, choose a fresh policy/credential ID and
secret through the credential manager, and update every reference below. The
historical ID and secret must not be reused or revived; never reset spend.
Inject `CLAWROUTER_ADMIN_TOKEN`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`, and `CLAWROUTER_SEARCH_CANARY_SECRET` only into the
operator command. Set `CLAWROUTER_BASE_URL=https://clawrouter-fakeco.openclaw.ai`.
Never put their values in command arguments or commit them.

The [policy fixture](../config/codex-search-canary-policy.json) allows only Sol and
Astra, retention off, reserve-before-dispatch budgeting, no account fallback,
and a $5 router budget. Each standalone request costs 1,000 microUSD; inference
remains token-priced. This is a router tariff, not an upstream invoice cap.
The smoke's key inspection checks the configured budget and tariff; the admin
policy below establishes `budgetMode=reserve`, which key inspection does not expose.

After deployment authorization, register the policy before enabling its credential:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { adminRequest } from './scripts/admin-api.mjs';
assert.equal(process.env.CLAWROUTER_BASE_URL, 'https://clawrouter-fakeco.openclaw.ai');
const id = 'codex_search_canary_20261022';
const secret = process.env.CLAWROUTER_SEARCH_CANARY_SECRET;
assert.ok(typeof secret === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(secret));
const policies = await adminRequest('/v1/admin/policies', { method: 'GET' });
const credentials = await adminRequest('/v1/admin/credentials', { method: 'GET' });
assert.ok(!policies.policies.some(p => p.policyId === id), 'choose a fresh canary ID');
assert.ok(!credentials.credentials.some(c => c.credentialId === id), 'choose a fresh canary ID');
const body = JSON.parse(await readFile('config/codex-search-canary-policy.json', 'utf8'));
await adminRequest(`/v1/admin/policies/${id}`, { method: 'PUT', body, responseMode: 'ack' });
await adminRequest(`/v1/admin/credentials/${id}`, { method: 'PUT', responseMode: 'ack', body: {
  enabled: true, policyId: id, principalId: null,
  secretSha256: createHash('sha256').update(secret).digest('hex'),
  expiresAt: new Date(Date.now() + 86400000).toISOString()
} });
console.log(JSON.stringify({ canaryRegistered: true, credentialId: id }));
JS
```

Use the credential manager to inject the resulting full router credential as
`CLAWROUTER_SMOKE_KEY` for the following commands. It has format
`clawrouter-live-codex_search_canary_20261022-<secret>`; do not print it. No upstream
API key, Cloudflare token, or admin token is needed by the native smoke.

## Deployed native qualification

Both modes below passed. These commands record the tested configuration; the
campaign credential is now revoked. A new run needs a fresh credential and approval.

Capture the provider-budget baseline before paid smoke using the observation
command below. Run the two modes sequentially; they share the same dedicated
budget. The approved limits at that stage were $50. Astra opaque-state admission reserves
up to $46.7144 in the pinned pricing envelope; $5 and $15 attempts therefore
failed qualification on zero-cost 402 denials despite much lower settled spend.
The fixture and harness default remain $5; explicitly pass the approved $50
ceiling below. Each invocation admits at most 32 routed operations and caps inference
output at 4,096 tokens per operation. Admission can stop earlier at the policy or
provider budget. Do not raise a cap automatically on failure.

```sh
CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs \
  --router-url https://clawrouter-fakeco.openclaw.ai --expected-environment fakeco \
  --max-budget-micros 50000000 \
  --model gpt-6.1-sol --switch-model gpt-6-astra \
  --web-search cached --transport websocket --compact
CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs \
  --router-url https://clawrouter-fakeco.openclaw.ai --expected-environment fakeco \
  --max-budget-micros 50000000 \
  --model gpt-6-astra --switch-model gpt-6.1-sol \
  --web-search live --transport websocket --compact
```

The parent relay holds the real router key in memory; Codex receives a random
synthetic key, isolated HOME/CODEX_HOME, and an ephemeral local profile/catalog.
Only catalog reads and the qualified native endpoints are relayed. There is no
local upstream-key substitution or local production Worker in deployed mode.
The test verifies search/open/click/find, citations, original-reference resume,
model switching, completed native compaction followed by reference reuse, one
client search namespace, and actual WebSocket inference with no HTTP fallback.
Known HTTP-200 tool errors fail qualification even if the CLI retries successfully.
Origin probes and direct replays are deliberately unavailable in deployed mode.

The remote usage check waits up to 60 seconds for receipts, correlates by the
relay's unique attribution session, checks fixed search vs token inference prices
and retention off, and compares the dedicated policy's usage/spend deltas.
It rejects unexpected concurrent policy traffic. It never uses the fixture SQL
inspection route. A successful result explicitly reports
`providerLedgerInspected=false`; provider authority and queue checks remain below.
Do not repeat paid requests to resolve delayed reporting. Inspect queue delivery
and settlement first. HTTP or process success alone is insufficient.

## Observation and stop conditions

Before and after each smoke, read only the provider-authority spend projection:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { adminRequest } from './scripts/admin-api.mjs';
assert.equal(process.env.CLAWROUTER_BASE_URL, 'https://clawrouter-fakeco.openclaw.ai');
const { connections } = await adminRequest('/v1/admin/connections', { method: 'GET' });
const row = connections.find(c => c.providerId === 'openai');
assert.ok(Number.isSafeInteger(row?.spentMicros), 'provider budget must be configured for spend comparison');
console.log(JSON.stringify({ provider: 'openai', spentMicros: row.spentMicros, remainingMicros: row.remainingMicros }));
JS
pnpm exec wrangler queues info clawrouter-usage-fakeco
pnpm exec wrangler queues info clawrouter-usage-fakeco-dead-letter
```

Use FakeCo-scoped Cloudflare credentials for those queue reads. Compare provider
spend delta with the smoke's total only during a quiet provider window; otherwise
record the comparison as inconclusive. Queue info identifies the intended queues;
inspect their backlog/retry/DLQ metrics in Cloudflare separately. Do not consume or
print queue bodies. Record receipt convergence, settlement errors, 402/403/409/5xx,
`search_restart_required`, and synthetic tool-output failures without raw content.
Stop on a failed qualification, unexplained spend, retained content, settlement
error, or new DLQ backlog. Do not reset budgets or silently fall back to HTTP.

## Budget denial and rollback drill

This campaign's cap-denial and credential-revocation checks passed. The denial
receipt charged zero and the saved key now returns 403. Metadata receipt:
`.artifacts/fakeco-codex-search-20261022/cap-denial-revocation-receipt.json`.
The following commands remain a procedure for future separately approved runs.

After capturing successful accounting, lower the dedicated monthly cap to its
already-settled spend and make one denial probe. It should return 402 with no
additional spend. Keep the cap positive so public budget status continues to
show the existing ledger balance:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { adminRequest } from './scripts/admin-api.mjs';
assert.equal(process.env.CLAWROUTER_BASE_URL, 'https://clawrouter-fakeco.openclaw.ai');
const headers = { authorization: `Bearer ${process.env.CLAWROUTER_SMOKE_KEY}`, 'content-type': 'application/json' };
const readUsage = async () => {
  const response = await fetch(`${process.env.CLAWROUTER_BASE_URL}/v1/usage`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); return response.json();
};
const before = await readUsage();
assert.ok(Number.isSafeInteger(before.budget.spentMicros) && before.budget.spentMicros > 0);
const policy = JSON.parse(await readFile('config/codex-search-canary-policy.json', 'utf8'));
// Preserve the authorized daily/weekly headroom while testing monthly denial.
policy.dailyBudgetMicros = before.budget.daily.limitMicros;
policy.weeklyBudgetMicros = before.budget.weekly.limitMicros;
await adminRequest('/v1/admin/policies/codex_search_canary_20261022', { method: 'PUT', responseMode: 'ack', body: { ...policy, monthlyBudgetMicros: before.budget.spentMicros } });
const response = await fetch(`${process.env.CLAWROUTER_BASE_URL}/v1/native/openai/v1/alpha/search`, {
  method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  body: JSON.stringify({ id: randomUUID(), model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'official OpenAI homepage' }] }, settings: { external_web_access: false } })
});
await response.body?.cancel(); assert.equal(response.status, 402);
assert.equal((await readUsage()).budget.spentMicros, before.budget.spentMicros);
console.log(JSON.stringify({ capDenied: true, additionalSpendMicros: 0 }));
JS
```

For any stop condition, revoke the dedicated credential through authority first:

```sh
node scripts/key-revoke.mjs --kid codex_search_canary_20261022
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
assert.equal(process.env.CLAWROUTER_BASE_URL, 'https://clawrouter-fakeco.openclaw.ai');
const response = await fetch(`${process.env.CLAWROUTER_BASE_URL}/v1/key/inspect`, { headers: { authorization: `Bearer ${process.env.CLAWROUTER_SMOKE_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
await response.body?.cancel(); assert.equal(response.status, 403);
console.log(JSON.stringify({ revokedKeyDenied: true }));
JS
```

The harness removes its client profile automatically. Any separately managed
client should disable search/remove its profile. Treat old references as disposable
after owner/policy changes. If Worker restoration is needed, dispatch the same
locked FakeCo workflow against the previously recorded, reviewed published ref and
its exact full `expected_sha`, keeping existing provider credentials. Revalidate
health/Access/provider gates after restoration. This is code restoration, not a
budget reset or secret rollback. Never tear down Durable Objects to roll back.

The requested manual browser checkpoint completed before cleanup. At that stage,
human Access admission used membership in the `openclaw` GitHub organization.
At the user's request, `joshavant@gmail.com` was FakeCo's sole human admin email;
Safari confirmed the admin role. The matching deployment variable was removed
with the dedicated GitHub Environment during cleanup.
