# FakeCo cleanup handoff — 2026-10-23

Browser inspection: complete, confirmed by the user. Cleanup: **not authorized or
executed**. Retain the environment until a separate mutation batch is approved.
This plan supersedes historical cleanup identities, not the search qualification
limits in the [campaign assessment](codex-search-qualification.md).

Read-only reconciliation completed at **2026-10-23 09:24:19 UTC**. Fourteen checks
passed. No Cloudflare, GitHub or router application writes; no paid search calls.
All evidence below is metadata-only, stored locally under
`.artifacts/fakeco-codex-search-20261022/`. Do not replay consumed experiment runners.

## Current state

- Main and fixture versions, bindings, routes, domains and Access fingerprints
  match the last qualified fixture restoration. Main version:
  `3d669069-fb9e-45e0-a71b-bded66c5b7b2`; fixture:
  `9ea3e336-0cf8-41e0-b44b-09e448fd70cb`.
- All 36 account Worker settings inspected. No outside Worker references the
  owned KV, R2, queues, namespaces or either FakeCo Worker.
- Search credential revoked; bootstrap credential active. Search monthly cap
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

## Exact remote deletion set

Account `91b59577e757131d68d55a471fe32aca` (OpenClaw), zone
`72b20df9e990ac41365dadace6499187` (openclaw.ai). IDs, not name prefixes, define
ownership. All six namespaces contain disposable canary data.

| Resource | Identity |
| --- | --- |
| Fixture Worker | `clawrouter-search-semantics-fakeco`; migration tag `v1` |
| Fixture route | `dd2ae4273551492db92c3b5ffc367529`; `https://clawrouter-fakeco.openclaw.ai/search-semantics/*` |
| Fixture namespace | `148cbb6483b4421dbf8b25301a325865`; `SearchSemanticsObject` |
| Main Worker | `clawrouter-edge-fakeco`, including assets, deployments and bound secret copies |
| Main namespace | `e55d5c688dac4faa98ec8c360df61755`; `ContentArchiveCleanupObject` |
| Main namespace | `0a4b9486e8454c53a395924376b7870b`; `GrantCredentialObject` |
| Main namespace | `b4ecc28ff977441fa1b0290602edef76`; `PolicyBindingIndexObject` |
| Main namespace | `b0da8f0bbf274503bd931cb112ffd3f5`; `BudgetLedgerObject` |
| Main namespace | `e5672c159dac4cb28961af4d376b923d`; `UsageLedgerObject` |
| Worker custom domain | `38664e272d7e218f4f84dfe42a9b268c60fd1fa7`; `clawrouter-fakeco.openclaw.ai` |
| Usage queue | `bd6016244cd749f78e916e50a2ac7dd9`; sole producer/consumer main FakeCo Worker |
| DLQ | `2843acdd30004177a6c3a092f13d9ee3`; no producers or consumers |
| KV | `ca69a07938214acf9fae2bfea2ee2e8d`; `clawrouter-policy-fakeco` |
| R2 | `clawrouter-content-fakeco`; jurisdiction `default` |
| Access application | `beac7325-b743-4eef-982f-117bb7d27cce`; `ClawRouter FakeCo Console` |
| Application policies | `4a44c524-2d85-48ee-bdeb-3f1f5bd43913` and `63650e41-619d-40cc-a3fe-d2d28e7286d6` |
| Service token — manual browser deletion | `f6264117-b130-4b39-a4f9-4b01a17b4ffa`; `clawrouter-fakeco-codex-search-20261022` |
| Router records in owned storage | Policies `fakeco_bootstrap_20261022`, `codex_search_canary_20261022`, `ui_dollars_smoke_20261022`; bootstrap/search credentials; canary ledgers and receipts |
| GitHub configuration — later approval | `openclaw/clawrouter` Environment `fakeco`, ID `25093378320`; exact names in `cleanup-readonly-github-20261023.json` |

## Separate approval batches

1. **First proposed batch: bootstrap revocation and fixture removal.** Refresh
   identities, dependency checks and queue settlement. POST only
   `/v1/admin/credentials/fakeco_bootstrap_20261022/revoke`; verify inactive and
   key inspection denied, with search still revoked. Delete only the recorded
   fixture route. Deploy `wrangler.search-semantics.cleanup.toml`, applying
   `v2-delete-fixture` with `deleted_classes = ["SearchSemanticsObject"]`, no DO
   binding or class export. Verify the exact fixture namespace absent, then delete
   only the empty fixture Worker. Verify main FakeCo health and Access unchanged.
   This permanently deletes fixture data. Do not redeploy the normal fixture
   config afterward. Local Wrangler 4.147.0 dry-run passed: no bindings, no upload.
2. **Core teardown, after another approval.** Recheck no serving fixture route or
   outside dependencies, settled accounting and empty queues. Use the existing
   [guarded teardown](fakeco.md#guarded-teardown), locked to FakeCo, with both
   irreversible-storage confirmations. It removes the main Worker/storage, queues
   and Access app; preserve Access if serving resources remain or deletion fails.
   Keep KV until this command completes its identity checks. Verify all five main
   namespaces and the owned custom-domain binding actually disappear; do not infer
   absence from Worker deletion alone. Stop and reconcile any residue before a
   separately approved corrective action. Verify application policies absent;
   delete only verified owned residues. Preserve all reusable/shared policies.
3. **Retained resources, after another approval.** Once every writer is gone,
   re-list R2 objects/uploads, locks and notifications. If still empty, delete the
   exact R2 bucket and KV namespace. Unexpected content/integrations require
   review. Remove the exclusively run-owned GitHub Environment after rechecking
   its exact entry set. The user deletes the dedicated Access token through the
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
