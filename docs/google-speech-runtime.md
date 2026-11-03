# Google unary speech runtime

Shared selection consumes `prepareNativeGoogleSpeech` from the published
[speech wrapper](google-speech-contract.md). The
[finite schema](google-speech-schema.md) and shared model eligibility choose
the exact five frozen models and their transport. This change adds no provider
YAML, generated snapshot, codec implementation or pricing rule.

The three preview models may use their qualified native GenerateContent path
or explicit manifest endpoint. The two Gemini 3.8 models use only the explicit
manifest Interactions endpoint. Ambiguous native Interactions remains closed;
manifest delivery is not native-route proof. Preview offers and dispatch expire
at the existing trusted-clock cutoff without substituting a model.

The ordinary runtime selects and materializes the original credential, checks
the final Google destination, reserves budget and response capacity, records
dispatch, and enforces cancellation and deadline. The existing wrapper validates
every audio block and complete EOF before delivery, with a 64 MiB charged lease.
It retains qualified native JSON and audio bytes while reporting no normalized
token count or vendor invoice. Unknown upstream-dollar budgets deny before
egress; explicit policy-fixed charges remain separate. Dispatched interruption
retains conservative settlement and never retries the generation.

`worker/test/google-speech-runtime.test.mjs` compiles the source-owned declaration
contract in memory and exercises real Worker authentication, SQLite admission,
dispatch and settlement. It covers both qualified transports, environment and
stored original credentials, scoped catalog facts, expiry, wrong-route and
generic/SSE bypass denial, hard-dollar admission, revocation, malformed/partial
responses, full-EOF delivery, cancellation, capacity and dispatch acknowledgment.
The fixture replaces only its exact model IDs and capability bindings so future
source declarations cannot create duplicates or erase unrelated rows.

These are composed runtime fixtures, not proof of a shipped provider snapshot,
actual OpenClaw speech consumption, intelligibility or live vendor execution.
Provider activation, serialized snapshot qualification and actual client proof
remain with their existing owners. No deployment or live generation occurs.
