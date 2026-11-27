# Private Copilot account qualification

The existing grant authorize route accepts the fixed query
`?flow=copilot-account.v1`. This selects bounded intake before generic JSON.
Every operation requires the current, original Cloudflare Access administrator
and a same-origin request. Token-admin and proxy-key authorization cannot use it.

The closed input contains `flow`, `provider:"github-copilot"`,
`operation:"qualify"|"status"|"cancel"`, the committed device `attemptId`,
`expectedGeneration` and `expectedLineage`. The route supplies the original
grant key. No token, domain, URL, identity, entitlement or expiry is accepted.

The private credential owner distinguishes current installation generation from
the acquisition binding preserved by the original token and device attempt.
It persists an account fence before one fixed account GET. The original GitHub
token goes only to the selected-domain account request factory. Remote account
I/O runs outside the ordering tail, so cancellation, replacement and revocation
can proceed. No environment, alternative key or token exchange is involved.

After complete syntax and physical retirement, the existing identity qualifier
applies selected-domain fallback and approved base-path rules. Fresh owner and
administrator checks precede a single durable write of the private identity and
terminal account attempt. The credential generation and acquisition binding do
not change. Device-code expiry is not GitHub-token expiry.

Generic credential materialization remains `reauth_required`. Account identity
is not catalog visibility, model entitlement, inference permission, quota or USD
authority. Neither private account field appears in grant projections. Generic
edits, revocation and a new device acquisition invalidate account state.

Concurrent qualification returns the existing attempt. Status can recover an
atomic commit after publication acknowledgment loss without another HTTP GET.
A restarted dispatch fence or ambiguous failure is unknown; the flow does not
retry or replace that attempt automatically. This first slice binds one account
qualification to one acquisition; future account refresh policy remains separate.

## Finite allocation contract

These are operational limits and owner counts, not a measured V8 heap bound.
The unchanged 96 MiB isolate pool admits a 64 MiB account-owner reservation before
the fence/HTTP, plus 2 MiB for the admin control request. A second 64 MiB account
exchange is refused; small cancel/status requests retain admission headroom.
Device allocation evidence is not reused as account proof.

| Phase | Explicit representations and bounds |
| --- | --- |
| Control | Existing 8 KiB accumulator, 8 KiB returned backing, bounded UTF-16 text/guarded input; only six scalar fields survive closed validation; five forwarded authority headers≤16 KiB each/32 KiB aggregate, original private token≤8 KiB |
| Account I/O |16 MiB cumulative wire; one≤16 KiB returned backing; at most 8192 reads including empty results and EOF; no archive, tee or whole response text/AST |
| Read bookkeeping |One pending physical read; up to8192 native read/retirement/finally/await groups, never a history; one pump abort listener and one outer operation race |
| Projection |384-byte stack,8192-byte URL buffer, fixed scalar parser state, one≤4096-unit string and at most two projection objects |
| Canonicalization |One existing qualifier/URL construction from bounded input;≤48 KiB canonical UTF-8 result, bounded property strings and validation encoding |
| Owner state |At most128 nodes/members, depth6, no arrays/accessors; exact escaped UTF-8 count≤96 KiB BEFORE serialization; device saves retain their 32 KiB ceiling |
| Commit/publication |Current and replacement bounded rows; bounded serialized text/encoding/storage input; replies≤2 KiB per owner/admin producer |

No per-read `HttpOperation.wait` race is created for the account profile. The
owner races the whole operation to keep public cancellation prompt. The reader
continues to own the actual read, FIRST cancellation and lock through physical
settlement. Catalog/device reader behavior is unchanged. Returned backing is
reused; an audio accumulator, unbounded fallback or borrowed foreign reader is
never substituted.

Capacity remains charged through actual fetch settlement, late Response
disposal, reader cleanup, canonicalization and owner settlement. Exchange
response/identity references are cleared only after that work. The owner reply
producer must also reach EOF or cancel before its charge releases once; the
admin copy retains its own charge until its producer completes. Upstream EOF
or a prompt public error alone is insufficient. Cleanup rejection denies
qualification; an unreleased original lock cannot retire the charge.

Dropping an owner reference is not a garbage-collection or remote client-buffer
claim. The ledger does not assign invented byte sizes to engine promise or URL
objects. Cross-DO producer acknowledgment and unrelated inference/account
entitlement remain separate boundaries.

## Qualification

Focused owner tests cover current Access/scope, acquisition versus installation
binding, private atomic commit, replacement/revocation, unknown/restart behavior,
publication recovery and capacity contention. Actual workerd admin-to-owner
fixtures exercise maximum 16 MiB/structural input, 8192-read admission and 8193rd
denial, held read AND FIRST cancel, late Response disposal and separate-request
cancel/revoke/replace. Barriers are real I/O continuations in the original
request context. Hosted exact-head results determine qualification; these tests
do not perform live GitHub consent or provider inference.
