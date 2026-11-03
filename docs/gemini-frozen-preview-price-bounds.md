# Frozen Google Pro preview price bounds

E01 adds only `gemini-3.1-pro-preview` to the
existing native GenerateContent and SSE routes. The original default and
selected identities stay unchanged. No customtools variant, new generation,
retired image/video preview, replacement alias or native media route is added.

Primary evidence checked 2026-11-04:

- Model facts for [3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
  qualifies 1,048,576 input tokens, 65,536 output tokens and multimodal input with
  text output. Static facts do not prove runtime media parity.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) lists no
  announced shutdown for this exact preview.
- [3.1 Pro prices](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-pro-preview)
  rise above 200,000 input tokens.

Use the high-context Pro ceilings across admitted inputs. USD
rates per million tokens:

| Model | Tier | Input ceiling | Cached input ceiling | Output, including thinking |
| --- | --- | --- | --- | --- |
| 3.1 Pro Preview | Standard | 4.00 | 0.40 | 18.00 |
| 3.1 Pro Preview | Flex | 2.00 | 0.40 | 9.00 |
| 3.1 Pro Preview | Priority | 7.20 | 0.72 | 32.40 |

Flex cache prices do not halve with inference. The existing
`published_upper_bound` settlement label makes these conservative values
explicit; they are not exact invoices for short/text-only requests. No new
modality or long-context pricing framework is introduced.

The existing estimator reserves the full input ceiling for unbounded media and
expands output by candidate count. Actual hosted tools, opaque stored caches
and unknown service tiers stay closed under hard-dollar budgets, while ordinary
client functions remain priced. Cache storage, search, account allowances and
free quotas are not inferred from token rates. Policy-fixed charging remains
separate. Batch/Contributor tariffs and a new discovery tier field are excluded.

Five focused cases compose the compiler, native selection, tier/cache bounds,
conditional admission and actual Worker native/manifest JSON/SSE SQLite
settlement. No live request or account-access proof is claimed. Source6 owns
serialized snapshot integration and actual client qualification.

The Flash preview row is already carried by the landed catalog foundation.
This bounded composition preserves that row byte-for-byte and adds no Flash
card or duplicate Flash test. The superseded Flash-Lite pair is not reopened.
