# Codex CLI search rollout candidate

Local branch: `feat/codex-standalone-search`. No PR, push, staging change, or
production deployment. Desktop and non-Lite models remain outside this campaign.
Qualified CLI/model/transport scope: [Codex setup](codex.md#opt-in-to-built-in-cli-web-search).

The local Wrangler packaging dry run passed, including manifest compilation and
the admin production build. It exposed two shared-pricing imports whose `.ts`
suffixes failed the admin compiler; those now follow the existing extensionless
admin import convention. The compiler check and all 229 admin tests then passed.
This local bundle does not verify remote bindings or authorize a deployment.
Wrangler emitted a conditional `node:string_decoder` dependency warning. A
separate workerd fixture loaded the actual packaged bundle under the existing
compatibility flags, parsed synthetic JSON, and settled its expected 600 microUSD
token charge. The dependency's TextDecoder fallback worked in that check.

## Retrieval investigation — October 22, 2026

Ten direct public-API requests with `gpt-6.1-sol`, bypassing both ClawRouter and
model inference, produced the following results. All returned HTTP 200:

| Operation | Cached (`false`) | Live (`true`) |
| --- | --- | --- |
| Search query | Text and references | Text and references |
| Open returned reference | Text, no selected tool error | Text, no selected tool error |
| Open `https://openai.com/` | Text, no selected tool error | Text, no selected tool error |
| Open unique synthetic content on established `httpbingo.org` | `Internal Error`, marker absent | `Internal Error`, marker absent |
| Open ready controlled tunnel URL | `Internal Error`, marker absent, zero page/robots requests | `Internal Error`, marker absent, zero page/robots requests |

The stable service's separate readiness URL returned the expected content.
Neither unique synthetic test URL was primed locally. Its content is generated
by the documented [base64 endpoint](https://httpbingo.org/); no inference model
was involved in this direct test. The controlled tunnel had independently
passed DNS/TLS/HTTP readiness. Unique paths differed between modes.

A separate native Codex CLI 0.163.0 session with live search/WebSocket inference
then opened another fresh controlled URL. Replaying its exact forwarded body
and headers directly against OpenAI, and replaying a reduced body containing
only `id`, `model`, `commands`, and `settings`, both returned the same tool-level
`Internal Error`. Neither replay reached the page or returned its hidden marker.
The exact replay retained its original session ID; it tests forwarding, not an
independent fresh session. The ten-request direct matrix used fresh mode sessions.

Representative upstream request IDs for a provider investigation:

- Direct live known URL success: `req_34a71a4981b5416594b2ce9a6c7fa95a`.
- Direct live stable synthetic failure: `req_c3c33d483471457ba299cfd8b4113202`.
- Direct live controlled-origin failure: `req_f57f0406129d4ec9955045e0c774a6b3`.
- Exact native-payload direct replay failure: `req_ebd08a5954ab419293b2b219dee0ed8b`.
- Reduced-payload replay failure: `req_b2f8214422764f9b85f840b6f5d41cf3`.

This reproduces the failure upstream without router forwarding. It does not
distinguish an upstream bug from account restrictions or URL/fetch policy.
Fresh-origin retrieval and strict cache-only behavior remain unqualified.
No provider report has been sent.

Reproduce with the already-authorized credential injected through 1Password:

```sh
CLAWROUTER_SEARCH_LIVE=1 node scripts/probe-codex-search.mjs --model gpt-6.1-sol
CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs \
  --model gpt-6.1-sol --web-search live --transport websocket \
  --origin-only --direct-replay
```

The first command makes ten standalone requests, no inference. The second shares
the harness's 32-operation ceiling, including its two direct replays. It exits
nonzero if native origin retrieval is not qualified. Both log metadata only;
keys, native bodies, ciphertext, and provider content stay in memory. Tunnels
and temporary native homes are removed at completion.

## Billing qualification

No `usage` object appeared in the ten direct search responses or two replays.
Successful requests return text and encrypted output, which are not a usage meter.
The [published pricing page](https://developers.openai.com/api/docs/pricing#tools)
lists hosted web-search tool charges and search-content tokens; it does not
explicitly establish a standalone `/v1/alpha/search` tariff. The
[hosted-tool guide](https://developers.openai.com/api/docs/guides/tools-web-search)
documents Responses search. Do not transfer that price or its cache-only contract
to this standalone endpoint without confirmation. The
[Codex guide](https://learn.chatgpt.com/docs/web-search#search-with-a-custom-model-provider)
describes standalone search as under development.

The policy tariff is an explicit router charge **per standalone HTTP request**,
including open/click/find and multi-command requests. It is not per query or an
upstream invoice estimate. An HTTP-200 tool error still incurs that router tariff.
Inference retains model token pricing. In-flight settlement freezes the tariff
used at admission, even if a policy map changes while upstream is running.

Before choosing a production tariff, obtain provider confirmation of endpoint
availability, charging unit, navigation/multi-command/failure charges, content
token treatment, and an authoritative usage/cost source. Alternatively, compare
an isolated project/time-window sample against authorized billing records, with
control traffic and a documented attribution delay. An ordinary inference API key
does not establish billing-record access; no administrative credential was sought
and no organization-wide billing query was made for this campaign.

The documented administrative [web-search usage endpoint](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/web_search_calls)
supports API-key/project/time filters and exposes request counts. The
[costs endpoint](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)
supports key/project filters and line-item grouping, but uses daily buckets.
These are candidate reconciliation sources, not evidence that standalone calls
appear there. A billing export or an explicitly authorized admin read path is
still needed; a zero/missing bucket alone would not prove the endpoint is free.

## Regression and staging plan

The deterministic workerd regression covers interleaved WS inference and HTTP
search, a model switch/reconnect carrying a synthetic compaction summary, original
reference reuse, unchanged search wire output, fixed search vs token inference
charges, both durable SQL budget ledgers, and denial before dispatch at the cap.
It does not run Codex's automatic compaction algorithm. Native automatic
compaction is checked separately by the opt-in harness using completed rollout
records and a subsequent original-reference open. The native harness also checks
usage receipts and both budget ledgers, excluding direct replay probes from router
accounting.

The October 22 native rerun with stricter HTTP-200 fetch-error checks passed
Sol → Astra with cached search and WebSocket
inference: two completed automatic compactions, original-reference reuse, one
search namespace, and all upstream operations successful. Sixteen usage receipts
agreed with both SQL ledgers: five search requests charged 5,000 microUSD, plus
972,180 microUSD of model-token charges, totaling 977,180 microUSD. Those are
router accounting values, not an upstream invoice. An earlier attempt failed the
strict WebSocket fixture check and did not qualify; it is not included in these
figures. The deterministic regression separately checks known token counts/rates
and exact tariff totals without a paid API dependency.

A three-pass autoreview through P2 covered the branch from its pre-campaign base
through commit `3069f85`, with source context for accounting, continuation state,
WebSocket sessions and setup. It reported one P2 harness finding: normal
navigation could accept HTTP-200 fetch errors. No P0/P1 findings or suspected real
credentials were reported. The finding is fixed: ordinary qualification rejects
known fetch/reference/internal errors, and the live adapter retains a failed check
across a successful retry. Six focused tests passed, including the actual adapter
retry path; the native rerun above passed the stricter output checks. The review
outcome was `findings`, not a clean review of the subsequent fix.

Validation before that focused review correction: 2,568 Worker tests, 229 admin
tests, and 791 passing script tests with 18 skips. The script suite passed when
run independently; running it concurrently with the full Worker suite initially
failed three unrelated cadence/deadline checks. The admin compiler, production
build, Wrangler packaging dry run, and packaged-parser smoke also passed. No
production request-path code changed in this follow-up campaign; the admin import
fix and diagnostic/regression work are local commits.

```sh
node --test test/standalone-search-probe.test.mjs test/standalone-search-workerd.test.mjs
node --test worker/test/standalone-search.test.mjs worker/test/request-pricing.test.mjs
```

For a future authorized canary:

1. Pin the reviewed full commit SHA. Use the locked [FakeCo staging](fakeco.md)
   target and its dedicated credentials/workflow. Verify resource identities with
   `CLAWROUTER_DEPLOY_ENV=fakeco pnpm cf:target`; it requires the scoped account/KV
   inputs and performs reads. The ordinary deployment preflight can write probes;
   do not treat it as a read-only command. No deployment commands run here.
2. Use a dedicated low-budget key, explicit non-null `search.web` tariff, token
   inference pricing, retention off, and one public API account without fallback.
   Keep general rollout pending billing qualification; any limited canary must
   explicitly accept the fresh-origin/cache limitations.
3. Exercise cached/live search, open/click/find, citations, resume, a representative
   model switch, compaction, WS transport without silent fallback, and budget
   denial. Compare usage totals and provider/policy spend; each admitted search
   settles once. Confirm unrelated inference remains token-priced.
4. Watch router status/error codes, `search_restart_required`, settlement failures,
   queue/DLQ health, and synthetic tool-output success. HTTP success alone cannot
   detect the upstream `Internal Error`; do not log user search content to monitor it.
5. Roll back the dedicated canary credential through the authority first, then
   disable client search/remove its managed profile and restore the previous
   reviewed Worker release through the existing workflow if necessary. Treat
   existing search sessions as disposable after owner/policy changes. Reverting
   Worker code does not undo settled spend; never reset budget authority or reuse
   an old key to make the canary look clean.

The actual remote readiness, deployment, monitoring, and rollback drill are future
operations, not claims of this local qualification.
