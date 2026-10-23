# FakeCo cleanup handoff — 2026-10-23

Browser inspection: complete, confirmed by the user. **Approved automated cleanup
through batch 3 completed.** Core verification passed eight checks at 09:42:59 UTC;
retained-resource verification passed seven at **2026-10-23 09:47:08 UTC**. Both
FakeCo Workers, all six namespaces, serving routes/domain, queues, owned Access
app/policies, KV namespace, R2 bucket and GitHub Environment are absent.
Production/shared infrastructure and deployment history preserved. **Manual
Access-token deletion remains:** Safari shows the exact token with its context
menu open. The two dedicated 1Password items remain until that revocation is
verified. No credential switch, DNS repair, paid probe, PR or push.
This handoff supersedes historical cleanup identities, not the search qualification
limits in the [campaign assessment](codex-search-qualification.md).

Read-only reconciliation completed at **2026-10-23 09:24:19 UTC**. Fourteen checks
passed. No Cloudflare, GitHub or router application writes; no paid search calls.
All evidence below is metadata-only, stored locally under
`.artifacts/fakeco-codex-search-20261022/`. Do not replay consumed experiment runners.

## Approved batch 1 outcome

- Revoked `fakeco_bootstrap_20261022`. Bootstrap and search credentials both
  disabled/inactive; both saved keys return 403 on inspection.
- Deleted only fixture route `dd2ae4273551492db92c3b5ffc367529`.
- Applied `v2-delete-fixture` once. Namespace
  `148cbb6483b4421dbf8b25301a325865` absent; all other namespaces preserved.
  Cleanup version `3599ce34-78a7-49e5-89ab-9a477873a63e` was verified before deletion.
- Deleted `clawrouter-search-semantics-fakeco`, including its remaining secret
  binding. Worker inventory and settings 404 confirm absence; former fixture
  health path now returns 404. Do not redeploy either fixture configuration.
- Thirteen final checks passed. Main FakeCo health/version/settings/deployments,
  its domain and Access application, production settings/deployments, all other
  Workers, routes and namespaces preserved. Both queue backlogs remain zero;
  settled router spend and budgets unchanged. No paid search calls.

Authoritative receipt: `cleanup-batch1-verification-20261023.json`, including hashes
of the preflight and four operation receipts. Mutations: one credential revoke,
one route delete, one fixture deletion-migration deployment and one Worker delete.
No main teardown, KV/R2 deletion, Access/service-token deletion, GitHub change or
credential-manager cleanup. The local guarded main-teardown preview passed; it
made no Cloudflare requests and did not execute deletion.

## Retained evidence from before core cleanup

- Last deployed main version was `3d669069-fb9e-45e0-a71b-bded66c5b7b2`. Main settings,
  deployments, domains and Access fingerprints match the last qualified fixture
  restoration in the pre-deletion receipts. Both main and fixture deployments
  are now removed; former fixture version `9ea3e336-0cf8-41e0-b44b-09e448fd70cb`.
- All 36 account Worker settings inspected. No outside Worker references the
  owned KV, R2, queues, namespaces or either FakeCo Worker.
- Search and bootstrap credentials revoked. Search monthly cap
  equals settled router spend, **$3.614986**. OpenAI provider monthly limit and
  search daily/weekly limits remain $50. This is not an upstream bill total.
- Both queue backlogs zero. R2 contains zero objects and zero multipart uploads;
  complete S3 listings succeeded without reading object bodies or persisting keys.
  No bucket lock rules. Event-notification GET returned 404/code `11015`, the
  documented [no-configurations response](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/event_notifications/methods/list/).
- All 27 Access applications' policies inspected. Only FakeCo references the
  dedicated token or either owned application policy. The 12 reusable policies
  contain neither owned policy ID; preserve them all.
- Safari confirms the dedicated token UUID/name, enabled status, 24-hour duration,
  and one application in use: FakeCo. Displayed expiry: October 23 at 08:17 PM;
  display timezone unqualified. Its summary says no associated policies despite
  the verified application policy reference; do not use that summary as proof of
  no references. API service-token writes remain unqualified.
