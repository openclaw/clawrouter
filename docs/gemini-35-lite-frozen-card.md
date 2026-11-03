# Frozen Gemini 3.5 Flash-Lite card

This E01 continuation adds only `gemini-3.5-flash-lite` to the existing Google
GenerateContent/SSE routes. The existing default remains `gemini-3.5-flash`.
It introduces no replacement alias, model generation or media output route.

Primary evidence checked 2026-11-04:

- [Model facts](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
  qualify 1,048,576 input tokens, 65,536 output tokens and text/image/video/audio
  inputs with text output.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) list no
  shutdown date for this exact identity.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)
  provides the following USD rates per million tokens.

| Tier | Input | Cached input | Output, including thinking |
| --- | --- | --- | --- |
| Standard | 0.30 | 0.03 | 2.50 |
| Flex | 0.15 | 0.02 | 1.25 |
| Priority | 0.54 | 0.05 | 4.50 |

The cache rates are direct published values, not inferred tier multipliers.
Batch and invite-only Contributor pricing are not generation service tiers.
The existing Google tariff path consumes these cards; the OpenAI-only native
discovery tier field remains absent.

Unbounded media reserves the qualified input ceiling. Native output bounds
include thinking and candidate count. Actual hosted tools, stored-cache
references and unknown tiers remain denied under hard-dollar budgets; ordinary
client functions stay priced. Cache storage, per-search fees, account allowances
and free quotas are not inferred from token pricing. Explicit policy-fixed
charges remain separate.

Five focused cases compose the compiler, native model selection, tier/cache
accounting, conditional hard-budget guards and actual Worker native/manifest
JSON/SSE settlement using SQLite. Static vendor facts are not runtime media
parity or live access proof. Source6 retains serialized snapshot integration
and actual client qualification; no generated payload or production state is
changed by this source PR.
