# Tencent TokenPlan: frozen product, current endpoint

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/tencent/openclaw.plugin.json`, `index.ts` and `models.ts`.
Primary contracts checked 2026-11-03.

| Router ID | Dedicated server binding | Selected upstream base |
| --- | --- | --- |
| `tencent-tokenplan` | `TOKENPLAN_API_KEY` | `https://tokenhub.tencentmaas.com/plan/v3` |

The [current primary quickstart](https://cloud.tencent.com/document/product/1823/130119)
specifies this plan host, `/chat/completions` and Bearer authentication. The
frozen OpenClaw source instead uses
`https://api.lkeap.cloud.tencent.com/plan/v3`. This new declaration deliberately
selects the current documented endpoint. It does not assert that the old host
is retired, equivalent or a valid redirect target. The old host is not an
automatic fallback, and no credential is sent there by this route.

Native requests use `/v1/native/tencent-tokenplan/chat/completions` with the
original model name. Manifest requests use
`/v1/proxy/tencent-tokenplan/chat_completions` with a
`tencent-tokenplan/` model prefix. Policies and provider-scoped grants select
the plan explicitly. `TOKENHUB_API_KEY` and generic Tencent keys are never
borrowed; a denied or exhausted plan does not retry pay-as-you-go `/v1`.

## Account and finite model contract

The [current plan inventory](https://cloud.tencent.com/document/product/1823/130060)
lists both frozen IDs: `hy3` and `hy4-preview`. Preserve them exactly. The
upstream's legacy `hy3-preview` alias is not one of these two frozen plan cards
and is not added. No newer generation is imported.

General and Hy personal plans share one account's plan key; they are not
independent credentials. The selected model and upstream account determine
the applicable entitlement. A policy must restrict models to that account's
approved inventory. `hy3` requires Hy plan access; `hy4-preview` appears in
both plan lists. Do not share a subscriber's key across users. Personal plans
are documented for supported interactive AI tools, including OpenClaw, rather
than arbitrary application backends or noninteractive bulk API workloads.
Configure a named subscriber and permitted consumer before live activation;
the router does not infer eligibility from the documented `sk-tp-` key prefix.

Plan subscription fees and quota points are not per-token API prices. Both
cards and opaque model passthrough remain unpriced. Hard-budget admission
requires an explicit fixed policy request charge; it does not estimate an
upstream invoice or remaining plan quota. No account, subscription or
credential is created or changed by this implementation.

## Native wire and proof boundaries

The [Hy API contract](https://cloud.tencent.com/document/product/1823/132252)
requires preserving assistant reasoning and tool-call replay. The transport
passes those fields and the requested `reasoning_effort` unchanged. Frozen
OpenClaw's `hy3` effort normalization remains a client responsibility; it is
not silently applied to native requests or other models. JSON and fragmented
SSE fixtures preserve the wire and terminal token observations. Missing usage
and disconnects remain unknown rather than zero-token success.

Seventeen real Worker/SQLite fixtures compile the source manifest and exercise
native/manifest transport, both frozen identities, grant/product isolation,
policy admission, one fixed reservation/settlement, errors and cancellation.
Snapshot activation needs an explicit serialized slot and final-head CI.
Actual OpenClaw client and live account qualification remain separate.

Messages and Responses use distinct native contracts and remain separate
continuations. Frozen plan discovery requests `<plan-base>/models`; current
primary plan documentation does not qualify that endpoint here. Never borrow
the pay-as-you-go model list to claim subscription entitlement. No live call,
login, provisioning, commercial-account change or deployment is performed.
