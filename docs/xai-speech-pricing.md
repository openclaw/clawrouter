# Native xAI unary speech pricing boundary

The settled request format `xai.tts` uses the existing native-audio pricing gap.
`requestPricingGap` returns `opaque_input_bound`; `estimateModelCost` returns
unavailable pricing and unknown token counts; `actualModelCost` returns null
before token or nonbillable shortcuts. The existing Groq, Mistral and xAI
transcription guards retain their behavior.

`prepareXaiSpeech` has no model selector. Native text length, voice, speed,
codec, complete audio bytes and the reader's service-default sample rate do not
qualify a whole-request upstream invoice. Supplying a Chat, zero-rate or image
card must not certify an audio estimate or settlement. Character tariffs,
rounding, account charges and interrupted-request debit remain unqualified.

The existing admission and accounting path preserves the distinction:

- Upstream-dollar hard budgets reject unknown prices before dispatch.
- Explicit policy-fixed charges, including an explicitly configured zero,
  retain the `policy_fixed` basis; they are not vendor prices.
- Ordinary Chat and client functions or JSON named `xai.tts` keep their
  independent token pricing. Only the selected request format invokes this guard.

Five composed cases consume the actual speech codec/reader, estimator, budget
validation and settlement APIs. Synthetic bytes test wire completion only.
This slice changes no shared selection, native factory, YAML or snapshot. The
future runtime must freeze the selected format through admission and settlement,
preserve original credentials and avoid replay after uncertain dispatch. No
live speech, charge probe, deployment or route activation is claimed.
