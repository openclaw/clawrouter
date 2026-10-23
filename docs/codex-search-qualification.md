# Codex search qualification and release assessment

Assessment date: 2026-10-23. Current campaign reference; dated experiment notes
remain evidence, not instructions to replay consumed approvals. Runtime reviewed
from branch `feat/codex-standalone-search`, starting at `6359e16`.

## Release decision

At the user's request, new `codex:connect` CLI profiles enable cached web search
by default, replacing the earlier default-off recommendation. Explicit
`--web-search live` and `--web-search disabled` remain available. Existing profiles
retain their saved mode, including older receipts without a mode, and Desktop
setup stays disabled. Missing search eligibility fails before writing files;
inference-only setup requires an explicit disable choice.

This remains an experimental integration for tested text-search workflows, with
an explicit router tariff and one public OpenAI API account. It does not establish general equivalence to direct
OpenAI authentication. General rollout remains pending upstream billing
qualification; fresh-retrieval and strict cache-only claims remain blocked.

The Alpha retrieval investigation is stopped as inconclusive. The latest bounded
comparison exposed no additional structured diagnostic evidence. Another paid
batch needs a specific new hypothesis or a working fresh-fetch control, a pinned
operator and separate approval. No larger matrix is authorized by this assessment.
The user explicitly chose to leave upstream pricing unqualified; this work does
not seek billing credentials or provider clarification.

## Evidence and limits

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| CLI setup/model gating | New profiles default cached; minimum CLI 0.163.0, eligible native search offer, matching policy generation and Responses Lite descriptor | Minimum version check is not qualification of every later CLI release; catalog eligibility does not probe upstream; saved modes are preserved |
| Public native workflows | CLI 0.163.0 search/open/click/find, cited answer and original-reference resume on eight listed models | Known-content workflows; not fresh-origin proof or a full model × mode × transport matrix |
| Deployed FakeCo workflows | Cached Sol → Astra and live Astra → Sol over WebSocket inference; five search requests, 16 receipts and two automatic compactions per run | Search itself uses unary HTTP; no Desktop, non-Lite, media, feed or pool-failover qualification |
| Session ownership | Caller-isolated upstream IDs, authority-owned account/policy binding, reference reuse after restart/resume/compaction, explicit restart on incompatible ownership | Local binding lifetime does not establish upstream reference lifetime |
| Router accounting | Native runs reconciled policy authority, provider authority and reporting; search tariff separated from inference token cost | Both authorities measure ClawRouter charges, not an upstream invoice |
| Reserve budgets and revocation | Denial before paid dispatch, zero-cost 402 and revoked credential 403; recorded queue drain | Historical evidence for tested reserve-mode configuration; no new live verification in this assessment |
| Error behavior | HTTP-200 tool errors and other upstream responses preserved; search fixed tariff retained for HTTP-200 tool errors | HTTP success, native completion/action events and dashboard success counts do not establish tool or retrieval success |
| Admin price input | Dollars in form; exact conversion to integer micros for API/storage; `$0.001` maps to `1000` | API fields and ledgers still use micros; form units are not an upstream price claim |
| Fresh retrieval | Calibrated Cloudflare observer and independently reachable Funnel fixture; multiple Alpha failures, no qualified hidden-marker + origin-GET pair | Failure cause unresolved; zero origin observations do not identify a failure layer |
| Cache/live modes | Wire preferences match pinned Codex source: cached `false`, live `true` | No passing fresh live control; strict cache-only behavior, rotation and broader semantics unqualified |
| Alpha response shape | Latest IANA control passed; FakeCo health returned HTTP-200 `Internal Error`; `results` absent in both | No additional structured error evidence; does not qualify result semantics or explain the failure |
| Upstream charges | No qualified Alpha usage meter in observed responses | Missing usage does not mean free; Responses hosted-search prices do not establish Alpha charges |

