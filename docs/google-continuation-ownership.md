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
