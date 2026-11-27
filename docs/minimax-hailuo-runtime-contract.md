# MiniMax Hailuo text-to-video runtime

This slice implements only `MiniMax-Hailuo-2.3` and `MiniMax-Hailuo-02` text-to-video creation, task polling and original-job metadata/content retrieval. Production declarations, generated snapshots and native-client activation are unchanged. Image inputs, Fast, I2V, cover/reference authority, cancellation and result endpoints remain closed. `api.minimax.cn` is not an alias.

## Authority and accounting

A verified administrator explicitly chooses `minimax-global-video` or `minimax-cn-video` through `minimaxVideoAuthorization`. The private closed binding permits only a scalar API key and the exact `https://api.minimax.io` or `https://api.minimaxi.com` destination. Speech, Music, Messages/OAuth, TokenPlan, caller fields and environment keys do not grant video authority.

Requested or existing video authority requires current SQL administrator authorization after credential preparation, hashing and pool admission. The owner computes a domain-separated digest covering actor, original attachment/revision/generation/lineage, result identity and secrets fingerprint, account, expiry, operation binding and mutation mode. A matching bounded reply immediately precedes storage. Pending records cannot enter repair before authorization. Missing or forged metadata projects authoritative null. Rename preserves only unchanged credential authority; rotation, replacement, account/region changes and clearing require the appropriate explicit intent. This is fresh-at-check authorization, not a transaction across Durable Objects.

Creation uses a verified proxy credential. Native inputs require an exact declared upstream model ID; manifest inputs require its exact declared router ID. Ambiguous, foreign and undeclared identities deny before materialization; only the two qualified text-to-video models can proceed. Current effective principal policy and the explicit `media.predict` fixed tariff are checked before secret materialization. An unknown tariff cannot borrow model prices. Policy preparation precedes the final original-owner read. The first admitted current tariff and connection also supply the durable reservation; earlier request snapshots cannot supply a different amount. After a confirmed dispatch acknowledgment, an authority denial remains a readable known-unsent admission result while genuine caller/deadline cancellation remains active. Credential-owner control imports and request preparation complete before the final policy check; only synchronous deadline, caller, expiry and route assertions precede fetch construction. No alternate grant, migration, cache repair or environment substitution is available. The existing route digest gains a Hailuo-only versioned component binding key, generation, lineage, account, operation, region, credential fingerprint and requested model. Other protocols retain their digest bytes. A metadata generation change invalidates controls even if lineage survives.

Collection derives its private context from the original durable job's accounting principal, credential, policy, tenant, model and managed route. It checks current SQL authority, connection and original owner; absent or inconsistent facts deny collection. This context cannot create a job or serve a public file. Every file remains attached to an original succeeded job and a fresh active metadata observation.

One create POST can follow a confirmed dispatch admission. Losing that admission acknowledgment means zero POST, no freeze and no replay. A confirmed acknowledgment followed by a proved pre-send denial uses the existing known-unsent freeze. After POST, losing bind/observe acknowledgments remains uncertain. The durable job owns the original receipt and fixed reservation; unknown outcomes are not refunds.

## Constant operational reservation

Each create, poll, collector or file invocation separately reserves 96 MiB by `BodyLease.grow(48 MiB)` before identity hashing, control exchanges or body acquisition. Failure has zero egress and no durable outcome. File requests inherit this owner and do not acquire the legacy additional 32 MiB file lease. There is no downshift or GC credit.

| Allowance | Simultaneous or cumulatively retained representations |
| --- | --- |
| 48 MiB | 32 nonrefundable tickets, each 1536 KiB: request graph/text/flatten/encoding/transport 512 KiB; response backing/text/flatten/window 384 KiB; at most two parsed/projection graphs 256 KiB; headers/views 64 KiB; error/fallback/continuations 320 KiB |
| 8 MiB | Five separately assigned 1 MiB physical-slot scratch allowances plus 3 MiB serial SQL/hash/preflight scratch |
| 16 MiB | Intake/lifecycle/metadata raw bytes, decoded and int64-normalized text, flattening, graph, bounded projection, serializer, tokens and descriptors; lifecycle and metadata parsers do not run concurrently |
| 16 MiB | One file accumulator, retained through downstream EOF or cancellation; no chunk archive or second complete file copy |
| 8 MiB | Bounded output views, serializer, inspection and delivery queues |

These are enforced operational allowances, not measured heap claims. Successive phases retain the same complete reservation; dead JavaScript representations do not earn early credit. Credential-owner internal storage, upstream forwarding buffers, settlement/sink work and producer cleanup acknowledgments are outside the caller ledger and remain separate qualification boundaries.

