# Bedrock Converse runtime

The shared Worker dispatches explicit `llm.chat` model bindings through these
native formats:

| Request format | Response format | Native path |
| --- | --- | --- |
| `aws_bedrock.converse` | `aws_bedrock.converse` | `/model/${model}/converse` |
| `aws_bedrock.converse_stream` | `aws_bedrock.converse_eventstream` | `/model/${model}/converse-stream` |

The registered upstream model is one opaque path segment. Existing Invoke and
embedding cards do not acquire Converse eligibility implicitly. The route must
explicitly bind `llm.chat`; passthrough, caller query options, transport overrides
and generic streaming declarations are rejected.

After selecting the original server credential, the Worker gives its configured
regional origin to the existing native wrapper. Both wrappers prepare the body
**before** transport serialization and SigV4. Routing-only `modelId` and `stream`
fields are removed before hashing; native tools and signed reasoning remain in
the prepared payload. The final destination must match the server-owned signing
region and Bedrock service. A selected grant cannot borrow environment key
material. Caller AWS headers cannot replace the selected credentials or hash.

Each response leases 64 MiB from the existing shared capacity budget before
dispatch. Unary responses require complete bounded JSON. ConverseStream holds
the complete 2 MiB-bounded wire and decoded events, validates every EventStream
frame and terminal result, then releases the original bytes. This is buffered
delivery, with no incremental latency claim. EOF, cancellation and failure release
the lease through the existing request lifetime.

Validated native usage includes cache reads and writes once in gross input and
preserves the codec's reported-total floor. Native cache TTL details remain in
the response and usage inspection; the existing usage ledger exposes aggregate
cache writes. No new tariff or invoice receipt is inferred. Unknown hard-dollar
bounds remain denied; explicit `policy_fixed` charging is separate.

A valid refusal or modeled failure returns a content-free error with qualified
observed usage. Invalid JSON, corrupt or truncated frames, incomplete tools and
caller cancellation discard buffered output and retain conservative dispatched
cost. The shared runtime does not retry a native response after dispatch. Proven
unsent capacity or reservation-acknowledgment failures settle zero.

`worker/test/bedrock-converse-runtime.test.mjs` exercises actual Worker routing,
original grant selection, SigV4 bytes, SQLite reservation/settlement, cancellation
and buffered delivery with synthetic upstreams. Provider declarations, snapshots,
live regional availability and actual native-client acceptance remain separate
integration work. No live AWS requests are required by these tests.
