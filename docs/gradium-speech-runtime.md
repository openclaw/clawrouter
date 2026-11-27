# Gradium unary runtime

The shared selection path consumes `prepareNativeGradiumSpeech` through the
existing `NativeResponse` boundary. Native and manifest routes preserve the
model-less JSON settings, including `voice_id`, `model_name` and encoded
`json_config`. The selected server environment or grant credential supplies
`x-api-key`; caller upstream credentials are not forwarded.

The original reservation and dispatch acknowledgment precede the paid request.
The wrapper acquires 32 MiB of shared capacity before fetch for its 16 MiB
complete response bound. Capacity stays held through downstream delivery.
Only complete HTTP 200 WAV or Ogg Opus is returned, with unchanged bytes.
`ulaw_8000` remains denied before dispatch because its HTTP MIME pair is
unqualified. Redirects, ranges, invalid lengths, overflow, interrupted reads and
deadline expiry cannot publish a successful audio prefix or replay synthesis.

Native speech has no qualified whole-request dollar tariff. Hard upstream-dollar
budgets reject it before egress. An explicitly configured `policy_fixed` charge
uses the existing reservation and settlement path; incomplete upstream outcomes
retain that conservative charge. Native voice settings, text length and audio
bytes are not tokens or a fabricated dollar receipt. Known-unsent failures
release reservations. No separate speech accounting system is introduced.

The runtime tests use the actual Worker, source-owned declaration and wrapper,
SQLite budget/usage objects, and synthetic transport bytes. They do not establish
audio playback, live account eligibility, production deployment or actual-client
activation. Provider snapshot and native-client proof remain separate campaign
steps. See [the schema contract](gradium-speech-schema.md) for exact declaration
fields.
