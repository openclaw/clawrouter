# FakeCo canary operator handoff — archived

**Handoff closed; no live resources or pending operator action.** Use the
[final cleanup record](codex-search-cleanup-20261023.md) for current disposition
and the [qualification assessment](codex-search-qualification.md) for remaining
product limitations. All readiness, credential, ownership and approval statements
below are historical snapshots; they do not authorize replay or credential revival.

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

The dated entries below are historical. `paired-retrieval-receipt.json` records
former fixture ownership; that fixture is now deleted as recorded above. The completed Funnel experiments have no pending
exposure cleanup. Refresh read-only inventory before any future mutation.

Prepared 2026-10-22. The user now authorizes individual Cloudflare write batches
after being asked; this replaces the earlier strictly read-only boundary for
explicitly approved batches only. The assistant created the GitHub Environment,
published the reviewed candidate tag, and ran the separately authorized queue/KV
provisioning once. All were verified afterward. Ask before any further Cloudflare
mutation, including workflow dispatch that causes Cloudflare writes. No PR
or cleanup has run. The separately approved first deployment
and ordinary paid OpenAI smoke passed. Upstream search billing remains unqualified.
Dedicated registration, both deployed native search modes, cap denial and
credential revocation passed. As of 2026-10-23 03:54:29 UTC, settled campaign spend
is $3.614986 and usage/DLQ backlogs are zero. The search key is revoked and its
monthly policy cap equals settled spend; daily/weekly and provider monthly limits
remain $50. The user authorized up to $200 if needed; no limit above $50 was needed.
Paused for the user's manual browser login. Earlier setup details below are historical.
The isolated GitHub Environment now contains the nine required secrets and four
variables, uploaded from verified inputs without displaying or caching secret values.

## Historical readiness snapshot

Cloudflare ownership baseline refreshed: 2026-10-23 03:28:36 UTC.
Metadata-only receipt: `.artifacts/fakeco-codex-search-20261022/preprovision-baseline.json`.
Refresh again if provisioning is deferred or another operator changes these targets.

| Input | Verified state |
| --- | --- |
| Cloudflare account | OpenClaw; `91b59577e757131d68d55a471fe32aca` |
| Locked FakeCo targets | Clear original baseline; approved queue/KV and first-deployment batches created the isolated resources recorded below |
| GitHub Environment | `openclaw/clawrouter` / `fakeco`; ID `25093378320`; nine secrets and four variables, including the subsequently authorized browser-admin email |
| FakeCo workflow | Run `39895613643` succeeded, including ordinary paid OpenAI inference smoke |
| Candidate | Published annotated tag `canary/codex-search-2026-10-22`; peeled remote commit `beed4c7d873e82bfdeb024afe609ccabf9c9c493`; branch remains unpublished |
| Access team | `crabbox-openclaw.cloudflareaccess.com` |
| Shared GitHub IdP | Safari shows GitHub; existing production GitHub organization policy references UUID `32ade06d-f190-4da6-985d-6d1ebc5617da` for `openclaw` |
| Dedicated service token | User-created UUID `f6264117-b130-4b39-a4f9-4b01a17b4ffa`; Enabled, 24h, expires Oct 23, 2026; referenced by the FakeCo service-token policy; authenticated admin proof passed |
| OpenAI credential | `op://Agent Secrets/OpenAI/OPENAI_API_KEY`; populated field verified, value not displayed |
| Admin/router credentials | User saved `ClawRouter FakeCo canary credentials 20261022`; all three fields populated, valid and distinct on read-only verification at 2026-10-23 03:26:37 UTC |

Local `cf:target` and Access `--dry-run` passed with the explicit shared IdP UUID
and the dedicated service-token UUID. Neither command wrote to Cloudflare.
The management token's IdP list returns an empty result while Safari shows three
providers; direct IdP GET returns 403. Use the explicit UUID above rather than
automatic discovery. Preserve that shared provider during cleanup.

The service token expires October 23, 2026 at 08:17 PM as displayed in Safari;
display timezone remains unqualified. Recheck enabled status and expiry before
deployment. Its API inventory is also incomplete; use the browser verification
described in the [cleanup record](codex-search-canary-cleanup.md).

## Historical credential preparation (dedicated items subsequently deleted)

The user created an item in **Agent Secrets** named
`ClawRouter FakeCo canary credentials 20261022`, with three independent random
alphanumeric values of at least 40 characters:

- `ADMIN_TOKEN`
- `SMOKE_SECRET`
- `SEARCH_CANARY_SECRET`

The user reported saving the item. Metadata verification found all three fields
populated and no `ACCESS_INSTRUCTIONS` field. Targeted in-memory reads confirmed
each value has at least 40 alphanumeric characters and all three values differ.
No values were displayed or cached during verification.
The admin digest and full bootstrap key will be derived in memory when preparing
their user-operated upload; no extra plaintext cache is needed.

## Historical local inputs

Ignored directory: `.artifacts/fakeco-codex-search-20261022/`.

- `cloudflare.env`: account, management-token reference, locked deployment target,
  and disabled Wrangler metrics. No mutation confirmation.
- `access-plan.env`: only non-secret Access metadata, including both UUIDs.
- `application.env`: verified application credential references.

All credential entries are `op://` references. No secret values are stored in
these files. Do not source them as shell code; inject through the skill helper.
No provider key is included in the Cloudflare provisioning environment.
The Cloudflare reference file was exercised through `op run` with the local-only
`cf:target -- --mutation` guard check; the FakeCo target lock passed without a
Cloudflare mutation.

## Completed operator gates

The user completed the requested manual browser inspection. Separate approvals
covered credential revocation and each infrastructure cleanup batch. The user
manually deleted the dedicated Access token and both dedicated 1Password items.
Final verification at 2026-10-23 09:54:00 UTC confirms all owned resources absent
and production/shared resources preserved; see the
[final cleanup record](codex-search-cleanup-20261023.md). No operator gate remains.

### Completed: browser admin grant

The user requested admin access for GitHub `joshavant` and supplied
`joshavant@gmail.com`, matching the existing enabled FakeCo user. Browser roles
derive from the verified Access email allowlist, not the stored user role.
Added only `CLAWROUTER_ACCESS_ADMIN_EMAILS=joshavant@gmail.com` to
`clawrouter-edge-fakeco`, explicitly inheriting all 17 existing bindings.
Persisted `CLAWROUTER_FAKECO_ACCESS_ADMIN_EMAILS` in the `fakeco` GitHub Environment.
No production configuration or runtime source changed. That grant created version
`5d05ccb8-6be2-437f-ba8e-4a3208e24627`; qualification used the earlier version below.
The original settings verification guard failed after the acknowledged write;
subsequent read-only checks independently confirmed all existing version bindings,
runtime settings, revoked search key, policy limits and provider spend were preserved.
Safari confirmed the actual human session is admin.
Receipt: `.artifacts/fakeco-codex-search-20261022/browser-admin-receipt.json`.
Manual exploration remains open; no cleanup is authorized by this grant.

