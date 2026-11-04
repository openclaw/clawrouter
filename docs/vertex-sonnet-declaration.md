# Vertex Sonnet Messages declaration

`anthropic-vertex` declares one model, `anthropic-vertex/claude-sonnet-4-6`,
with the exact upstream identity `claude-sonnet-4-6`. The Google
[Sonnet 4.6 model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-4-6),
observed on 2026-11-04, supplies the numeric input limit of 1,000,000 tokens
and output limit of 128,000 tokens. These support facts do not establish
account access, quota or billing.

The numeric support facts appear in `/v1/catalog` model metadata. Legacy
`/v1/models` tariff-derived limit fields remain null; clients must not replace
them with inferred price cards or default limits.

The `messages` endpoint uses paired `anthropic.messages` formats and JSON or
SSE responses. Its operation is `llm.chat`; `llm.messages` exposes the same
endpoint to Messages clients. The native caller route is
`POST /v1/native/anthropic-vertex/v1/messages`; the manifest route is
`POST /v1/proxy/anthropic-vertex/messages` with the native request inside `body`.
Neither route accepts caller path, query, resource or authentication overrides.
There is no model passthrough, date alias or separate direct-Anthropic route.

The declared Google base is `https://aiplatform.googleapis.com`. The existing
[owner-bound runtime](vertex-preprovisioned-runtime.md) selects the actual
project, location and credential. Its model/location predicate admits this
exact upstream ID only at `global`, `us-east5`, `europe-west1` or
`asia-southeast1`, then revalidates the original owner before dispatch.
The declaration supplies no project or location and cannot grant access to
any of them. Existing [owner JWT refresh](vertex-owner-jwt-refresh.md) remains
separate from these model facts. ADC, environment credentials, direct Anthropic
keys and caller metadata are not substitutes for original owner authority.

Messages pricing is explicitly null. The omitted model tariff compiles to
null as well. No direct Anthropic, global or regional tariff is borrowed;
cache TTL and endpoint geography remain unqualified economic inputs. Hard
upstream-dollar budgets stay closed. An explicitly configured `policy_fixed`
charge is a policy charge, not a Vertex invoice estimate. Native token usage
does not turn an unknown tariff into zero cost.

The declaration tests compile this YAML into the real Worker fixture and
exercise native and manifest JSON/SSE selection, catalog facts, original
owner qualification and unknown-dollar denial. Source handoff does not
include the generated snapshot or establish registered-client execution.
Serialized snapshot qualification and the actual proxy-key Anthropic Messages
consumer remain required before campaign activation.

## Composed qualification

The declaration is integrated with its generated snapshot. The focused suite
covers all four owner locations through native and manifest JSON/SSE, and a real
workerd/SQLite check verifies native and manifest JSON delivery, original owner
credentials, a separate fixed policy charge and zero-egress unknown-price denial.

The pinned OpenClaw source is
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. Eleven actual registered Messages
consumer cases are authored for both stream entrypoints, location binding, tool
replay and output, thinking/prefill, late errors, cancellation and revocation.
Their hosted execution is required; authored cases are not completed proof.

This client pin selects the native Messages route. Manifest LLM selection and
dispatch remain an internal client dependency; Worker manifest tests do not
certify that client path. The old client's cost projection also does not qualify
unknown server prices. No deployed, live-account or vendor-invoice parity is
claimed by deterministic fixtures.

The smoke planner records a non-executable target requiring an original private
owner grant and a qualified policy. Environment tokens and ADC cannot satisfy it;
selection returns an explicit unresolved failure with no network request or
successful health report.
