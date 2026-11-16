# StepFun frozen standard Chat contracts

Scope: the two standard Chat cards and both standard regions in frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/stepfun/openclaw.plugin.json` and `index.ts`. The existing global
seed remains. No Step Plan manifest, newer model, Messages endpoint or media
adapter is changed.

## Region, product and original credentials

| Router provider | Explicit server binding | Standard upstream base |
| --- | --- | --- |
| `stepfun` | `STEPFUN_API_KEY` | `https://api.stepfun.ai/v1` |
| `stepfun-cn` | `STEPFUN_CN_API_KEY` | `https://api.stepfun.com/v1` |

The [global Chat contract](https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create)
and [China Chat contract](https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create)
qualify these distinct hosts with Bearer API keys. Keep the original provider,
region and selected grant. Standard endpoints append `/chat/completions`;
subscription endpoints use `/step_plan/v1` and remain the separate, already
implemented `stepfun-plan` and `stepfun-plan-cn` products.

The frozen client chooses standard/plan and China/global during authentication,
and binds catalog resolution to the explicit base URL or profile region. Its
shared environment variable name does not authorize reusing one region's or
product's credential in another. The router exposes an explicit China ID and
binding rather than a caller-controlled hostname. No auth/quota error retries
another model, host, region or subscription. Existing provider-scoped grants
remain authoritative even when unrelated server keys or grants exist.

The frozen `stepfun-ai` provider alias maps to the global standard provider and
same grant. It is not a region detector or plan alias. Router model IDs prepend
the explicitly selected provider; native upstream model IDs stay unchanged.

## Finite catalog and primary model facts

Primary model pages checked 2026-11-03:

