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

## Serialized integration proof

Exact source `e6b07bf53cad75ecca062cad9bc90695c109e555` is composed on qualified
landed router base `6d106ca12467b0e4dc68446a08b6e76afaddeb38`. The complete 39-line
card and five source tests are unchanged; removing the new row restores the
entire base YAML. All 86 manifests compile. Five focused cases, Worker types
and 1,051 existing Chat/consumer-selection cases pass. The generic Chat matrix
does not prove Google native client behavior.

Serial snapshot SHA256:
`08a7dd54d5304b4bf1a1f8df063be3691da7d4b300e4a5ac0041831a3a49b393`.
Only `google/gemini-3.5-flash-lite` is added to the base model index. The landed
Gemini 3.6 card is preserved; held Google-image declarations remain excluded.

`test/openclaw-gemini35lite.test.mjs` authors nine actual registered Google
consumer cases against public OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`,
using the shared actual-source Worker/SQLite fixture. It preserves exact observed
cache/thinking usage and the 415-micro standard-tier example, separate fixed
charges, original credentials, tool replay, inline PNG bytes, denied calls,
embedded errors and post-delivery cancellation. These cases are enrolled in
ordinary hosted CI and remain **AUTHORED/UNRUN** until the exact composed head
passes. The existing shared consumer fixture and its actual static-catalog
return shape are unchanged. No new SDK report, local dependency install or live
call is performed. Explicit GenerateContent configuration does not certify default
Interactions, live discovery, other modality consumers, entitlement, vendor
invoice totals or physical pre-header cancellation. Flex and Priority retain
the exact source rates, independently exercised by the focused Worker cases.
