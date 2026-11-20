# Groq and Mistral native audio pricing guard

The explicit `groq.transcription` and `mistral.transcription` formats consume the
landed [multipart codec](groq-mistral-audio-contract.md). Upload byte limits,
transcript text, native audio seconds and an observed model alias do not establish
a whole-request audio tariff or admission bound.

The existing pricing exports enforce that distinction:

- `requestPricingGap` returns `opaque_input_bound` for either format, independent
  of a token, free, image or absent model card.
- `estimateModelCost` returns unknown input/output tokens and unavailable pricing
  before any token or image estimator can run.
- `actualModelCost` returns null, including zero usage and nonbillable token flags;
  those fields do not qualify the native request's complete audio charge.

The common estimator consequently denies both caller and provider hard-dollar
budgets. Explicit `policy_fixed` charges, including authorized zero, remain
separately labeled. The existing accounting event uses `unpriced_usage` for an
unqualified native charge, never a vendor invoice inferred from Chat token rates.
The `audio_upload_bound` classification remains reserved for the existing OpenAI
upload path and its separately qualified measured-token exception.

This guard classifies trusted request formats only. It does not inspect function
names, text or arbitrary user JSON for provider intent. Ordinary Chat retains
its current pricing behavior. No rate is registered and no YAML, snapshot,
multipart controller or provider route is activated. The runtime owner still
must supply authenticated bounded upload, exact original provider/model/grant
binding, fresh admission after upload, dispatch and uncertain-outcome proof.

Five composed tests exercise the actual codec, pricing exports, both hard-budget
paths and accounting events. Synthetic fixture bytes prove transport shape only;
no playable audio, live charge probe or complete provider parity is claimed.
