# Paired retrieval experiment

Status: reviewed through P2; read-only preflight passed. Deployment and paid calls
await approval under the user's standing Cloudflare-write boundary.
No PR or push. Upstream billing stays unqualified.

## Proposed approved batch

One temporary observation deployment, at most two direct search POSTs, owned
session cleanup, then verified normal restoration. No inference, router policy/key
or budget changes, new namespace, secret change, security relaxation or campaign
teardown. Use the same `gpt-6.1-sol` model and experimental
`https://api.openai.com/v1/alpha/search` endpoint as the previous probes.

1. Refresh read-only preflight and require the prepared inventory less than ten
   minutes old with unchanged normal fixture/infrastructure. Verify IANA public
   HTTP content, non-creating diagnostic auth check, private/public absence,
   robots baselines, Access challenge and BIC. No provider call or OpenAI key read.
2. Deploy reviewed observation source `d3af38c` with the existing namespace/digest,
   temporary `/robots.txt*` route and main-Worker service binding. Record actual
   version and both route IDs immediately; retain independently available IDs if
   another inventory read fails. Require three consecutive compatible Worker and
   object readiness responses five seconds apart, bounded to 120 seconds/25 checks.
   Require marked observation collection absence and diagnostic absence.
3. Read the exact existing OpenAI key into memory and make one live-mode standalone
   open of `https://www.iana.org/help/example-domains`. Require HTTP 200, nonempty
   tool output without known tool/navigation errors, expected page title,
   `example.com` and RFC 2606. Failure/timeout stops paid traffic; create no FakeCo
   sessions. IANA content can be cached: this does not qualify a fresh IANA fetch.
4. Only after IANA passes, create one fresh five-minute observation session and
   one fresh five-minute diagnostic generation. Journal each owned ID on 201
   before helper validation. Initial private counters must be zero. Require enough
   TTL for the 90-second provider timeout and 15-second late window.
5. Make one live-mode standalone open of the stable FakeCo diagnostic URL. Keep
   its new marker out of the provider request. No operator public FakeCo request
   or inventory helper that fetches public health while observation may be active.
   Capture private snapshots immediately after response/failure and after 15
   seconds; no provider retry or reference follow-up.
6. Qualify fresh FakeCo retrieval only if tool output succeeds and contains the
   exact new marker, with at least one successful diagnostic origin GET and
   agreeing independent diagnostic/observation GET totals. HEAD alone, marker
   alone, GET alone, mismatched counters, overflow/saturation, tool errors or
   uncertain handler identity do not qualify. Zero counts remain inconclusive.
7. In `finally`, attempt each owned session DELETE once, then verify owned-ID and
   collection absence while the compatible observer is deployed. Verify public
   diagnostic absence only after private cleared-state checks. No collection
   DELETE, unowned deletion, mutation replay or TTL extension.
8. After qualified cleanup and fresh ownership/infrastructure checks, remove only
   the added robots route and redeploy normal config. Verify original normal code
   bytes, exactly three bindings, temporary service/route absent, preserved
   namespace/main/unrelated resources, robots baselines, Access and BIC. Record
   the new normal version/prefix route IDs. Uncertainty stops restoration for
   read-only reconciliation; retain the receipt/resource custody.

## Pins and preparation artifacts

| Resource | Required baseline |
| --- | --- |
| Account | OpenClaw `91b59577e757131d68d55a471fe32aca` |
| Zone | `openclaw.ai`, `72b20df9e990ac41365dadace6499187` |
| Fixture Worker | `clawrouter-search-semantics-fakeco` |
| Normal version | `f5e2791a-196f-4a8a-a990-590c9bd12891` |
| Prefix route | `e636ada557fd4550a4abb64edd03e3df` |
| Prefix pattern | `https://clawrouter-fakeco.openclaw.ai/search-semantics/*` |
| SQLite namespace/class | `148cbb6483b4421dbf8b25301a325865`, `SearchSemanticsObject` |
| Main Worker/version | `clawrouter-edge-fakeco`, `3d669069-fb9e-45e0-a71b-bded66c5b7b2` |
| Reviewed runtime | `d3af38ce0f182cd293571b0defbaa3c1237d7fc2` |
| Instrumentation calibration | `request-observation-stability-calibration-receipt.json`, passed |

