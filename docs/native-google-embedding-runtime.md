# Native Google embedding runtime

The Worker consumes the source-owned `prepareGoogleEmbedding` and
`readGoogleEmbedding` codecs for `google.embed_content` and
`google.batch_embed_contents`. It supports the qualified stable
`gemini-embedding-001` and `gemini-embedding-2` identities. The preview is not a
live offer. Existing YAML, snapshot activation and actual native client proof
remain with their source/integration owners.

Native and manifest routes resolve policy against the registered path model.
The native body is preserved, including `models/{model}` assertions, task text,
dimensions and ordered batch rows. The codec rejects a foreign sub-request
model before credential selection or reservation. Client task formatting,
batch splitting and normalization are unchanged. No file URLs, asynchronous
file batches, query overrides or streaming aliases are enabled.

The existing authenticated admission, selected server credential, budget ledger
and dispatch acknowledgment own egress. The final destination must be the
qualified Google origin and selected native model path. Caller credentials
cannot replace the server-owned `x-goog-api-key`. Redirects and post-dispatch
grant retries are disabled. Unknown prices fail upstream-dollar hard budgets
before dispatch; an explicit `policy_fixed` tariff remains a policy charge.

Before dispatch, response decoding reserves 64 MiB from the existing shared
body budget. This covers the codec's bounded decoded JSON and parsed output;
concurrent large inputs may therefore be refused before paid execution. The
lease remains held through downstream EOF or cancellation. The existing
operation deadline covers the complete upstream read. HTTP 200, JSON MIME,
fatal UTF-8, bounded complete EOF and every requested vector/dimension must
validate before any result is published. The validated native JSON is serialized
incrementally; its values and ordering are preserved, not its whitespace or
compression headers. Invalid responses, upstream rejection, transport loss,
deadline expiry and cancellation retain conservative dispatched accounting.

Only qualified `usageMetadata.promptTokenCount` becomes an observed input
count. Dimensions, response size, characters and inline media bytes do not
become tokens. Missing counts remain unknown; output tokens are not invented.
The response observer uses this validated observation instead of a second
generic JSON interpretation. Token observations do not establish dollar rates.

The runtime tests use synthetic native and manifest requests through the actual
Worker, authority and SQLite budget ledger. They cover unchanged wire input,
selected credentials, reservation before dispatch, exactly one settlement,
model/query/price/origin denials, invalid later vectors, malformed responses,
deadlines, shared capacity and cancellation. Provider activation still requires
the separately owned manifest/snapshot and actual consumer qualification.
