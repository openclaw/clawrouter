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

## Local Pro-only integration proof

The integration carries only the Pro delta from exact source
`e6e4937fd4040faf37e540baeb82af8f34494b30` onto qualified landed router base
`6d106ca12467b0e4dc68446a08b6e76afaddeb38`. The Pro card is byte-exact to source;
removing it restores the entire base YAML. The source assertions retain all Pro
selection, price, cache, admission, native/manifest and SQLite checks. Only the
already-landed Flash model iteration is omitted. All 86 manifests compile;
five focused cases, Worker types and 1,051 Chat/consumer-selection cases pass.
Only the Pro row is added to the base model index. The landed 3.6 card remains
unchanged; unlanded Flash-Lite and Google-image changes are excluded. Serial
snapshot SHA256: `f1084ff3e31167410b5c18dd79295b87b63439ab9cc23c0546027df492e231c8`.

`test/openclaw-gemini31pro.test.mjs` authors nine actual registered Google
consumer cases using public OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`
and the shared Worker/SQLite fixture. They preserve exact model/key binding,
cache/thinking usage and a 4,000-micro upper-bound example, separate fixed
charges, tool replay, inline PNG bytes, denials, embedded errors and cancellation
after delivery. They are **AUTHORED/UNRUN**, with syntax checks only. No new SDK
build or hosted enrollment is performed. Explicit GenerateContent configuration
does not prove default Interactions, live discovery, other media consumers,
entitlement, exact vendor billing or physical pre-header cancellation.
