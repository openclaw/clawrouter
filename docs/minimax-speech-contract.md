# MiniMax native unary speech

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/speech-provider-factory.ts` and
`media-provider-runtime.ts`. The eight frozen speech-2.8, 2.6, 02 and 01 HD/turbo
identities remain named in the current native HTTP API. No newer model or
cross-provider alias is introduced.

`worker/minimax-speech.ts` exports `miniMaxSpeechModels`,
`miniMaxSpeechPath`, `prepareMiniMaxSpeech`, `observeMiniMaxSpeech` and
`readMiniMaxSpeech`. Prepare returns native JSON/path/non-secret headers only.

## Wire and acceptance

POST `/v1/t2a_v2`, selected native Bearer credential, JSON request/response.
This frozen slice requires `stream:false`, `output_format:"hex"`, 32kHz MP3 and
the original voice ID/speed/volume/pitch fields. No URL download, transcode, voice
creation or silent option translation. Text is locally limited to fewer than
10,000 UTF-16 code units; this conservative bound is not a billable count.

A valid complete response requires `base_resp.status_code:0`,
`data.status:2`, and nonempty even-length hexadecimal audio. Decode exact bytes;
reject errors, partial output, foreign model metadata and inconsistent media
metadata. Local limits are 8MiB decoded audio and twice that plus 64KiB JSON.
The reader enforces valid UTF-8 EOF, HTTP 200, byte bounds and cancellation,
including stalled bodies. No uncertain POST replay is authorized.

Native `extra_info.usage_characters` is the billable-character observation.
`word_count`, `usage_voice_count`, input text length and audio duration cannot
replace it. Missing or invalid usage stays unknown. Audio duration is observed
in milliseconds; it is not a charge formula.

## Product and cost boundaries

The frozen client can fall back through portal OAuth/plan environment sources.
That behavior does not qualify arbitrary credential reuse at the router.
The existing E09 materializer binds Anthropic resources separately. Source 11.4
and 11.1 must qualify native-media access and original regional resource/grant
before activation; no account/region fallback, refresh on egress or client
upstream-secret forwarding is added here. The primary HTTP contract documents
native API-key Bearer authentication. CN and OAuth/plan media eligibility are
separate handoffs, not inferred from the global API key.

The public global card lists $100/M characters for the qualified HD families and
$60/M for turbo (2.8, 2.6, 02); no inspected speech-01 rate is assigned. Voice
design/cloning can add a first-use charge. Those prices and returned counts do
not establish a pre-dispatch upper bound, selected account entitlement or every
voice's actual total charge. This codec calculates no cost. Unknown upstream-USD
hard budgets remain closed; policy-fixed charges stay distinct.

## Consumer handoff

Proposed exact native request/response format: `minimax.speech`, capability
`audio.speech`. Source 11.3 owns existing MiniMax YAML/schema/catalog; source
11.1 owns native JSON dispatch, admission/accounting and response qualification;
source 11.2 owns actual speech/Talk consumption and optional local Opus
transcoding; source 11.6 owns actual Worker/client proof. The response remains
native JSON with hex audio, not a fabricated OpenAI binary response.

Fixture: `providers/_fixtures/minimax/speech.json`. Three synthetic bytes prove
encoding only, not playable MP3 or measured duration. Six focused tests cover
wire identity, settings, billing-field selection, error/partial handling,
complete delivery and cancellation. No live call, deployment or route activation.

Primary evidence checked 2026-11-03:
- [Native synchronous HTTP schema](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [Global public pricing and voice fees](https://platform.minimax.io/docs/pricing/overview)

