# Frozen Gemini 2.5 model cards

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/openclaw.plugin.json`, includes `gemini-2.5-pro` and
`gemini-2.5-flash`. This slice qualifies those two exact identities on the
existing native GenerateContent and SSE routes. Frozen zero-cost placeholders
are not vendor tariffs. No newer model is added, no selected ID is rewritten,
and the original default remains unchanged.

## Current disposition

Google's current unlocalized [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations),
checked 2026-11-03, marks both models deprecated and restricts API access to
existing active users. They are no longer selectable in AI Studio. The dated
`deprecated` metadata records the disposition observed on that date, not an
invented original announcement date or account entitlement.

Effective 2026-12-01, Google announces upstream routing of Pro to
`gemini-3.8-flash` and Flash to `gemini-3.5-flash-lite`, with replacement billing
and documented API changes. Those are future upstream aliases, not current
serving facts: this slice does not set `servingModel`, silently substitute the
replacement or claim its runtime compatibility. The current card does not
establish access for a new API account. Retired previews and image/audio-output
models are outside these two exact rows.

## Published ceilings

The primary [Pro model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)
and [Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)
qualify text/image/video/audio inputs, text output, 1,048,576 input tokens and
65,536 output tokens. These are model bounds, not an account's serving grant.
[Current pricing](https://ai.google.dev/gemini-api/docs/pricing) was checked
2026-11-03. Output rates include thinking tokens.

The existing `published_upper_bound` basis is used because native aggregate
counts do not distinguish every billable modality or pricing regime. Pro uses
the published >200k-input rates even for shorter requests; Flash uses the higher
audio input/cache rates for all inputs. Values below are USD per million tokens,
ordered uncached input / cached input / output:

| Model | Standard | Flex | Priority |
| --- | --- | --- | --- |
| Gemini 2.5 Pro | 2.50 / 0.25 / 15 | 1.25 / 0.25 / 7.50 | 4.50 / 0.45 / 27 |
| Gemini 2.5 Flash | 1 / 0.10 / 2.50 | 0.50 / 0.10 / 1.25 | 1.80 / 0.18 / 4.50 |

Flex cached-input prices are unchanged from Standard; they are not inferred by
halving every rate. Explicit cache storage, hosted Search/Maps/code execution,
unknown/contributor tiers and separate products are not qualified by these
ceilings. Existing request guards keep their unknown hard-budget costs closed.
Client-declared functions with tool-like names remain ordinary client functions.
`policy_fixed` remains separately labeled and does not certify vendor cost.

Settlement reports `manifest_rate_upper_bound`, not an exact invoice. The
ceilings can overstate short Pro calls and non-audio Flash input. The announced
replacement rates are lower than or equal to these per-tier ceilings at this
verification date, but that comparison does not qualify future wire semantics,
new model facts or account access. Preserve the selected identity and requalify
concrete changed behavior when the announced upstream transition takes effect.

## Proof and integration

Seven focused cases exercise compiled selection/facts, all three served tiers,
cached-input rates, high-context/media reservation bounds, unchanged default,
hosted-cost denial and separately labeled policy charges. Four cases run the
actual Worker native/manifest JSON/SSE paths with SQLite budgets, original
credentials and exact unchanged selected-model URLs. The complete native usage
counts include thinking and cached tokens; sanitized fixtures are not live API
availability or account proof.

This slice changes no common runtime, schema or generated snapshot. Source6
owns serialized snapshot integration after the existing queue, including
[PR633](https://github.com/openclaw/clawrouter/pull/633)'s independent three-model
card slice. Preserve those rows and changes when combining sources. Actual
client capability and account acceptance remain separate from static metadata.
