# Codex search canary permissions and cleanup — archived

**Campaign closed; no cleanup remains.** The
[final cleanup record](codex-search-cleanup-20261023.md) supersedes every readiness,
permission and ownership snapshot below. Present-tense statements in dated
entries describe that earlier stage. Resource IDs and receipts remain evidence;
completed approvals do not authorize replay.

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

Prepared on 2026-10-22. Cloudflare qualification began read-only. The user later
explicitly authorized separate queue/KV provisioning and first-deployment batches,
requiring a fresh question before any subsequent Cloudflare mutation. Both batches
completed and their run-owned resources are recorded below. The user created the
dedicated service token. Both deployed native search modes, cap denial and search
credential revocation passed. Paused for the user's manual browser login before
separately approved cleanup.
The separately approved $5 provider budget and dedicated search policy/credential
were registered and verified at 2026-10-23 03:41:56 UTC, with zero spend.
Later approved headroom increases preserved spend and raised provider monthly
and policy daily/weekly/monthly limits to $50. At 03:51:16 UTC, campaign spend is
$3.614986, provider/policy/reporting agree, and usage/DLQ backlogs are zero.
The user allowed up to $200 if needed; no limit above $50 was configured.
At 03:54:29 UTC, the monthly search policy cap was lowered to settled spend,
3,614,986 microUSD, and a correlated 402 denial added zero charge. The search key
is revoked and returns 403; bootstrap remains active. Daily/weekly and provider
monthly limits remain $50. Both queues are empty; total spend is unchanged.
This is an operator runbook, not a new executable teardown command. Further
provisioning and destructive execution require separate explicit authorization.

## Permission qualification

The exact account-owned token stored in the supplied 1Password item was verified
active. Its returned token ID matched the dashboard's `clawrouter` token summary
and JSON payload. No token value was displayed or persisted. The token's own
policy-details API returned 403; the authenticated Safari summary supplied the
permission and resource-scope evidence instead.

| Operation | Observed permission and scope | Qualification |
| --- | --- | --- |
| R2 bucket creation, configuration, deletion; object access | Workers R2 Storage Write and Read; entire OpenClaw account | Bucket creation/lifecycle exercised; destructive operations untested |
| Access application and policy creation/deletion | Access: Apps and Policies Write and Read; entire OpenClaw account | App/policy creation exercised; deletion untested |
| Worker / Durable Objects, KV, queues | Workers Scripts Write, Workers KV Storage Write, Queues Write; entire OpenClaw account | Deployment, namespace/queue creation and temporary KV probe exercised; teardown untested |
| Worker routes | Workers Routes Write; openclaw.ai zone | FakeCo custom-domain creation exercised; deletion untested |
| Access service-token creation/deletion | Access: Service Tokens Write absent from the displayed policy | No explicit required grant; writes remain unqualified |
| Independent DNS record creation/deletion | DNS Write absent from the displayed policy | No explicit required grant; avoid independent DNS changes or qualify another credential |

