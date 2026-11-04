# Native Groq and Mistral multipart runtime

The common transcription controller recognizes the paired `groq.transcription`
and `mistral.transcription` formats. It consumes the existing codec in
[groq-mistral-audio-contract.md](groq-mistral-audio-contract.md); it adds no provider
YAML, model roster, tariff, alternate transport or generated snapshot.

Only the declared audio model and exact native/manifest endpoint qualify. The
server selects the original API-key owner before reading the multipart body.
After bounded intake, authoritative admission and the pinned owner are checked
again. Final admission and owner metadata checks follow reservation awaits;
rotation, revocation, model-policy changes and environment-key substitution deny
before egress. Caller authentication precedes body reads. Ordinary OpenAI
multipart retains its existing behavior. JSON cannot enter these formats through
the generic proxy preparation path.

The existing parser retains strict duplicate, filename, MIME, framing and option
checks. This profile adds exact Content-Length and 8,192-read bounds, including
empty reads. The original file bytes/name/MIME survive the codec's fields-before-
file multipart serialization. Mistral prompt remains explicitly unsupported.

The request reserves the existing 96 MiB body pool before intake, keeping it
through bounded provider output, settlement and downstream producer EOF or
cancellation. There is no second response lease. Intake remains at 25,032,768
bytes, with a 25,000,000-byte file; responses remain at the codec's 1 MiB bound.
The raw reader's growth/copy phase precedes multipart parsing. The raw buffer is
retired after the File copy; serialization retains the File and its transport
copy, then complete JSON is bounded before delivery. The charge is a conservative
shared admission budget, not a claim about engine-independent object sizes.
No unbounded intake form parser, tee, page archive or pool increase is introduced.

Every dispatch uses manual redirects, the fixed original destination and one
attempt. Only complete HTTP 200 identity UTF-8 JSON validated by the source codec
is delivered. Interrupted, malformed, rejected or redirected dispatched work
keeps its conservative reservation; known-unsent work settles zero. Native audio
seconds and token-shaped fields remain diagnostics: accounting tokens are null,
unknown upstream-dollar budgets stay closed, and explicit `policy_fixed` charges
remain separately labeled.

Worker tests use the actual controller, original credential owners, SQLite
budgets and settlement. A workerd fixture crosses the real multipart fetch/body
path for both native and manifest routes. Four synthetic audio bytes prove wire
identity only, not playability or duration. Provider declarations, serialized
snapshot activation and actual OpenClaw client proof remain with their existing
owners; factory registration alone is not completed provider parity.
