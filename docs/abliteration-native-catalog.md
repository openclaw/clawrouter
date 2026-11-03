# Abliteration frozen native Chat catalog

Scope: the four Chat cards in OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/abliteration/openclaw.plugin.json` and `index.ts`. Preserve all four
public IDs and the existing Large v2 seed. Responses, Messages, web search,
Policy Gateway administration and later model generations are not added.

## Qualified model facts

Primary [models](https://docs.abliteration.ai/models),
[compatibility](https://docs.abliteration.ai/compatibility-matrix) and
[reasoning](https://docs.abliteration.ai/capabilities/thinking) contracts checked
2026-11-03:

| Exact upstream ID | Input | Context | Max output | Canonical frozen efforts | Default |
| --- | --- | ---: | ---: | --- | --- |
| `abliterated-model-large-flash` | text, image | 1,048,576 | 262,144 | none, low, high, max | high |
| `abliterated-model-large-v2` | text | 1,000,000 | 999,990 | low, high, max | max |
| `abliterated-model` | text, image | 262,144 | 262,134 | none, minimal, low, medium, high, xhigh, max | native depth; unrecorded |
| `abliterated-model-large` | text | 1,000,000 | 999,990 | none, high, max | high |

Context is the combined input/output budget; the output ceiling assumes enough
remaining input capacity. All four support native function tools. The two
text-only models reject image inputs with HTTP 400; they are not silently
changed to an image-capable model. Video is not advertised.

The primary model page explicitly deprecates `abliterated-model-large` while
keeping it available for existing integrations. Versioned `deprecated` metadata
uses 2026-11-03 as the evidence-as-of date, not an invented original deprecation
or shutdown date. The selected upstream ID, facts and eligibility checks remain
separate. There is no serving-model alias or universal entitlement claim.

## Reasoning, replay and structured output

Chat uses `reasoning_effort`. Preserve the frozen canonical ladders; do not
expand them with current compatibility aliases. Large v2 cannot disable
reasoning: a `none` or `thinking: false` request runs low reasoning and hides its
trace upstream. `include_reasoning: false` hides a trace without eliminating
reasoning tokens. Tests preserve the native request and independently reported
usage; no hidden reasoning is treated as zero tokens.

The recorded default is a fact, not an injected request control. Keep
`reasoning_content`, function IDs, argument fragments and tool results intact,
consistent with frozen `dropReasoningFromHistory: false` and OpenAI tool hooks.
The [Chat tool contract](https://docs.abliteration.ai/capabilities/tool-calling/openai-chat-completions)
uses the ordinary call/result continuation loop. Native JSON mode and JSON
Schema use `response_format`; this source does not add a separate router schema
enforcement promise. The frozen host uses `max_tokens`; no output cap is
silently inserted into the request.

## Credentials and project discovery

The [authentication contract](https://docs.abliteration.ai/api/authentication)
uses a project inference key with Bearer auth under
`https://api.abliteration.ai/v1`. Admin keys for organization management are a
different contract. Keep the selected original grant; do not fall back to an
unrelated provider, caller header or ambient credential.

ClawRouter currently qualifies `ABLITERATION_API_KEY`. Frozen OpenClaw also
recognizes the vendor's `ABLIT_KEY` name. The existing shared Worker selector
and readiness logic do not recognize that legacy name; source1 owns the queued
narrow correction and its proof. This manifest intentionally keeps the currently
qualified configuration name. Do not activate the legacy name until the common
selector/readiness pin is qualified, or forward a global environment blindly.
No new secret or external credential task is required to implement that code.

[Project model discovery](https://docs.abliteration.ai/api-reference/models/list-models-available-to-the-api-key-project)
is keyed `GET /v1/models`, without query parameters. The native `object: list`
envelope fits existing `openai.models`; strict shared parsing and original
policy filtering remain unchanged. Project rows may include
`access.available`, `access.locked`, `required_checks`, `missing_requirements`,
`is_ready`, pricing, modality and limit metadata. Preserve those native fields;
a known ID or local grant does not clear an upstream access requirement. Frozen
OpenClaw uses static catalog augmentation, so this additional qualified native
metadata route does not silently switch its discovery mode.

## Usage and pricing boundary

[Streaming](https://docs.abliteration.ai/capabilities/streaming) uses SSE deltas,
fragmented tool arguments and `[DONE]`. For terminal usage, the
[prompt-cache contract](https://docs.abliteration.ai/capabilities/prompt-caching)
requires `stream_options.include_usage`. Cached input is a subset of prompt
usage; reasoning is a subset of completion usage. Do not count either twice.
`prompt_cache_key` is a routing hint, not reserved cache capacity or proof of a
hit. Missing cache usage stays unknown; an explicit zero remains zero.

Published [USD-per-million token rates](https://docs.abliteration.ai/pricing)
are input/cache-read/output: Flash 1/0.1/2, base 1/0.1/3, both Large models
3/0.3/5. Cache creation is standard input processing, with no separate premium;
it is not a free cache-write token category. The
[account pricing contract](https://abliteration.ai/pricing) adds subscription
and negotiated discounts. Search has a separate charge and is not advertised
here. No copied frozen zero, automatic USD invoice or account tariff is added.
Sources1/3 own qualified common pricing/receipt projection. Fixture
`policy_fixed` charges remain independent router policy.

## Proof and ownership

`worker/test/abliteration-native-runtime.test.mjs` compiles this YAML and calls
the actual Worker with its existing authority and SQLite budget fixtures. It
covers both routes, four identities, canonical efforts, tool/reasoning replay,
fragmented SSE, missing usage, cache evidence, errors, cancellation, late errors,
image acceptance/rejection, native structured requests and private discovery.

Prepared tests are not executed proof. Local source stays code-only because
native dependency qualification refuses an escaping workspace link. Source6
owns a later explicit serialized snapshot slot and integrated final-head proof;
this source assumes no snapshot lease. Source2 owns actual frozen-client replay,
effort mapping and static catalog augmentation. Source1's legacy credential-name
fix remains distinct. No common/compiler/client edits, live inference, login,
provisioning, account changes or manual deployment are performed here.
