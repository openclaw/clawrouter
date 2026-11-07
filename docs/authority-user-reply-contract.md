# Selected user-query reply ownership

Only generic `policy-bindings` `/users/resolve` replies use this consumer.
Existing specialized owners run first. Other queries, namespaces and the
seventeen acknowledgment paths are unchanged. Requests retain their existing
serialization, normalization, order, deduplication and cold-import behavior.

This is intentional complete-reply operational denial. It neither projects
records nor truncates fields. Unknown fields and parsed duplicate-member
last-wins semantics survive. A valid legacy revision above 64 KiB remains
admitted when its complete reply fits the following profile.

| Representation | Maximum |
| --- | --- |
| Original wire | 1,048,576 bytes |
| Decoded text | 1,048,576 UTF-16 units |
| Depth / values / containers | 16 / 8,192 / 2,048 |
| Members / array entries | 4,096 / 4,096 |
| Aggregate decoded strings, including keys | 1,048,576 UTF-16 units |
| Key / scalar / number token | 1,024 / 1,048,576 / 64 units |
| Whole reused read backing | 16 KiB |
| Owned reads, including empty and EOF | 8,192 |
| Response headers | 32 fields, 4 KiB combined names and values |

Original wire bytes and decoded text are counted separately, before append.
Default UTF-8 replacement and BOM handling match `response.text()`; replacement
characters are not re-encoded to invent additional wire bytes. The closed JSON
guard counts every duplicate and discarded occurrence before `JSON.parse`.
User metadata does not inherit Access key64/kid256, RSA/JWK or evidence caps.
Existing Access profiles are unchanged. Equal wire/text ceilings can dominate
the scalar and aggregate-string ceilings through JSON syntax overhead; tests
must identify the reached guard rather than claim an impossible joint maximum.

Success accepts `response.ok`, including other successful statuses, and an
empty DO URL. There is no MIME gate. A complete JSON envelope must contain
boolean `initialized`, a `users` array of email/record objects, and string
`missingEmails`; additional fields remain intact. Status, malformed protocol,
resource and cleanup failures throw fixed sanitized query errors. They never
become a missing user or authorize creation, a session or another auth fallback.
Storage, existing no-ops and canonical rereads are unchanged. An earlier cold
initializer may already have committed; subsequent failure does not roll it back.

The actual fetch root is registered before invocation. The response body is
owned before header/status rejection. A non-BYOB reader is cancellation-only.
Retirement joins the original pending read and memoized FIRST cancellation,
including cancellation rejection, then verifies unlock. Cleanup failure denies;
an unknown lock retains the owner and completion indefinitely. Late replies are
disposed by the same owner. Raw transport/parser errors and response text do not
enter outward errors. Successful publication rechecks a supplied signal after
all awaited cleanup and listener removal.

No deadline is added. Ordinary `resolveUsers()` supplies no signal, so this does
not establish whole-auth caller-abort behavior. It does not bound request email
count, producer SQL/KV parsing, cold initialization, stored records, shared caches,
common 30/32 MiB allocations, platform memory or whole-heap usage.

## Evidence boundaries

Focused Node tests exercise complete envelopes, exact/reachable plus-one guards,
discarded duplicates, decoding, selected routing, original cancellation and the
final cleanup signal fence. Node byte streams are explicit synthetic producers.
The isolated Workerd fixture first requires the unchanged real SQLite DO reply's
original BYOB body, EOF, identity and unlock. Failure of that prerequisite is a
producer blocker, never permission to replace the healthy body.

Subsequent cases use real SQL/KV cold and canonical records and actual public
Access/JWKS session and separately configured local-login paths. Fault bodies are
labelled local Node HTTP producers. The pending-read fault withholds bytes before
the original native read settles; late-DO and final-unlock faults are injected
continuation intervals. Controlled empty reads begin only after native EOF.
Unknown unlock is tested last as retained ownership; runtime disposal is not
retirement proof. Neither authored assertions nor syntax checks are runtime proof.