- GitHub Environment identity unchanged: nine run-created secrets, four variables,
  one deployment of the pinned candidate; no repository-level `CLAWROUTER_FAKECO_`
  secrets or variables. No unrelated Environment entries found.
- Tailscale Funnel/Serve configurations empty; local port 18765 free. No pending
  exposure cleanup. Certificate state unchanged; no key enrollment or revocation.

## Batch 2 refusal and prepared correction

The refreshed batch-2 preflight passed 16 checks. At **09:32:10 UTC**, the guarded
teardown attempted only `DELETE /accounts/91b59577e757131d68d55a471fe32aca/workers/services/clawrouter-edge-fakeco?force=true`.
Cloudflare returned HTTP 403/code `10064`, with no acknowledgement. Neither queue
nor the Access app was deleted. The endpoint was not retried; no other credential,
auth mode or endpoint was substituted.

Read-only reconciliation completed **09:34:03 UTC**, passing 12 checks. Worker
inventory/settings/deployments, all five main namespaces, domain/routes, queue
configuration and Access app unchanged. Both keys remain revoked; queue backlogs
zero; router spend $3.614986. Main FakeCo healthy and Access-protected; production
unchanged. References API shows no incoming/outgoing services, only the main
Worker's own five namespace bindings, and no tail producers.

