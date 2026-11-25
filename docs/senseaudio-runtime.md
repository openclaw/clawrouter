# SenseAudio multipart runtime

The existing transcription controller recognizes the native
`/v1/native/senseaudio/v1/audio/transcriptions` and manifest
`/v1/proxy/senseaudio/transcriptions` routes. The selected declaration must pair
`openai.audio_transcriptions` with `senseaudio.transcription`, use unary POST,
and bind the frozen SenseAudio model to `audio.transcription`. No unified OpenAI
offer, JSON replacement, uploaded-file ID or model passthrough is enabled.

Authentication precedes body inspection. The selected SenseAudio parser profile
bounds the raw multipart envelope to 10,032,768 bytes and each file to 10,000,000
bytes. Only that profile adds `.aac`/`audio/aac` and three-letter language codes;
the existing OpenAI profile stays unchanged. The source-owned
`prepareSenseAudioUpload` validates the parsed fields and creates the native form.
Files retain their original bytes, filename and MIME. The parser and preparer
both retain their independent bounds.

After the upload, the controller re-admits the exact caller, model and provider,
then selects the original environment or grant credential. The final destination
must be `https://api.senseaudio.cn/v1/audio/transcriptions`. Reserve and dispatch
acknowledgment precede fetch. Redirects and uncertain requests are never replayed.

Only a complete HTTP 200 UTF-8 JSON response passes the source-owned observer.
Ranges, compression, malformed bodies and inconsistent lengths fail closed.
Duration, including native millisecond diagnostics, never becomes token usage.
Even an OpenAI-shaped usage field does not establish SenseAudio token accounting.
Unknown upstream dollar bounds deny enforced budgets before egress; an explicit
`policy_fixed` fee remains separate. Known-unsent failures refund reservations;
dispatched failures retain conservative accounting, without asserting free work
from an unqualified upstream error.

The runtime tests compile the exact source-owned manifest in memory. They include
the public client's decoder-qualified 1,401-byte AAC sample and assert one actual
upstream upload, original bytes/credentials and exactly one terminal settlement.
This does not activate the shipped snapshot or prove the actual client bridge.
The integration owner must qualify the provider, runtime and generated snapshot
together on the existing SenseAudio source route, then run the actual client proof.
Deepgram's separate raw-body route remains a separate composition dependency.
