# Codex search final local handoff — 2026-10-23

Local review candidate on `feat/codex-standalone-search`. No PR, push, production
deployment, new paid probe or Cloudflare mutation is part of this handoff.

## Frozen source and scope

- Validated runtime source: `5f69436b6ccb4303a06a3e788bce78c0e0d20aab`.
- Local `main` and merge base: `c130b15727021498493d541df168141f1d93528f`.
- Runtime candidate diff: 103 files; 10,577 insertions and 309 deletions.
- Source tree was clean when frozen. This handoff is subsequent documentation;
  validation/review targets and any corrections are recorded separately below.
- These are local refs, not a claim that remote `main` was refreshed.

## Resulting behavior

| Surface | Result | Principal implementation |
| --- | --- | --- |
| Native search | Bounded text search/open/click/find forwarded through the standalone OpenAI endpoint; caller-isolated session IDs and authority-owned account/policy bindings; errors and opaque references preserved | `worker/standalone-search.ts`, `worker/openai-public-account.ts`, proxy/discovery/continuation integration; OpenAI manifest |
| Accounting | Capability-specific fixed request tariffs override the legacy policy-wide tariff, including zero; admitted tariff frozen through settlement; inference retains its configured pricing | `shared/request-pricing.ts`, Worker authority, admission and accounting paths |
| CLI setup | New eligible CLI profiles default to cached search; explicit live/disabled choices; existing saved/legacy modes preserved; Desktop search stays disabled | `scripts/codex-connect.mjs`, `scripts/codex-catalog.mjs` |
| Admin pricing | Request prices entered in dollars and converted exactly to integer microdollars for API/storage; capability JSON input below fixed request cost, with explicit dollar/JSON title | `admin/src/request-price-input.ts`, policy/fusion admin hooks and access screen |
| Teardown | Both queues checked for identity, owned dependencies and empty backlog before writes; exact consumer disconnected and verified absent before Worker deletion; Access last, with failure stops | `scripts/teardown-fakeco.mjs`, `test/fakeco-teardown.test.mjs` |
| Qualification tooling | Synthetic local tests and bounded historical search/hosting diagnostics; archived deployment/cleanup receipts and procedures | `scripts/*search*.mjs`, `worker/fixtures/`, associated tests and experiment documents |

Keep provider-specific search eligibility out of generic routing semantics. No
broader capability follows from an upstream accepting a larger schema. Revocation
and authoritative budget enforcement remain ahead of reporting.

## Deployment and cleanup status

