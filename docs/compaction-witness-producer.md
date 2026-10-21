# Compaction witness producer: first, independently landed stage

Local source preparation only. No deployment, publication or runtime/configuration
change is authorized by this document. Producer and consumer are two sequential
focused PRs; do not collapse them into a single squash-deployable unit.

## Producer PR A

Based on landed hosted-search metering W-S0 (`c379acd9c201`). Add bounded HTTP
JSON/SSE witness production, authorization-scoped immutable SQL rows, and the
conservative retained-search tariff guard. No consumer lookup, witness-based
admission relaxation, or multi-account compaction qualification is enabled here.
The later consumer fails closed for missing evidence; there is no backfill or
adoption of ciphertext produced before the producer is deployed. Landing alone
does not deploy the producer or create witnesses.

The tariff guard withholds a precise fee for compaction and item references,
even if a later consumer knows a checkpoint's token-only/hosted enum: that enum
does not establish the exact retained search tariff. Response/turn ancestry,
conversation, saved prompts, multi-agent, dynamic server tools, mixed tariffs
and unknown preview-model rates retain their existing exclusions. Ordinary
encrypted reasoning is classified by the inventory owner as a non-inventory
item, so the declared current-request search tariff can still apply to its
observed completed calls. This does not certify a retained inventory, reduce
opaque token bounds, qualify hard-budget hosted-search admission, or change the
producer's conservative unknown knowledge for encrypted-reasoning ancestry.

## Authority and upgrade proof

`worker/test/compaction-witness-runtime.test.mjs` runs the real Worker, authority
and ledgers in workerd with persistent SQLite storage. Witness scope is the
existing continuation identity (auth type, tenant, policy, credential id,
principal). A foreign tenant's lookup returns nothing, and its own production of
the same item lands in its own scope. A foreign binding written into the owner's
object is a conflict. Revocation fails authentication before any lookup or
write. Reassigning a credential to another policy derives a new, empty scope.
Rotation keeps the credential's scope. Pooled-grant revocation or a new grant
lineage cannot replace the original owner binding. An administrator re-enabling
the same credential id under the same policy keeps the same identity, as for
continuation ownership; consumer B must not treat scope equality alone as
current-owner proof.

The upgrade case opens pre-producer storage with the producer and checks
settings, grants, continuation rows, the background job, budget reservations and
usage events. Only additive witness DDL appears, on first use. CI emulates the
pre-producer store. `CLAWROUTER_UPGRADE_BASE=<extracted tree with node_modules>`
runs the same case from an exact earlier source tree.

The release case writes storage with the latest stable release, v0.4.0
(`080831563e0a`). Its Worker and Durable Objects are bundled from that
commit's own tree. Grants are stored with that release's OAuth-callback
sequence. Head then opens the same persisted SQLite/KV storage.

v0.4.0 persisted these, and all of them carry over:

- Settings and proxy credentials: unchanged rows.
- Grant pool membership and selection: members gain `status='legacy'` on open
  and attach as `active` in place on first use. Release pool accounts are still
  selected.
- Grant owner records: unchanged on open. First use imports the release's
  secretless KV metadata and issues a lineage. Account and secret are kept.
- Budget reservations: they gain `dispatch_started=1` and
  `budget_scope_key=NULL`. They keep counting, so the fourth request against a
  release-written three-request budget gets 402.
- Usage events: they gain null grant columns.
- Refusals: a release-revoked key and a wrong secret are refused exactly as
  before.

Head tables with no v0.4.0 predecessor are created by head:

- `upstream_grant_pool_versions` and `upstream_grant_projections` start empty.
- `http_continuations`, `responses_background` and the witness tables exist
  only in the per-scope continuation object, which v0.4.0 never created. They
  hold only head-produced rows.
- `content_cleanup` is not exercised.

v0.4.0 stored no continuation owner, so a release response id given as
`previous_response_id` fails closed with `continuation_restart_required`
before egress.

The case extracts the pinned commit from the local object store. Shallow
checkouts, which CI uses, skip it with that reason.

## Qualification and next stage

Before publication, bind the exact producer commit/tree, full source audit,
focused behavioral/SQL evidence and a real producer TypeScript run. Preserve
previous raw failed/aborted check artifacts; a pnpm pre-script abort is not a
TypeScript pass. Use direct existing tool entrypoints, without install/purge.
The bounded independent repair-delta review and original parent source re-gate
remain mandatory. Publication stays closed until the parent clears it.

After clearance, PR A still needs exact-head independent review, security and
required CI plus the native merge outcome. Only after A actually lands may PR B
requalify the consumer on that actual base, preserving all authority and
full-window budget invariants. PR B must explicitly document reserve-mode
`pricing_required` for all unwitnessed compaction, including WebSocket and
pre-producer-rollout output, and soft `unpriced_usage` labeling. Witness production
and consumption over WebSocket remain unqualified. Consumer source prepared
locally before that landing is provisional, not a publication candidate.

No paid upstream calls, live state, deployment or whole-parity completion proof
is part of these local checks.
