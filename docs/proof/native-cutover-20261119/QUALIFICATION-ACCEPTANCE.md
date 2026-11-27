# Non-streaming deliberate response-loss acceptance, revision 2

This is an explicit qualification-policy change, accepted by the user after the
targeted hosted result was reported. It does not change the product, frozen
controller or harness, rewrite the hosted verdict, or authorize production.

The original rule accepted a complete HTTP 424 or an HTTP 200 followed by a
recognized body transport failure. The targeted attempt instead received HTTP
200 and a clean EOF after the six-byte, deliberately incomplete JSON prefix.
Its original `responseCheck.passed:false`, payload failure, complete capture,
accounting receipts and evidence seals remain unchanged.

For this deliberate **non-streaming JSON response-loss case only**, accept any
of the original outcomes or application-detected truncation when all of these
conditions are supported together:

1. The request reached the intended attested version and exactly one matching
   synthetic provider attempt. The deliberate loss outcome is delivery_unknown.
2. The client bytes are completely retained within the capture bound and hashed.
   They are the exact injected incomplete prefix, not a valid successful JSON
   response. A timeout, capture limit, wrong version, unrelated error, complete
   successful response or unspecified malformed response does not qualify.
3. A representative supported client, using its ordinary parsed JSON operation,
   rejects those captured bytes without returning a successful result or
   automatically resending that uncertain operation. A separate valid operation
   succeeds through that same client configuration.
4. Independent hosted evidence proves one unclean finish, once-only charging,
   no replay or uncertainty refund, quarantine of the affected grant/slot and
   generation, and seven unaffected members. Cleanup independently proves
   native absence, fixture closure and private-session removal.

Evidence: hosted cutover/controller run
https://github.com/openclaw/clawrouter/actions/runs/44426289658 plus the retained
case-level client, fixture, accounting and cleanup receipts. The exact body hash
is `082027641f4532cec3b8585e1d86e6a9adf1dfb9cd2333de1aca7b1b35cc4ece`.
The local replay uses official `openai` JavaScript SDK 7.60.0 on Node 24.22.1,
normal `responses.create({stream:false})`, retry defaults unchanged at two,
and a five-second safety timeout. It rejected with SyntaxError after one POST
and one fetch invocation. The distinct valid control completed after one POST.
No x-should-retry suppression header or simulated framing error was used.

The local replay reproduces the captured body/status and application/json type,
with a clean chunked HTTP EOF. Other original response headers were not retained.
It exercises the actual SDK parser and retry path, not a parser mock. No real
credential, provider call, Cloudflare call or hosted campaign was needed.

Limits: this proves a representative SDK/version and parsed non-streaming path.
It does not certify every client, a raw-response API that bypasses parsing,
SSE/WebSocket loss semantics, or no SDK retries for timeouts/transport failures.
It does not establish which hosted forwarding hop normalized the error or
attribute a regression to the candidate. Existing independent official-Codex
saved-session evidence supplies continuity within its original scope; the local
positive control does not itself prove saved-session recovery after this loss.

Normal success, rejection/refund, large-payload and overflow requirements are
unchanged. Invalid normal responses remain failures. Request/response buffering,
seamless migration and new production retry mechanisms are not introduced.

Disposition: this one deliberate loss case is supported under revision 2, while
its original transport-specific assertion remains failed under revision 1.
The two targeted attempts and original four attempts remain exhausted. The registry records this reviewed aggregate disposition; the production hold
remains true pending separately authorized activation.
