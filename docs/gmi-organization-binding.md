# GMI original-account organization binding

GMI Chat and keyed OpenAI-format model discovery use the existing selected
API-key credential. When its authoritative credential-owner record has an
`accountId`, the Worker sends that exact value as `X-Organization-ID`. Absence
or explicit `null` sends ordinary Bearer authentication without an organization
header. No new credential type, attestation, migration or live account change
is introduced.

The first qualified destination is `https://api.gmi-serving.com/v1`, with POST
`/chat/completions` and bodyless GET `/models`. Unified, native and manifest
callers use the same binding. Other origins, transports, endpoint authentication overrides,
mapped paths and query overrides remain outside this qualification.

Unified `/v1/chat/completions` selection carries internal `model` and
`deployment` parameters. Both must exactly match the selected upstream model
and serialized body model; neither changes GMI's literal upstream path. This
exception does not accept extra parameters or caller-supplied native/manifest
path parameters. Canonical router IDs and registered routing prefixes resolve
to the same original model and credential binding.

The Worker removes caller, provider-static and endpoint-static organization
headers after header construction. It then inserts only the original
materialized owner's account. Environment credentials have no account binding
and cannot inherit an organization from another grant, a label, caller headers
or an environment organization variable. The existing API-key source selection
is preserved, including registered credential bundles. The final Bearer value
must match that original source; static authorization cannot replace it.

Organization values must be single nonempty visible-ASCII header identifiers,
at most 512 bytes, without commas. This is a router header bound, not a claim
that GMI requires UUID identifiers. Invalid values fail with a fixed,
content-free error before egress.

After reservation and other admission waits, the request checks the original
caller and current policy, then inspects the original credential owner without
refresh, reselection or credential-cache reuse. Provider, kind, generation,
lineage, account, enabled/revoked state and expiry must still match. Account
replacement already changes owner lineage. A selected grant cannot fall back
to an environment key or another account after this check fails. A dispatched
GMI generation is not retried through a different organization.

Keyed discovery repeats the check after its complete bounded JSON read and
filters with that final current policy. A disabled owner or changed account
prevents publication; a tightened model policy removes newly hidden rows.
The existing strict OpenAI list decoder is unchanged. Missing prices and limits
stay unknown, and an empty list is authoritative. Discovery is not inference.

This guarantee is fresh at the authoritative check, followed by synchronous
caller/credential expiry checks. It does not claim globally instantaneous
revocation between the check and fetch, or a new network check per Chat frame.
Existing budget and response accounting remain in force; this binding grants
no model entitlement or upstream-dollar price.

The runtime tests use synthetic owner records, real Worker dispatch, SQL budget
and usage ledgers, controlled post-admission mutation, and native/manifest
requests. Provider declarations, generated snapshots, actual-client composition
and live account configuration remain separate owner-controlled work.