Historical FakeCo deployment used candidate
`beed4c7d873e82bfdeb024afe609ccabf9c9c493`, published tag
`canary/codex-search-2026-10-22`, and
[successful workflow 39895613643](https://github.com/openclaw/clawrouter/actions/runs/39895613643).
Later user-approved FakeCo updates exercised pricing UI changes. These are
historical deployments, not deployment qualification of the frozen source above.
The new default-on setup and teardown hardening are local changes.

FakeCo cleanup completed and was verified at 2026-10-23 09:54:00 UTC. Dedicated
Workers, namespaces, routes/domain, queues, Access app/policies/token, KV, R2,
GitHub Environment and dedicated credential-manager items are absent. Production,
shared credentials/resources and deployment history were preserved. No cleanup
remains. Exact ownership and verification limits:
[final cleanup record](codex-search-cleanup-20261023.md).

## Qualification and remaining risk

The integration remains experimental. Native CLI 0.163.0 known-content workflows
passed on eight recorded models; deployed cross-model WebSocket-inference runs
covered Sol/Astra in cached/live modes. Search itself uses unary HTTP. Minimum
version gating does not qualify every later CLI, model or combination.

Fresh-origin retrieval, strict cache-only guarantees and upstream Alpha billing
remain unqualified. HTTP 200 and native completion events are not proof of tool
success or fresh retrieval. The explicit router tariff is not an upstream invoice
estimate; historical router spend of $3.614986 excludes direct-provider probes.
The user chose to leave upstream pricing unqualified. The Alpha investigation is
stopped as inconclusive; this handoff does not authorize another experiment.

Desktop search, media/feed commands, non-Lite models and account-pool failover
remain outside qualification. Session metadata retention does not establish the
upstream lifetime of opaque references. Teardown reads are observations, not an
atomic drain; operators must stop writers and audit external dependencies.

## Final local validation

Environment: Node `v24.21.0`, pnpm `11.28.4`. Validation uses synthetic fixtures
and local runtimes. No new live provider qualification. Logs retained under
`.artifacts/codex-search-final-handoff-20261023/`:

| Command/surface | Result | Log |
| --- | --- | --- |
| `pnpm check`: Worker TypeScript and tests | Passed; 2,568 tests, no skips | `check.log` |
| `pnpm check`: admin TypeScript and tests | Passed; 236 tests, no skips | `check.log` |
| `pnpm check`: script tests | Passed; 941 tests, 18 optional native tests skipped | `check.log` |
| `pnpm build` | Passed; all 22 bundled provider manifests compiled/validated, admin production assets built, 2,568 Worker tests passed again | `build.log` |
| `pnpm provider:smoke-plan` | Passed strict plan coverage: 22 providers, 22 smoke targets; no live provider calls | `provider-smoke-plan.log` |
| Pricing browser regression, desktop/mobile | Passed both cases: dollar display/save, integer-microdollar API payloads, edited/free values and sub-microdollar rejection | `admin-pricing-browser.log` |
| `pnpm worker:e2e` | Passed local Worker, Responses WebSocket/SQL accounting/revocation, and content-cleanup recovery smokes | `worker-e2e.log` |

The build regenerated `worker/generated/provider-snapshot.json` without a byte
change. Vite emitted nonfatal vendor `use client` directive and bundle-size
warnings; the build completed. Browser checks used mocked admin APIs against
local production assets. Exact browser command:

```sh
pnpm --dir admin exec playwright test browser/policy-drafts.spec.ts \
  -g 'request prices display dollars'
```

The check run left `CLAWROUTER_CODEX_BINARY` and `CLAWROUTER_CODEX_CATALOG_BINARY`
unset. All 18 skipped tests require the optional native CLI binary: five setup
lifecycles, five native metadata/auth/Guardian cases, and eight native-router/
reconnect/cancellation cases. This handoff does not claim a fresh native CLI or
Guardian qualification. Earlier paid native search evidence remains historical.

Additional semantic inspection compared the generated snapshot at the pinned
base and candidate. Exactly 19 locations differ: search capability/provider
index entries, one standalone endpoint, and addition of `search.web` to each of
the eight models in both model indexes. Each changed model capability list only
appends that capability; no other snapshot changes. Receipt:
`provider-snapshot-semantic-diff.json` beside the validation logs. This supplements
the compiler-output equality check because the one-line generated JSON is split
across review passes.

## Complete branch review

An initial seven-pass run returned no findings but failed final source-stability
verification after this handoff changed during the run. It produced no accepted
report; those pass outputs are not a scoped-clean result.

Repeat shared autoreview completed **`scoped-clean` through P2**. All seven passes
completed with zero findings; final source-stability verification passed and the
helper exited 0. Engine: GPT-6.1 Sol, high reasoning.

- Reviewed candidate: `1a359ae5766d9322114d974297c10e7a38dcffbc`.
- Base: `c130b15727021498493d541df168141f1d93528f`.
- Entire committed branch diff: 104 files, including this handoff at that stage.
- Runtime matches the validated `5f69436` source; `1a359ae` adds documentation.
- Accepted report and seven preserved pass conclusions: `report.md` / `report.json`.
- Machine-readable outcome: `status.json`.
- Output directory: `~/.codex/review-results/codex-search-full-branch-20261023-frozen/`.

The independent reviewer assessed supplied patch/source evidence; it did not run
project tests or live probes. The validation above ran separately. The generated
snapshot's removed/replacement lines occupy separate passes; compiler equality
and the semantic comparison supplement that static-review limitation. No fresh
retrieval/cache guarantee or upstream-billing qualification follows from this
review. This result entry is a subsequent documentation-only update, outside the
reviewed candidate; runtime source remains unchanged.

## Publication privacy correction

The historical Funnel host is replaced with `funnel-fixture.example.invalid` in
the diagnostic script and examples. The reserved placeholder deliberately cannot
identify an operator's machine; a future live experiment requires a separately
approved host. The PR branch history is sanitized as part of this correction.
Original source/review commit identifiers above describe the pre-redaction
evidence and are retained as historical provenance, not current branch identities.

All 41 focused Funnel and endpoint-comparison tests passed after the correction.
No provider request, Tailscale command, exposure, Cloudflare change or deployment
was performed. Core Worker, pricing, admin and CLI-setup behavior is unchanged.

## Evidence index

| Record | Purpose |
| --- | --- |
| [Qualification assessment](codex-search-qualification.md) | Tested workflows, models, errors, accounting and empirical limits |
| [Setup guide](codex.md#built-in-cli-web-search) | Current connect behavior, tariff configuration and session contract |
| [Rollout history](codex-search-rollout.md) | Earlier regressions, upstream retrieval and billing investigation |
| [Final cleanup record](codex-search-cleanup-20261023.md) | Exact deletion set, approval batches, final absence/preservation checks |
| [Archived canary runbook](codex-search-canary.md), [operator handoff](codex-search-canary-handoff.md), [permission/cleanup plan](codex-search-canary-cleanup.md) | Historical stage snapshots; no replay authority |
| `.artifacts/fakeco-codex-search-20261022/` | Retained metadata-only experiment and cleanup receipts; ignored local evidence, unavailable in a clean checkout |

Earlier scoped reviews remain linked in the qualification assessment. The latest
teardown change passed 55 focused tests and scoped autoreview through P2; outputs:
`~/.codex/review-results/fakeco-teardown-20261023-final/`. Those checks are not a
substitute for the full candidate validation and branch review recorded here.
