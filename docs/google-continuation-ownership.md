# Google continuation ownership

GenerateContent continuation is a new HTTP hop. The opaque top-level
`continuationToken` / `continuation_token` field supplies no authority by itself.
Each hop authenticates, resolves its selected model, reserves its own budget and
settles its own observed usage. The router never starts another hop or retries
an uncertain hop with a different credential or full original input.

The runtime reuses the existing principal-scoped `/http-continuations` store.
Its scope includes caller authentication type, tenant, policy, proxy credential
and principal. A protocol-specific token digest resolves the original grant and
credential lineage. The existing six-field owner remains unchanged; its route
digest additionally binds both selected and upstream model IDs and the exact
original request JSON, excluding only the two top-level continuation aliases.
The original origin, endpoint, configuration and credential binding remain part
of that digest. Changing contents, system input, generation settings, model,
endpoint or credential denies the hop before egress. Alias resolution follows
the existing ProtoJSON last-field-wins rule; nested text or tool names are not
continuation fields.

`worker/google-continuation.ts` owns request resolution, original-owner binding
and returned-token publication. `GoogleContinuation.resolve` pins the original
environment route or grant before selection; `bind` compares the complete owner
before budget admission. Initial requests make no continuation-authority call
unless a usable returned token needs publication.

The existing bounded usage reader supplies complete JSON documents or delimited
SSE JSON observations through `ResponseBodyInspection.acceptJson`. There is no
second response buffer. Only `candidates[].continuationToken` with that
candidate's `finishReason: CONTINUATION` can qualify. The exact native JSON or
SSE MIME must match the declared route. Ownership registration is acknowledged
at response EOF before delivery closes; a partial frame, malformed evidence,
error event or interrupted upstream read cannot qualify pending tokens. Raw
token bytes may already be visible in an unfinished stream, but remain unusable
without acknowledged ownership. Publication failure retains the dispatched
charge and does not replay inference.

Local limits are 16 KiB per opaque token and eight candidate tokens per response,
within the existing 2 MiB JSON/frame inspection bound. Overflow establishes no
ownership. Tokens are never decoded, logged or stored in plaintext; only their
digests and the existing bounded owner record are persisted. No global token
index, background executor or new database framework is introduced.

The pricing dependency is the source-owned full-input-window continuation
reserve in PR635. It does not supply ownership, and this module does not duplicate
pricing logic. Hard-dollar admission still needs that qualified bound and tariff;
explicit policy-fixed charges remain distinct. No Argon offer, tariff, snapshot
or live activation is added here. Native client replay remains independently
owned and must preserve the original model, caller and request.

`worker/test/google-continuation-fixture.mjs` exports
`googleContinuationFixture(t, { stream?, manifest?, pooled?, fixed? })`,
`googleOriginalRequest`, `googleContinuationResponse`, and
`googleContinuationToken`. The fixture's `initial()` obtains a token through the
real Worker, original credential, SQLite authority and completed response before
`request(body)` sends a continuation. Pricing tests must use that real first hop,
not prepopulate an unowned token or bypass the ownership check. Fixtures use the
existing model solely for deterministic protocol/accounting proof; they make no
live long-decode support claim for that model.

## Registered client contract

The dedicated `google-continuation` consumer pins OpenClaw
`b6072e63fdf09422ea70ef4bbdc818536d871047`. It keeps the older Google-text
consumer and its independent pin unchanged. The new fixture selects
`google/gemini-3.5-flash` from the real credential-owned Worker catalog, runs
the production embedded-runner selector with its registered Google fallback,
and retains the registered ClawRouter and final-policy wrappers. It requires
the `boundary-aware:google-generative-ai` strategy and observes the original
managed acquisitions, readers and releases. The raw public `llm.stream` facade
alone selects the generic GenAI adapter and is not this continuation route.
The fixture uses synthetic Google
responses through an isolated Worker and SQLite, with no paid provider traffic.

An intermediate checkpoint and a final `CONTINUATION` frame precede a held HTTP
EOF. The client must withhold its replay receipt while its original read is
pending. After EOF, the caller explicitly supplies that receipt as
`GoogleContinuationOptions.googleContinuation` to a second invocation. The
async final payload policy, original input, model, session, profile, headers and
selected credentials remain bound. The actual upstream bodies must match except
for the owned continuation token. There is no automatic second or third call.

Changed input, final policy, key, profile, session or origin must fail in the
client before another transport. Separate Worker cases revoke or replace the
original grant, change policy generation, or exhaust caller/provider capacity
between completed hops. Authenticated denied hops retain their own zero-charge
receipt; they are not confused with client-only denials that never dispatch.
Successful hops settle separate observed usage at the manifest tariff, with the
continuation reserving its conservative full input window independently.

Late SSE/JSON errors, truncation and `DONE` before actual EOF cannot publish a
receipt. The cancellation case aborts the real caller only after SDK content
arrives; original SDK, Worker, source, handler and accounting work must retire.
This is post-response cancellation, not physical pre-header disconnect proof.
The separate pre-header runtime limitation remains unqualified. Native client
cleanup admission and build-size qualification are also separate from execution
of this explicit fixture pin. The direct manifest tests remain Worker-level
proof; this registered client selects the advertised native route.
