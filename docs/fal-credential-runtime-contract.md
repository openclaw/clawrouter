# Canonical fal credential binding

The runtime recognizes `FAL_KEY` only when the fal provider declares it and
uses the native `Authorization: Key ${secret}` API-key scheme. Other products,
undeclared keys, generic `*_KEY` names and `FAL_API_KEY` are not substitutes.
Existing `_API_KEY`, `_API_TOKEN` and `_TOKEN` contracts are unchanged.

The existing factory uses the selected original grant when one is present;
it never replaces a missing or malformed grant credential with `FAL_KEY`.
Environment-backed jobs retain their existing credential fingerprint, and
pooled jobs retain their original grant lineage across status/result/cancel.
Rotation cannot turn an existing job into a request on a new credential.
Readiness recognizes the declared canonical secret as satisfiable by a scoped
grant and exposes configuration names, not credential values.

For this native Key scheme, whitespace, control bytes and non-ASCII credentials
are rejected before header construction. The failure uses the existing
`provider_not_configured` error without echoing the value. Colon-delimited key
values are preserved. No prefix, account entitlement or billing plan is inferred.

`worker/test/fal-credential-runtime.test.mjs` exercises the real factory,
readiness, native/manifest Worker create and restart/control paths with the
published queue fixture and SQLite state. It checks original environment and
pooled credentials, rotation denial, missing/malformed input, private-state
redaction and unknown-price admission before any fetch. Fixtures make no live
provider requests. `policy_fixed` remains distinct from upstream-dollar cost.

This runtime prerequisite does not activate the provider declaration, repair
the smoke/deploy tooling, qualify deeper create paths or authorize unowned job
controls. Those source-owned integration gates remain separate.
