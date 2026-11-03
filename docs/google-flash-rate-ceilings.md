# Gemini Flash published rate ceilings

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` declares
`gemini-3.6-flash` and `gemini-3.8-flash` in
`extensions/google/openclaw.plugin.json`. Both current primary model pages
qualify text/image/video/audio input, 1,048,576 input tokens and 65,536 output
tokens. Existing default ordering and native generate/stream endpoints stay intact.

Sources checked 2026-11-03:
[3.6](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash),
[3.8](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[pricing](https://ai.google.dev/gemini-api/docs/pricing),
[deprecations](https://ai.google.dev/gemini-api/docs/deprecations).
Neither identity has an announced shutdown date. This is catalog/source
qualification; actual client acceptance and account entitlement are separate.

Google publishes introductory rates through 2026-12-31 and doubled rates from
2027-01-01. These cards intentionally use the higher announced rates as an
explicit `published_upper_bound` for both reservation and settlement:

| Tier | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Standard | $1.50 | $0.15 | $7.50 |
| Flex | $0.75 | $0.075 | $3.75 |
| Priority | $2.70 | $0.27 | $13.50 |

Units are USD per million tokens; the introductory rates are half these values.
This can conservatively debit more than the upstream invoice during the discount.
The existing accounting runtime labels measured usage `manifest_rate_upper_bound`,
never exact invoice cost. It therefore cannot silently keep a promotional price
after the known increase. Missing usage retains the reservation; unknown served
tiers remain unpriced. No clock-dependent price selection is claimed.

Hosted search/maps, stored context and hosted execution retain the existing
hard-budget guards. These cards do not price storage, Batch, private contributor
plans or additional tool fees. Policy-fixed tariffs remain distinct.

The frozen `gemini-3.7-flash` target is a documented upstream alias to 3.8; this
change records that disposition without creating a separate qualified offer or
rewriting a requested ID. The existing `gemini-3.5-flash` default is likewise a
documented upstream alias to 3.6; its established route is preserved. No retired
Veo models or replacements are introduced. Argon's Interactions path is a
separate runtime/codec contract, not implied by these GenerateContent cards.
