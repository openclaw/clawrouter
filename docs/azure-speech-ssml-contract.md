# Azure Speech regional unary SSML

This is the Azure Speech service, separate from Azure OpenAI and the host-side
Microsoft Edge TTS package. Frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/azure-speech/speech-provider.ts`, sends a simple single-voice SSML
document to a configured regional /cognitiveservices/v1 endpoint.

## Primary contract

- [REST reference](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech):
  regional resource-key binding, application/ssml+xml,
  Ocp-Apim-Subscription-Key, X-Microsoft-OutputFormat and User-Agent; binary output.
  REST output exceeding ten minutes can be truncated, so EOF is not proof that
  the whole input was spoken.
- [Billing characters](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech#billable-characters):
  characters, whitespace and applicable SSML markup count; speak/voice tags are
  excluded; Chinese characters, including Han characters in other languages,
  count twice. Language mismatch can still be billed without generated speech.

## Adapter and activation

`prepareAzureSpeechSsml` recognizes the exact simple grammar emitted by the
frozen client. It preserves the document, validates XML character/entity bounds,
rejects nested/general XML and external resources, and accepts the three frozen
normal/voice-note/telephony defaults. This is not a general SSML parser.
The 64 KiB document cap is a router envelope. The character upper bound doubles
encoded UTF-16 text units, conservatively covering entity spellings and Han
weighting. It is not claimed as an exact invoice count or a dollar tariff.

`prepareNativeAzureSpeech(selection, input)` consumes the existing `ProxySelection`
and `{ body: string, contentType: string, outputFormat: string, region: string }`.
It returns the existing `NativeResponse` or `undefined` for another format. It
requires the model-less `azure_speech.ssml` POST `/cognitiveservices/v1` route,
`audio.speech` capability and `audio.binary` response; no query, path selectors,
streaming, lifecycle or alternate dispatch path is accepted. It calls the actual
`prepareAzureSpeechSsml`, preserving the original SSML without modifying selection
or adding a body override.

11.1 owns authenticated raw intake, a 64 KiB byte cap, fatal UTF-8 decoding and BOM
rejection before preparation. The wrapper also rejects a leading BOM, invalid
XML/UTF-16, oversized encoded text and non-UTF-8 content types. `contentType` must
be `application/ssml+xml`, optionally with a single UTF-8 charset parameter.
`region` comes from the selected original destination, never caller input or a
wrapper-side environment fallback. The wrapper validates that public-cloud name
with `azureSpeechRegionalOrigin` and pins the returned origin and path. 11.1
retains the original credential/grant, validates the pinned destination, obtains
fresh admission and sends the original bytes with `Ocp-Apim-Subscription-Key`
and the selected `X-Microsoft-OutputFormat`. Generic JSON serialization would
change the wire protocol.

## Complete MP3 response contract

The first wrapper qualifies only `audio-24khz-48kbitrate-mono-mp3` and an exact
`audio/mpeg` response media type. The other two codec formats remain wire evidence,
not qualified wrapper output. Microsoft's [output-format enum](https://github.com/microsoft/cognitive-services-speech-sdk-js/blob/master/src/sdk/SpeechSynthesisOutputFormat.ts)
defines this MP3 format; its [audio destination](https://github.com/microsoft/cognitive-services-speech-sdk-js/blob/master/src/sdk/Audio/SpeakerAudioDestination.ts)
maps MP3 to `audio/mpeg`. This strict acceptance profile does not claim that every
regional HTTP response has that MIME or relabel an unqualified response.

`acquire()` uses the existing 32 MiB shared capacity lease before dispatch for a
16 MiB complete-output limit. `read(response, signal)` accepts only nonempty,
complete HTTP200 audio with matching bounded Content-Length when present. It
rejects redirects, ranges, non-identity encoding, malformed lengths, overflow,
interruption and abort. It cancels the local response reader on failure; no
upstream cancellation or refund is inferred. Valid output bytes are unchanged,
upstream headers are removed and usage is `{ tokens: null, outcome: "success" }`.
The 720-byte offline MP3 fixture in the wrapper test is verified as 24 kHz mono,
48 kbit/s; it is separate from the original synthetic μ-law fixture and is not
live vendor audio. The wrapper validates transport completion, not decoded speech
content or whether the service spoke the entire input before its duration cap.

The operator configures AZURE_SPEECH_REGION and AZURE_SPEECH_API_KEY. No key reuse
with Azure OpenAI or cross-region fallback is inferred. Known-unsent rejection
has zero upstream cost; dispatched errors, empty output, interruption and abort
remain conservative under the shared settlement machinery. No POST replay or
automatic refund is authorized. Neither the character bound nor null tokens
establish an invoice. Hard upstream-dollar budgets remain fail-closed until
region, voice tier, character bound and tariff are qualified, except explicit
policy_fixed charging.

11.1 still owns raw-body dispatch wiring, auth, headers and accounting; this
wrapper alone does not activate the provider. 11.6 owns snapshot integration and
real Worker acceptance after runtime wiring; 11.2
consumes `providers/_fixtures/azure-speech/ssml.json` through the scoped bridge.
The synthetic μ-law silence qualifies bytes, not generated speech. Sovereign
clouds, custom resource endpoints, extra SSML markup/formats, voice discovery and
live paid proof remain outside this first regional unary slice.
