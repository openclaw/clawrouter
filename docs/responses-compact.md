# Public OpenAI unary compaction

ClawRouter routes the public OpenAI `POST /v1/responses/compact` API. This is
provider-native compaction, not text summarization. The response is the upstream
JSON document unchanged, including retained messages, opaque compaction items,
extra fields, and canonical output ordering. Consumers must retain the entire
`output` window; do not select only its compaction item or prune retained messages.

## Routes and request

- Unified: `POST /v1/responses/compact`, model `openai/gpt-6-astra` or
  `openai/gpt-6.1-sol`.
- Native: `POST /v1/native/openai/v1/responses/compact`, the corresponding native
  model slug (`gpt-6-astra` or `gpt-6.1-sol`).
- Manifest: `POST /v1/proxy/openai/responses_compact`, with the existing
  `{ "body": { ... } }` envelope and registered, namespaced model.

These models are an intentionally narrow initial slice, not a claim that every
model accepted by the upstream reference is qualified here. The dedicated wire
format and capability are `openai.responses_compact` and `llm.responses.compact`.
An unregistered model cannot use ordinary Responses model passthrough for compact.

The JSON body requires a canonical registered `model` and either `input` (string
or array) or an owned `previous_response_id`. `instructions`, cache options,
`service_tier`, and provider extras are forwarded unchanged except for the existing
model namespace transformation and public API default-tier pin: omitted or auto
tiers become default after authorization, never the project's possibly paid tier.
Existing 8 MiB JSON admission applies.
Query options are not supported. A streaming request receives
`400 unsupported_compact_stream` before upstream dispatch; there is no fabricated
SSE implementation. Background jobs are likewise explicitly unsupported.

Compact has no caller output-token-limit contract. Fields resembling chat or
ordinary Responses output limits never reduce its reservation. They are not
translated into a new compact limit; upstream validation still applies.

## Authentication, account routing, and continuity

Existing proxy-key/Access policy, model restrictions, service-tier grants,
provider access, and upstream credential selection apply before dispatch.
Subscription/Codex transports do not support this public endpoint.

Until durable opaque-account witnesses are available, compact is restricted to a
single resolvable public API account: either environment authorization with no
configured scoped grants, or one API-key grant without environment fallback.
Multiple pool members remain unqualified even if one is temporarily unavailable.
An inactive detached grant cannot route; activating another account causes the
next compact request to fail closed. Detached disabled default-key metadata does
not add a routable account. Qualification refreshes authoritative membership after
projection/attachment reads, and again after budget/retention awaits immediately
before egress. A topology change caught there releases the known-unsent reservation
once. This is a current authority decision, not a lease that prevents later
operator changes. Missing pool projections are not evidence that an account
disappeared. Unqualified routing receives
`409 compact_account_unqualified` (or the existing upstream-grant-unavailable
error when no compatible transport can be selected).

`previous_response_id` resolves in the existing caller/tenant/policy credential
scope. It uses the ordinary Responses creation owner's exact grant, credential
lineage, route, organization/project headers, and policy generation. Missing,
expired, foreign, or changed ownership returns `409 continuation_restart_required`
before a new reservation or egress. A compact result is not registered as an
ordinary Responses ID and is not a new token-only ancestry attestation.

This restriction does not prove where arbitrary user-supplied ciphertext was
created. Opaque full-window affinity, cross-account reuse, repeat compaction under
hard budgets, threshold accounting, and remote Codex v2 remain separate work.
There is no multi-account continuity or full compaction-parity claim here.

## Admission and accounting

The existing budget contracts are retained:

- Reserve mode with a monetary limit requires token-priced, known tool ancestry.
  Tagged input declarations, saved prompt references, hosted tools, and inherited
  parent tool evidence are checked for the distinct compact format. Unknown or
  opaque ancestry cannot become token-only evidence merely because the format
  changed. Missing/unknown/pending parent proof or unwitnessed compaction,
  encrypted reasoning, or item references fail with `400 pricing_required`.
- Input reservation is UTF-8 bytes plus overhead bounded by the manifest window,
  or the full authoritative window for retained/opaque input. No ciphertext-size
  discount is introduced. Output always reserves the model's manifest maximum.
- Soft budgets preserve existing observed-charge semantics. Unmetered routes
  preserve existing reporting semantics; an unpriced ancestry gap remains
  `unpriced_usage` with zero unmetered charge, not a token-only attestation.
- Operator-configured fixed request tariffs remain fixed, including opaque input.
  They do not claim a measured token-price envelope.

For a complete successful `response.compaction`, settlement uses actual
compaction-pass usage and the **served** service tier. Nonnegative safe-integer
input/output/total counters, cache details, reasoning details, and internally
consistent totals are required. Missing, corrupt, inconsistent, truncated, or
wrong-format usage cannot discount a dispatched reserve-mode reservation. A
missing or unknown served tier also retains the reservation under tiered pricing;
the requested tier is never invented as an authoritative response fact.

Delivery observes bounded scalar usage while forwarding the same response bytes.
Large retained windows do not require building an output array in the Worker.
Cancellation, deadlines, transport errors, and provider rejections use existing
HTTP/accounting ownership: exactly one event and one settlement per ledger leg.
A dispatched unknown-outcome failure retains its reservation; an authoritative
HTTP rejection releases it. Existing HTTP transport errors remain HTTP 502, with
caller cancellation versus timeout distinguished in usage status.

## Sources and validation

Primary contracts checked October 20, 2026:

- OpenAI compact reference:
  https://developers.openai.com/api/reference/resources/responses/methods/compact
- OpenAI compaction guide:
  https://developers.openai.com/api/docs/guides/compaction

`worker/test/responses-compact.test.mjs` exercises actual Worker `handler.fetch`,
HTTP request/response objects, SQLite budget ledgers, continuation ownership,
credential authority, and scripted upstream behavior. Compiler/schema rejection
coverage lives in `test/responses-compact-manifest.test.mjs`. No live provider
credential, prompt, deployment, or production state is required for these tests.
