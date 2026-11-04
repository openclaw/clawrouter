# OpenRouter Gemini opaque PCM response leaf

`prepareNativeOpenRouterPcmSpeech(selection: ProxySelection): NativeResponse | undefined`
uses the existing `prepareOpenRouterSpeech` and `readOpenRouterSpeech` codecs.
It selects only `google/gemini-3.1-flash-tts-preview` on provider `openrouter`,
capability `audio.speech`, request format `openai.audio_speech`, response format
`audio.binary`, and POST endpoint `/v1/audio/speech`. The configured base is
exactly `https://openrouter.ai/api`; the final URL is
`https://openrouter.ai/api/v1/audio/speech`. Other models return undefined so
the existing MP3 factory can retain its own model validation. There is no alias.

Common dispatch must select this leaf before the MP3 factory and generic input
validation. It must bind the original caller, selected model, destination and
OpenRouter credential before admission, acquire response capacity before fetch,
and retain the lease through delivery or cancellation. The leaf receives no
credentials or authority flag, changes no request body and performs no fetch.
`OPENROUTER_API_KEY` is a server credential source, not authority to borrow another
grant, provider, Google key or caller-supplied secret. No common route is added.

## Request and response boundaries

- JSON is at most 256 KiB, with one nonempty input of at most 32,768 valid UTF-16
  units. The selected model must match the native body exactly. Voice and
  `response_format: "pcm"` are explicit. All speed fields, including speed 1,
  are rejected. The existing bounded provider privacy fields are preserved.
- No voice defaults, provider routing options, input references, uploads, URLs,
  stream flag, query, model passthrough or alternate destination are accepted.
  `Kore` in the test is the frozen configuration example, not live voice proof.
- Output requires HTTP 200, bare `audio/pcm`, no redirect or range, and complete
  nonempty EOF. At most 16 MiB and 8,192 reads are allowed, counting empty chunks
  and EOF. The aggregate byte count must be even; transport chunks may be odd.
- Content-Encoding may be absent or identity only. Identity is removed from
  the reader view while original Content-Length remains available for exact
  validation. The original response headers are not mutated.
- No audio escapes before complete validation. Aborts, timeouts, interruption,
  invalid metadata and overflow produce a sanitized failure. Output includes
  only MIME, actual length, no-store, nosniff and an optional bounded generation
  ID. A generation ID is diagnostic metadata, never later-call authority.

The [exact OpenRouter model page](https://openrouter.ai/google/gemini-3.1-flash-tts-preview)
describes 24 kHz, 16-bit mono output. The
[OpenRouter TTS contract](https://openrouter.ai/docs/guides/overview/multimodal/tts)
requires PCM for Gemini. Signedness and byte order are not qualified here.
The existing codec still returns `sampleRate: null`. Frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` returns `.pcm` with
`voiceCompatible: false`; this leaf does not change that behavior. No PCM
playability, WAV conversion, Talk compatibility, resampling or telephony rate is
claimed. Test bytes are synthetic opaque transport fixtures only.

## Capacity and accounting

The existing 32 MiB response lease charges 64 MiB in the 96 MiB pool. A separate
16 MiB ingress charge brings the combined admitted charge to 80 MiB. No pool or
shared allocator change is made.

The unchanged codec retains at most 16 MiB of copied chunks and allocates one
final buffer of at most 16 MiB at EOF. Every accepted source backing buffer is
also limited to 16 MiB; shared backing is rejected. Plain Uint8Array views ensure
the codec's `slice()` copies even a Node Buffer instead of retaining its backing.
The transform has writable high-water mark 1 and readable high-water mark 0.
During collection, copied chunks plus two bounded transient source backings fit
within 48 MiB. At assembly, chunk copies, final output and a final source backing
also fit within 48 MiB. The remaining 16 MiB covers bounded metadata, request
cloning and stream bookkeeping. Delivery enqueues the final buffer directly,
without a further whole-output copy. This is a leaf allocation ledger, not
measured common transport retention: actual Worker fetch queues, concurrent
ingress, cancellation and delivery lifetime still require composed proof.

Only complete validation returns `{ tokens: null, outcome: "success" }`.
Sample format, input length, bytes and generation ID establish neither billable
usage nor an invoice. Upstream USD and character usage remain unknown. Hard
upstream-dollar budgets stay closed; explicit `policy_fixed` charging is
separate. Common accounting owns known-unsent versus dispatched uncertainty,
and must not replay a possibly paid POST or infer a refund from a failed read.

Source1 owns routing, original grants, admission and settlement; source3 owns
existing declarations/pricing; source2 owns actual PCM consumption; source6 owns
composed proof. This leaf does not activate a route or complete voice parity.
The separate OpenRouter music reference-image authority/capacity dependency
remains internal and unchanged.

Focused command: `node --test worker/test/native-openrouter-pcm-speech.test.mjs`.
