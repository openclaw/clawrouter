# Requesty managed catalog runtime

The paired request/response format is `requesty.models_managed`. The compiled
`models_managed` endpoint has capability `models.list`, method `GET`, path
`/models/managed`, and no path parameters, query, body, endpoint authentication
override, mapped path, stream, lifecycle, request tariff or input profile.

The native caller route is `/v1/native/requesty/models/managed`; the manifest
route is `/v1/proxy/requesty/models_managed`. Both return the native `{data}`
envelope. Compiler registration and provider declaration are separate changes;
this runtime does not publish YAML or a generated provider snapshot.

## Original authority

The existing metadata-owner path selects an original managed API-key credential
and retains its provider, owner key, generation, lineage and destination. An
environment key, OAuth credential, anonymous request or alternate grant cannot
replace it. The registered Requesty factory supplies the fixed
`https://router.requesty.ai/v1/models/managed` URL and selected Bearer key; caller
and static account headers do not reach the upstream API.

Fresh caller policy and original-owner metadata are read after budget/retention
waits, immediately before the physical fetch, and again after complete parsing.
The current routing policy must still admit that owner. Rotation, revocation,
caller removal or destination changes deny the request or withhold the parsed
catalog. Final rows intersect the admitted and current model policy; a policy
widening during the read cannot expose additional rows. These are fresh-at-check
guarantees, not globally instantaneous revocation after the check completes.

## Wire and lifetime

The existing Requesty reader bounds the complete native response to 2 MiB,
4,096 source rows and 8,192 chunks, including zero-byte chunks. It trims and
deduplicates eligible Chat IDs and excludes `@` regional IDs. Missing limits
remain absent. The four price observations retain their reported values; their
units, current account tariff and inference eligibility remain unqualified.
Explicit zero is preserved, never synthesized. An empty catalog is authoritative.

The existing discovery lease charges 32 MiB before fetch and covers complete
reading, parsing, filtering, serialization and delivery. Producer EOF or actual
cancellation releases it. Unread bytes in a client transport buffer alone do not
prove that the Worker producer still holds the lease. The original operation
deadline bounds authority waits and upstream reading; cancellation closes the
physical reader. Redirects, non-200 responses, malformed or incomplete metadata
fail without a second request. Metadata accounting remains separate from priced
inference; these observations cannot authorize a later paid call.

## Verification

`worker/test/requesty-catalog-runtime.test.mjs` exercises native/manifest routes,
warm-cache authority changes before fetch and during parse, current-policy
intersection, original key isolation, request/destination escapes, malformed
responses and read/capacity cleanup. `worker/test/requesty-catalog-workerd.test.mjs`
uses actual Worker fetch and SQLite authorities for both routes, 4,096-row
publication, producer EOF, response cancellation and a pending-read deadline.
Existing OpenAI metadata and GMI/DeepInfra authority tests remain unchanged.
