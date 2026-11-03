# Step Plan: frozen product and regional contracts

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/stepfun/openclaw.plugin.json` and `extensions/stepfun/index.ts`.
Primary contracts checked 2026-11-03. This batch implements the frozen
OpenAI Chat contract for the subscription product.

| Router ID | Server credential binding | Fixed upstream base |
| --- | --- | --- |
| `stepfun-plan` | `STEPFUN_PLAN_API_KEY` | `https://api.stepfun.ai/step_plan/v1` |
| `stepfun-plan-cn` | `STEPFUN_PLAN_CN_API_KEY` | `https://api.stepfun.com/step_plan/v1` |

The frozen ID selects global explicitly; `-cn` selects China within the same
StepFun family. Both append `/chat/completions`. Native callers use
`/v1/native/<id>/chat/completions`; manifest callers use
`/v1/proxy/<id>/chat_completions`. The native model name is unchanged; manifest
model IDs prepend the selected router ID.

The [global integration contract](https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api)
and [China integration contract](https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api)
specify separate hosts, a dedicated plan path and Bearer API-key authentication.
The router uses explicit plan bindings even though the frozen OpenClaw plugin
exposes `STEPFUN_API_KEY` for both products. Configure a key for the selected
account and region under its own policy. A matching provider-scoped grant stays
with that policy and region. No key prefix establishes entitlement.

The [Step Plan overview](https://platform.stepfun.ai/docs/en/step-plan/overview)
distinguishes subscription Credits from the standard API quota. A successful
standard API call does not prove subscription usage. Neither standard keys nor
the other region's key are fallback credentials. Authentication failures,
denied access and exhausted quota do not retry a different host or product.

## Frozen inventory and usage

Both regional integration contracts still list all three frozen IDs:

| Exact upstream ID | Disposition |
| --- | --- |
| `step-3.7-flash` | Supported plan model; account entitlement still applies |
| `step-3.5-flash` | Supported plan model; distinct from the versioned card |
| `step-3.5-flash-2603` | Supported plan model; preserve the version suffix |

The current [retirement notice](https://platform.stepfun.ai/docs/en/guides/model-migration)
does not retire these three IDs. No newer generation, automatic model alias,
context limit or tariff is inferred. The frozen catalog's zero costs are not
vendor prices. Every card and model-passthrough price remains unknown.

The [Chat API](https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create)
documents `reasoning_format`, `reasoning_effort`, tools and cumulative SSE usage
on content chunks. The transport preserves these fields and versioned model
names without converting reasoning levels. Fixtures cover a cumulative partial
counter followed by terminal usage, fragmented delivery, absent counters and
disconnects. They do not require `stream_options.include_usage`, which the
frozen model compatibility contract marks unsupported. Tokens are observations;
they do not measure remaining Credits or a subscription invoice. Hard-budget
admission needs an explicit fixed policy request charge, not a fabricated rate.

## Integration boundaries

Real Worker/SQLite fixtures compile these source manifests and exercise both
routes, region/grant isolation, all frozen models, replay, fixed reservation
and settlement, unknown-price admission, stream errors and cancellation.
Snapshot activation needs an explicit serialized integration slot and green
final-head CI. Actual OpenClaw client and live entitlement proof are separate.

Native Messages is documented at `/step_plan/v1/messages` with the Anthropic
SDK base ending in `/step_plan`. It remains a separate protocol continuation;
this Chat batch does not claim Messages parity. The frozen provider also probes
`<selected-plan-base>/models`. The current public
[models reference](https://platform.stepfun.ai/docs/en/api-reference/models/list)
documents the standard `/v1/models` address only. Plan discovery must qualify
the selected plan endpoint and account; it must never borrow the standard
catalog or a different region's credential. No live calls, login, provisioning,
subscription changes or deployment are performed here.