The R2 permission covers both bucket management and object operations according
to [R2 authentication documentation](https://developers.cloudflare.com/r2/api/tokens/).
Access app/policy management and service-token management are distinct:
[application deletion](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/delete/)
accepts Apps and Policies Write, whereas
[service-token creation](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/)
and [deletion](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/delete/)
require Service Tokens Write. Do not treat a successful read as a write proof.

Additional read-only checks with the same stored token succeeded for Access
service-token inventory (GET, HTTP 200) and R2 S3 ListBuckets (GET, HTTP 200).
The S3 check derived credentials in memory from the verified token identity and
token value using Cloudflare's documented mapping; no new token or secret cache
was created. This qualifies R2 client authentication without exercising object
deletion. The service-token read does not resolve its missing explicit write grant.

Wrangler OAuth separately reported relevant Worker/KV/queue write scopes and
Super Administrator membership in OpenClaw. That does not fill missing scopes in
the account-owned token. No new OAuth grant or API-token permission was requested.

Before using the existing FakeCo workflow, qualify the dedicated Access
service-token lifecycle, including deletion. The agreed alternative to an API
credential is the user-operated browser handoff below. FakeCo requires a
service-token UUID; the user's new token is verified below.
An existing shared token is not canary-owned and must never be deleted during
this cleanup.
GitHub Environment administration and application-level ClawRouter admin access
are separate requirements; Cloudflare permissions do not establish either.

## User-operated browser handoff

The initial browser handoff kept the assistant read-only and all Cloudflare
mutations user-operated. The user subsequently allowed specifically approved
assistant write batches, requiring a fresh question before subsequent Cloudflare
mutations. This is not blanket permission for deployment or deletion. The
assistant may navigate, inspect and populate unsaved form fields, prepare local
instructions, and verify non-secret metadata through GET requests. Do not run the
mutation commands in this runbook on the user's behalf without new explicit
authorization, including the guarded teardown.

Separate explicit authorization allowed the assistant to create GitHub
Environment `fakeco` (ID `25093378320`, created 2026-10-23 03:27:15 UTC) and
publish tag `canary/codex-search-2026-10-22`, pointing to reviewed commit
`beed4c7d873e82bfdeb024afe609ccabf9c9c493`. Both were verified afterward; the
Environment initially contained zero secrets/variables and the deployment
workflow still had zero runs. This did not expand Cloudflare write authorization.
The assistant subsequently populated the run-created Environment from the verified
inputs: nine secrets and three variables, with exact names recorded in
`.artifacts/fakeco-codex-search-20261022/github-inputs-receipt.json` and the
[operator handoff](codex-search-canary-handoff.md). Secret values were passed via
stdin and not cached. Inventory verification at 2026-10-23 03:31:58 UTC found
the expected entries; no deployment was dispatched.

Read-only Safari inspection confirmed the OpenClaw account's Service Tokens page
and its creation form. The form contains a token-name field, a duration selector
defaulting to one year, and a **Generate token** submission button. At the user's
subsequent request, the assistant populated
`clawrouter-fakeco-codex-search-20261022` and a custom duration of 24 hours,
verifying both unsaved field values. The assistant did not press the submission
button. The user then reported creating the token and saving its credentials in
the dedicated 1Password item. Subsequent read-only Safari inspection verified
creation, enabled status, and the requested duration. Deletion remains untested.

### Historical token handoff (token subsequently deleted)

- Name/item title: `clawrouter-fakeco-codex-search-20261022`.
- User-created for this canary run; verified lifetime: 24 hours.
- Populated fields verified through 1Password metadata: `CLIENT_ID`, `CLIENT_SECRET`.
- References: `op://Agent Secrets/clawrouter-fakeco-codex-search-20261022/CLIENT_ID`
  and `op://Agent Secrets/clawrouter-fakeco-codex-search-20261022/CLIENT_SECRET`.
- Resource UUID: `f6264117-b130-4b39-a4f9-4b01a17b4ffa`.
- Status: Enabled. Created October 22, 2026 at 08:17 PM; expires October 23,
  2026 at 08:17 PM, as displayed in Safari. The display's timezone was not
  independently established; do not infer an exact UTC timestamp from it.
- The stored Client ID matches the browser details; the comparison printed only
  a boolean. Secret presence was checked through field metadata, not an
  authentication attempt.
- Associated applications: 0. No policies reference the token; not seen/used yet.

The account-owned management token's service-token list returned HTTP 200 with
an empty inventory, both with explicit pagination and default parameters. Safari
previously showed seven existing tokens and now shows eight, including this
canary. A direct GET of the verified resource UUID returned HTTP 403. This API
view therefore does not establish absence or creation failure and must not serve
as the cleanup absence check. Use browser inventory/details to verify this
resource and its eventual absence; do not recreate the token to resolve the
API discrepancy.

For a future creation session:

1. Verify OpenClaw, the canary resource baseline, and a unique dedicated token
   name together. Choose a short duration covering the test window; do not accept
   the one-year default merely because it is preselected. Record the actual expiry.
2. The assistant may populate the agreed name/duration without submitting. The
   user reviews those fields and selects **Generate token**. The assistant does
   not submit the form or enter credential values.
3. The user saves the generated client ID and secret directly into a dedicated
   1Password item in Agent Secrets, then closes the secret display. Do not paste
   the secret into the conversation. Pause UI observations while the generated
   secret is visible. Resume only after the user reports that it is hidden.
4. The assistant verifies the resulting inventory metadata read-only and records
   the resource UUID, exact name, expiry, and secret-manager reference. The resource
   UUID is distinct from the client ID. Future wiring of this UUID into the canary
   Access policy and GitHub configuration is also user-operated.
5. During eventual cleanup, the assistant verifies the recorded UUID/name and
   canary-only ownership, guides the user to that token's deletion control, and
   leaves the deletion and confirmation to the user. Afterward, verify absence
   through a GET/list operation. Keep API service-token writes unqualified unless
   separately established; browser cleanup does not expand the API token's scopes.

## Resource ownership before provisioning

Use the locked [FakeCo profile](../config/deployments/fakeco.json) for the existing
[canary runbook](codex-search-canary.md). A differently named canary needs its own
reviewed deployment profile and cleanup target; do not override the FakeCo lock.

| Resource | Expected FakeCo target | Cleanup identity to record |
| --- | --- | --- |
| Worker, versions/assets, bound secrets | clawrouter-edge-fakeco | Account, exact service name, creation result, version IDs |
| Durable Object namespaces | Five namespaces bound to the new Worker | Namespace IDs, class names, Worker ownership |
| Custom domain / any separate route or DNS record | clawrouter-fakeco.openclaw.ai | Domain/route/record IDs and original state |
| Primary and any distinct preview KV namespace | clawrouter-policy-fakeco | Exact title and namespace IDs |
| Usage queue and DLQ | clawrouter-usage-fakeco; clawrouter-usage-fakeco-dead-letter | Queue IDs and producer/consumer bindings |
| R2 archive and bucket configuration | clawrouter-content-fakeco | Bucket name, jurisdiction, creation result |
| Access app and its application policies | ClawRouter FakeCo Console | App ID, exact destination set, policy IDs |
| Any reusable Access policies created for the canary | Profile's user/service policy names | Policy IDs, creation result, attached app IDs |
| Dedicated Access service token | clawrouter-fakeco-codex-search-20261022 | f6264117-b130-4b39-a4f9-4b01a17b4ffa; verified 24h, expiry recorded above; no secret values |
| Router policy and credential | codex_search_canary_20261022 | Policy/credential IDs, secret-manager reference only |
| GitHub configuration, if created | fakeco Environment; CLAWROUTER_FAKECO_* names | Repository, environment ID/name, exact new secret/variable names |
| Local/generated files and credential-manager items | Only artifacts created for this run | Exact paths/item references and ownership |

Approved queue/KV provisioning completed once, followed by read-only detail checks
at 2026-10-23 03:30:11 UTC. Run-owned cleanup identities:

- KV `clawrouter-policy-fakeco`: `ca69a07938214acf9fae2bfea2ee2e8d`.
- Queue `clawrouter-usage-fakeco`: `bd6016244cd749f78e916e50a2ac7dd9`.
- DLQ `clawrouter-usage-fakeco-dead-letter`: `2843acdd30004177a6c3a092f13d9ee3`.
- Both queues had zero producers and consumers at verification.
- Metadata receipt: `.artifacts/fakeco-codex-search-20261022/provision-receipt.json`;
  original baseline: `.artifacts/fakeco-codex-search-20261022/preprovision-baseline.json`.

Never rerun the provisioning command to discover these IDs: KV creation is not
idempotent. Re-read these exact identities before any future deployment or cleanup.

Approved deployment run
[39895613643](https://github.com/openclaw/clawrouter/actions/runs/39895613643)
completed successfully, including ordinary paid OpenAI smoke. Further run-owned
cleanup identities, verified through metadata-only API reads:

| Resource | Identity |
| --- | --- |
| Worker | `clawrouter-edge-fakeco`; active version `3d669069-fb9e-45e0-a71b-bded66c5b7b2` after authorized JSON-title deployment; layout version `6f20b7a4-4323-47c5-8db3-8c3ba29f7f7e`; dollar-input version `7d17a962-c1d7-4257-aebb-b4f6c3b7955d`; label version `272eab13-76a3-4281-8ffb-07e73b2988bf`; admin-grant version `5d05ccb8-6be2-437f-ba8e-4a3208e24627`; qualification version `82bbd5bc-e569-435c-8738-d3c12789207b` |
| Worker secret bindings | `OPENAI_API_KEY`, `CLAWROUTER_ADMIN_TOKEN_SHA256`; values not read back |
| Custom domain | `clawrouter-fakeco.openclaw.ai`; ID `38664e272d7e218f4f84dfe42a9b268c60fd1fa7` |
| R2 bucket | `clawrouter-content-fakeco`; jurisdiction `default`; `v1/` expiry 30 days |
| Access app | `beac7325-b743-4eef-982f-117bb7d27cce`; exact five profile destinations verified |
| Human Access policy | `4a44c524-2d85-48ee-bdeb-3f1f5bd43913` |
| Service-token Access policy | `63650e41-619d-40cc-a3fe-d2d28e7286d6`; references only the dedicated token |
| ContentArchiveCleanupObject namespace | `e55d5c688dac4faa98ec8c360df61755` |
| GrantCredentialObject namespace | `0a4b9486e8454c53a395924376b7870b` |
| PolicyBindingIndexObject namespace | `b4ecc28ff977441fa1b0290602edef76` |
| BudgetLedgerObject namespace | `b0da8f0bbf274503bd931cb112ffd3f5` |
| UsageLedgerObject namespace | `e5672c159dac4cb28961af4d376b923d` |
| Bootstrap router policy and credential | `fakeco_bootstrap_20261022`; enabled, OpenAI only, retention off |
| Search router policy and credential | `codex_search_canary_20261022`; credential revoked, key inspection 403; policy enabled, monthly cap $3.614986 exhausted, daily/weekly $50; original expiry 2026-10-24 03:41:17.469 UTC |
| Provider budget configuration | FakeCo OpenAI connection; $50 monthly; baseline starts after bootstrap smoke; $3.614986 settled campaign spend |

All five DO namespaces report ownership by `clawrouter-edge-fakeco`. The usage
queue's sole producer/consumer is that Worker (consumer ID
`0d6d0b30a9a94cbe9efbbf7b0ccaa7aa`), with the expected FakeCo DLQ. The DLQ has
no producers/consumers. Revoke bootstrap and verify the search credential remains
revoked before teardown; do not leave bootstrap out of the deletion set.
Full metadata-only receipt:
`.artifacts/fakeco-codex-search-20261022/deployment-resource-receipt.json`.
Search registration metadata:
`.artifacts/fakeco-codex-search-20261022/search-registration-receipt.json`.
Final native qualification metadata:
`.artifacts/fakeco-codex-search-20261022/native-qualification-summary.json`.
Cap denial and revocation metadata:
`.artifacts/fakeco-codex-search-20261022/cap-denial-revocation-receipt.json`.
Browser-admin grant metadata:
`.artifacts/fakeco-codex-search-20261022/browser-admin-receipt.json`.
Label deployment metadata:
`.artifacts/fakeco-codex-search-20261022/label-deployment-receipt.json`.
Dollar-input deployment metadata:
`.artifacts/fakeco-codex-search-20261022/dollar-input-deployment-receipt.json`.
Capability-price layout deployment metadata:
`.artifacts/fakeco-codex-search-20261022/capability-layout-deployment-receipt.json`.
Capability-price JSON-title deployment metadata:
`.artifacts/fakeco-codex-search-20261022/capability-json-title-deployment-receipt.json`.
Live dollar-price roundtrip metadata:
`.artifacts/fakeco-codex-search-20261022/live-dollar-roundtrip-receipt.json`.
Run-created policy `ui_dollars_smoke_20261022` remains in FakeCo storage:
disabled, $0 monthly budget, retention off, no credentials or bindings. Its fixed
and `search.web` prices are 1,000 microUSD each, displayed as $0.001 after reload.
Include this record in the eventual approved FakeCo storage teardown.
The user subsequently authorized admin access for `joshavant@gmail.com`.
Run-created GitHub configuration now also includes the `fakeco` Environment
variable `CLAWROUTER_FAKECO_ACCESS_ADMIN_EMAILS`; include it in cleanup inventory.
The Worker has the corresponding plaintext `CLAWROUTER_ACCESS_ADMIN_EMAILS`
binding. All 17 previous bindings were preserved. Safari confirmed the admin role.

The read-only inventory on 2026-10-22 returned 404 for the expected Worker and
R2 bucket. Complete paginated KV, queue, Access app, and reusable-policy lists
returned no exact matches for the profile's names. This is a point-in-time
snapshot, not the ownership baseline for a later provisioning operation. No
additional service token is planned; the user-created token's verified identity
is recorded above. The [operator handoff](codex-search-canary-handoff.md) records
the refreshed baseline and remaining readiness inputs.

Immediately before any future provisioning, save a metadata-only baseline with
complete pagination for all these resource types. For every entry record account,
zone/jurisdiction where applicable, exact name/ID, whether it already existed,
whether this run created it, and its dependency IDs. Record each successful create
response immediately, including resources created before a later provisioning
failure. Store no secrets, raw prompts, object bodies, queue bodies, or completions.

Refuse a collision instead of adopting a pre-existing resource. Reused resources
remain outside the deletion set. Do not overwrite pre-existing GitHub secrets:
their values cannot be recovered through a read-only baseline. In a run-created
Environment, delete the Environment only after verifying it contains no unrelated
configuration or activity; otherwise remove only the run-created exact entries.

## Historical complete teardown plan

The user requested a manual browser-login checkpoint after testing and before
cleanup. Pause at `https://clawrouter-fakeco.openclaw.ai` and wait for the user to
finish exploring. No cleanup action may begin merely because tests complete;
obtain separate teardown authorization after this checkpoint.

This sequence deletes canary-owned infrastructure and data. It is not code rollback
and must not be used to reset spend or revive a revoked credential. For code-only
rollback, use the existing canary restoration procedure.

1. Stop the canary client and all deployment/bootstrap automation. Revoke its router
   credential through the authority while the Worker is available; verify denial.
   Record settled usage and queue/DLQ metadata without consuming message bodies.
   Investigate outstanding settlement before deleting storage or queued events.
   If application auth is unavailable, remove the canary Worker first to stop
   traffic; record that authority revocation could not be verified.
2. Re-read every recorded resource identity and dependency. Require the intended
   account, exact names/IDs, the complete Access destination set, and no production
   bindings, shared service-token use, external queue consumers, or other resource
   owners. Refuse ambiguity or an unexpected dependency. Obtain explicit approval
   of the exact deletion set and irreversible data loss before execution.
3. Run the existing [guarded FakeCo teardown](fakeco.md#guarded-teardown) with its
   target lock and both confirmations. It deletes the Worker with associated
   Durable Object storage, queues, then the Access app. It keeps Access protection
   if Worker/queue deletion fails. Do not substitute raw Wrangler deletion commands
   for this phase. Its current KV identity check requires the primary KV namespace
   to remain until this phase has completed.
4. Verify the Worker, its Durable Object namespaces, custom-domain binding, usage
   queue, and DLQ are absent. Inspect any independently created routes/DNS records
   from the ownership record; remove only those recorded IDs with a qualified
   credential. Keep the Access gate if a serving Worker or route remains.
5. Inspect application and reusable Access policies. Remove only remaining
   run-created policy IDs, after proving no unrelated application uses them. Verify
   app absence; an application deletion must not be assumed to remove a reusable
   policy. The user deletes any run-created service token by its recorded resource
   UUID through the browser handoff, or uses an independently qualified credential
   with Service Tokens Write. Preserve pre-existing tokens and the shared
   identity provider/Access organization.
6. Delete the primary and any distinct run-created preview KV namespaces by their
   recorded IDs. This removes router policies/credentials and other canary KV
   records; do not delete individual production records or rely on a name prefix.
7. Empty the canary R2 bucket after every writer is gone. Use paginated object and
   multipart-upload listings; delete all objects, abort all unfinished uploads,
   and check every per-item result. Do not download content or log object keys.
   Use an approved R2 client with credentials injected in memory. S3 authentication
   was qualified read-only as recorded above; recheck it before provisioning,
   without creating another token merely for cleanup. Remove any run-created event notifications. Unexpected
   bucket locks or shared integrations require review, not automatic removal.
   Verify empty listings, then delete the exact bucket with its jurisdiction.
   [Bucket deletion prerequisites](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/)
   include no objects, multipart uploads, or event-notification rules. Verify the
   bucket is absent; a lifecycle expiration rule is not completed cleanup.
8. Remove only run-created GitHub secrets/variables and, if exclusively run-owned,
   the FakeCo Environment. Check repository-level prefixed entries too. Stop if
   ownership or required GitHub permissions are unqualified. Remove dedicated
   credential-manager items and local client profiles/temp files after remote
   credentials are revoked. Preserve the shared Cloudflare management token,
   Wrangler login, upstream provider credentials, zone, and shared configuration.
9. Re-list all owned resource types with complete pagination and compare with the
   baseline. Confirm every run-created ID is absent and every reused resource is
   unchanged. Verify the production deployment/version and bindings are unchanged.
   Record metadata-only results for each resource, including absence already
   established on a prior attempt. Report any retained resource or unverified read
   explicitly; 401/403/network failures are not proof of deletion. Do not claim
   complete cleanup while an owned resource remains.

Cloudflare audit history, platform billing/usage records, and existing Git history
are not canary infrastructure and are outside this deletion set. Complete cleanup
does not mean erasing those records or reversing charges.

## Historical preparation versus execution

The complete operator sequence is prepared here. The existing `cf:teardown`
command still intentionally retains KV, R2, service tokens, and GitHub settings;
its default remains non-mutating. The helper now checks empty queues and
disconnects verified owned consumers before Worker deletion, as described in
[guarded teardown](fakeco.md#guarded-teardown). Steps 4–9 require supervised
operator work, or separately implemented and reviewed tooling. A default
`CLAWROUTER_DEPLOY_ENV=fakeco pnpm cf:teardown` prints only the existing partial
plan and performs no Cloudflare requests; it is not a complete-cleanup preview.

No provisioning should start until the baseline and ownership record are ready,
the user-operated service-token lifecycle or an alternative credential is ready,
any chosen R2 client/GitHub credentials are qualified, and the operator has
reviewed this sequence. Read-only qualification
establishes permission coverage; account quotas, runtime API behavior, and actual
destructive execution remain untested.

## Historical owned resources: hosted search semantics fixture

Separately approved and deployed 2026-10-23 04:45:59 UTC. This snapshot predates cleanup.
The initial batch exercised exact path-route creation with the existing
management token. Later temporary robots-route deletion succeeded; destructive
class/namespace migration remains untested.

| Resource | Exact ownership |
| --- | --- |
| Worker | `clawrouter-search-semantics-fakeco` |
| Active version | `9ea3e336-0cf8-41e0-b44b-09e448fd70cb` at 100% |
| Route | `dd2ae4273551492db92c3b5ffc367529` → `https://clawrouter-fakeco.openclaw.ai/search-semantics/*` |
| SQLite DO namespace | `148cbb6483b4421dbf8b25301a325865`, `SearchSemanticsObject`, owned by the fixture Worker |
| Secret binding | `SEARCH_SEMANTICS_CONTROL_SHA256`, purpose-separated derived-token digest only |

Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-deployment-receipt.json`.
That original receipt and the diagnostic deployment receipt are historical.
The current ownership receipt is
`.artifacts/fakeco-codex-search-20261022/paired-retrieval-receipt.json`.
Wrangler recreated the prefix route during approved paired-probe restoration;
prior IDs `edc2e346c12c4d1d880a20fd91c9e0d6`,
`1c2b602bb58a4cb6b1db52e45820bdae`, `adf4daadf3f0489ba46a5084f2193688`
`36010a73441f4e118b3c26a679ac69f6`, `e636ada557fd4550a4abb64edd03e3df`
and `1f3b5b02fe294a549f2b08fcff93576a` are historical. Route semantics and
all unrelated routes match baseline. Use the current ID above for later cleanup.
The namespace was empty at original deployment; subsequent runs allocated its
registry object. Existing router Worker/settings/deployments, custom domain,
Access app, all prior routes, and all 36 existing namespaces are preserved.

For separately approved cleanup, follow [the exact fixture procedure](search-semantics-validation.md#cleanup-prepared-before-provisioning):
remove only the owned route; deploy `wrangler.search-semantics.cleanup.toml`
with class/binding removed and `v2-delete-fixture` delete migration; verify this
namespace is absent; then delete only the empty fixture Worker. Do not delete
the existing FakeCo custom domain or router. Never assume a standalone namespace
DELETE API or that Worker deletion automatically erases its Durable Objects.

Cache Rules and Page Rules inspection returned HTTP 403; their behavior remains
unqualified before semantic claims. No OAuth/account/token fallback was used.

Read-only cache inspection at 2026-10-23T06:09:50.397Z: Safari shows no Cache Rules,
Cache Response Rules or Page Rules on openclaw.ai. No new Cloudflare resources
or cleanup obligations were created. Worker cache opt-in absent from the reviewed
fixture config and allowed metadata responses. Empirical calibration remains
pending separate approval. Receipt: `.artifacts/fakeco-codex-search-20261022/search-semantics-cache-inspection.json`.

Hosted calibration completed 2026-10-23T06:18:12.735Z. Its single owned run was deleted
and both authenticated/public absence checks passed. The registry Durable Object
is now allocated; keep its existing namespace `148cbb6483b4421dbf8b25301a325865`
in the later approved delete-migration cleanup. The fixture Worker and route remain
active. No additional resource names or credentials were created. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-calibration-receipt.json`.

Approved direct Sol probe completed 2026-10-23T06:19:59.984Z: its one fresh run was
deleted, with authenticated lookup and all four public pages returning 404.
No new infrastructure or router credentials were created. Exactly two direct
standalone search calls ran, no inference; no upstream usage/cost was reported,
so upstream billing remains unqualified. Existing fixture Worker/route/namespace
remain owned as recorded. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-semantics-direct-sol-receipt.json`.

Stable HTML diagnostic deployment/calibration completed 2026-10-23 06:53:10 UTC.
Its sole generation `690a3d4e-7849-4e84-a5b2-e751978766cc` was deleted;
private generation/collection and public GET/HEAD absence checks returned 404.
No new namespace, class, binding or credential; the existing namespace remains
allocated for later delete-migration cleanup. No additional OpenAI call.
Receipt: `.artifacts/fakeco-codex-search-20261022/search-diagnostic-calibration-receipt.json`.

Approved single Sol HTML diagnostic probe completed 2026-10-23 06:56:12 UTC.
Owned generation `6f5c413f-dcae-4a37-95e6-81b12ec5fc5a` was deleted;
private generation/collection and public GET/HEAD returned 404. Exactly one
standalone search call returned tool-level Internal Error; counters stayed zero
through the 15-second late window. No infrastructure, credential or budget
changes; upstream billing unqualified. Current fixture version/route/namespace
ownership above remains valid. Receipt:
`.artifacts/fakeco-codex-search-20261022/search-diagnostic-sol-receipt.json`.

Request-observation follow-up: Safari exact-host Security Events, 2026-10-23
06:55–06:57 UTC, showed no matching events. Temporary wrapper/service binding/
robots route and expiring session cleanup are prepared locally in
[the request-observation runbook](search-semantics-request-observation.md),
commit `c1a1ae2`. No deployment or hosted session; no new live cleanup obligation.
Before any future code restoration, clear and verify observation storage while
the wrapper is still deployed. Later ownership records must include the new
robots route ID and any recreated fixture-prefix route ID. Existing live resource
ownership above is unchanged. Worker TypeScript, 24 focused tests and P0–P2
autoreview passed; hosted equivalence remains unqualified.


Approved observation attempt/restoration completed 2026-10-23 07:11:24 UTC.
Temporary version `e0e2c851-3f43-4062-94af-ec0c47715b77` and robots response
comparisons succeeded. Session creation failed non-2xx, status not retained;
no owned ID recorded or diagnostic generation attempted. Private collection and
public diagnostic checks returned 404 before restoration; new observation-handler
execution/storage clearing was not independently established. Existing namespace
may include the fixed observer object; the same later class-deletion migration
covers it. Do not infer namespace emptiness from 404.

Deleted only temporary robots route `0d2f713b00354801882592550300ace4` and
restored normal config; service binding absent and exactly three normal bindings
remain. Current version/prefix route above supersede earlier ownership records.
Normal code bytes, base settings/runtime and unrelated infrastructure verified;
main Worker unchanged, BIC on, dashboard Access-protected. Current control auth
validated with non-creating invalid-input POST (400) at 07:13:14 UTC. No paid
calls, router writes, credential changes or namespace deletion. Further Cloudflare
mutations require approval; observation counters remain unqualified.


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
