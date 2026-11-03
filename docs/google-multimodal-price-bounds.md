# Frozen Gemini multimodal price bounds

This slice adds only `gemini-3.1-flash-lite`, `gemini-3-flash-preview` and
`gemini-2.5-flash-lite`, named by the frozen OpenClaw revision
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` in
`extensions/google/openclaw.plugin.json`. The existing default and native
generate/stream routes remain unchanged.

Primary evidence checked 2026-11-03: [pricing](https://ai.google.dev/gemini-api/docs/pricing),
[3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite),
[3 Flash Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview),
[2.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)
and the current unlocalized [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations).
The 2.5 model is limited to existing users who previously used it; it is explicitly
not deprecated. No shutdown is announced for 3 Flash Preview. The earliest listed
shutdown for stable 3.1 Flash-Lite is 2027-05-07; its retired Preview identity is
a different model. No alias, new-account entitlement or live probe is inferred.

All three document text/image/video/audio input, 1,048,576 input tokens and 65,536
output tokens. PDF support is documented but has no separate router modality.
These facts do not establish actual-client replay or tool execution acceptance.

## Published upper-bound accounting

Google charges more per audio input token than per text/image/video input token.
The current unified usage observation does not retain the modality split. Each
card therefore uses the highest published input and cached-input rate, labeled
`settlementBasis: published_upper_bound`. Both reservation and settlement may
overcharge non-audio usage relative to the upstream bill; neither is presented
as an exact modality-aware receipt.

USD per million input / cached input / output tokens:

| Selected model | Standard bound | Flex bound | Priority bound |
| --- | --- | --- | --- |
| 3.1 Flash-Lite | 0.50 / 0.05 / 1.50 | 0.25 / 0.025 / 0.75 | 0.90 / 0.09 / 2.70 |
| 3 Flash Preview | 1.00 / 0.10 / 3.00 | 0.50 / 0.10 / 1.50 | 1.80 / 0.18 / 5.40 |
| 2.5 Flash-Lite | 0.30 / 0.03 / 0.40 | 0.15 / 0.03 / 0.20 | 0.54 / 0.054 / 0.72 |

Use the published Flex cached-input rates, including the two unchanged Standard
rates. Select settlement rates from observed served-tier evidence. Media
reserves the full declared input window; output bounds include thoughts and
candidate counts. Token strings, audio byte counts and URLs do not estimate
media duration or billable input.

Existing hard-dollar guards still reject unqualified hosted tools, explicit
stored-context references and unknown tiers. Ordinary client function names do
not imply hosted execution. Cache storage, Batch, contributor pricing, Live,
Interactions and media generation are not priced by these cards. Explicit
policy-fixed accounting retains its separate basis.

Nine focused cases cover exact native selectors and stream query, served-tier
cost arithmetic, full-window media reservations, conditional cost guards and
actual Worker JSON/SSE settlement for all three models on native and manifest
routes. Serialized snapshot integration and actual client/account qualification
remain separate work.
