# Native Google music runtime

The shared selection factory consumes the landed
`prepareNativeGoogleMusic(selection)` wrapper for `google.music_generate` /
`google.music`. The finite declaration contract is
[Google unary music](google-music-schema.md); the source-owned codec and complete
output requirements remain in [the music contract](google-music-contract.md).

Registered `lyria-3-clip-preview` and `lyria-3-pro-preview` models select the
qualified `audio.generate` endpoint on their shared GenerateContent path.
Selection is independent of YAML order. Manifest requests use the explicit
endpoint ID. The caller's policy and original environment/grant credential
remain authoritative; requests use the canonical Google origin, original JSON,
`x-goog-api-key`, manual redirects and no automatic POST replay.

The existing selected-model/ProtoJSON audio classifier prevents generic and
streaming text routes from admitting these requests. The music pricing guard
keeps upstream-dollar hard budgets closed. An explicitly configured
`policy_fixed` charge is separately labeled; native token-shaped metadata is
preserved in delivery but does not become an audio invoice or token charge.

The response lease reserves actual shared capacity before dispatch. Budget
reservations and dispatch acknowledgments precede the one upstream request.
The actual wrapper validates full JSON EOF, explicit MIME, complete MP3 or
qualified Pro WAV, and all response parts before exposing output. It removes
thought parts while preserving final lyrics, native usage metadata and audio
bytes. Text-only, partial, malformed or interrupted output cannot cause replay
or a refund. Known-unsent capacity or acknowledgment failures settle zero;
dispatched uncertainty retains the separately authorized policy charge.

Worker fixtures compose the actual provider compiler, landed wrapper and SQLite
admission/usage ledgers. They cover both models, native/manifest routes,
environment/original grants, endpoint order, unknown-price denial, exact bytes,
inline input, complete EOF, malformed output, caller cancellation, capacity and
missing dispatch acknowledgments. No live generation is used.

This runtime change adds no bundled provider/model rows or snapshot. Source3
owns declarations, source2 the actual music consumer and its no-replay behavior,
and source6 the serialized snapshot and composed client proof. Runtime fixtures
are not a claim that those activation/consumer steps are complete.
