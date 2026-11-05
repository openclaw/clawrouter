# Copilot public operation boundary

This implementation is pending qualification. No bundled provider declaration,
generated snapshot or native-client compatibility is activated by this branch.
The three existing wire formats are Chat Completions, Responses and Messages.
Configured Copilot Proxy is a separate provider.

## Authority and routing

Only an administrator can attest a proxy credential's closed integration profile:
integration ID, editor version, editor plugin version, user agent and explicit
user/agent initiator. Each string is printable ASCII, 1–512 characters, without
surrounding whitespace; integration ID also uses `[A-Za-z0-9._-]+`. The authority
generates the revision. Legacy imports strip the field. Rotation, revocation and
principal/policy rebinding invalidate it; rename preserves it. Public credential
projections expose neither the attestation nor its revision.

The URL determines the registered provider, endpoint, method, paired format and
capability before input reading. Native requests use the exact upstream model;
manifest envelopes use the registered router identity. The model is unknown until
bounded intake. Policy/tenant selection chooses one candidate private owner before
that read. Candidate metadata is not execution authority and never enables generic
credential materialization. A subsequent model or account mismatch denies without
switching owners or replaying the input.

Nondefault private owners are nominated by the current policy's existing
`grantRouting.eligibleGrants` references within that policy or tenant scope.
Their `reauth_required` status remains excluded from generic active-pool
materialization. Metadata selection still requires private owner qualification;
it is not an account or inference permit.

The owner derives acquisition/account IDs and runtime owner binding from private
state. It rechecks the original key, current generation/lineage, current caller
policy and profile revision. Account and model requests use the original GitHub
token. There is no token exchange, inferred TTL, generic permit, fallback key or
environment credential. The protocol body supplies only validated image presence,
not integration identity or initiator authority.

Chat, Responses and Messages use their registered `llm.chat`, `llm.responses` and
`llm.messages` capabilities throughout budget preflight, reservation and settlement.
Their explicit fixed tariffs may differ. Unknown dollar pricing denies enforced
monetary limits before authenticated provider I/O. One operation owns one paid POST
and exactly one conservative settlement.

## Phase allocation contract

The credential owner atomically reserves the existing **96 MiB** before frontend
input reading: **80 MiB account/catalog + 2 MiB control + 6 MiB input + 8 MiB
response**. The frontend receives an opaque single-use continuation, never a lease
or reusable inference credential. Standalone catalog retains its separate 82 MiB
contract. There is no nested catalog charge, pool increase or phase downshift.

These are bounded operational allowances, not measured engine heap sizes. Bounds
cover every retained representation; no admission decision assumes GC has run.

| Input owners that may coexist | Maximum |
| --- | ---: |
| Owner's fixed original JSON intake | 256 KiB |
| Decoded JSON text | 512 KiB |
| Decoded key/string values | 512 KiB |
| Bounded parse/container/property representation allowance | 512 KiB |
| Prepared request serialization string | 1 MiB |
| Prepared request UTF-8 backing | 512 KiB |
| Provider transport request representation | 512 KiB |
| Frontend original/RPC and owner upload read/output windows | 128 KiB |
| Bounded request headers, route/profile and RPC metadata | 128 KiB |
| Remaining shallow copies, bounded continuations and structural allowance | 2 MiB |
| **Total input charge** | **6 MiB** |

The frontend streams the original input without an archive or JSON parse. Each
frontend original read, RPC returned read and emitted output backing is at most
16 KiB, with one queued and one in-flight chunk per stream and HWM 0. The owner
reads at most 256 KiB once; the manifest envelope refers to its existing body graph,
not a second parsed or cloned graph. Prepared provider JSON is at most 512 KiB.
Input and complete response JSON enforce depth 64, 4096 values/members/entries and
262144 decoded key/string units before parsing. Frontend and owner intake each
admit at most 8192 reads including EOF; no read history is retained.

The 8 MiB response share retains the qualified private inference bounds: 256 KiB
unary, 64 KiB complete SSE frame, 32 MiB cumulative wire, original reader/guard,
bounded accounting parser and scalar usage. It also includes frontend DO-returned
and delivery windows, at most 128 KiB combined. No new complete response copy,
event/tool history or second accounting observer is introduced. Each body/frame is
validated before its original bytes leave the owner. DONE is not EOF.

The existing 2 MiB control ledger remains 896 KiB predecessor/current/write record
representations, 512 KiB bounded control input, 256 KiB headers, 80 KiB replies,
128 KiB continuations and 176 KiB structural allowance. Inference admission metadata
is at most 8 KiB; each reply is at most 2 KiB. One inference continuation has at most
three reply producers and one cancel/status participant. It retains IDs/profile/
route data, not another credential row or account/catalog graph. Record and header
bounds are enforced before copies. The two continuations grant different operations.

