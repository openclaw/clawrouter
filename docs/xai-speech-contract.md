# xAI native unary speech and voice discovery

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/tts.ts`, `speech-provider.ts` and
`speech-provider-metadata-factory.ts`. This bounded slice covers unary TTS and
the voice-list control. WebSocket TTS and realtime voice/transcription retain
their separate protocol qualification; unary support need not wait for them.

`worker/xai-speech.ts` exports `xaiSpeechFormats`, `xaiSpeechFallbackVoices`,
`prepareXaiSpeech(body)`, `readXaiSpeech(response, request, signal)`,
`prepareXaiSpeechVoices()` and `readXaiSpeechVoices(response, signal)`.

## Native contract

POST `/v1/tts` at the selected xAI API origin with native Bearer auth.
The body has text, voice_id, language, output_format.codec and optional speed.
It has **no model field**. Do not fabricate an OpenAI speech model or rewrite
the native request as `/audio/speech`. Prepare emits no credential; common
materialization owns the selected server API key or separately qualified OAuth
resource. No caller upstream-secret fallback, login or account change.

Keep the five frozen codecs: MP3, WAV, PCM, mu-law and A-law. Require the
documented codec-specific MIME, complete HTTP 200 bytes and a maximum 16MiB
body. PCM must contain whole 16-bit samples. The recorded 24000Hz rate is the
dated service default, explicitly marked `service_default`; it is not a returned
usage or media-analysis measurement. The frozen client sends no sample-rate
override. Client speech/Talk and telephony adapters retain responsibility for
playback, raw PCM interpretation and optional local transcoding.

Preserve voice/language and speech markup. Local text is limited to 60000
UTF-16 units with valid Unicode; this conservative admission bound is not a
billable-character count. Speed stays within 0.7–1.5. Timestamp envelopes,
new output options and unsupported codecs are rejected before egress.

GET `/v1/tts/voices` parses a bounded native voices array, preserving IDs and
optional names/language/gender. The frozen fallback labels ara/eve/leo/rex/sal
are not availability evidence and are never substituted for a failed native
read. Voice discovery caches must remain scoped to the selected credential;
list results do not authorize voice creation or account changes.

## Delivery, billing and integration

Wrong MIME, redirects, ranges, incomplete lengths, invalid voice JSON and empty
speech cannot become successful delivery. Abort cancels stalled readers. No
speculative partial output or automatic POST replay. Fixtures contain synthetic
bytes only, not playable MP3/WAV or observed synthesis.

The current public TTS card lists $15 per million characters. This codec does
not qualify the vendor's billing character unit, rounding, custom-voice charges
or interrupted-request debit. Upstream cost remains unknown; upstream-dollar
hard budgets stay closed until the shared admission/settlement contract is
qualified. Policy-fixed charges remain separate from vendor cost.

Native synthesis format `xai.tts` to `audio.binary`, capability `audio.speech`;
voice-list request/response format `xai.tts_voices` is an accompanying native
control. Source 11.3 owns existing xAI YAML/schema/prices and the exact catalog
link without a fake model row. Source 11.1 owns binary dispatch, admission and
credential selection; source 11.2 actual speech/Talk/voice consumption; source
11.4 OAuth resource eligibility; source 11.6 integrated proof. No route
activation, live call or complete E12 parity claim.

Fixture: `providers/_fixtures/xai/speech.json`. Five tests cover native identity,
all codec MIME mappings, byte completeness, bounded voice discovery and stalled
read cancellation.

Primary evidence checked 2026-11-03:
- [Native TTS, codecs and voice discovery](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
- [Public voice pricing](https://docs.x.ai/developers/pricing)
