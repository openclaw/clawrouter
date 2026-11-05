# Private Copilot inference owner

The credential owner exposes the internal `POST /copilot-inference` operation.
There is no public route, provider declaration, generic credential activation or
native-client activation. A successful operation is not a reusable permit.
Configured Copilot Proxy remains separate.

The private input extends the catalog input with explicit `initiator: user|agent`
and a JSON `body`. The selected canonical model and advertised format are
required. The body carries the exact upstream model and an explicit `stream`
boolean. `x-clawrouter-copilot-deadline` is the original absolute deadline and must
match the input; it applies from byte zero. This internal header is not a public
caller authority source. Trusted runtime identity and initiator must be supplied
by a future qualified caller bridge, never copied from public headers.

## Authority, dispatch and settlement

The original current grant generation/lineage, committed device/account attempts,
selected GitHub domain and account binding are checked separately from historical
device acquisition binding. The original GitHub token remains inside the owner.
Every operation performs a fresh account GET and models GET using that token and
the same operation deadline. The account destination must match the committed
binding exactly, including its base path. No `/v2/token`, token-expiry inference,
environment fallback or alternate owner is used.

Only the current, enabled, visible exact model and its advertised Chat Completions,
Messages or Responses format can proceed. The verdict intersects original and
current caller policy. Unknown policy, empty inventory and hidden/unconfigured
models deny; no seed fallback or consent inference occurs. Existing account
cancellation, grant replacement and revoke invalidate active inference too.

Unknown-price hard-budget preflight happens before either authenticated GET.
The `github-copilot` guard prevents model/token-price fallthrough and preserves
explicit `policy_fixed` pricing. Existing reservation and dispatch acknowledgments
precede the sole inference POST. Policy and owner are checked again after awaits;
the final owner read is the last await before synchronous caller/deadline checks
and fetch. Remote I/O never occupies the owner's ordering tail. No automatic
retry or paid replay exists.

Before output release, the original caller/owner is checked again. Streaming uses
the existing configured authority cadence, plus synchronous expiry and local
owner invalidation; final EOF requires a fresh check. Unary output is quarantined.
SSE releases only complete validated frames and preserves backpressure. Earlier
valid frames are not revoked by a later invalid frame. Terminal events and DONE
are not source EOF. Original accounting observes bounded delivered bytes; one
settlement owns the result. A possibly paid failure or cancellation retains the
reservation conservatively. Physical retirement does not rewrite that outcome.

## Composite operational allocation

One synchronous `BodyLease.grow(48 MiB)` atomically charges **96 MiB** in the
existing pool before input consumption. The lease remains private to the owner.
No caller allocation, zero-charge qualification, nested account/catalog lease,
release/reacquire or phase downshift exists. Standalone catalog remains 82 MiB.
These are operational reservations, not measured heap or engine object-size
claims. No phase relies on GC before admitting the next phase.

| Simultaneous owners | Charge |
| --- | ---: |
| Existing combined account/catalog wire, text, AST including discarded metadata, normalized rows, policy projection, reader continuations and scratch | 80 MiB |
| Private control, bounded predecessor records, authorization and retained publication state | 2 MiB |
| Inference input graph and request construction | 6 MiB |
| Inference response, accounting inspection and queued delivery | 8 MiB |

The 6 MiB input allowance includes a 256 KiB fixed intake, a 16 KiB returned
window, up to 512 KiB decoded text and 512 KiB decoded strings, bounded 4096-node
parse/tokenizer state, up to 1 MiB serialized request string, 512 KiB request
encoding and 512 KiB upload representation. The remainder covers shallow request
construction, bounded headers/control, promises and scratch. The prepared body
is measured without a second whole-document serialization before the existing
factory constructs its Request. It must fit 512 KiB. The original input graph and
request owners stay charged until the operation and upload consumption retire.
The factory-created request has a separate original reader: its backing is bounded
by the already-measured 512 KiB representation and it emits fresh chunks of at
most 16 KiB. This is not a fallback for external input or response BYOB. Its
physical EOF/FIRST cancellation and lock are joined explicitly; receiving response
headers alone cannot retire upload ownership. There is no tee or replay copy.

The 8 MiB response allowance includes a 256 KiB unary or 64 KiB frame buffer,
16 KiB original read backing, decoded guard text/strings and at most 4096 parsed
values, the existing usage inspectors and their bounded metadata, retained
previous scalar usage, tokenizer scratch, one queued accounting/delivery chunk
and one in-flight 16 KiB chunk. No event, tool or usage archive is accumulated.
The guard runs before either its JSON parse or the accounting observer's parse.
The catalog graph remains charged concurrently; its allowance is not reused for
inference.

Each complete unary body and SSE frame is checked before parsing: depth 64;
4096 values, members and array entries each; 262144 decoded key/string UTF-16
units. All duplicate and discarded occurrences count. Token feeds are at most
1024 UTF-8 bytes with raw surrogate pairs preserved. Unary wire is at most
256 KiB, each complete SSE frame 64 KiB and cumulative SSE wire 32 MiB.

Input and each of account, catalog and inference responses allow at most 8192
reads INCLUDING empty results and EOF. Thus authenticated responses allow at
most 24576 reads, with a separate 8192 input-read limit. Every returned inference
or input backing is at most 16 KiB, not merely its visible slice. No per-read
HttpOperation race/history is retained. Existing account/catalog wire, shape,
row, URL and record limits remain unchanged.

## Physical retirement and proof

Whole-operation cancellation and accounting remain prompt. Separate retained
ownership joins the original pending read, FIRST cancellation, lock retirement,
late-response disposal, upload consumption, active inspection and downstream
EOF/cancel. Cancellation starts before joining a pending pull. Cleanup rejection
is distinguished from success, while settlement still waits for the physical
continuations to retire before releasing charge. No second cancel is treated as
proof that the first cleanup completed. No producer-side cross-DO acknowledgment
or retained-buffer capacity claim is made.

Focused Node tests cover private owner and policy denial, exact APIs, pricing,
reservation-await replacement, contention and independent cleanup barriers.
The actual workerd fixture uses real admin device/account setup, the real
credential owner, intercepted fixed destinations and HTTP response bodies. It
exercises all three APIs in unary/SSE modes, maximum combined shapes, incremental
frames, exact read limits, held input/read/cancel cleanup, late responses,
revocation/replacement/account cancellation and exactly-once conservative usage.
These tests require actual hosted qualification; authored fixtures alone are not
runtime proof. Native-client composition and public activation remain subsequent
original dependencies.