This does **not establish a permission failure**. Cloudflare's own
[Workers SDK issue](https://github.com/cloudflare/workers-sdk/issues/3370) records
`10064` when a Worker is still a queue consumer and recommends disconnecting that
consumer before deleting the Worker. FakeCo has that attachment. This is a
plausible cause, not a confirmed diagnosis: only status/code were persisted from
the failed request, not its server message. The current guarded command does not
disconnect consumers before its Worker deletion; do not rerun it unchanged against
the same attached consumer.

The user approved this correction; preflight stopped before either action:

1. Refresh ownership, zero-backlog and revoked-key checks. Disconnect only
   `0d6d0b30a9a94cbe9efbbf7b0ccaa7aa` from usage queue
   `bd6016244cd749f78e916e50a2ac7dd9`, using the documented
   [consumer DELETE endpoint](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/delete/).
   Its direct metadata GET on **09:34:29 UTC** confirmed `clawrouter-edge-fakeco`,
   type `worker`, expected FakeCo DLQ and sole-consumer status; queue empty.
   This removes the consumer attachment, retaining both queues and Access.
2. Verify that exact consumer absent, then retry the existing guarded core teardown
   **once**, with the same account/token, exact deletion set and per-operation
   journaling. Verify Worker/namespaces/domain absent before proceeding with queue
   deletion; retain Access until serving resources and queues are gone.
3. Stop on another refusal or unexpected residue; no automatic mutation retry,
   alternate credential, broader cleanup or budget reset. KV/R2, service token,
   GitHub Environment and credential-manager items remain outside this correction.

Receipts: `cleanup-batch2-preflight-20261023.json`,
`cleanup-batch2-core-execution-20261023.json`,
`cleanup-batch2-refusal-reconciliation-20261023.json`, and
`cleanup-batch2-consumer-correction-plan-20261023.json`. Successful consumer reads
do not exercise its deletion permission. No source-code changes or paid probes.

## Earlier correction stopped before dispatch: DNS precondition

Read-only reconciliation completed **09:39:27 UTC**, with five checks passed.
Cloudflare's authoritative nameserver and public resolver `1.1.1.1` both return
`NXDOMAIN` for `clawrouter-fakeco.openclaw.ai`. Production's hostname resolves.
The main Worker, its settings/deployments, all five namespaces, custom-domain
binding, queues/sole consumer and Access app/policies still match the recorded
baseline. Both queues are empty; KV/R2 remain. Production settings/deployments and
all other Worker/namespace/domain/route inventories are unchanged.

No consumer DELETE or core retry was dispatched; no Cloudflare/application writes
or paid calls in this correction attempt. The first preflight comparisons also
needed metadata normalization: Access inventory formatting and the direct
consumer response's additional queue/timestamp fields. Those comparisons passed
after correction; they did not identify remote changes.

The cause and timing of DNS loss are unconfirmed. The earlier refused DELETE is
not proven atomic, and unchanged custom-domain metadata does not establish DNS
reachability. The earlier 09:34:03 health/revocation/spend checks are historical,
not current availability evidence. Token access to DNS-record metadata was
unavailable; no alternate credential or DNS repair was attempted.

Revised execution prepared at that stage: refresh management ownership/dependencies
and empty queues, then perform the same exact consumer removal and single guarded
retry, using the last successful revocation/spend receipt instead of fresh
application, key and health checks. This changed the agreed precondition and
required approval under the user's instruction to stop on unexpected state. It created no DNS
record, public re-exposure or alternate-host/IP path. Keep the same token/account
and all existing deletion gates; stop on another refusal or residue. KV/R2,
service token, GitHub and 1Password remain outside this batch.

Receipts: `cleanup-batch2-dns-reconciliation-20261023.json` and
`cleanup-batch2-dns-correction-plan-20261023.json`; the reconciliation hashes all
three read-only preflight attempts. The user subsequently approved this changed
precondition, and execution completed below. Do not replay exclusive receipts or
treat the old application's historical health result as a current result.

## Approved revised correction completed

The user approved use of historical revocation/spend evidence without restoring
DNS. Refreshed management preflight passed six checks at **09:41:36 UTC**: exact
identities/configurations, all 35 Worker settings, all 27 Access applications'
policies, exclusive references, empty queues, retained storage and unchanged
guarded-command hashes. No live application/key/health checks were claimed.

Executed once each, with a durable journal before dispatch and the same account,
token and guarded Worker endpoint:

1. Disconnected consumer `0d6d0b30a9a94cbe9efbbf7b0ccaa7aa` (HTTP 200).
   Direct GET returned 404; usage queue's consumer list empty, producer unchanged,
   both queues retained and drained.
2. Guarded main Worker DELETE acknowledged (HTTP 200). Before queue deletion,
   verified Worker settings 404, Worker inventory absence, all five namespaces
   absent, custom-domain binding absent and no serving routes. Unrelated
   inventories and production settings/deployments preserved.
3. Deleted usage queue and DLQ (HTTP 200 each); direct GETs confirmed 404.
4. Deleted the exact Access application last (HTTP 202); subsequent GET confirmed
   404. Both owned application policies return scoped 404 and are absent from
   every remaining application's policy list and the reusable-policy inventory.

Final read-only verification passed **eight checks at 09:42:59 UTC**. Account now
has 34 Workers and 31 namespaces, exactly the unrelated baseline. All 26 remaining
Access applications' identity/destination/policy sets and all 12 reusable policies
preserved. Exact KV and R2 resources remain. No service-token API request, GitHub
write or 1Password change; no additional deletion, DNS repair or paid call.

Authoritative receipt: `cleanup-batch2-verification-20261023.json`, hashing
`cleanup-batch2-revised-approved-preflight-20261023.json`,
`cleanup-batch2-consumer-disconnect-20261023.json`, and
`cleanup-batch2-core-retry-20261023.json`. Five approved management DELETEs total
in this correction. The successful retry after disconnection supports the
consumer-dependency explanation; it does not recover the original error message
or establish the cause of the earlier DNS loss. Last router spend $3.614986 is
historical evidence, not a post-deletion usage reading or upstream bill total.

## Approved retained-resource cleanup completed

The user approved the remaining cleanup. Preflight passed six checks at
**09:45:41 UTC**: core resources absent, all 34 remaining Worker settings inspected
with no owned-storage references, exact KV/R2 identities and unchanged lifecycle,
no bucket locks/notifications/custom domains/public managed domain, and complete
fresh S3 lists with zero objects and zero multipart uploads. No object bodies or
keys persisted. GitHub Environment ID, nine secret names/timestamps, four
variable names/timestamps and pinned history unchanged; no active FakeCo runs.

Executed once each, journaled before dispatch:

1. Deleted empty R2 bucket `clawrouter-content-fakeco` (HTTP 200).
2. Deleted KV namespace `ca69a07938214acf9fae2bfea2ee2e8d` (HTTP 200), including
   its remaining stored key/value pairs; no values read or logged.
3. Deleted `openclaw/clawrouter` Environment `fakeco`, ID `25093378320`
   (HTTP 204), removing its nine secret copies and four variables.

Final read-only verification passed **seven checks at 09:47:08 UTC**. Storage
resources return 404 and are absent from complete KV/cursor-paginated R2 lists;
unrelated storage inventory preserved. Environment and scoped secret/variable
GETs return 404; other Environments and repository-level secret/variable metadata
unchanged. Candidate deployment `7269515560`, tag and workflow run history
preserved. Core resources remain absent; production/shared routing/Access and
production settings/deployments match their baselines.

Receipt: `cleanup-batch3-verification-20261023.json`, hashing
`cleanup-batch3-preflight-20261023.json` and `cleanup-batch3-execution-20261023.json`.
The preflight pins `cleanup-batch3-r2-preflight-20261023.json`. Two Cloudflare
DELETEs and one GitHub DELETE; no fallback or replay. The documented
[bucket deletion](https://developers.cloudflare.com/r2/buckets/delete-buckets/),
[namespace deletion](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/delete/)
and [Environment deletion](https://docs.github.com/en/rest/deployments/environments#delete-an-environment)
endpoints define this batch's mutation scope; no workflow/tag/deployment deletion.

## Manual token handoff and credential disposal

Safari, read-only, confirms account OpenClaw and token
`f6264117-b130-4b39-a4f9-4b01a17b4ffa`, name
`clawrouter-fakeco-codex-search-20261022`, still Enabled with 24-hour duration.
It now shows zero associated applications, no associated policies and no
applications in use. Context menu open with **Delete token** visible. No
delete/disable/refresh/rotate action selected; the user performs deletion and any
confirmation. No API service-token request or 1Password change.

Receipt: `cleanup-batch3-manual-token-handoff-20261023.json`; identifiers and UI
state only, no credential values persisted. After the user completes deletion,
verify absence in the browser before disposing of the two dedicated 1Password
items. Keep shared Cloudflare/OpenAI/Tailscale items, Wrangler login and evidence.

## Exact ownership and completed deletion set

Account `91b59577e757131d68d55a471fe32aca` (OpenClaw), zone
`72b20df9e990ac41365dadace6499187` (openclaw.ai). IDs, not name prefixes, define
ownership. All five main namespaces and the fixture namespace are deleted.
Completed entries below are retained as evidence; only explicitly retained
resources belong to later cleanup batches.

| Resource | Identity |
| --- | --- |
| Fixture Worker — deleted | `clawrouter-search-semantics-fakeco`; final migration tag `v2-delete-fixture` |
| Fixture route — deleted | `dd2ae4273551492db92c3b5ffc367529`; `https://clawrouter-fakeco.openclaw.ai/search-semantics/*` |
| Fixture namespace — deleted | `148cbb6483b4421dbf8b25301a325865`; `SearchSemanticsObject` |
| Main Worker — deleted | `clawrouter-edge-fakeco`, including assets, deployments and bound secret copies |
| Main namespace — deleted | `e55d5c688dac4faa98ec8c360df61755`; `ContentArchiveCleanupObject` |
| Main namespace — deleted | `0a4b9486e8454c53a395924376b7870b`; `GrantCredentialObject` |
| Main namespace — deleted | `b4ecc28ff977441fa1b0290602edef76`; `PolicyBindingIndexObject` |
| Main namespace — deleted | `b0da8f0bbf274503bd931cb112ffd3f5`; `BudgetLedgerObject` |
| Main namespace — deleted | `e5672c159dac4cb28961af4d376b923d`; `UsageLedgerObject` |
| Worker custom domain — deleted | `38664e272d7e218f4f84dfe42a9b268c60fd1fa7`; `clawrouter-fakeco.openclaw.ai` |
| Usage queue — deleted | `bd6016244cd749f78e916e50a2ac7dd9`; sole consumer disconnected first |
| DLQ — deleted | `2843acdd30004177a6c3a092f13d9ee3` |
| KV — deleted | `ca69a07938214acf9fae2bfea2ee2e8d`; `clawrouter-policy-fakeco` |
| R2 — deleted | `clawrouter-content-fakeco`; jurisdiction `default` |
| Access application — deleted | `beac7325-b743-4eef-982f-117bb7d27cce`; `ClawRouter FakeCo Console` |
| Application policies — absent | `4a44c524-2d85-48ee-bdeb-3f1f5bd43913` and `63650e41-619d-40cc-a3fe-d2d28e7286d6` |
| Service token — manual browser deletion | `f6264117-b130-4b39-a4f9-4b01a17b4ffa`; `clawrouter-fakeco-codex-search-20261022` |
| Router records — owned storage deleted | Main Durable Object storage and KV deleted. Historical policy IDs: `fakeco_bootstrap_20261022`, `codex_search_canary_20261022`, `ui_dollars_smoke_20261022` |
| GitHub configuration — deleted | `openclaw/clawrouter` Environment `fakeco`, ID `25093378320`; nine secrets and four variables; history retained |

## Separate approval batches

1. **Completed batch 1: bootstrap revocation and fixture removal.** Historical
   execution sequence follows; do not replay. Refresh
   identities, dependency checks and queue settlement. POST only
   `/v1/admin/credentials/fakeco_bootstrap_20261022/revoke`; verify inactive and
   key inspection denied, with search still revoked. Delete only the recorded
   fixture route. Deploy `wrangler.search-semantics.cleanup.toml`, applying
   `v2-delete-fixture` with `deleted_classes = ["SearchSemanticsObject"]`, no DO
   binding or class export. Verify the exact fixture namespace absent, then delete
   only the empty fixture Worker. Verify main FakeCo health and Access unchanged.
   This permanently deletes fixture data. Do not redeploy the normal fixture
   config afterward. Local Wrangler 4.147.0 dry-run passed: no bindings, no upload.
2. **Completed batch 2: core teardown after approved correction.** Consumer
   disconnected, then existing [guarded teardown](fakeco.md#guarded-teardown)
   executed once after revised precondition approval. Main Worker, five
   namespaces, custom domain, queues and Access app/policies absent; all deletion
   gates verified. KV retained for later disposal. Do not replay the teardown.
3. **Automated batch 3 completed; manual token step pending.** Exact empty R2
   bucket, KV namespace and exclusively run-owned GitHub Environment deleted and
   verified as above. The user deletes the dedicated Access token through the
   browser; verify its absence there. No service-token API deletion attempt.
4. **Final verification and local credentials.** Re-list every recorded remote ID
   and compare production settings/deployments and shared routing with the saved
   baseline. Record partial failures; 403/network errors never establish absence.
   After remote credentials are revoked, separately confirm disposal of the two
   dedicated 1Password items and any remaining canary client profiles. Preserve
   metadata receipts, experiment evidence and Git history. Do not delete local
   artifacts as a substitute for revoking remote credentials.

The existing teardown is only one phase, not a complete cleanup command. Each
batch requires fresh user approval. A failed batch does not authorize broader
deletion, retries with another account/token, spend reset or credential revival.

Preserve production `clawrouter-edge`, its storage/domain/Access resources, the
zone, shared GitHub IdP `32ade06d-f190-4da6-985d-6d1ebc5617da`, all other service
tokens, shared Cloudflare/OpenAI/Tailscale credentials, Wrangler login, and the
published candidate tag/workflow history. The dedicated credential items are
`ClawRouter FakeCo canary credentials 20261022` and
`clawrouter-fakeco-codex-search-20261022` in Agent Secrets.

## Evidence and read limitations

`cleanup-readonly-reconciliation-20261023.json` records the 14 checks and hashes of
seven inventory receipts: general inventory, Worker dependencies, router state,
S3 listings, GitHub, Access dependencies, and routing/storage. It includes the
production settings/deployments baseline for future preservation checks.

The initial generic Worker pagination failed to qualify that list; the documented
[unpaginated Worker list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)
and all 36 settings reads resolved it. No denied token-policy or IdP endpoint was
retried. The known incomplete service-token API view was replaced by read-only
browser verification, not another API credential. Successful reads still do not
exercise delete permissions. Current metadata must be refreshed at execution.
