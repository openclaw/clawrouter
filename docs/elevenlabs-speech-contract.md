# ElevenLabs unary speech

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/elevenlabs/speech-provider-factory.ts`, submits JSON to the
voice-scoped `/v1/text-to-speech/{voice_id}` path with xi-api-key. Native model_id,
voice_settings, seed and normalization stay in the body; output_format and
optional optimize_streaming_latency stay in the query.

The manifest declares this route. The focused wrapper qualifies complete MP3
delivery through the shared native-response ABI; declaration alone does not
activate it.
The frozen default is eleven_multilingual_v2; default normal output is
mp3_44100_128 and voice notes use opus_48000_64. This wrapper accepts only
mp3_44100_128 / audio/mpeg. The fixture is offline-generated silent MP3 at
44.1 kHz mono / 128 kbps, verified with ffprobe; it is not a live generated voice
or a billing receipt. Opus/PCM/WAV remain outside this qualified route.

## Evidence and boundaries

- [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
  qualifies the voice path, query, JSON and binary response. Some formats require
  a higher subscription tier. Latency optimization is deprecated upstream;
  preserving the frozen client's query does not guarantee that optimization.
- [Authentication](https://elevenlabs.io/docs/api-reference/authentication)
  specifies xi-api-key. Caller proxy authorization never becomes that key.
- [API pricing](https://elevenlabs.io/pricing/api) varies by model and plan.
  The manifest has no universal speech rate: native model_id is not resolved
  as a registered model, and billed character/plan qualification remains.

This is provider-wide capability selection. Native voice/model IDs are not
registered policy model IDs. Hard upstream-dollar budgets must reject unknown
pricing before fetch; explicit policy_fixed is a policy fee, not vendor cost.
Binary MIME/EOF proves delivery only. Partial delivery and disconnect do not
prove that upstream work was canceled or free.

## Exact wrapper input and delivery contract

`worker/native-elevenlabs-speech.ts` exports
`prepareNativeElevenLabsSpeech(selection: ProxySelection): NativeResponse | undefined`.
It consumes the actual PR639 query ABI, qualified source
`431b3d59e1071e2cd2c30af6782ead45f17accfe`:
`selection.nativeQuery` is the frozen ElevenLabs binding with outputFormat
mp3_44100_128 and optional optimizeStreamingLatency string 0 through 4.
The response wrapper returns that same binding as `query`. Shared dispatch
owns query parsing, canonicalization, credential selection and final destination
comparison. No arbitrary query or caller-selected origin is forwarded.

The selection is provider elevenlabs, capability audio.speech, model null,
POST, request format elevenlabs.speech and response format audio.binary.
The endpoint is exactly `/v1/text-to-speech/${voice_id}`, with one voice_id path
parameter of 10–40 ASCII alphanumerics. upstreamPath, endpoint query defaults,
streaming, lifecycle, WebSocket and model passthrough are rejected.

There is no preexisting ElevenLabs validator export. The wrapper explicitly
validates the frozen native JSON without rewriting it: nonblank well-formed
text up to a local 10,000 Unicode-code-point ceiling; optional bounded native
model_id; unsigned 32-bit integer seed; auto/on/off text normalization; two-letter
lowercase language_code; and native voice_settings. The frozen client accepts
stability/similarity_boost/style in 0–1, boolean use_speaker_boost and speed in
0.5–2. Unknown fields, including body model/output_format/stream overrides,
are denied. These are bounded input checks, not new model eligibility or a
guarantee of vendor/model-specific settings support.

`acquire()` uses the existing 32 MiB pre-dispatch lease for at most 16 MiB of
complete output. Only nonempty HTTP200 audio/mpeg with complete EOF is returned,
byte-for-byte, with usage `{ tokens: null, outcome: "success" }`. Redirects,
ranges, nonidentity encoding, malformed or mismatched length, overflow and
interruption fail without exposing partial HTTP200 audio or raw upstream errors.
The reader cancels on abort; cancellation is not proof of free upstream work.

Known-unsent validation/capacity failures do not consume a synthesis charge.
After dispatch, failure retains the original fixed reservation, produces no
invented tokens, and cannot replay the request. The actual shared dispatcher
and settlement owner determine that distinction; the wrapper supplies no
zero-cost or refund verdict.

## Integration

Integration owns snapshot regeneration and all-manifest validation. The scoped
client bridge must pass the selected native voice path, body and output query,
using its proxy credential separately from the upstream key. Fixtures at
`providers/_fixtures/elevenlabs/speech.json` are the portable consumer contract.
Worker tests cover native and manifest paths, query placement, credentials,
audio bytes, unknown-price budget refusal and unsuccessful delivery.
The new wrapper unit tests exercise the published query factory, actual compiled
declaration, capacity lease and binary reader. Corrected legacy Worker tests
require source1's real selection wiring; tests do not install a production
adapter override. Source1 retains auth, selection, deadlines and accounting;
source3 retains schema and source6 retains snapshots and actual client proof.

The /stream, timestamped JSON, voice management and multipart Scribe endpoints
are outside this unary slice. No deployment, paid entitlement or live cost proof
is claimed.
