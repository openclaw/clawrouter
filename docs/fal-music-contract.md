# fal unary music

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/music-generation-provider.ts` and `http-config.ts`, sends
JSON POSTs directly to `https://fal.run/<model>` using native
`Authorization: Key <selected server FAL_KEY>`. This is the synchronous
transport, separate from the queue adapter and its job controls.

`worker/fal-music.ts` exports `prepareFalMusic`, `assertFalMusicDispatch`,
`observeFalMusic` and `readFalMusic`. The finite models are:

| Model | Qualified native inputs | Output |
| --- | --- | --- |
| fal-ai/minimax-music/v2.6 | prompt, lyrics or lyrics_optimizer or is_instrumental, frozen audio_setting | MP3 |
| fal-ai/ace-step/prompt-to-audio | prompt, optional instrumental, duration 5–240 seconds | WAV |
| fal-ai/stable-audio-25/text-to-audio | prompt, optional integer seconds_total 1–190 | WAV |

No edits, images, callbacks, alternate endpoint, new model generation, queue
acknowledgement, transport fallback or automatic paid retry is added. The pure
dispatch assertion qualifies the selected path/origin and Key header; source1
still owns credential selection/lineage, authorization, admission and settlement.

The sanitized request/result fixture is `providers/_fixtures/fal/music.json`.
HTTP200 complete JSON contains one `audio` URL string or File object. The
codec retains native body/metadata, checks MIME and advisory file length, and
returns an opaque URL descriptor without credentials. It does not fetch files.
Actual delivery still requires source1/2 output ownership, DNS/redirect policy,
byte/MIME validation and cancellation handling. A URL-only result or local
download failure does not establish free generation.

Source3 schema handshake: proposed request/response formats
`fal.music_create` / `fal.music`, capability `audio.music`, synchronous
POST to the three exact paths above. No lifecycle links or managed job ID.
Source5 owns eventual new fal manifest additions after its active queue PR.
Source1 owns common Worker qualification; source2 owns actual music consumers;
source6 owns snapshots and end-to-end acceptance. No shared files or manifest
are changed by this bounded codec slice. It is not complete provider parity.

## Primary evidence and client corrections

- [Direct synchronous transport](https://fal.ai/docs/documentation/model-apis/inference/synchronous)
  uses fal.run without queue polling. The [HTTP API](https://fal.ai/docs/api-reference/inference-api/sync/run)
  specifies Key auth and HTTP200 output. A retry hint is not permission to replay
  an uncertain paid POST. Local cancellation cannot prove compute stopped.
- [MiniMax 2.6](https://fal.ai/models/fal-ai/minimax-music/v2.6/api) qualifies
  prompt length10–2000, lyrics up to3500 and native audio settings. Its
  [schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/minimax-music/v2.6)
  declares no duration. Frozen OpenClaw forwards duration; this adapter rejects
  that unsupported field instead of claiming an honored duration bound.
- [ACE-Step schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ace-step/prompt-to-audio)
  qualifies duration5–240, including fractional seconds.
- [Stable Audio schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/stable-audio-25/text-to-audio)
  limits integer seconds_total to190. Source2 must correct the frozen shared
  240-second capability cap before claiming per-model native acceptance.

No qualified per-request dollar tariff or settlement receipt is established
here. Native output length, seeds, lyrics and file sizes are not billing proof.
Upstream cost remains unknown and hard upstream-dollar budgets stay closed;
policy_fixed is a separate router charge. No live request, deployment, secret
provisioning or commercial-account change was used.