The eight public-native models tested on October 22: `gpt-6-astra`, `gpt-6.1-sol`,
`gpt-6-sol`, `gpt-6-luna`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`. Model declarations share one forwarding/accounting implementation.
The deployed cross-model runs cover Sol/Astra only. A later model, runtime,
upstream account or version requires its own compatibility evidence.

## Evidence index

Receipts are metadata-only local artifacts under
`.artifacts/fakeco-codex-search-20261022/`; their absence from a clean checkout
does not turn the narrative into an independently reproduced result.

| Evidence | Record |
| --- | --- |
| Initial deployment + ordinary inference smoke | [GitHub run 39895613643](https://github.com/openclaw/clawrouter/actions/runs/39895613643), candidate `beed4c7d873e82bfdeb024afe609ccabf9c9c493` |
| Deployed native search/accounting | `native-qualification-summary.json`; cached $0.979108, live $0.667252 in router charges |
| Cap denial/revocation | `cap-denial-revocation-receipt.json`; final tested router spend $3.614986, including earlier stopped attempts; not total upstream campaign expenditure |
| Cloudflare observer calibration and paired retrieval | [Observation](search-semantics-request-observation.md), [pair](search-semantics-paired-retrieval.md); `paired-retrieval-receipt.json` is the retained fixture ownership record |
| Independent hosting comparison | [Funnel](search-semantics-funnel.md), [Responses/Alpha pair](search-semantics-endpoint-comparison.md); neither endpoint qualified fresh retrieval |
| Codex client source | [Pinned 0.163.0 audit](codex-alpha-source-audit.md); no client-side fix identified in the traced path |
| Final response-shape pair | [Outcome](search-response-shape-comparison.md#approved-execution-and-outcome); `alpha-response-shape-comparison-outcome.json`, source `2c052c1`, two requests, no retries |

The published [OpenAI custom-provider guide](https://learn.chatgpt.com/docs/web-search#search-with-a-custom-model-provider),
checked on the assessment date, describes standalone search as under development.
Its provider capability flag is insufficient by itself: the model, runtime,
compatible endpoint and configured restrictions also matter. That documentation
does not replace the empirical limits above or qualify this endpoint's billing.

## Release behavior audit

| Contract | Implementation checked | Assessment |
| --- | --- | --- |
| New CLI default cached; explicit disable | `scripts/codex-connect.mjs`, `scripts/codex-catalog.mjs` | New connections enable eligible search; saved modes/legacy receipts and Desktop remain unchanged; enabled summaries retain experimental retrieval/cache and tariff/billing notices |
| Request eligibility and caller/account binding | `worker/standalone-search.ts`, `worker/openai-public-account.ts`, `worker/discovery.ts`, `worker/proxy.ts` | Explicit tariff and single account checked in discovery and dispatch; stale owners cannot silently migrate references; no search failover |
| Text command scope | `worker/standalone-search.ts`, `providers/openai.provider.yaml` | Only bounded search_query/open/click/find requests; no extra media/feed capability inferred |
| Honest errors and fixed tariff | `worker/test/standalone-search.test.mjs`, `shared/request-pricing.ts` | Wire errors preserved; capability tariff overrides policy-wide tariff, including zero; in-flight admission freezes its tariff |
| Dollar form, micro API/storage | `admin/src/request-price-input.ts`, `admin/src/hooks/access/use-policy-admin.ts`, `admin/src/screens/access.tsx` | Existing conversion and dollar/JSON labels match the contract; no runtime change needed |
| Monitoring without content logging | Standalone Worker regression and diagnostic summaries | Use status/accounting for transport and router charging; synthetic text-error checks for known tool errors. No raw output parser added to the hot path |

Setup notices do not change installed TOML, model enablement, tariffs, error
status or budget enforcement. No Worker, admin or manifest source changes in
this assessment. The [setup guide](codex.md#opt-in-to-built-in-cli-web-search)
and [rollout history](codex-search-rollout.md) use this narrower qualification.

## Retained environment and handoff

The user confirmed browser inspection complete. Core FakeCo cleanup completed;
KV/R2, the dedicated service token, GitHub Environment and 1Password items remain
for separately approved cleanup. The [current cleanup handoff](codex-search-cleanup-20261023.md)
records exact identities and approval batches. Approved batch 1 completed
at 2026-10-23 09:28:51 UTC: bootstrap revoked, fixture route removed, fixture
namespace deleted through its migration, and empty fixture Worker deleted.
Both saved canary keys returned 403 on inspection at that stage. Thirteen final checks passed:
main FakeCo health/version and Access preserved, production unchanged, other
Workers/routes/namespaces preserved, queues empty and spend unchanged. Receipt:
`cleanup-batch1-verification-20261023.json`.

The user then approved core teardown. Its first Worker DELETE returned HTTP
403/code `10064` at 09:32:10 UTC; execution stopped before queue or Access deletion.
Twelve read-only reconciliation checks passed at 09:34:03 UTC: no core resources
removed, main FakeCo and production unchanged, keys revoked, queues empty and
spend unchanged. The attached queue consumer is a plausible dependency blocker;
the exact server message was not retained, so permission failure and root cause
are not established. See `cleanup-batch2-refusal-reconciliation-20261023.json` and
`cleanup-batch2-consumer-correction-plan-20261023.json`.

The user approved exact consumer disconnection and one guarded retry. Preflight
stopped before either mutation: FakeCo now returns authoritative DNS `NXDOMAIN`,
so live application/key/health checks cannot run. Read-only reconciliation at
09:39:27 UTC confirms Worker/settings/deployments, all five namespaces, domain
binding, queues/sole consumer and Access unchanged; queues empty, KV/R2 retained,
production and unrelated infrastructure preserved. DNS loss timing/cause remain
unconfirmed; the prior refused DELETE is not proven atomic. Earlier health,
revocation and spend checks remain historical evidence. No DNS repair, alternate
host/IP path, credential switch or paid probe. The handoff prepared the same
deletion sequence using historical revocation/spend evidence, requiring approval
for that changed precondition. Receipts: `cleanup-batch2-dns-reconciliation-20261023.json`
and `cleanup-batch2-dns-correction-plan-20261023.json`. This was a historical stop;
the user subsequently approved the revised precondition.

The approved correction completed at **09:42:59 UTC**, with eight final checks
passed. Sole consumer disconnected and verified absent, then the same guarded
Worker DELETE succeeded once. Five main namespaces and the custom domain were
verified absent before both empty queues were deleted; Access was deleted last.
Both application policies absent from scoped GETs and all current application/
reusable inventories. All unrelated Worker/namespace/domain/route inventories,
production settings/deployments, 26 remaining Access apps and 12 reusable policies
preserved. KV/R2 retained; service token, GitHub and 1Password untouched. Receipt:
`cleanup-batch2-verification-20261023.json`, hashing preflight and both execution
receipts. Five management DELETEs, no retry beyond the approved single core retry,
no DNS repair and no paid call. Spend/revocation evidence is historical; no live
application checks after removal. Success supports the consumer-dependency
explanation without establishing the original refusal or DNS-loss cause.

Read-only reconciliation at 2026-10-23 09:24:19 UTC passed 14 checks: main/fixture
restoration fingerprints match, all 36 Worker dependencies and 27 Access apps'
policies inspected, no external resource references found, both queues drained,
R2 empty including multipart uploads, and GitHub Environment entries exclusively
run-owned. At that snapshot search was revoked and bootstrap active; settled router
spend was $3.614986. Safari verified the dedicated Access token; its API deletion permission
remains unqualified, requiring the manual browser step. No Cloudflare, GitHub or
router application writes and no paid search calls during this inventory.
Receipt: `cleanup-readonly-reconciliation-20261023.json` plus its hashed inputs.

Earlier cap-denial qualification, 2026-10-23 03:54:29 UTC: search credential revoked,
monthly policy cap equals settled spend ($3.614986), daily/weekly and provider
monthly limits $50. Later direct provider probes are outside that router total.
Historical fixture restoration: normal version `9ea3e336-0cf8-41e0-b44b-09e448fd70cb`,
prefix route `dd2ae4273551492db92c3b5ffc367529`, former namespace
`148cbb6483b4421dbf8b25301a325865`; see `paired-retrieval-receipt.json`.
Funnel/Serve were independently empty and port 18765 free at 08:45:20.683 UTC;
there is no pending cleanup from that completed experiment. These are timestamped
records preceding the refreshed inventory and approved cleanup above. Fixture
infrastructure is now absent; spend remains unchanged. Funnel/Serve and port 18765 were checked again during reconciliation;
no exposure or listener remains.

Before any future mutation, refresh the read-only ownership and credential
inventory. Cloudflare mutations still need explicit approval for each batch;
browser inspection is complete. Historical registration IDs and exclusive
experiment receipts must not be reused. The earlier release assessment itself
made no live credential reads or remote queries; the later read-only inventory
used targeted credential reads. Neither step changed remote state. The later
approved batch 1 made only the mutations listed above; batch 2's initial attempt
was rejected, followed by the separately approved correction and verified core
removal. No PR, push or live provider
probe. The fixture cleanup build passed a local Wrangler dry run before approval;
the approved deletion migration subsequently deployed once and was verified.

## Earlier assessment verification

- Setup/catalog: 59 passed, five optional native lifecycle tests skipped. Both
  cached/live notices exercised through planning, installation, verification and
  refresh; default-disabled setup and removal retain their previous output.
- Worker search/request-pricing: 35 passed. Wire preservation, account/session
  boundaries, catalog/dispatch agreement, tariff precedence, in-flight tariff
  freezing, authority failures, cap denial and revocation.
- Admin request-price/policy/cost presentation: 90 passed. Exact dollars/micros
  conversion, explicit free tariffs, invalid/sub-microdollar rejection and
  separation of router accounting from invoice claims.
- Workerd integration: one passed. Interleaved WebSocket inference/HTTP search,
  model switch, synthetic compacted transcript, references and SQL accounting.

All provider operations use synthetic fixtures; no new native paid qualification.
No full-suite or remote deployment claim. Commands:

```sh
node --test test/codex-connect.test.mjs test/codex-catalog.test.mjs
node --test worker/test/standalone-search.test.mjs worker/test/request-pricing.test.mjs
node --test admin/test/request-price-input.test.mjs admin/test/use-policy-admin.test.mjs admin/test/cost-presentation.test.mjs
node --test test/standalone-search-workerd.test.mjs
```

Autoreview of `1ad6fcd` completed `scoped-clean` through P2 with GPT-6.1 Sol,
high reasoning, no actionable findings. Static review of the committed change
and supplied dependency context; the reviewer did not execute tests or probes.
That review predates the subsequent user-requested default-on change; the
default-off verification above describes the earlier assessment's test run.
Outputs: `~/.codex/review-results/codex-search-release-assessment-20261023/`.
Local assessment receipt:
`.artifacts/fakeco-codex-search-20261022/release-assessment-receipt.json`.

## Default-on setup verification

The subsequent user request changes only the `codex:connect` default for new CLI
profiles to cached search. Existing profiles and Desktop are not migrated;
explicit live/disabled modes and the existing qualification notices remain.
Focused setup/catalog tests: 63 passed, five optional native lifecycle tests
skipped. Coverage includes default-enabled installation and catalog narrowing,
explicit disable on older or search-ineligible producers, refusal before file
writes, and preservation of explicit-disabled/legacy modes through verify/update.
No new live qualification or deployment is part of the default change.

Autoreview of `178ce56` completed `scoped-clean` through P2, with no actionable
findings. Outputs: `~/.codex/review-results/codex-connect-default-search-20261023/`.
