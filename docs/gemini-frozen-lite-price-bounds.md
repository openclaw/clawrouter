# Frozen Gemini 3.1 and 2.5 Flash-Lite cards

This E01 slice adds only `gemini-3.1-flash-lite` and `gemini-2.5-flash-lite`
to existing GenerateContent/SSE routes. It preserves the default, selected
upstream identity and original credentials.

Primary evidence checked 2026-11-04:

- Model pages for [3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
  and [2.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)
  qualify 1,048,576 input tokens, 65,536 output tokens, multimodal inputs and
  text output. These facts do not activate new media consumers.
- Stable 2.5 Flash-Lite explicitly remains served through the API and is not
  deprecated; access is limited to users who actively used it. This is distinct
  from the retired preview and the separate 2.5 Pro/Flash migration notices.
  No account entitlement, replacement alias or stopped status is invented.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) lists
  2027-05-07 for 3.1 Flash-Lite; it is not a current shutdown.
- [3.1 pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)
  and [2.5 pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash-lite)
  distinguish audio input/cache rates from cheaper text/image/video rates.

The card uses each tier's published audio input/cache ceiling across inputs,
with the published output rate including thinking. Rates below are USD per
million tokens:

| Model | Tier | Input ceiling | Cached input ceiling | Output |
| --- | --- | --- | --- | --- |
| 3.1 Flash-Lite | Standard | 0.50 | 0.05 | 1.50 |
| 3.1 Flash-Lite | Flex | 0.25 | 0.025 | 0.75 |
| 3.1 Flash-Lite | Priority | 0.90 | 0.09 | 2.70 |
| 2.5 Flash-Lite | Standard | 0.30 | 0.03 | 0.40 |
| 2.5 Flash-Lite | Flex | 0.15 | 0.03 | 0.20 |
| 2.5 Flash-Lite | Priority | 0.54 | 0.054 | 0.72 |

2.5 Flex cache pricing does not halve with its inference rate. Settlement uses
the existing `published_upper_bound` label; these conservative amounts are not
an exact upstream invoice. Unbounded media reserves the full input limit and
candidate count expands the output reservation.

Actual hosted tools, stored-cache references and unknown tiers remain closed
under hard dollar budgets. Client function names and user text do not imply
hosted execution. Cache storage, search charges and account/free allowances
are not silently covered by token prices; explicit policy-fixed charges stay
distinct. No Batch, Contributor, or new native discovery tier field is added.

Seven focused cases compose compilation, native selection, tier/cache bounds,
conditional admission and actual Worker native/manifest JSON/SSE SQLite
settlement. No live call, broader media parity or entitlement proof is claimed.
Source6 owns serialized generated snapshot and actual client integration.