### Completed: request-price label deployment

The user requested a title change and explicitly authorized deployment. Focused
local commit `e197f3073a13d54f0bd7770f4dbecd8e235ff9d6` changes only the label
to "Price per request by capability" and explains the existing units in the
tooltip. The JSON input and behavior remain unchanged. Admin TypeScript checks,
72 focused policy tests and the build passed. Direct locked-target deployment
preserved all bindings, the admin email and Worker code/runtime; no provisioning
or paid inference smoke was run. At 2026-10-23 04:09:14 UTC the healthy active
FakeCo version was `272eab13-76a3-4281-8ffb-07e73b2988bf` at 100% traffic.
The served JS matches the local build SHA-256 and contains the new title.
Receipt: `.artifacts/fakeco-codex-search-20261022/label-deployment-receipt.json`.
The branch remains unpublished. No PR or cleanup has run.

### Completed: request-price dollar-input deployment

Subsequent commit `efa121b` changes both request-price inputs to US dollars,
with exact conversion to the existing integer-microdollar API. Existing values,
zero overrides, blank/null values, defaults and presets retain their meaning.
The JSON example is now `{"search.web":0.001}`. Sub-microdollar prices fail before
any API mutation. Build, 236 admin tests and four desktop/mobile browser checks
passed; independent autoreview found no actionable P0–P2 defects. The user
explicitly authorized deployment. At 2026-10-23 04:17:51 UTC, healthy FakeCo version
`7d17a962-c1d7-4257-aebb-b4f6c3b7955d` serves 100% of traffic. The served asset
matches the local build and contains both dollar inputs. Worker code, runtime,
bindings, admin access and application configuration are unchanged; retention
remains off and the search credential remains revoked. Receipt:
`.artifacts/fakeco-codex-search-20261022/dollar-input-deployment-receipt.json`.
No provisioning, paid inference smoke, PR or cleanup was performed. Preserve the
user's browser checkpoint before any separately authorized cleanup.

### Completed: capability-price layout deployment

Commit `eee614aebd32acf859fd09c71b4f149a7d279b57` moves capability pricing
below Fixed request cost and gives it the same full-width textarea dimensions as
Limit hint. Admin TypeScript/build and the existing desktop/mobile price-editing
browser checks passed. Browser measurements confirmed equal width and height on
both viewports; the desktop rendering was visually inspected.

The user explicitly authorized deployment. Healthy FakeCo version
`6f20b7a4-4323-47c5-8db3-8c3ba29f7f7e` now serves 100% of traffic. The initial
post-deployment assertion failed; a separate read-only reconciliation verified
the exact version, all bindings, unchanged Worker code/runtime, retention off,
matching served asset bytes and unchanged application state. No deployment retry
or rollback occurred. Receipt:
`.artifacts/fakeco-codex-search-20261022/capability-layout-deployment-receipt.json`.
No paid inference, PR or cleanup was performed; the browser checkpoint remains open.

### Completed: capability-price JSON title deployment

Commit `8deedac049d36ddf5ed056befe0a2d3bb13c950b` appends `· JSON object`
to the capability-price title, matching the service-tier field. Admin build and
desktop/mobile price-editing browser checks passed. The user explicitly approved
deployment. At 2026-10-23 04:23:44 UTC, healthy FakeCo version
`3d669069-fb9e-45e0-a71b-bded66c5b7b2` serves 100% of traffic. Served asset
bytes and the full title were verified; Worker code, runtime, bindings and
application state are unchanged. Retention remains off and the search credential
remains revoked. Receipt:
`.artifacts/fakeco-codex-search-20261022/capability-json-title-deployment-receipt.json`.
No paid inference, PR or cleanup was performed; preserve the browser checkpoint.

### Completed: deployed dollar-price roundtrip

The user authorized a focused live UI save/read/reload check. Safari created
`ui_dollars_smoke_20261022` through the deployed FakeCo console: disabled,
monthly budget $0, OpenAI only, retention off, no credentials or bindings.
Both Fixed request cost and `search.web` capability price were entered as $0.001.
Read-only admin API verification at 2026-10-23 04:26:38 UTC confirmed
`requestCostMicros: 1000` and `requestCostsMicros: {"search.web":1000}`.
A full browser reload and policy reselection displayed 0.001 in both inputs.
Existing policies, bindings, credentials, provider configuration and spend match
the baseline. No paid inference or deployment occurred. The disabled test policy
remains for inspection and eventual approved FakeCo teardown; no cleanup ran.
Receipt: `.artifacts/fakeco-codex-search-20261022/live-dollar-roundtrip-receipt.json`.

### Completed: provider budget and dedicated search registration

After the user's explicit approval, fresh reads confirmed OpenAI enabled with
unconfigured budget fields and both dedicated IDs absent. The API omits these
unconfigured fields rather than returning explicit nulls. Applied exactly once:

1. `PATCH /v1/admin/connections/openai` with
   `{"monthlyBudgetMicros":5000000}`. Preserve other fields. Do not reset any
   existing spend; fail if the baseline unexpectedly differs.
2. `PUT /v1/admin/policies/codex_search_canary_20261022` with the existing
   `config/codex-search-canary-policy.json`: Sol/Astra only, retention off,
   reserve mode, no fallback, $5 daily/weekly/monthly limits, 1,000 microUSD search tariff.
3. `PUT /v1/admin/credentials/codex_search_canary_20261022` with that policy,
   SHA-256 of the saved `SEARCH_CANARY_SECRET`, and a 24-hour expiry.

Read-only verification completed at 2026-10-23 03:41:56 UTC. Provider spend is zero,
remaining 5,000,000 microUSD; policy monthly/daily/weekly ledgers agree. The saved
search key verifies, credential is active, usage has zero requests/events/cost,
and the executable OpenAI catalog exposes exactly the two allowed models.
Policy model sets are normalized in sorted order and routing adds default fields;
verification compares the requested settings semantically. Retention remains off.
Credential expiry: **2026-10-24 03:41:17.469 UTC** (Oct 23, 8:41:17 PM PDT).
Metadata receipt: `.artifacts/fakeco-codex-search-20261022/search-registration-receipt.json`.
No paid inference/search ran in this batch. These are ClawRouter accounting limits;
upstream charges remain unqualified. Existing spend was not reset.

### Completed: deployed native cached/live qualification

The user approved both paid tests and increased the allowed ceiling to $15,
then $50, then $200 if needed. Actual configured limits reached $50 only, with
every earlier charge preserved. No Worker code, provider credentials, or human
permissions changed. No upstream key was injected into the native client/harness;
the parent relay held only the dedicated router key, and Codex used a synthetic key.

| Mode | Models | Outcome | Receipts / search operations | Compactions | Router cost |
| --- | --- | --- | --- | --- | --- |
| cached | Sol → Astra | Passed | 16 / 5 | 2 | $0.979108 |
| live | Astra → Sol | Passed | 16 / 5 | 2 | $0.667252 |

