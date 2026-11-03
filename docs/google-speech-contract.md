# Google unary speech

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/speech-models.ts` and `speech-provider.ts`.
`worker/google-speech.ts` supplies native preparation and complete-response
validation for exactly these models:

| Model | Transport | Current qualification |
| --- | --- | --- |
| gemini-3.1-flash-tts-preview | generateContent | Published shutdown November 17, 2026 |
| gemini-2.5-flash-preview-tts | generateContent | Published shutdown November 17, 2026 |
| gemini-2.5-pro-preview-tts | generateContent | Published shutdown November 17, 2026 |
| gemini-3.8-flash-tts | Interactions | No shutdown date announced |
| gemini-3.8-flash-lite-tts | Interactions | No shutdown date announced |

The adapter conservatively stops preview admission at 2026-11-17 00:00 UTC,
using the runtime's trusted clock. This is an explicit router qualification
cutoff, not a claim of the vendor's exact shutdown timezone. No model is silently
aliased. Retired models cannot remain working offers after that cutoff.

## Native requests

`prepareGoogleSpeech` returns the unchanged validated JSON body, non-secret
headers and relative native path. Runtime owns original Google credentials,
deadline, provider selection, admission and HTTP execution.

- The three preview models use POST
  `/v1beta/models/{model}:generateContent`, one user text part, AUDIO response
  modality and the native prebuilt-voice configuration.
- The two 3.8 models use POST `/v1beta/interactions`, exact model identity,
  `store: false`, one user-input envelope, structured speech annotations and
  raw `audio/l16` at 24 kHz. Stateless unary requests cannot carry stream,
  background, previous-interaction, tools or remote-media fields.
- Single-speaker Interactions uses a one-element voice array. Dialogue uses
  exactly two distinct speaker names and the conversational speaker map.
  Every dialogue turn must reference that cast; style remains separate text.

Requests are locally bounded to 256 KiB JSON, 64 Ki UTF-16 units per text turn,
256 turns and bounded voice/style metadata. These limits are resource bounds,
not tokenizer or upstream-dollar admission proofs. The actual native client
owns prompt construction, configured voices, dialogue splitting and output
conversion. Voice shape validation does not certify provider entitlement.

## Audio, completion and accounting

`observeGoogleSpeech` accepts only a complete parsed native response; runtime
must enforce a 16 MiB UTF-8 JSON envelope and deadline before parsing.
GenerateContent candidates must stop normally; blocked or partial candidates
cannot publish audio success. Interactions rejects explicit non-completed
status and mismatched model identity. Native output aliases are supported only
when unambiguous; step-based audio is supported.

All returned audio blocks are validated atomically. Base64/base64url must decode
canonically, with at most 8 MiB audio total. PCM is mono signed 16-bit
little-endian at 24 kHz, matching Google's documented format. MIME parameters
must agree with that contract. WAV fallback requires a complete RIFF envelope,
PCM format, mono/24 kHz/16-bit fields, aligned data and consistent chunk lengths.
No URL is fetched and no response is written to the host filesystem.

The observer preserves native usage in the transient body. It does not convert
audio bytes, PCM duration, voice count or text length into tokens or a dollar
invoice. A missing/malformed/partial response is not evidence of free execution.
The consumer must use every qualified audio part or fail explicitly; a valid
first part cannot conceal malformed later audio. Unknown upstream-dollar
budgets stay closed pending model/modality tariff and whole-request bounds;
explicit `policy_fixed` remains a distinct charge basis. Do not replay an
uncertain POST just because the response lacked playable audio.

## Integration handoff

Existing Google YAML belongs to its manifest owner. Proposed capability:
`audio.speech`; native formats `google.speech_generate_content` and
`google.speech_interactions`. These paths overlap generic Google inference
and the separately owned Interactions video replacement: the shared runtime
must dispatch by the selected model and capability rather than assume every
generateContent/Interactions call is text inference.

Runtime owns authenticated, model-scoped selection, capability policy/budgets,
deadline and terminal usage. It must invoke the preview qualification cutoff
before egress and preserve the original selected Google grant. Client owner
consumes `providers/_fixtures/google/speech.json` through the actual frozen
speech provider and keeps its PCM/WAV output contract. Native request replay,
retention and credential fallback cannot be introduced by the bridge.

The focused codec and response wrapper do not change provider declarations,
shared controllers or snapshots. Actual Worker/client delivery and accounting
remain activation gates; no deployment or live call is performed.
Realtime/Live, voice design/replication and newer speech models are outside this
bounded slice.

## Complete-response wrapper

`worker/native-google-speech.ts` exports
`prepareNativeGoogleSpeech(selection): NativeResponse | undefined`. It consumes
the existing JSON `ProxySelection.body`; the published format names above serve
as matching request and response formats for each transport. Selection must use
provider `google-gemini`, capability `audio.speech`, the exact frozen upstream
model and its native POST path. GenerateContent requires the selected model path
parameter; Interactions requires no path parameters and an identical body model.
There is no query, alias, passthrough, streaming or retained-state option. The
destination is exactly `https://generativelanguage.googleapis.com`.

The wrapper preserves validated request JSON and invokes the codec's trusted
preview cutoff before egress. The existing 32 MiB response lease charges 64 MiB
of shared capacity before dispatch. Its tighter output policy requires complete
HTTP 200 UTF-8 JSON at EOF, at most 8 MiB JSON and 32 audio blocks totaling at
most 4 MiB decoded bytes. Every block must have explicit supported MIME and
canonical padded base64. Missing MIME is rejected even where the pure codec
supports a compatibility default. Raw PCM must be aligned mono PCM16 24 kHz;
explicit WAV must have matching RIFF framing and the codec's qualified PCM
fields. WAV bytes cannot masquerade as headerless PCM. Container/alignment
checks do not establish intelligibility or an invoice duration.

Interactions must report `completed` and the selected model. Native REST
`model_output` steps and unambiguous direct audio envelopes are supported;
all final blocks are validated before any output. Thought content is removed,
while final native fields and usage remain unchanged. GenerateContent requires
every candidate to stop normally. No remote file or returned URL is fetched.
Malformed lengths, ranges, redirects, encoded bodies, overflow, interruption
and cancellation cannot produce partial HTTP 200 output or a replay instruction.

Normalized usage is `{ tokens: null, outcome: "success" }` only after complete
validation. Native usage metadata is not an upstream cost receipt. Source1 owns
original credentials, capability/model-aware shared-path selection, admission,
deadlines, bypass closure and conservative dispatched settlement. Source3 owns
declarations and qualified pricing. Source2 owns actual speech consumption;
Source6 owns composed Worker/client proof. Twelve wrapper cases cover these
leaf boundaries; they do not certify activation of a declaration.

## Evidence

Checked current unlocalized sources on 2026-11-03:

- [Speech generation](https://ai.google.dev/gemini-api/docs/speech-generation):
  Interactions single/dialogue wire and PCM/WAV encoding.
- [Deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations):
  the exact three preview shutdown dates and two 3.8 TTS identities.

Seven focused tests cover the five-model transport split, cutoff, stateless
admission, cast binding, complete native output, WAV framing, blocked/partial
responses and invalid later audio.