Fresh authority snapshots are bounded to 128 KiB wire and the existing inference
preparse graph limits, within the account/catalog share. No generic unbounded
`Response.text()` plus parse is used for these operation-owned snapshots. Both
account/catalog responses and discarded metadata remain charged concurrently with
the inference representations; the 80 MiB share is not reused for input or output.

## Scoped discovery

Only `GET /v1/catalog?provider=github-copilot` and
`GET /v1/models?provider=github-copilot` enter this branch. Duplicate or additional
query parameters deny. Other providers' discovery is unchanged. This branch does
not use the entitlement/colo cache. The private catalog remains an 82 MiB operation;
public discovery reserves its own 96 MiB composite, never a nested catalog lease.

The owner derives a fresh account/catalog observation under the same original key,
profile, generation, lineage and deadline. The sole compact response contains a
75-byte header and three bits per registered model: at most 1611 bytes for 4096
models, within the fixed 2 KiB envelope. The header binds version, model count,
ordered compiled registry digest, profile revision and observation ID/time.
The digest includes the complete compiled provider identity and each ordered
model, including endpoint, API, capability, routing and pricing metadata. Each hash
step validates and encodes only one record of at most 16 KiB. Indices and metadata
never come from the public caller. The observation is not a reusable permit.

Owner and frontend maintain one mapping each to their existing compiled registry;
they do not copy upstream rows across RPC. The owner retains its decoded and
discarded metadata in the original 80 MiB share until the public producer retires.
The owner checks current policy/profile/original binding before returning the
bits. After the compact packet's physical reader retires, the frontend rechecks
the original authorization and expected attestation, then intersects the bits
with that current policy. No asynchronous work follows this final authority check
before bounded counting and public headers. This is fresh-at-check authorization;
it does not promise instantaneous cross-owner revocation. A mismatch, expiry or
overflow denies without public partial discovery.

Public records use closed fields and bounded scalars. Models retain registered
identity and qualified API capabilities; price fields remain null. Offers retain
the exact endpoint/capability's fixed-tariff and unknown-price admission result.
Only the preferred native-or-manifest route is emitted, never a unified route.

| Simultaneous discovery representations within the unchanged shares | Bound |
| --- | ---: |
| Owner account + catalog readers, text, guarded parse/projection and discarded metadata | 80 MiB |
| Existing owner/control representations, one public continuation, three reply producers and one cancel/status participant | 2 MiB |
| Original authority snapshots/control metadata, bounded hash record/string/encoding, fixed mapping/seen-ID references and control/RPC windows | 6 MiB |
| Public-record/serialization/publication operational allowance | 8 MiB |

Within the 8 MiB allowance, the owner retains one compact packet (2 KiB), the
frontend one fixed packet (2 KiB), and at most 128 KiB of original/RPC/delivery
windows. Counting and delivery are sequential passes. Each holds only one closed
model or offer record, one bounded record string, one encoded chunk and at most
one queued plus one inflight output chunk; each encoded backing is at most 16 KiB.
There are at most 4096 model records and 12288 preferred-route offers over the
whole response, not simultaneously allocated copies. Three endpoint records,
three capability slots, a three-entry readiness set and fixed top-level metadata
are the only retained projection structures. Static identity strings are borrowed;
no full public model/offer array or serialized output is retained.

The exact UTF-8 counting pass runs before headers and the first public byte and
rejects output above 4 MiB. Delivery repeats the same bounded record generator,
checking the final exact byte count. These bounds qualify operational ownership,
not measured engine heap or immediate garbage collection. Public retirement
joins the compact reader, original cleanup, serializer and downstream EOF/cancel
before the opaque continuation retires. No public IDs or receipt are emitted.

## Retirement

Reserve finishes before execute starts in a separate HTTP request context. The
frontend registers original input, DO fetch, late-response disposal and returned
body owners before racing public cancellation. Every reader joins its pending read,
FIRST cancellation and lock retirement. Output uses fresh byte windows; detachable
BYOB output never receives an input backing.

The frontend closes its producer before reporting its own retirement. The private
retirement reply closes before allocation retirement, avoiding a reply/lease cycle.
Registration closes before joining all admitted participants. The owner retains
the full charge through physical cleanup, accounting, frontend publication and
downstream EOF/cancel, including refusal and cleanup rejection. No reply is evidence
that a distinct upstream producer behind DO transport has retired; that acknowledgment
remains a separate unqualified boundary.

## Required qualification

Hosted tests must cover all three APIs through native and manifest routes; exact
capability tariffs; unknown-price zero provider egress; admin-only profile storage
and revision changes after awaits; authority before the first input read; maximum
combined representations/read counts; full-charge control; independent held read
and FIRST cancel; late Response disposal; replacement/revoke; slow delivery and
exactly-once settlement. Separate frontend and owner workerd isolates are required.
Node logic and static syntax checks do not substitute for that proof.

Native-client composition is separate. The frozen client needs exact eligible
offer/API/path selection, scoped omission of Responses `store:false`, and one caller
signal/remaining deadline through discovery and dispatch. No compatibility claim
follows from registering these Worker routes.
