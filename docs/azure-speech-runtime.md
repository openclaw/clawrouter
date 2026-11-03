# Azure Speech raw SSML runtime

The native route is `POST /v1/native/azure-speech/cognitiveservices/v1`.
The manifest route is `POST /v1/proxy/azure-speech/speech`. Both take the raw
rendered SSML document with `Content-Type: application/ssml+xml` (optionally
one UTF-8 charset) and
`X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3`.
There is no JSON envelope, model selector, query or caller-selected region.

Authentication and provider/policy checks precede reading. Intake allows at
most 65,536 bytes within 30 seconds, verifies any declared length, decodes fatal
UTF-8 and rejects BOMs, encoding transforms and unqualified XML. After upload,
proxy-key admission reads the authority directly, bypassing isolate/colo caches
and inflight admission reuse. Access-session requests re-resolve the current
identity and policy. Caller, principal, tenant and policy identity cannot change
across intake. The final policy and original selected provider credential govern
dispatch; the ordinary preflight credential-failover path is disabled.

`native-raw-input.ts` binds validated input to the internal selection in a
WeakMap. Caller JSON cannot establish that binding. The existing upstream
factory supplies the selected regional URL and credential headers. Region is
derived from that URL, then the source-owned `prepareNativeAzureSpeech` wrapper
pins the exact origin and path. UTF-8 encoding of the validated string preserves
the original bytes without XML normalization or JSON serialization. The
dispatcher owns both Microsoft headers; the wrapper never reads credentials.
Only the configured public-cloud regional origin is accepted. Azure OpenAI,
Edge, custom origins and grant transport rewrites do not inherit this contract.

The existing reservation/dispatch acknowledgment and response accounting path
remain authoritative. The 32 MiB response lease precedes egress. Complete,
nonempty HTTP 200 MP3 is withheld until bounded EOF; rejected or interrupted
delivery does not expose partial audio or replay the POST. Known-unsent failure
settles zero. Dispatched failure retains conservative settlement. Tokens remain
null, and neither XML size nor the codec's character bound establishes a tariff.
Unknown whole-request prices fail upstream-dollar hard budgets before egress;
an explicit `policy_fixed` charge remains separately labeled. When policy
requires request retention, its internal `{ ssml }` record contains the actual
input, while usage events contain no SSML or upstream credential.

`worker/test/azure-speech-runtime.test.mjs` exercises the real Worker, canonical
authority, credential owner, SQLite reservations and usage ledger. It covers
both route forms and environment/grant credentials, raw Unicode bytes, warm-cache
revocation during upload, malformed input and bounds, cancellation/deadlines,
unknown-price denial, dispatch acknowledgment, output capacity and conservative
settlement. Source wrapper/codec tests remain separate and unchanged.

This atomic branch carries the provider declaration and source-owned wrapper
from PR466 unchanged. The integration owner must regenerate the shared snapshot
and qualify final-head Worker/native checks before landing. Actual client proof
is separate. No live paid call, regional credential provisioning, Opus/telephony
activation or claim that transport EOF proves all text was spoken is included.
