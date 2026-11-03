# Frozen xAI image contracts and retired alias

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/model-definitions.ts` and `image-generation-provider.ts`.
The finite selected identities are `grok-imagine-image`,
`grok-imagine-image-2.0` and `grok-imagine-image-quality`.

## Identity and quality

Effective 2026-11-02, `grok-imagine-image-quality` is retired as an independent
model but remains an upstream alias to `grok-imagine-image-2.0` at low quality,
for both generation and edits. Preserve the selected slug in the request and
policy identity. Require the actual serving model in the response; do not
rewrite it back to the alias or accept missing/foreign identity. The 1.0 model
`grok-imagine-image` is unaffected and must return its own identity.

The adapter records quality separately from model identity:

| Selection | Expected serving quality | Basis |
| --- | --- | --- |
| Retired quality alias, either mode | low | retired_alias |
| Direct 2.0, explicit low/medium | selected value | explicit |
| Direct 2.0, omitted/auto, generation | low | service_default |
| Direct 2.0, omitted/auto, edits | medium | service_default |
| Unaffected 1.0 | unspecified | legacy |

Service defaults are dated qualification, not returned usage counters. Quality
overrides are accepted only for direct 2.0; the alias must not inherit its auto
edit behavior. No caller selection is silently migrated.

## Wire and limits

`worker/xai-images.ts` exports `xaiImageModels`, `xaiImageAliasEffectiveAt`,
`prepareXaiImage(model, mode, body)`, `observeXaiImage(body, request, complete)`
and `readXaiImage(response, request, signal)`. Modes are `generate` and `edit`.
Prepare supplies native JSON and non-secret headers, never a credential.

Native Bearer requests use POST `/v1/images/generations` or `/v1/images/edits`.
Edits use JSON, not OpenAI multipart. The frozen subset retains one to four
outputs, one to three edit references, 13 aspect ratios and 1k/2k resolutions.
It requires `response_format:b64_json`. HTTPS references are opaque inputs to
the selected upstream, never router downloads or credential destinations.
Data references are bounded PNG/JPEG/WebP encodings; raw file IDs stay closed
without original-owner binding. Deferred operations and newer inventories are
outside this slice.

Limits: 32KiB prompt, 8MiB per decoded image, 16MiB total input/output images,
24MiB JSON envelope. Only complete HTTP 200 JSON/UTF-8 EOF with matching image
count and serving model can deliver images. Reject moderation failures, partial
results, URLs, malformed base64 and truncated bodies. Abort cancels stalled
reads. Interrupted delivery never authorizes a new paid POST or implies refund.

## Cost and owner handoff

The public 2.0 card checked 2026-11-03 lists $0.01 per input image; low output
costs $0.04/$0.06 at 1k/2k, and medium costs $0.06/$0.08. The alias uses the low
rate, including edits. These evidence values are not activated tariffs or a
complete admission/settlement contract. The codec preserves native usage and
calculates no dollar charge. Unknown upstream-USD hard budgets remain closed;
policy-fixed charging stays separate from upstream cost.

Proposed exact formats: request `xai.images_generations` / `xai.images_edits`,
response `xai.images`, capability `image.generate`. Source 11.3 owns existing
xAI YAML/schema/prices and must preserve alias disposition, selected identity,
serving-model validation and quality-sensitive pricing. Source 11.1 owns native
dispatch/admission/accounting; source 11.2 owns actual image consumers and their
returned-model fixtures; source 11.6 owns integrated Worker/client proof.
No manifest, catalog activation, live call or deployment occurs here.

Fixture: `providers/_fixtures/xai/images.json`. Its three synthetic bytes test
encoding only, not a playable image or paid generation. Focused tests cover the
alias in both modes, default/explicit quality, model mismatch, finite request
bounds, partial/filtered outputs, byte delivery and cancellation.

Primary evidence checked 2026-11-03:
- [Retirement and supported upstream alias](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2)
- [Generation and quality defaults](https://docs.x.ai/developers/model-capabilities/images/generation)
- [Native JSON edits](https://docs.x.ai/developers/model-capabilities/images/editing)
- [Public image rates](https://docs.x.ai/developers/pricing)
