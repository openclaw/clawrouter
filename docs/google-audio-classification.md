# Google native audio classification

`worker/google-audio-classification.ts` exports:

```ts
googleAudioRequest(selectedUpstreamModel, body, requestFormat): boolean
```

This is output intent, not route qualification, availability, model selection,
duration, price or invoice evidence. The selected upstream identity must come
from the router's original model selection. A JSON `model` value, prompt,
function name or inline audio input does not supply that authority.

The explicit `google.music_generate`, `google.speech_generate_content` and
`google.speech_interactions` formats classify as audio. Generic
`google.generate_content` classifies from either the seven published frozen
music/speech identities or native output modalities. It uses the existing
ProtoJSON reader's camel/snake aliases and last-value/null behavior. AUDIO is
integer 3 in the [primary Google proto](https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/generative_service.proto);
quoted `"3"` is conservatively recognized as well. Other protocols remain
outside this classifier.

Shared selection denies generic unary/SSE audio output before reservation and
egress, including explicit policy-fixed callers. Explicit audio formats require
their actual qualified `NativeResponse`; this slice does not wire or activate
the published music/speech wrappers. Inline audio input requesting ordinary text
retains its current route behavior. Preview cutoffs and native validation stay
with the actual codecs and wrappers; classification cannot extend availability.

Accounting freezes the boolean at request construction. Subsequent body changes
or token-shaped response counters cannot establish an audio invoice, token
price or refund. Uncertain dispatched cost retains the reservation with an
unpriced basis, separately from policy-fixed charging; known-unsent work stays
zero. The classifier introduces no tariff calculation or pricing helper.

Source3 owns `worker/pricing.ts`, including the landed/published explicit-format
guards and the continuation that consumes this same classifier. The existing
selected-model projection published by PR662 remains the context handoff. Generic
admission estimation must consume that actual pricing contract before audio
activation; do not alias music to a speech/image tariff or duplicate modality
classification there. Source1 owns later native wrapper wiring; source5 retains
the wrappers, and source2/6 qualify each actual client and activated route.

Eight pure cases verify classification, and 42 real Worker/accounting cases cover
all frozen identities, native/manifest unary/SSE rejection, original environment
and grant paths, ordinary inline-audio text responses, explicit unwired formats
and frozen conservative settlement. No provider YAML, snapshot, live audio call,
new model or current upstream compatibility claim is included.