Controls are at most 64 KiB UTF-8, depth 16, 512 value/member/entry occurrences, 32768 decoded key/string units and 16384 units per scalar. Preflight precedes whole serialization, encoding and canonical sorting. Headers are at most 32/4 KiB before copying. Input is 64 KiB, native forwarded create 16 KiB and prompt 2000 UTF-16 units. Lifecycle wire is 1 MiB; metadata wire 64 KiB; both are depth 32, 4096 occurrences, 262144 decoded units and 65536 per scalar. Tokenizer feeds are at most 1 KiB UTF-8. Int64 replacement count and total normalized text are checked before joining.

Original readers use a reusable 16 KiB whole-backing BYOB window and at most 8192 reads including empty reads and EOF. Unsupported default-reader producers deny before reading. One 16 MiB accumulator receives file bytes; delivery uses bounded views without transferring that accumulator. Complete structural MP4 boxes and the initial signature are checked before publication, including when the exact download response is labeled `application/json`. This does not establish playability. Vendor URLs never become destinations.

## Exchanges and retirement

The whole invocation admits at most 22 ordinary plus 10 mandatory nonrefundable tickets, with four ordinary physical slots and one mandatory slot. Slots precede serialization and fetch construction. Queued work retains bounded descriptors. Scope and tail counts are preflighted as a whole; cold initialization or overflow denies rather than truncating authorization.

| Invocation | Caller exchange ceiling |
| --- | --- |
| Create | 16 ordinary: authentication/selection 2, connection 1, materialization 1, optional lookup 1, admit 1, POST 1, three connection/policy/owner refreshes 9; at most five mandatory dispatch/bind/observe/files/known-unsent freeze |
| Poll | All S scopes plus 7 ordinary, S at most 15; at most observe and closed-success files acknowledgments |
| File | All S scopes plus 11 ordinary, S at most 11; separate metadata and download connection/policy/owner/GET |
| Collector | Current event policy, connection, owner and GET; acceptance is local |

A grant-owned `/responses/control` transport carries native JSON or file content, not a 64 KiB ACK. Durable-owner internal operations are not included in this caller exchange count. First cancellation consumes no new ticket. Mandatory attempts have a 15-second window; a subsequent allowed attempt waits for predecessor physical retirement. Stalled cleanup retains capacity; it is not successful recovery.

The original absolute deadline covers intake, admission, metadata/download and unclaimed output. At POST only the caller signal detaches; the already-started execution deadline does not reset. Collector time is bounded by ten seconds and `observeUntil`. Each physical read, first cancellation, late response, lock, serializer and downstream owner retires independently before release. A public cancellation can complete promptly while those owners remain charged. No encompassing completion promise waits on itself, and a transport pipe is not evidence of producer retirement.

## Qualification status

Focused authority/route/operation tests and one isolated Workerd fixture are authored. Hosted execution is required: local dependency admission refused reuse, so syntax checks are not semantic proof. The fixture authors both regions/models and native/manifest routes, actual create/restart/poll/file transport, maximum wire/graph and 16 MiB file delivery, full-capacity contention, original read/first-cancel/late-response cleanup, acknowledgment outcomes and current SQL administrator mutation fencing. Existing Worker/admin/manifests/E2E/native-consumer/security gates must qualify the final head before landing. No live vendor, entitlement, deployment or native-client parity claim is made.

The combined-capacity cases are separate **per-invocation** create, poll and file proofs. Each carries maximum admitted 64 KiB/512-occurrence control replies alongside its reachable native response (1 MiB lifecycle, or 64 KiB metadata followed by the single 16 MiB file backing), and holds output while competing admission is refused. Setup uses real attested owners and the SQL guard to find the largest reachable eligible pool for the complete stored-record shape; the next candidate must deny, and setup revokes it before the measured invocation. The 32-member ceiling does not promise that 32 fully populated projections fit the independent aggregate record limits. Payload phases and retired control representations are covered by one cumulative reservation, with no claim that all earlier graphs remain simultaneously live.

Fixture-side counters record every caller-owned physical exchange by invocation, including control transports and the provider POST. Registered proxy-key paths have one policy scope; their observed counts are checked against create 16+5, poll 8+2, file 12+0 and collector 4+0. Resolver tests separately exercise whole-scope overflow before any lookup; they do not claim that public proxy keys gain multiple policy scopes. A separate actual-transport slot test holds four ordinary original reads/FIRST cancellations while a genuine mandatory managed-files acknowledgment progresses on its independent slot. This is a scheduler invariant, not an artificial expansion of a registered invocation's call inventory. Late-response disposal asserts zero reads plus held first cancellation; already-started-read cases independently retain their read and cleanup barriers. All new semantic and Workerd cases remain authored/unrun until the final hosted head executes them.
