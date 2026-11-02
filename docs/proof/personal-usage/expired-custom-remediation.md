# Fully expired custom range follow-up

The coordinator reports the full pinned base6fceb88..bbf9bbd review complete, checkout verified, actual model **internal**, and no security or maintainer-decision blocker. The pagination repair was accepted. One late P2 remained: a valid historical custom request can resolve to an empty retained interval. Studio artifact: /Users/hrudolph/Data/clawsweeper-local-reviews/clawrouter-dashboard-20261102-bbf9bbd/full-review/0.md. This Team session has not independently read that artifact.

## Focused repair

Custom controls now retain the original requested from/to/timezone. They are not replaced by the server's clamped bounds. Grouping/filter changes, refresh and report Retry therefore continue sending the original usable custom interval. Rolling controls keep their existing server-time anchor behavior.

Events independently use server-confirmed resolved bounds. If from===to, the hook produces a local empty page with nextCursor null and copies the report's history/projection metadata. It sends no invalid equal-bound events request. Existing anchor retirement still clears cursor and previous-page history when scope/range changes. A current valid interval with no calls still performs the normal valid events read.

Affected verification: **29/29 hook tests,275/275 admin unit tests, TypeScript check/build passed;16/16 focused browser tests** across desktop/mobile and UTC/America-Los_Angeles. Fully/partially expired and valid empty ranges, grouping/filter changes, report/event Retry and refresh are covered with shipped parser/SQL/cursor behavior. The focused UI autoreview was scoped-clean P0-P2. Initial browser locator timeouts were corrected to use the accessible Group-by combobox; assertions were not weakened. Existing accepted full Worker/browser checks were not repeated.

## Small shipped-route runtime trace

Run npm --prefix admin run build, then node scripts/prove-personal-usage-navigation.mjs. This reuses the existing local workerd proof router/upstream and the existing browser. Only two exports expose that existing fixture; no production Worker code or new infrastructure was added. The prior authenticated cost proof is refreshed only to keep its source-hash identity accurate after those exports.

navigation-runtime.json records the actual browser flow: thirty real synthetic proxy calls seed actual ingestion; page one/page two; Catalog; browser cache clock +16,001ms while Worker clock stays live; My usage; Retry. Each browser API request is relayed into the actual shipped Worker entrypoint/local-session authorization/report/events routes. Successful DTO bodies are received from those routes, not handcrafted or returned by a parser-only fixture.

One explicitly labeled synthetic **delivery503 is injected AFTER the shipped events route returned200**, solely to exercise Retry. The artifact records nativeStatus and deliveredStatus separately. It does not pretend the shipped route produced503. Retry uses the same new bounds without the old cursor, returns200, and displays page one with Previous disabled. An old-range/old-cursor reentry read may occur and is valid; no new-range/old-cursor read or native400 occurs.

The same small trace also sends the actual fully expired UTC request2026-10-01..10-02. Native report/grouping/refresh return200 with equal resolved bounds; controls retain the original dates and the browser sends no events HTTP for that empty interval. Source and built-asset hashes bind this run. Synthetic local session/provider wire only; no Cloudflare JWT acceptance, production traffic, real credentials or billing proof is claimed.

## Original-base control limitation

The coordinator correctly distinguished prior af23 controls from original main. Bounded controls now use immutable original6fceb88 with identical Node/dependency/proxy settings. Results are retained outside the control target and rendered in the coordinator conversation, without a separate evidence commit or broad-suite rerun. Both script files report78tests/76pass/2fail on original6f and frozenbbf: the two CLI WebSocket lifecycle failures. Original6f also reproduces the external cancel-stream abort failure.

The JSON HTTP300/no-Location Body-already-read case does not reproduce in either bounded original6f or frozenbbf replay. Additional selected-case discovery context was also checked on original6f without reproducing it. It remains context-dependent/unclassified. The earlier af23 comparison does **not** prove all four broad-suite failed records are original-main failures. No full-PR baseline waiver or publication clearance is inferred for that JSON case.

No unrelated production redirect/cancellation changes, changed thresholds or network bypass changes were made. Full exact-head pinned re-review remains required before publication through the existing Team path; no merge or deployment approval is implied.
