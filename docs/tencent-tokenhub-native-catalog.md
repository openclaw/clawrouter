# Tencent TokenHub frozen standard Chat contract

Scope: `hy3-preview`, `hy3` and `hy4-preview` from OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/tencent/openclaw.plugin.json`, `models.ts` and
`provider-discovery.ts`. Preserve the existing `deepseek-v4-flash` seed. No
later generation, TokenPlan declaration, media adapter or extra API is added.

## Product, region and credentials

The [primary API contract](https://cloud.tencent.com/document/product/1823/130078)
qualifies mainland `https://tokenhub.tencentmaas.com/v1` with Bearer
`TOKENHUB_API_KEY`. It explicitly prohibits cross-region and cross-site calls.
Singapore's `tokenhub-intl.tencentmaas.com` is a separate service binding;
the documented alternate `.cn` hosts are not automatic retry destinations.
The original selected provider grant stays authoritative. Caller headers and
TokenPlan credentials cannot replace it. No error retries another host, model,
region or product.

The already implemented `tencent-tokenplan` uses its own `TOKENPLAN_API_KEY`
and `/plan/v3` contract. A shared hostname or model slug does not grant access
to standard postpaid inference. The frozen client's legacy Plan host is not a
standard API fallback. This slice does not edit the Plan manifest or tests.

## Finite cards and the postpaid preview alias

The [Hy model guide](https://cloud.tencent.com/document/product/1823/132252)
qualifies text, tools and structured output for `hy3` and `hy4-preview`.
Their finite frozen reasoning menu remains `none|high`. The
[thinking contract](https://cloud.tencent.com/document/product/1823/131208)
qualifies high as the upstream default; the router records that fact without
injecting it. Current Hy3 also accepts low, which maps upstream to high when
tools are present. Native requests preserve low unchanged, without expanding
the frozen advertised menu or performing that mapping locally.

Primary context/output tables use rounded `256k/128k` and `1024k/64k` values.
No exact token ceiling is inferred from them or copied from frozen defaults.
Neither card receives a tariff from the static OpenClaw cost table.

The [dated retirement and migration notice](https://cloud.tencent.com/announce/detail/2391)
provides a more precise product contract than the frozen preview card:
from **2026-08-31 00:00 Beijing time**, standard **postpaid API** calls retaining
`hy3-preview` are automatically served by **Hy3**, and billed under the
replacement model's rules. The frozen `replacedBy: hy4-preview` is not the
qualified replacement for this product. The selected API identity remains
callable under that notice, so it is recorded as `upstream_alias`, not stopped.

The row preserves selected `id: tencent-tokenhub/hy3-preview` and wire
`upstream: hy3-preview`, with `servingModel: hy3`, effective date 2026-08-31,
check date 2026-11-03 and the notice as provenance. It inherits no serving-model
tool facts, input limits, reasoning menu or tariff. A response's native model
field remains untouched; usage events retain the selected model and explicit
`policy_fixed` basis. These deterministic fixtures do not establish the
account's actual serving invoice. The notice is not a TokenPlan contract or a
promise of account eligibility.

## Replay, stream and usage

Preserve native `reasoning_content` throughout tool cycles, including previous
assistant traces, tool-call IDs, arguments and results. The primary guide
requires reasoning history across rounds; it is not interchangeable with a
new plain assistant answer. `thinking.type` and `reasoning_effort` pass through
unchanged. Structured JSON requests retain the selected schema and mode.

SSE fixtures use fragmented content/tool frames and the separately reported
terminal usage frame requested with `stream_options.include_usage`. Native
`prompt_tokens_details.cached_tokens` is a subset of inclusive prompt usage;
`completion_tokens_details.reasoning_tokens` is a subset of output usage.
Neither subset is added again. Missing cache/usage is unknown, explicit zero
is zero, and late failure or cancellation retains conservative settlement.
No inference key, prompt, reasoning trace or answer is copied into receipts.

The [mainland price table](https://cloud.tencent.com/document/product/1823/130055)
uses CNY per million tokens: Hy3 input/output/cache-read 1/4/0.25 and Hy4 preview
6/18/0.3. Singapore and other products have separate tables. No conversion to
USD, cache-write zero, copied frozen price, discount, plan entitlement or
upstream settlement is inferred. The alias notice requires account-specific
replacement billing confirmation; unknown pricing remains unknown.

## Keyed discovery

`GET /v1/models` requires the same original mainland API key; missing or invalid
keys return 401. The native `object: list`, `data` envelope contains model IDs,
model objects, names, creation times and status observations such as `online`
or `pre-offline`. Existing `openai.models` parsing preserves the envelope and
allowed row fields while filtering with the original policy and grant.
No query remapping, pagination invention, unauthenticated fallback or relaxed
decoder is added. An empty list or absent row is not retirement evidence.

## Proof and owner handoffs

`worker/test/tencent-tokenhub-native-runtime.test.mjs` compiles the actual
provider source and invokes the real Worker with existing authority and SQLite
budget fixtures. It covers both native and manifest routes, exact identities,
original grant/TokenPlan isolation, fragmented SSE, replay, controls, schema,
usage subsets, alias versus serving model, strict discovery, errors and cancel.
Prepared tests are not executed proof. Local work remains code-only after
native dependency qualification; source6 owns later snapshot integration,
focused/full checks and actual-client proof on the final composed head.

Availability schema/runtime PR576/614 are already present at this source base.
Source1 retains shared usage, selected-model/serving-model accounting and auth;
source2 retains actual frozen Tencent client behavior. Native returned-model
observations do not authorize silently changing a policy-selected tariff.
Source3 retains the compiler. No shared source, client, media file, snapshot,
production deployment, login or live account provisioning is changed here.
