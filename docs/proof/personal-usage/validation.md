# Personal usage candidate verification

Review base: **6fceb88d4d165ba66281c931b74c3047772a2ef5**. This focused follow-up descends from **af23e0bb9f55810bb85a3ca7cc8777ae5f0b278a**. The final head is supplied by the committed bundle receipt, not guessed here. No package/lock/provider snapshot or production Worker/accounting changes in this follow-up.

## Current local results

Linux x64, Node v26.12.1, locked dependencies. Inherited network/proxy policy is unchanged.

| Gate | Result |
|---|---|
| pnpm worker:check (TypeScript + Worker tests) | **2,840 passed**, zero failed/skipped |
| Admin TypeScript and production build | passed |
| Admin unit tests | **268 passed**, including 22 hook tests |
| Focused real-cursor browser cases | **4 passed**, desktop/mobile |
| Complete Chromium browser suite | **484 passed**, desktop/mobile, no snapshot updates |
| Full native upgrade/cost proof script | completed with 600 actual baseline proxy/accounting events, two original candidate preservation calls and two critical cost-path calls |
| Latest focused native upgrade test | passed; real guard/partial/report/export assertions included |
| Broader serial script/workerd suite | **960 passed, 4 failed, 20 skipped**; not claimed green; see exceptions below |
| Local HTTP Worker smoke | passed |
| Content cleanup smoke, run separately | passed |
| External WebSocket smoke | non-green external-abort assertion; same assertion reproduces on pristine af23 |
| Whitespace/source-proof identities | checked before commit/bundle |

## Cursor P2: red/green and real behavior

The frozen af23 hook failed six added unit assertions, including expired-cache pagination and five scope transitions. The fixed hook passes all 268 admin tests. Its pagination state owns resolved anchor, cursor and previous-page stack together. Accepted changed bounds retire both coordinates before publication; a render-time anchor gate prevents a transient old cursor/new range combination independently of React batching. Same-anchor cached/custom reentry preserves valid pages; explicit Refresh resets pages without moving pinned custom bounds. Retired event reads cannot provide a Next-page cursor.

The browser fixture uses shipped personalUsage, actual range/cursor parsing/binding and real SQLite reporting/events queries. Only session authority, synthetic stored metadata and Durable Object transport are adapters. It creates 42 calls, reaches page two via real controls, leaves for Catalog, expires the 15-second cache and returns. Tests assert page one, disabled Previous, no invalid request, and report/event failure plus Retry recovery. Same-anchor cached navigation and expired pinned custom-range navigation are also covered. It is not an opaque cursor echo.

The ordinary Node HTTP URL-readiness probe failed before any browser test executed: Host/request authority mismatch for 127.0.0.1:4317 versus the inherited proxy's authority. Installed Playwright1.64.1 documents webServer.wait.stdout. A temporary configuration imported the original projects/baseURL/viewports/timezone/snapshots/assertions and used Vite stdout readiness, then actual Chromium navigation. All proxy environment/policy remained intact; no bypass list or security guard was disabled. Focused four and full484 cases passed with this launcher. A redundant launcher experiment was cancelled and is not counted as acceptance evidence. See cursor-browser-launcher.md for the reproducible options.

## Native critical cost-path proof

See authenticated-upgrade.json and test/helpers/personal-usage-cost-runtime.mjs. This extends the persisted baseline proof beyond fixed tariff. Actual shipped entrypoint, proxy-key admission, authority, transforms, guard, accounting, USAGE_QUEUE producer, unchanged handler.queue consumer, SQL ingestion, authenticated report/events and shipped CSV exporters run. Setup/state inspection, fixture clock and synthetic provider wire are adapters, not stubs for those operations.

- Unsupported Anthropic served priority tier: real client HTTP502, retained reservation/debit **7,775 micros**, explicit known component null, UNKNOWN detail amount null, recorded charge preserved, CSV monetary reporting fields blank.
- Soft hosted search: real HTTP200, stock observer marks hosted completeness false and fee null, measured token component/debit **56 micros**, PARTIAL amount56 and CSV USD0.000056.
- Both persist through same-candidate restart. Reads preserve receipt digests, projection counts, settings and budget debit. UNKNOWN summary zero is only the existing additive sentinel, not a price.
- Original fixed-tariff upgrade still preserves 600 original events, 300 owned calls before/immediately after upgrade and zero historical projection writes from reads. One new owned call yields301 and adds exactly17 micros: 5,100 ->5,117. Missing historical reasoning stays unreported; only the new owned call adds ten reasoning tokens. Other-owner exclusion and revocation remain asserted.
- All37 listed source SHA-256 identities are verified against the final files. Redacted outputs exclude raw headers, provider responses, credentials, prompts and completions. This is shipped local-session KV/authority evidence, not Cloudflare JWT acceptance, live production or real provider billing.

## Broader non-green checks and controls

The broad script suite is **not** represented as all passing. Four failed records include two deploy-cli WebSocket lifecycle cases and the parent/subcase for JSON refresh HTTP300 without Location reporting Body-already-read. The serial run was repeated, with the same failures. Exact clean-af23 controls under inherited routing reproduce the deploy-cli failures and the external WebSocket cancel-stream abort failure; the full af23 script comparison also returns **960 passed, 4 failed, 20 skipped**, with the same four failed records. See validation-comparison.json for exact inputs/counters. This bounds introduction claims; it does not diagnose a universal cause or waive those checks.

The credential-redirect file also has an isolated 76/76 passing run. A temporary old-helper control and current helper isolated controls were used to avoid guessing about the additive fixture binding option; observed variability is retained rather than widening assertions or changing production redirect/cancellation code. The fixture extension remains minimal: explicit synthetic environment binding overrides. No proxy values/bypass lists were changed to manufacture green. HTTP and content-cleanup checks passed independently; the chained worker:e2e command stops at its non-green WebSocket stage.

These are named remaining validation limitations for review/CI on its authorized runtime. They are not approval to publish, merge, deploy or alter unrelated production paths. All affected cursor and native-cost acceptance tests pass.

## Historical evidence, scope and review gate

The large-corpus performance samples/screenshots remain labeled **af23** with their original source/asset identities, not falsely relabeled as a fresh benchmark of the pagination fix. The disclosed 30-day read-through overhead remains for usability review. The current native proof is refreshed separately with its own source identities. Earlier mock-producer JSON/SSE regressions and read-only dry-run preview are retained as additional evidence, not substitutes for the new shipped-entrypoint proof.

The coordinator relayed the complete/non-passing af23 pinned review, actual model receipt **internal/medium** despite requested Sol, and source artifact path; this Team session has not independently read that Studio artifact. See review-af23e0b-receipt.json and review-af23e0b-remediation.md. Prior P2s were reported fixed/security clear; the new cursor P2 and evidence gap are addressed here. Full pinned re-review of the new head is pending and is not replaced by ordinary AutoReview.

Hannes already authorized the plan/PR and delegated default choices; seven/thirty-day selection is not a new owner-approval blocker. Maintainers review product-contract adoption in the PR; no merge approval is implied. Publication remains held through the existing Team path. **No production traffic/credentials/data read, production preview/backfill, deployment or budget migration was performed.** Explicit projection apply occurs only in local synthetic proof. Ignored caches, temporary launchers, captures and diagnostic logs are excluded from the candidate. No administrator or new screenshot baselines were churned.