Both verified actual WebSocket inference with no HTTP fallback, native
search/open/click/find, citations, model switching, original-reference resume,
one search namespace, and reference reuse after automatic compaction. Search
requests preserved `external_web_access=false` for cached and `true` for live.
No tool-output failure was accepted. Each test stayed within 32 operations and
4,096 output tokens per inference. Content retention remained off in every receipt.
Provider-authority deltas independently matched each test's policy/receipt costs.

Two earlier cached attempts at $5 and $15 stopped on router-side 402 admission
denials during Astra resume. Each denial charged zero; all 34 receipts settled,
total cost $1.968626. A local synthetic calculation against pinned pricing code
found the conservative opaque-input reservation: Astra $46.7144, Sol $28.02864
(922,000 input / 4,096 output token bounds, worst qualified tier/cache rate).
These are reservation estimates, not actual request charges. The separately
approved increases to $15 and $50 preserved spend and credential expiry.

The successful cached run's outer runner paused on an immediate nonempty queue
snapshot; read-only follow-up at 03:50:11 UTC proved drain and reconciliation.
Live ran separately without repeating cached traffic. Final snapshot 03:51:16 UTC:
66 receipts, 64 successes and two earlier zero-cost denials; provider authority,
policy authority, and reported total all **3,614,986 microUSD**. Both queue
backlogs are zero. Fresh-origin retrieval, strict cache-only semantics, desktop,
non-Lite models, and upstream billing remain unqualified.

Metadata receipts under `.artifacts/fakeco-codex-search-20261022/`:
`native-search-receipt.json`, `native-search-headroom-receipt.json`,
`search-headroom-receipt.json`, `search-headroom-50-receipt.json`,
`opaque-reservation-bound.json`, `native-search-50-receipt.json`,
`native-search-live-receipt.json`, and `native-qualification-summary.json`.
The first two native receipts remain failed attempts; the cached $50 receipt
retains its queue-pause status alongside the successful qualification and drained
follow-up. Use the summary and live receipt for the final campaign state.

### Completed: cap denial and credential revocation

The user separately approved this batch. Fresh reads confirmed unchanged spend,
66 settled receipts, both credentials active, the pinned Worker version and empty
queues. Applied exactly once:

1. `PUT /v1/admin/policies/codex_search_canary_20261022`, preserving its settings
   except lowering the monthly limit to settled spend, 3,614,986 microUSD. A full
   policy comparison proved no other setting changed. Daily/weekly limits remain
   $50 and the provider connection is unchanged.
2. One standalone search POST returned **402 `budget_exhausted`**. Request ID:
   `capdeny_15aca696e1794859a7e5a5b249c13a30`. Its correlated receipt is denied,
   reserved/actual cost zero, tokens null, retention off. Provider/policy/reported
   spend remained 3,614,986 microUSD; reporting converged to 67 requests, 64
   successes and three zero-cost denials. Both queues drained.
3. `POST /v1/admin/credentials/codex_search_canary_20261022/revoke` succeeded.
   Admin reads show enabled/active false; the saved key's `/v1/key/inspect`
   returns **403**. Original expiry is preserved; bootstrap remains active.

Final verification: 2026-10-23 03:54:29 UTC. The pinned Worker still serves FakeCo;
`/dashboard/` returns a 302 challenge from the expected Access team. Browser login
has not been performed by the assistant. No cleanup, Worker restoration,
bootstrap-key revocation or human admin grants ran. Metadata receipt:
`.artifacts/fakeco-codex-search-20261022/cap-denial-revocation-receipt.json`.
Preserve the deployment until the user finishes manual login/exploration and
separately approves cleanup.

### Completed: GitHub Environment and candidate tag (receipt)

The user explicitly authorized the assistant to execute these two writes after
fresh reads established that both targets were absent:

```sh
gh api --method PUT repos/openclaw/clawrouter/environments/fakeco --input - <<'JSON'
{}
JSON
git push origin refs/tags/canary/codex-search-2026-10-22:refs/tags/canary/codex-search-2026-10-22
```

Verified result: Environment `fakeco`, ID `25093378320`, created at
2026-10-23 03:27:15 UTC with default settings (no protection rules or deployment
branch policy), zero Environment secrets and zero variables. The remote tag
object is `b0ecc9fd60322d9892d44cbf6e537c4d33db81c1` and its peeled commit matches
the reviewed SHA above. No force push, PR, merge, or deployment dispatch occurred.
The FakeCo deployment workflow still has zero runs. Record this Environment and
exact tag as run-created artifacts; do not delete unrelated repository refs or
configuration during cleanup.

### Completed: approved Cloudflare queue and KV provisioning

The user explicitly asked the assistant to execute the following command and
to ask again before subsequent Cloudflare mutations. Immediate pre-write GET
inventories at 2026-10-23 03:29:43–44 UTC established no matching queue/KV names.
The command ran once and exited successfully:

```sh
CLAWROUTER_DEPLOY_CONFIRM=fakeco \
  /Users/joshavant/.codex/skills/one-password/scripts/op-with-service-account run \
  --env-file .artifacts/fakeco-codex-search-20261022/cloudflare.env \
  -- pnpm cf:provision
```

Read-only detail verification completed at 2026-10-23 03:30:11 UTC:

| Resource | Created ID |
| --- | --- |
| KV `clawrouter-policy-fakeco` | `ca69a07938214acf9fae2bfea2ee2e8d` |
| Queue `clawrouter-usage-fakeco` | `bd6016244cd749f78e916e50a2ac7dd9` |
| DLQ `clawrouter-usage-fakeco-dead-letter` | `2843acdd30004177a6c3a092f13d9ee3` |

Both queues had zero producers and consumers at verification. All three resources
are owned by this run. Receipt:
`.artifacts/fakeco-codex-search-20261022/provision-receipt.json`.
Do not rerun provisioning: KV creation is not idempotent. No Worker, R2 bucket,
Access app/policy, upstream credential upload, or paid inference was part of this batch.

### Completed: GitHub deployment inputs and read-only preflight

The assistant verified the exact Environment ID and an empty secret/variable
inventory before uploading the nine secrets and three variables listed below.
Secrets were passed to `gh secret set` through stdin from in-memory values,
including the derived admin digest and bootstrap key. Secret values were not
printed, placed in arguments, or cached. Each successful write was recorded in
`.artifacts/fakeco-codex-search-20261022/github-inputs-receipt.json`.
Read-only inventory verification found the exact nine names and all three
expected variable values at 2026-10-23 03:31:58 UTC. Secret values cannot be read
back; the local preflight used the same input derivations.

`deploy-preflight.mjs --before-access` passed with the real saved inputs and exact
KV ID: 22 providers / 22 smoke targets compiled, OpenAI upload inputs ready,
admin hash pair valid, locked KV title verified. This mode made no Cloudflare
writes. Access dry-run also passed with the explicit shared GitHub IdP UUID and
dedicated service-token UUID. The remote tag still resolves to the reviewed SHA;
the FakeCo deployment workflow still has zero runs.