- [Global Step 3.7 Flash](https://platform.stepfun.ai/docs/en/guides/models/step-3.7-flash)
  and [China Step 3.7 Flash](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash).
- [Global Step 3.5 Flash](https://platform.stepfun.ai/docs/en/guides/models/step-3.5-flash)
  and [China Step 3.5 Flash](https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash).
- [Model lifecycle](https://platform.stepfun.ai/docs/en/guides/model-migration).

Both standard regions retain exactly `step-3.7-flash` and `step-3.5-flash`.
Both support function tools; 3.7's frozen input is text/image and 3.5 is text.
The primary 3.7 contract qualifies `low|medium|high`, with medium as a default
fact, not an injected control. The versioned `step-3.5-flash-2603` effort ladder
does not establish an effort ladder for unversioned 3.5. Its separate plan card
is not added to the frozen standard inventory.

Primary model pages describe context as `256K` and the Chat reference leaves
output bounded by the model's context. This source does not infer exact numeric
ceilings or copy frozen output defaults. Context/output metadata stays absent.
The current lifecycle notice does not retire either selected ID. No replacement
alias, availability promise or later generation is inferred.

## Native reasoning, stream and accounting dependency

`reasoning_format` defaults upstream to `general`, whose output field is
`reasoning`; `deepseek-style` uses `reasoning_content`. Preserve the explicitly
selected format, prior assistant trace, native tool IDs/results and output
fields without conversion. The frozen client owns its own reasoning-level
mapping and developer-role/store/strict-mode compatibility. Source2 must
qualify those actual client hooks rather than infer them from the router.

Native SSE content chunks can contain cumulative usage. Observe the final
counters without summing cumulative chunks. The frozen client marks
`supportsUsageInStreaming: false`: fixtures do not inject
`stream_options.include_usage` or require it to elicit counters. Missing usage
remains unknown; cancellation and late provider failure retain conservative
settlement after dispatch.

The [primary cache contract](https://platform.stepfun.ai/docs/en/guides/developer/prompt-cache)
uses top-level `usage.cached_tokens`, a subset of inclusive `prompt_tokens`.
For example, prompt 300/cache 256/output 20 is total 320, not 576. Missing cache
usage is unknown; explicit zero remains zero. Cache population is ordinary
input processing, not free cache-write usage.

**Activation dependency:** at qualified source base
`047d9b984f38bada332cd71beaf1fe2f368c590e`, shared
`worker/token-usage.ts` recognizes nested cache hits and
`prompt_cache_hit_tokens`, but omits native top-level `cached_tokens`. Source1
owns the queued bounded correction, inclusive-subset/conflict validation and
real JSON/SSE proof. The new fixtures require the correct native observation;
they must not be weakened to accept the current missing value. Consume the
qualified common pin before final integrated-head activation. No shared file
is edited by this source.

Published global input/cache-read/output list rates per million tokens are
USD 0.20/0.04/1.15 for 3.7 and 0.10/0.02/0.30 for 3.5. China publishes separate
CNY 1.35/0.27/8.10 and 0.70/0.14/2.10 rates. These are not Step Plan Credits,
interchangeable currencies or a settled account invoice. No tariff conversion,
plan zero or missing-counter default is added. Fixture `policy_fixed` charges
remain independent router policy.

## Strict regional model discovery

The [global list API](https://platform.stepfun.ai/docs/en/api-reference/models/list)
and [China list API](https://platform.stepfun.com/docs/zh/api-reference/models/list)
use keyed `GET /v1/models`, without request parameters, and the native
`object: list`, `data` envelope. Rows have ID, creation timestamp, model object
and owner. Existing `openai.models` handles strict parsing, original-policy
filtering, private caching and response bounds. No decoder relaxation or
credential fallback is added. Standard discovery is not plan discovery.

## Proof and ownership

`worker/test/stepfun-native-runtime.test.mjs` compiles both actual manifests and
calls the real Worker with existing authority/SQLite budget fixtures. It covers
both routes/regions, exact IDs, unrelated environment and grant rejection,
tool/reasoning replay, fragmented cumulative SSE, native cache fields, images,
private discovery, errors, cancellation and late errors.

Prepared cases are not executed proof. Local source remains code-only after
native dependency qualification. Source6 owns a later explicit snapshot slot,
common-pin composition and final functional/native checks. Source2 owns actual
frozen-client region mapping, strict discovery and compatibility behavior.
Source1's cache accounting fix is required; schema/common/client/media files
remain with their owners. No new secret, provisioning, login, account changes,
live inference or manual deployment is performed here.

## Serialized integration and actual-client qualification

The integrated candidate composes local source
`33989aa286a40a25b60d755f057168351af1a5fa` onto landed router base
`81da9416c6e45f5b1ce2114288dc541ede81ce99`. Dependency inputs match the
qualified installation. The shared provider-scoped `cached_tokens` observer is
present; its original source dependency is resolved.

Owner corrections `bfcd3c1932353856a9991d6e3ef0c4e666bd045e` and
`df59902c0a05a48981154e1347c9c2344e9567f2` are carried with authorship.
Both regional YAML files are byte-identical to the final correction: keyed
catalog endpoints explicitly declare GET and omit streaming. The three
undeclared native URL aliases now assert exact `404 provider_not_found` and
zero upstream calls. Both canonical regions and the positive `stepfun-ai/…`
model-prefix route retain their assertions. No URL alias was invented.

On this composed source, all 98 focused cases, Worker types and all 1,051
Chat matrix/consumer-selection cases pass. All 86 manifests compile. The
snapshot is regenerated from those manifests; SHA256:
`68133dc924b7a0bfa223ba22ef7905c4408968902038845788017c09f142cc34`.
No generated JSON was merged by hand.

Eight actual registered-client cases in
`test/fixtures/openclaw-stepfun-contract.test.ts` use the real Worker/SQLite
outer harness `test/openclaw-stepfun.test.mjs`, pinned to public OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. The unchanged fixture imports
the registered standard provider, catalog, host replay policy and serializer.
It covers both frozen cards on explicitly selected global/China proxy routes,
canonical low/max mapping, exact inline PNG, tool replay, cumulative usage/cache
observation, original regional grants and zero-egress caller/product/unknown-price
denial. Ordinary hosted CI executes the pinned public source with its own frozen
dependencies; no SDK report is regenerated. These cases remain authored until
the final candidate's actual-client job passes; local Worker checks do not
substitute for that execution.

Automatic client region/profile selection, registered live discovery, Step Plan
entitlement and live inference remain separate from this explicitly configured
native-route fixture. Worker manifest coverage does not claim manifest-client
selection. No new credential, account change or manual deployment is required.
