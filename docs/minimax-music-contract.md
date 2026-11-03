# Frozen MiniMax music streaming contract

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/music-generation-provider.ts`. Finite identities:
`music-2.6`, `music-2.6-free`, `music-cover`, `music-cover-free`.
No automatic migration to Music 3 or host-local implementation.

## Availability and original product

The current primary API notice closes paid Music/Lyrics APIs to new users from
2026-08-20; existing paying users may continue. It also announces discontinuation
of the free variants without a date. The codec records those dispositions;
compatibility fixtures do not establish a live entitlement or continued free
availability. Catalog activation must respect those qualifications.

Select the original global `https://api.minimax.io` or CN
`https://api.minimaxi.com` grant. Native API Bearer, plan keys and E09 Anthropic
OAuth resources are not interchangeable by inference. No login, account changes,
credential fallback or client upstream-secret forwarding occurs here.

## Request and concrete client correction

`worker/minimax-music.ts` exports `miniMaxMusicModels`,
`miniMaxMusicAvailability`, `prepareMiniMaxMusic(region, body)`,
`observeMiniMaxMusic(frames, request, complete)` and
`readMiniMaxMusic(response, request, signal)`.

POST `/v1/music_generation` with `stream:true`, `output_format:hex`, MP3,
44100Hz and 256000bps. Original prompt/lyrics/options are retained, not silently
translated. Regular models accept lyrics or `lyrics_optimizer:true`; instrumental
requests must omit lyrics and the optimizer. Local lengths follow the documented
2000-character prompt and 3500-character lyrics bounds conservatively in UTF-16.

Cover models require exactly one `audio_url` or `audio_base64`, a 10–300-character
style prompt, optional 10–1000-character lyrics, and no instrumental/optimizer
flags. **The frozen client exposes cover IDs but never supplies reference audio;
its generic request is invalid and is rejected before egress.** Source 11.2 owns
the actual input-reference correction. Raw `cover_feature_id` stays closed until
durable original-caller/credential asset binding exists. No preprocessing call
or raw feature-ID pass-through is introduced.

HTTPS reference URLs are opaque upstream input, never router fetch targets.
Inline reference encoding is bounded to 8MiB, below the primary 50MB limit.
Encoding checks do not establish playable audio or the required 6-second to
6-minute source duration. Actual client/runtime asset qualification must enforce
that duration and media validity before cover activation.

## Complete stream and accounting

Accept native SSE or complete JSON with HTTP 200, no redirects/ranges, valid
UTF-8 and complete bytes. Stage audio until a status-2 terminal frame; `[DONE]`
alone, EOF, vendor errors and post-terminal data cannot finalize a track.
The frozen consumer ignores terminal audio when earlier deltas exist. This
codec instead verifies that a supplied terminal full-file aggregate starts with
the earlier decoded prefix, then uses it once. An ambiguous terminal delta or
contradictory aggregate fails closed. A status-2 frame without audio may close
the already staged deltas. Six sanitized state tests establish this accepted
subset; a different native terminal form needs qualification before widening it.

Local bounds: 8MiB output, 2048 frames and five times the audio limit plus 64KiB
for the SSE envelope. No speculative partial track, URL download, bare binary
fallback, remote task ID or automatic POST replay. Abort cancels stalled reads.
Final metadata must agree with byte size and selected audio settings when
present. Native `music_duration` is observed in milliseconds, not a price input.

The public existing-user Music-2.6 card lists $0.15/track up to five minutes;
the inspected card does not qualify a cover tariff. This does not prove an
account debit, lyric-generation surcharge, interrupted-work refund or safe
pre-dispatch total. All upstream costs remain unknown; upstream-dollar hard
budgets stay closed until qualified. `policy_fixed` remains a separate basis.

## Integration handoff

Proposed exact native request/response format `minimax.music`, capability
`music.generate`, existing provider `minimax`. Source 11.3 owns existing
YAML/schema/catalog; source 11.1 owns dispatch, admission, deadlines and
accounting; source 11.2 owns actual music consumption/reference correction;
source 11.4 owns grant/product qualification; source 11.6 integrated proof.
No manifest activation or claim of complete E10 parity is made by this codec.

Fixture: `providers/_fixtures/minimax/music.json`. Synthetic bytes prove encoding,
not playable MP3 or measured duration. No live call or deployment.

Primary evidence checked 2026-11-03:
- [Native music schema and availability notice](https://platform.minimax.io/docs/api-reference/music-generation)
- [One-step and owned-feature cover workflows](https://platform.minimax.io/docs/guides/music-generation)
- [Existing-user music pricing](https://platform.minimax.io/docs/pricing/overview)