Campaign artifact directory: `.artifacts/fakeco-codex-search-20261022/`.
New operator: `run-paired-retrieval.mjs`, with explicit `--preflight-only` and
`--deploy-approved` modes. New test: `paired-retrieval-runner.test.mjs`.
Shared reviewed inventory/Cloudflare helpers remain unchanged. Operator execution
uses an exclusive `paired-retrieval-receipt.json`; never replay it. Historical
calibration runners/receipts must not be reused for this new batch.

Credential metadata confirmed populated fields in Agent Secrets: existing
Cloudflare token, FakeCo canary `ADMIN_TOKEN`, and OpenAI `OPENAI_API_KEY`. No
`ACCESS_INSTRUCTIONS` field was present on those selected items. Execution must
recheck item instructions before targeted reads. Preflight reads only the scoped
Cloudflare token and derived fixture control credential. No credential value,
raw request/output, hidden marker, provider error body or diagnostic HTML is
written to receipts or logs. Save fixed booleans/counts, validated observation
categories, session IDs/expiry, and qualified resource metadata only.

## Qualification limits

The [official web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
describes live/cache controls for Responses web search. The fetched guide and
official search did not establish an `/v1/alpha/search` contract or its charges;
this experiment preserves the previously observed request shape and tests it
empirically. Published hosted-search prices are not used to qualify its billing.

A passing pair establishes one observed fresh FakeCo retrieval under the tested
endpoint/key/model/settings/time. It does not qualify cache-only mode, refresh,
click/find behavior, all models, global propagation or upstream charges. A failed
IANA control stops after one paid attempt. IANA success plus FakeCo failure
isolates a narrower failure but does not establish its cause. The larger cached/
live semantics matrix stays gated on a successful fresh FakeCo control.

## Local verification

Thirteen offline VM scenarios exercise the actual operator and fixture/probe
helpers with simulated network/deployment: read-only isolation, successful pair,
IANA failures, HEAD/marker/GET mismatches, tool/transport/non-JSON failures, late
arrival, readiness reset/deadline, ambiguous creation/deletion/restoration,
partial inventory, source/hash changes and exclusive-receipt replay refusal.
All pass. Five focused standalone-probe tests also pass. No Worker/admin/provider
source changes in this preparation; the previously calibrated runtime is pinned.


## Review and read-only preflight result

Frozen operator commit `0f45b1f259e217aa803d92a2082c29b083ca1214` reviewed scoped-clean through
P2. Status: `/Users/joshavant/.codex/review-results/paired-retrieval-20261023/status.json`. Actual ignored source/test bytes match the frozen
commit and hash manifest `paired-retrieval-runner-review.json`. No runtime change.

Read-only preflight passed 2026-10-23T07:54:45.783Z. Normal version/prefix route above
match the previous successful calibration's restoration snapshot. Exactly three
normal bindings; temporary robots route/service absent. Namespace, main Worker,
runtime/base settings, unrelated routes/domains/namespaces, Access and BIC match
baseline. Private/public absence, non-creating auth check (400), four robots
baselines and dashboard Access challenge verified. IANA public HTTP returned 200
with all three expected content checks true. Browser rules were not refreshed;
no denied-endpoint retry or authentication fallback.

Preparation receipt: `paired-retrieval-preparation-receipt.json`. Fresh inventory:
`paired-retrieval-preflight.json`, with a separate timestamped copy. No Cloudflare
management writes, session creations/DELETEs or paid search calls. Runner did not
read the OpenAI key; item metadata confirms the selected field is populated,
not current provider entitlement. Execution receipt remains absent. Deployment
and paid-search approvals remain null. No PR or push.

Approval request: one batch containing steps 1–8 above, with at most two direct
Sol search calls, IANA first and FakeCo conditional on IANA success. Source and
operator hashes must still match; refresh preflight again if older than ten
minutes. Other resources and the larger semantics matrix remain outside scope.
