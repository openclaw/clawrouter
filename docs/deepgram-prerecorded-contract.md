# Deepgram raw-audio transcription

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/deepgram/audio.ts`, posts raw bytes to
`https://api.deepgram.com/v1/listen`. It selects nova-3 in the query and uses
`Authorization: Token ...`; MIME is native audio or application/octet-stream.
An OpenAI multipart or JSON URL-only implementation does not cover this client.

## Native evidence

- [Prerecorded guide](https://developers.deepgram.com/docs/pre-recorded-audio):
  raw-file POST, Token auth, model and smart_format query, native results.
- [Reference](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded):
  repeated query options, metadata duration/channels and independent channel
  alternatives. callback changes the lifecycle and is rejected in this slice.
- [Pricing](https://deepgram.com/pricing): processed duration across channels,
  model/language/plan-specific prices and separately billed add-ons. A byte bound
  cannot establish audio duration. No current global rate is inferred from a
  streaming-price display or applied to all prerecorded query combinations.

## Concrete handoff

`prepareDeepgramPrerecorded` accepts already bounded bytes and native query,
preserves repeats, rejects callback/URL/credential injection and qualifies nova-3.
The 25 MB cap is a router memory envelope, not a vendor maximum or monetary bound.
The synthetic request bytes and response durations are independent wire examples.
Neither fixture represents paid inference.

The manifest declares `deepgram/nova-3` with upstream `nova-3` and
`audio.transcription` eligibility so native query/default selection resolves
under model policy. Its price card and pricing reference are deliberately absent;
model identity does not qualify upstream-dollar admission.

The activation work is explicitly stacked: source
[PR462](https://github.com/openclaw/clawrouter/pull/462) owns this adapter/YAML;
[PR482](https://github.com/openclaw/clawrouter/pull/482) owns shared runtime/tests
on that source branch. Snapshot integration remains serialized with its owner.

11.1 must add this binary format to the existing authenticated upload controller:
authenticate before reading, bound raw bytes/deadline, resolve the native query
model under policy, re-admit after upload, select the provider credential, reserve,
acknowledge dispatch and send the exact bytes. Do not JSON-stringify the body or
substitute a remotely hosted URL. Keep manual redirects and no replay after
unknown send outcome. Keep both caller and provider budget enforcement.

On bounded complete JSON EOF, `observeDeepgramPrerecorded` validates all tracks
and preserves their order, including repeated speech. Duration/channels are
diagnostic evidence only; they are never OpenAI usage tokens. Errors, partial
reads, cancellations and missing duration retain conservative fixed settlement.
No upstream cancellation/refund is promised on disconnect.

11.6 owns snapshot activation after the real runtime path/tests; 11.2 consumes
`providers/_fixtures/deepgram/prerecorded.json` through the scoped bridge.
The manifest alone must not advertise working binary dispatch. Hard upstream-dollar
budgets stay fail-closed until a whole-upload tariff is qualified, unless an
explicit policy_fixed fee is configured. Flux and realtime WebSockets are separate.