### Completed: approved first FakeCo deployment

The user approved this batch and the assistant dispatched it once:

```sh
gh workflow run deploy-cloudflare-fakeco.yml \
  --repo openclaw/clawrouter --ref canary/codex-search-2026-10-22 \
  -f expected_sha=beed4c7d873e82bfdeb024afe609ccabf9c9c493 \
  -f live_providers=openai -f provider_credentials=upload \
  -f access_github_orgs=openclaw \
  -f access_idp_ids=32ade06d-f190-4da6-985d-6d1ebc5617da
```

This batch creates the locked Access app/human and service-token policies, performs
the normal temporary KV write/delete probe, creates R2 storage and its lifecycle,
deploys `clawrouter-edge-fakeco` with assets, custom domain and isolated Durable
Objects, installs OpenAI/admin-digest credentials, and registers the bootstrap
router credential. The workflow then runs ordinary paid OpenAI inference smoke.
It does not register the dedicated search credential or run the native search
canary. The $5 dedicated search policy cap does not cover bootstrap inference;
upstream billing and provider-side budget qualification remain unproven.
Record each newly created resource ID and any partial failure before proceeding.

Run [39895613643](https://github.com/openclaw/clawrouter/actions/runs/39895613643)
completed successfully in 2m32s against the reviewed SHA. Worker checks, admin
type checks/tests/build, source/target gates, Access convergence, normal preflight,
R2 provisioning, deployment, secret installation, service/admin proof, bootstrap
registration, and live OpenAI smoke all passed. Smoke request:
`smoke_f3125992-f07e-4d7a-b754-61ee50a5a4d8`; usage event:
`usage_c927fcd37f72480b8064730e4b82316e`.

Independent read-only verification at 2026-10-23 03:36:02 UTC confirmed healthy
release 0.5.0, version `82bbd5bc-e569-435c-8738-d3c12789207b`, environment FakeCo,
metadata-only observability, retention default off, unauthenticated admin Access
challenge, authenticated service-token/admin success, and executable/verified
OpenAI catalog readiness. The dedicated search policy and credential remain absent.
R2's `v1/` 30-day expiry rule was independently verified. The usage queue's sole
producer and consumer are `clawrouter-edge-fakeco`; the DLQ has neither.

Metadata receipts: `deployment-receipt.json`, `deployment-resource-receipt.json`,
and `deployment-verification.json` in the ignored campaign artifact directory.
The [cleanup ownership record](codex-search-canary-cleanup.md) includes every
observed namespace/app/policy/domain ID and the bootstrap router credential.

### Environment secrets

All names below have prefix `CLAWROUTER_FAKECO_`.

| Suffix | Source |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | `op://Agent Secrets/Clawrouter Cloudflare API Token/notesPlain` |
| `CLOUDFLARE_ACCOUNT_ID` | `91b59577e757131d68d55a471fe32aca` |
| `POLICY_KV_ID` | Verified run-created namespace `ca69a07938214acf9fae2bfea2ee2e8d` |
| `ADMIN_TOKEN` | New item / `ADMIN_TOKEN` |
| `ADMIN_TOKEN_SHA256` | SHA-256 of exact admin token, derived in memory |
| `SMOKE_KEY` | `clawrouter-live-fakeco_bootstrap_20261022-` plus new item / `SMOKE_SECRET` |
| `ACCESS_CLIENT_ID` | `op://Agent Secrets/clawrouter-fakeco-codex-search-20261022/CLIENT_ID` |
| `ACCESS_CLIENT_SECRET` | `op://Agent Secrets/clawrouter-fakeco-codex-search-20261022/CLIENT_SECRET` |
| `PROVIDER_OPENAI_API_KEY` | `op://Agent Secrets/OpenAI/OPENAI_API_KEY`; first-deploy upload to FakeCo Worker |

Do not create secret values in variables or command arguments. Do not overwrite
unexpected existing entries. The dedicated search secret stays in 1Password; it
is not needed by the deployment workflow.

### Environment variables and dispatch

| Name | Value |
| --- | --- |
| `CLAWROUTER_FAKECO_ACCESS_TEAM_DOMAIN` | `crabbox-openclaw.cloudflareaccess.com` |
| `CLAWROUTER_FAKECO_ACCESS_DEFAULT_TENANT` | `fakeco` |
| `CLAWROUTER_FAKECO_ACCESS_SERVICE_TOKEN_IDS` | `f6264117-b130-4b39-a4f9-4b01a17b4ffa` |

The workflow derives the newly created app's audience into its runner environment;
do not invent `ACCESS_AUD` in advance. No human admin identities are assigned by
this preparation; service-token plus admin-bearer authentication supports the
canary commands. Human Access admission remains the existing `openclaw` GitHub
organization rule.

Dispatch inputs: `expected_sha=beed4c7d873e82bfdeb024afe609ccabf9c9c493`,
`live_providers=openai`, `provider_credentials=upload`,
`access_github_orgs=openclaw`,
`access_idp_ids=32ade06d-f190-4da6-985d-6d1ebc5617da`.
Keep other identity inputs empty unless separately configured by the user.

The dedicated search fixture already specifies reserve-before-dispatch,
retention off, Sol/Astra only, no fallback, and $5 daily/weekly/monthly router
limits. These do not qualify upstream billing or cap total provider charges.
Provider project/budget qualification remains a separate pre-paid-test check.

### Prepared locally: hosted search semantics qualification

Local commit `77bf4ac4fa1f155861b2415648242178ec17089b` adds a separate
FakeCo-only fixture Worker on `/search-semantics/*`, serialized Durable Object
counters, authenticated synthetic run controls, hidden markers, rotation,
direct/routed matrix probes and hosted native-harness integration. No router
production hot-path changes. New scoped key preparation and the supported DO
delete-migration cleanup candidate are included.

Validation: Worker typecheck + 2,568 Worker tests; 23 focused workerd/probe/relay
tests; both Wrangler deployment configs passed local dry runs. Required
autoreview of this commit completed scoped-clean at P0–P2, no findings.
Review status: `/Users/joshavant/.codex/review-results/search-semantics-3ss6akik/status.json`.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-preparation.json`.

No Cloudflare writes, secret uploads, credential registration, budget changes,
paid probes or cleanup occurred in this preparation. No PR or push.
Next proposed approval is fixture deployment only: Worker
`clawrouter-search-semantics-fakeco`, its new `SearchSemanticsObject` namespace,
exact HTTPS path route, and purpose-separated control-token digest. Refresh
read-only ownership/cache/Access baselines immediately before any approved write.
Paid probes and new router key/provider headroom remain separate approval batches.
See [the staged plan and cleanup procedure](search-semantics-validation.md).

### Completed: approved hosted fixture deployment

User approved the fixture Worker, new Durable Object namespace, exact path route
and control digest only. Deployed reviewed source `77bf4ac` and verified at
2026-10-23 04:45:59 UTC. Worker `clawrouter-search-semantics-fakeco` serves
`https://clawrouter-fakeco.openclaw.ai/search-semantics/health` with 200. Active
version `7c4bb07f-e01e-42f1-a784-7e58de842462`; route ID
`3027364f1df44bcfa2b39ce11a1fea14`; SQLite namespace
`148cbb6483b4421dbf8b25301a325865`, class `SearchSemanticsObject`.
Control digest secret binding installed; unauthorized requests return 404.
The namespace has zero allocated objects. No synthetic page runs, paid probes,
router credential registration, budget changes, PR, push, or cleanup occurred.

Existing router version `3d669069-fb9e-45e0-a71b-bded66c5b7b2`, settings,
deployments, custom domain, Access app, prior routes and all 36 namespaces match
the pre-write baseline. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-deployment-receipt.json`.
Cleanup ownership IDs and the delete-migration sequence are recorded in the
cleanup record and [fixture runbook](search-semantics-validation.md).

Cache Rules/Page Rules API reads returned 403 with the management token. Resolve
effective cache behavior via read-only dashboard inspection and/or separately
approved calibration before semantic qualification. Do not switch auth modes
to bypass this denial. Direct probe run creation/rotation/deletion and paid
search calls still require the next explicit batch approval. Router registration
and provider headroom remain later separate approvals after direct live retrieval.

### Completed: read-only cache-policy inspection

At 2026-10-23T06:09:50.397Z, Safari visibly showed zero Cache Rules, zero Cache
Response Rules, and no Page Rules (0 of 20 used) for the expected OpenClaw
account/openclaw.ai zone. No rules, toggles or Cloudflare state were changed.
The existing management token still lacks the denied cache-rule API permissions;
its allowed Worker metadata reads show no cache/exports opt-in on the fixture,
consistent with the reviewed deployment configuration. Cloudflare documents that
removing the Worker cache block disables that cache. No network caching behavior
is qualified by configuration evidence alone.

The separate default-cache configuration page was not inspected: the user began
using other Safari windows, and further UI actions stopped. No unrelated browser
content is retained in the receipt. Next: separately approved synthetic counter
calibration, then bounded direct Sol probing. No fixture run or paid probe ran.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-cache-inspection.json`.

### Completed: approved hosted counter calibration

At 2026-10-23T06:18:12.735Z, the assistant completed the separately approved single-run
calibration against fixture version `7c4bb07f-e01e-42f1-a784-7e58de842462`.
The run had a five-minute expiry. Two GETs and one HEAD at exactly the same URL
produced exact totals of two GETs/one HEAD; rotation preserved the URL and those
totals, changed the hidden marker, and reset revision GETs. A final GET returned
the new marker with totals three GETs/one HEAD and one GET at revision 2. The other
three synthetic pages remained untouched. Public responses allowed upstream cache
use while carrying both CDN no-store headers; none reported CF-Cache-Status or Age.

Only that run was deleted. Its authenticated snapshot and previously public page
both return 404. The registry Durable Object is now allocated; the namespace and
Worker remain deployed for further separately approved probing and eventual
cleanup. No namespace/Worker deletion was performed. Fixture/main deployments,
settings and routes match the immediate preflight baseline. No router application
write, paid OpenAI search/inference, PR or push occurred.

Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-calibration-receipt.json`.
This qualifies the observed fixture HTTP counter/rotation path, not OpenAI search
semantics. Next is a separately approved bounded direct Sol probe on a fresh run,
with a fresh live control before any broader qualification.

### Completed: approved direct Sol semantics probe — inconclusive

2026-10-23T06:19:48.971Z to 2026-10-23T06:19:59.984Z: one fresh hosted run, direct OpenAI
`/v1/alpha/search`, model `gpt-6.1-sol`. Exactly two standalone search
operations ran in separate sessions: cached then live. Both returned HTTP 200
with tool-level Internal Error, no hidden marker, no reported usage, and zero
registered origin GET/HEAD requests. The live positive control failed, so the
reviewed matrix stopped before warm/rotation/navigation cases and before any
Astra, routed or native follow-up. This does not qualify cache-only semantics.

The owned run was deleted; its authenticated lookup and all four public pages
return 404. Fixture/main settings, deployments and routes match preflight. No
inference, router credential registration, budget changes, new deployment, PR
or push occurred. Upstream search billing remains unqualified; no usage is not
evidence of no charge.

Metadata-only receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-direct-sol-receipt.json`.
Upstream request IDs: `req_b54c32a071fb40cbac57fa50b71e7ab0` (cached),
`req_ff15d09ec74943c29324de26d26d982b` (live).

A read-only GraphQL security-event query scoped to this run/path/time was denied
by the current management token (HTTP 200 GraphQL permission error).
It returned no usable event evidence. No credential/auth fallback or permission
change was attempted. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-direct-sol-edge-events.json`.
Zero Worker counters cannot distinguish upstream no-fetch from an edge rejection
before the Worker. Next useful step: read-only Safari inspection of Cloudflare
Security Events for the same narrow window before authorizing more probes or
changing any access/security configuration.

### Completed: read-only Safari Security Events inspection

2026-10-23 06:23 UTC: verified the OpenClaw account and `openclaw.ai` zone in
Safari. Security > Analytics > Events, 06:18–06:21 UTC, showed two zone-wide
Browser Integrity Check block events, both for another host (`docs.openclaw.ai`).
Adding `Host equals clawrouter-fakeco.openclaw.ai` showed no matching firewall
events and no summary data. This host-only filter covers all fixture paths.

No affirmative edge-block evidence found. Security Events may be sampled; the
dashboard also excludes Worker subrequests. Absence of events does not prove
absence of pre-Worker rejection or establish a provider fetch attempt. The
direct Sol result remains inconclusive. No Cloudflare mutation, credential read,
additional OpenAI call, PR or push. Safari left on the filtered result. Next
candidate requires separate approval: bounded direct live positive control
against a stable public page before another hosted semantics matrix.

### Completed: single direct Sol stable public-page positive control

2026-10-23 06:24:22–06:24:23 UTC: one approved direct Sol `/v1/alpha/search`
call, fresh session, external web access enabled, opened IANA's
`https://www.iana.org/help/example-domains`. Local HTTP preflight passed. Search
returned HTTP 200, 1,963 output characters, a search reference, and expected page
title/example.com/RFC 2606 content; no internal/reference/fetch error detected.
Request ID: `req_d17eddfba2ee4a7b93874efce2a19d98`.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-stable-public-sol-receipt.json`.
Only closed metadata persisted; credentials and raw/encrypted output stayed in
memory. No retries, inference, Cloudflare API calls/mutations, router application
writes, PR or push. No reported usage; billing remains unqualified.

The endpoint/request setup works for this stable public page. This does not
prove a new origin fetch or qualify fresh/cache-only/rotation/navigation
semantics. Next candidate: read-only inspection of fixture-host robots policy
and public fetch prerequisites, followed by a bounded comparison proposal.

### Completed: read-only fixture-host fetch prerequisite inspection

2026-10-23 06:25:24–06:25:26 UTC: nine unauthenticated public GETs, DNS A/AAAA
lookups and strict TLS verification. DNS resolved; TLS 1.3 hostname/chain check
passed. Root robots.txt returned the router's normal JSON 404 without crawl
directives/challenge for ordinary, OAI-SearchBot and ChatGPT-User strings. All
three user-agents received correct fixture health JSON with 200 and no redirect.
Prefix robots.txt returned fixture 404. Root `/` redirected to `/dashboard`;
the health control stayed public. No OpenAI/Cloudflare API calls, credential
reads, run creation, registered page requests, or resource mutation.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-fetch-prerequisites-receipt.json`.

Reviewed fixture/config still match `77bf4ac`. Synthetic page source is plain
HTML, sends `X-Robots-Tag: noindex`, and rejects any query string. These are
eligibility/URL-handling variables, not a confirmed cause. An unseen page's
header cannot itself explain zero first-fetch Worker hits. RFC 9309 permits
crawling after robots 4xx, but alpha/search implementation/cached policy remains
unqualified. Local user-agent tests do not verify actual OpenAI egress access.

Next proposed comparison: one direct Sol live-mode open of the existing public
fixture health URL in a fresh session, no inference/retry/Cloudflare mutation.
This isolates same-host retrieval from temporary HTML/run/header differences;
it cannot qualify fresh/cache-only semantics. No paid call or robots/noindex/
security change is part of this completed read-only inspection.

### Completed: one direct Sol fixture-health control — failed

2026-10-23 06:26:41–06:26:42 UTC: exactly one approved direct Sol live-mode
alpha/search open of existing public fixture health, fresh session, short output.
Local preflight returned correct JSON with 200 and no-store. Provider returned
HTTP 200, 273 output characters, tool-level Internal Error, and no expected
fixture identity/ok content. A reference alone is not retrieval success.
Request ID: `req_1969c4ec241d43d3b9af621f3f5b2f1a`.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-fixture-health-sol-receipt.json`.

Stopped after one call. No retries/inference, Cloudflare API calls/mutations,
fixture run creation, router application writes, PR or push. Only metadata
persisted; usage absent and billing unqualified. This stable same-host URL has
no UUID page path/noindex header, so failures extend beyond temporary HTML.
Root cause remains unknown; health has no counter, so zero origin requests
cannot be inferred. IANA control passed; same-host and fresh/cache-only
qualification remain open. Next candidate: read-only host-relevant Cloudflare
bot/security setting inspection before further paid calls or targeted changes.

### Completed: read-only Safari Cloudflare bot/security inspection

2026-10-23 06:27–06:29 UTC, correct OpenClaw account/openclaw.ai zone. AI Search,
Agent and Training policies Allow; Bot Preference Sync off. Individual OpenAI
ChatGPT-User/OAI-SearchBot/GPTBot Block Crawler switches off. Super Bot Fight
Mode allows definitely automated traffic and verified bots; JS detections off.
AI Labyrinth/Precursor off. Under-attack mode disabled. Cloudflare Managed/OWASP
rulesets off; no custom/rate-limiting/managed security rules. DDoS protections
always active. Schema validation showed zero endpoints/active schemas.

Browser Integrity Check is on. The only Configuration Rule matches
catalog.openclaw.ai, not FakeCo; no FakeCo exception visible in viewed rules.
No origin/rewrite/header/cache rules; two redirects match other hosts. Static
resource protection and account-level inherited restrictions were not qualified.
Expanded host-filtered Security Events, 06:18–06:28 UTC, found no matching
events, including the later health probe window. No block attribution possible.

No mutations, credential reads, API/paid OpenAI calls, PR or push. Drawers closed
without Save/Apply; Safari left on filtered event results. BIC remains a plausible
but unconfirmed candidate. Next preparation candidate: exact-host BIC-only
temporary exception for public health/robots GET/HEAD, original-state and cleanup
checks, then one Sol control. Prepare before requesting mutation approval. No
zone-wide disable or broader semantics matrix. No exception was created.

### Completed: approved stable HTML diagnostic deployment and calibration

2026-10-23 06:53:10 UTC: reviewed source `12b5383` deployed to the existing
fixture Worker as version `d29dd6b3-ceed-4d2c-93f5-c60fe791df26` at 100%.
Wrangler replaced the route's internal ID with
`a7df3050ed59443aa1b2f96362ecdd94`; use this current ID for cleanup, rather
than historical `3027364f1df44bcfa2b39ce11a1fea14`. Pattern/destination and all
other routes match baseline. Settings differ only in deployment annotations;
runtime, bindings, namespace, main Worker, domains and Access are unchanged.
Zone BIC remains on; the preflight Safari inventory contained only Catalog.

One five-minute generation passed two GETs/one HEAD: matching body marker,
empty HEAD body, exact counters 2/1 and correct timestamps. Deleted only owned
generation `690a3d4e-7849-4e84-a5b2-e751978766cc`; private generation and
collection controls plus public GET/HEAD returned 404. Infrastructure unchanged
after calibration. Prior matrix controls stayed 404; no active matrix run was
available for hosted independence comparison. Local workerd checks passed.

No OpenAI call, router/budget/security change, PR or push in this batch.
Receipts: ignored `search-diagnostic-deployment-receipt.json` and
`search-diagnostic-calibration-receipt.json` under
`.artifacts/fakeco-codex-search-20261022/`. Provider fetching/cached/live/billing
remain unqualified. Next separately approved batch: one fresh-generation direct
Sol live-mode open, zero-counter baseline, bounded late-hit observation and
generation-scoped cleanup. Full plan: [stable retrieval diagnostic](search-semantics-diagnostic.md).

### Completed: one approved Sol HTML diagnostic comparison — inconclusive

2026-10-23 06:55:53.557–06:55:54.386 UTC: one direct `gpt-6.1-sol`
alpha/search open of the stable diagnostic, fresh session, external web access
enabled, short output. Fresh five-minute generation
`6f5c413f-dcae-4a37-95e6-81b12ec5fc5a` began at zero counters. No operator
public request while active; marker excluded from the provider request.
Preflight matched the calibrated deployment and existing resource ownership;
FakeCo healthy, BIC on, refreshed Safari inventory showed only Catalog active.

HTTP 200, 281 output characters, tool-level Internal Error, marker absent;
request ID `req_eb5773ea178843b1afd9baea22e0b728`. Immediate and final
06:56:09.923 UTC snapshots were zero GET/HEAD, null timestamps, including a
15-second late observation. This narrows the result to no accepted diagnostic
handler activity; it does not prove no network attempt or identify the cause.
Retrieval, cached/live semantics and upstream billing remain unqualified.

Deleted only the owned generation; private generation/collection and public
GET/HEAD all 404 at 06:56:10.595 UTC. Infrastructure unchanged. No retry,
inference, broader matrix, router/budget/security/deployment change, PR or push.
Only metadata persisted; no usage reported. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-diagnostic-sol-receipt.json`.
Stopped after one provider call. Further paid probes or Cloudflare mutations
need separate approval.

### Completed: read-only latest event inspection and local request-observation preparation

Safari exact FakeCo host, 2026-10-23 06:55–06:57 UTC: no matching firewall
events, no summary data. The zone-wide BIC block belonged to another host. No
affirmative edge-block evidence; no-request/no-block conclusions remain invalid.
Safari left on this exact-host result without settings changes.

Commit `c1a1ae2` prepares an optional temporary fixture wrapper, robots pass-through
route/service binding, private five-minute observation sessions, bounded metadata
counts and restoration/cleanup. Normal fixture and main router source stay intact.
Worker TypeScript and 24 focused tests passed; autoreview completed with no
actionable P0–P2 findings. No deployment, hosted session, new live route/binding,
further search probe, PR or push. Current live ownership remains unchanged.

Next separately approved stage: temporary deployment and hosted calibration;
paired paid comparison remains separately approved. See
[scope and complete restoration](search-semantics-request-observation.md).


### Completed: approved observation deployment attempt and normal restoration

Batch 2026-10-23 07:10:54–07:11:24 UTC deployed temporary wrapper version
`e0e2c851-3f43-4062-94af-ec0c47715b77`. Four robots GET/HEAD/query/lookalike
response comparisons matched baseline. Observation creation failed non-2xx;
HTTP status was not retained and no ID was recorded. No diagnostic creation,
seven-request counter calibration or paid provider call ran. Private collection
and public diagnostic checks returned 404 before restoration; this does not
independently establish new observation-handler execution/storage cleanup.

Temporary robots route `0d2f713b00354801882592550300ace4` deleted and service
binding removed. Current normal fixture version
`5739c9d6-c696-4358-ba31-5b4054cb5ba8`, current prefix route
`edc2e346c12c4d1d880a20fd91c9e0d6`, existing namespace
`148cbb6483b4421dbf8b25301a325865`. These supersede prior current-ownership
claims. Normal bytes match the prior normal deployment; base settings/runtime,
main Worker and unrelated infrastructure preserved. Existing namespace cleanup
must include any fixed observer object; no new migration is needed.

Non-creating diagnostic control POST with `null` returned 400 `invalid_input`
at 07:13:14 UTC; current auth works. Root cause remains unresolved; operator
now journals response status before validation. No automatic replay/redeploy.
Safari rule refresh interrupted by user focus change; API inventory refreshed,
no browser settings changed. Further mutations and paid probes need approval;
first qualify hosted observation lifecycle/counting. Receipt:
`.artifacts/fakeco-codex-search-20261022/request-observation-calibration-receipt.json`.


Local diagnosis follow-up: read-only Cloudflare inventory matches the restored
normal deployment. Actual Wrangler bundle passed local in-place upgrade;
new Worker/old Durable Object pairing reproduced creation/collection 404.
Propagation is plausible, not proven. Prepared authenticated readiness and fixed
handler-marker correction; no deployment or new live cleanup obligation. Further
observation cleanup claims must require the object marker on the same 404
response. Existing version/route/namespace ownership remains current. See
[local diagnosis](search-semantics-request-observation.md#local-diagnosis-and-prepared-readiness-correction).

Readiness correction `593a2fa`: Worker TypeScript, 27 focused tests and corrected
Wrangler-bundle local upgrade/readiness checks passed. P0–P2 autoreview scoped-clean:
`/Users/joshavant/.codex/review-results/search-observation-readiness-20261023/status.json`.
No Cloudflare changes or search calls. Retry operator remains a blocked draft;
review and refresh it before seeking approval for hosted calibration.


Reviewed runner/preflight follow-up completed 2026-10-23T07:28:15.575Z. Frozen
operator `5fc8431` reviewed scoped-clean through P2; eight offline scenarios
passed. Current ignored runner is `run-request-observation-readiness-calibration.mjs`;
the old `.draft.mjs` is historical. Fresh live read-only preflight matched all
captured restored resource identities/hashes, three normal bindings, no temporary
robots route/binding, auth 400 without generation creation, and Access challenge.
No Cloudflare resource changes, hosted sessions or search calls. Existing current
version/route/namespace ownership above is unchanged. If later readiness or
cleanup cannot be qualified, retain temporary ownership and reconcile read-only;
never restore blindly over uncertain session state. Hosted mutation batch still
requires approval. Receipts: `request-observation-runner-review.json`,
`request-observation-readiness-preflight.json`, and
`request-observation-runner-preparation-receipt.json` in the ignored campaign
directory. See [runner procedure](search-semantics-request-observation.md#reviewed-runner-and-fresh-read-only-preflight).


Approved readiness batch closed 2026-10-23 07:35:04 UTC with normal fixture
restored and calibration incomplete. All seven public responses passed; later
private snapshots recorded six requests, missing diagnostic trailing-slash GET.
Initial readiness/both creations passed, but later observation read/DELETE and
collection checks returned unmarked 404. Cause unresolved; counters unqualified.
Diagnostic `ac1f54ea-67ab-4dcb-a0cc-1f21be8b035a` DELETE succeeded. Observation
`c2667132-2ad2-4516-9344-955f4304defe` DELETE was not retried; TTL elapsed and
marked collection/owned-ID absence verified before restoration. No pending session
cleanup. Namespace/fixed object allocation remains for the original later
class-deletion cleanup.

Removed only robots route `7ac3c4e743d145dc8f18a7ae43c4bae4`; temporary service
binding absent. Current normal version `e5e5231c-4477-4e4a-b95c-0f9c9e2b7101`, prefix route
`adf4daadf3f0489ba46a5084f2193688`, namespace `148cbb6483b4421dbf8b25301a325865`.
These supersede previous ownership IDs. Normal bytes match the prior normal
version; exactly three normal bindings remain. Main Worker/infrastructure/Access/
BIC unchanged. Restoration-only continuation reviewed as `47cb04c`, scoped-clean
through P2, within the existing approved cleanup scope. No session DELETE retry,
paid search, router write, secret change, new namespace, PR or push. Both executed
runners have exclusive receipts and must not be replayed. Current ownership:
`request-observation-readiness-restoration-receipt.json`; combined outcome:
`request-observation-readiness-batch-summary.json` in the campaign directory.
Further mutation batches need approval; paid comparison remains gated on a
successful observation calibration. See
[complete evidence and restoration](search-semantics-request-observation.md#approved-readiness-deployment-incomplete-calibration-and-qualified-restoration).


Approved v2 observation batch passed 2026-10-23 07:47:09 UTC: three matching
readiness samples, seven public responses and seven exact durable counters,
diagnostic counts 1/1, no overflow/saturation. Both owned session DELETEs returned
200 once; marked owned-ID/collection absence verified before restoration.
Removed robots route `ca3a2dbd80214dfba97494f559cecba8`; temporary service absent.
Current normal version `f5e2791a-196f-4a8a-a990-590c9bd12891`, prefix route
`e636ada557fd4550a4abb64edd03e3df`, namespace `148cbb6483b4421dbf8b25301a325865`.
Normal code bytes and exactly three normal bindings restored; main/infrastructure/
Access/BIC preserved. No pending session cleanup; fixed namespace/objects retained
for separately approved class-deletion teardown. Current ownership:
`request-observation-stability-calibration-receipt.json`; combined outcome:
`request-observation-stability-batch-summary.json`. Previous IDs above historical.
Runner receipt is exclusive; do not replay. No paid search, inference, router
write, secret change, security relaxation, new namespace, PR or push. Paired
retrieval comparison now needs separate approval; billing stays unqualified.
See [v2 evidence](search-semantics-request-observation.md#approved-v2-hosted-calibration-and-normal-restoration).


Paired retrieval preparation reviewed/preflighted 2026-10-23T07:54:45.783Z;
current ownership unchanged. Runner `run-paired-retrieval.mjs`, frozen `0f45b1f`,
thirteen VM scenarios/five probe tests pass; review scoped-clean through P2.
At most two future direct Sol search calls, IANA first, FakeCo only on IANA
success, immediate/15-second late snapshots, no operator public active-session
requests, owned cleanup and qualified restoration. Cloudflare/paid approvals
remain null; exclusive execution receipt absent. No writes or paid calls in
preparation. See [concrete batch](search-semantics-paired-retrieval.md).


Approved paired retrieval batch completed 2026-10-23 07:57:15 UTC, result
inconclusive. Two direct Sol search calls: IANA content passed; conditional FakeCo
returned HTTP-200 tool-level Internal Error, no fresh marker. Observation/diagnostic
initial/immediate/15-second late snapshots recorded zero requests and GET/HEAD 0/0.
Both owned session DELETEs returned 200 once; marked owned-ID/collection absence
verified before restoration. No pending session cleanup. Removed robots route
`8dc4ffa9fd2a48049371bd7704844462`; temporary service absent. Current normal version
`9ea3e336-0cf8-41e0-b44b-09e448fd70cb`, prefix route `dd2ae4273551492db92c3b5ffc367529`,
namespace `148cbb6483b4421dbf8b25301a325865`. Current ownership:
`paired-retrieval-receipt.json`; summary `paired-retrieval-batch-summary.json`.
Earlier normal/temporary version and route IDs are historical. Code bytes, three
normal bindings, main/unrelated resources, Access and BIC preserved. Read-only
follow-up observed normal unmarked controls after a transient v2 marker during
restoration propagation; proof `paired-retrieval-postrestore-readonly-receipt.json`.
No extra paid call, inference, router write, secret change, security relaxation,
new namespace, broader cleanup, PR or push. Larger semantics matrix remains gated;
billing unqualified. Runner has an exclusive receipt; do not replay it. Any future
mutations/paid calls need a newly pinned operator, fresh inventory and approval.
[Evidence](search-semantics-paired-retrieval.md#approved-execution-and-inconclusive-result).


Independent Tailscale Funnel batch completed 2026-10-23 08:18:48 UTC. Public
calibration via anonymous Jina Reader passed: exact calibration marker plus one
origin GET. Marker rotated and counters reset. One separately approved direct Sol
search call returned HTTP-200 tool-level Internal Error, no measurement marker,
zero origin requests immediately and 15 seconds late. Result inconclusive; no
retry or matrix expansion. Runner closed the fixture and its own foreground
child, exited 0; independent checks at 08:19:31 UTC confirmed Funnel/Serve `{}`
and port 18765 free. No active Funnel resource or pending Funnel cleanup;
certificate state not revoked. Final receipt `funnel-retrieval-receipt.json`;
calibration `funnel-exposure-receipt.json`, both in the campaign directory.
Completed approvals do not authorize replay. No Cloudflare writes; existing
FakeCo ownership still `paired-retrieval-receipt.json` (normal version
`9ea3e336-0cf8-41e0-b44b-09e448fd70cb`, route `dd2ae4273551492db92c3b5ffc367529`).
No inference, router call, enrollment, fallback-key access, broader cleanup, PR
or push. Upstream semantics and billing remain unqualified.
[Evidence](search-semantics-funnel.md#authorized-retrieval-and-verified-cleanup).


Approved Responses/alpha Funnel comparison completed 2026-10-23 08:43:52 UTC:
`neither-observed`. Fresh external calibration passed first; separate fresh
markers/counters for the two paid requests. Responses reported a completed
exact-target open_page action, alpha HTTP-200 tool-level Internal Error. Neither
returned its fresh marker; every immediate/15-second-late origin counter zero.
Both windows complete. No live positive control; stop hosting retries and retain
cached/live uncertainty. Alpha billing unqualified. Runner exited 0; independent
checks at 08:45:20.683 UTC confirmed Funnel/Serve `{}` and port 18765 free. No
active Funnel resource or pending cleanup; certificate state not revoked.
Execution receipt `endpoint-comparison-execution-receipt.json`, paid authorization
`endpoint-comparison-paid-authorization.json`, exposure/calibration
`endpoint-comparison-exposure-receipt.json`, all in the campaign directory.
Approvals consumed; do not replay. No Cloudflare writes, enrollment, fallback-key
access, router calls, broader teardown, PR or push. Existing FakeCo ownership
unchanged: `paired-retrieval-receipt.json`, normal version
`9ea3e336-0cf8-41e0-b44b-09e448fd70cb`, route `dd2ae4273551492db92c3b5ffc367529`.
[Evidence](search-semantics-endpoint-comparison.md#authorized-pair-and-verified-cleanup).


Read-only source audit completed against official Codex `rust-v0.163.0`, commit
`83086188ae0614bd882818ff1aa23f3194962012`. Live boolean matches native code;
no Alpha-specific API-key bootstrap or encrypted-output replay found in traced
path. Native completion/action events are not origin-retrieval proof; reviewed
upstream tests mock Alpha. No client-side fix identified. Optional structured
results are omitted by our diagnostic summaries; metadata-only instrumentation
is a possible preparation, not yet implemented. No credential reads, paid calls,
Cloudflare changes, public exposure or runtime changes. Existing deployment and
cleanup ownership unchanged. Report [source audit](codex-alpha-source-audit.md);
receipt `codex-alpha-source-audit-01630.json` in the campaign directory.


Local Alpha structured-results diagnostics prepared in `5fb72e3`: fixed state,
array count, text_result/unknown/malformed counters only; no arbitrary type names
or nested content copied. Diagnostic-only; success/fresh-retrieval criteria and
hosted Responses behavior preserved. All 62 focused synthetic tests pass.
Autoreview `scoped-clean` through P2; outputs under
`~/.codex/review-results/alpha-results-diagnostics-20261023/`. Receipt
`alpha-results-diagnostics-preparation.json` in campaign directory. No live probe,
1Password read, deployment, Cloudflare write or public exposure. Existing cleanup
ownership unchanged; new source freeze/approval needed before any future probe.
[Contract and verification](codex-alpha-source-audit.md#subsequent-local-results-diagnostics).
