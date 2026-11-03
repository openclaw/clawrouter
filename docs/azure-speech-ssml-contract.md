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

11.1 must connect this raw-text format to bounded authenticated request admission,
using fatal UTF-8 decoding, selected-provider policy/credential checks and existing
budget/dispatch/settlement machinery. Validate the configured public-cloud region
with `azureSpeechRegionalOrigin` before credential egress. Caller input cannot
choose region/origin or replace Ocp-Apim-Subscription-Key. Keep body text intact;
generic JSON serialization would change the wire protocol.

The operator configures AZURE_SPEECH_REGION and AZURE_SPEECH_API_KEY. No key reuse
with Azure OpenAI or cross-region fallback is inferred. The binary response uses
the existing MIME/complete-delivery observer; disconnect and empty output do not
prove canceled/free work. Hard upstream-dollar budgets remain fail-closed until
region, voice tier, character bound and tariff are qualified, except explicit
policy_fixed charging.

11.6 owns snapshot activation and real Worker tests after runtime wiring; 11.2
consumes `providers/_fixtures/azure-speech/ssml.json` through the scoped bridge.
The synthetic μ-law silence qualifies bytes, not generated speech. Sovereign
clouds, custom resource endpoints, extra SSML markup/formats, voice discovery and
live paid proof remain outside this first regional unary slice.
