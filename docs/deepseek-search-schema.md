# DeepSeek native Search declarations

This compiler contract consumes the landed `worker/deepseek-search.ts` codec
and the wrapper ABI published in [PR721](https://github.com/openclaw/clawrouter/pull/721)
at `e9002974ceb58fdee5537b3053afb21d89ab2d16`. It does not activate a provider
route, copy the wrapper or change the existing DeepSeek models.

The existing provider can declare capability `search.web` on one POST endpoint
`/v1/tools/search`, with request and response format `deepseek.search`.
The canonical origin is `https://api.deepseek.com`, using the selected original
Bearer API key. This operation has no model. Existing Chat cards retain their
own capabilities and token prices; none may advertise Search. Compiled property
names stay `request_format` and `response_format`; no new input or model API
field is needed.

The compiler rejects alternate origins, credential overrides, query injection,
body renames, mapped paths, templates, streams, lifecycle controls, model
passthrough and unqualified request/tool tariffs. This format does not add an
OpenAI-compatible Search alias or the separate Fetch API.

## Request and response ownership

The frozen request is explicit `{ query, count, need_content: false }`: query
is 1–128 Unicode characters and count is 1–10. The codec defaults count to 5;
the current API defaults it to 10. `prepareNativeDeepSeekSearch(selection)`
therefore requires explicit options and preserves the admitted body. Schema
compilation injects neither default. The wrapper owns the 4 KiB request and
1 MiB response bounds, complete JSON validation, and rejection of omitted or
excess results. No result URL or icon is fetched.

The composed compiler tests use the actual codec for unchanged native/manifest
selection, the fixed upstream request, complete observations, original auth and
model-less budget checks. They do not replace wrapper tests or real Worker
admission, dispatch, cancellation and accounting proof.

## Cost and activation boundary

The codec's native request-count and tariff evidence is not a settlement
registration. Search is not priced by Chat tokens, returned-result count or
query length. Existing hard-dollar admission rejects the unqualified request;
explicit `policy_fixed` remains separately labeled. Empty, filtered or
interrupted results cannot establish a free execution through this schema.

Activation requires qualified PR721, source1 authenticated exact-format
selection and response dispatch, admission and complete/uncertain accounting
proof, source6 serialized snapshot integration, and the actual source2 consumer.
No YAML, generated snapshot, shared runtime or pricing implementation changes
in this slice. A future qualified request tariff must extend the existing
request-pricing path with its own admission and settlement evidence.

Primary references, checked 2026-11-04:
[Search reference](https://api-docs.deepseek.com/api/search/) and
[Search guide and billing](https://api-docs.deepseek.com/guides/search/).
