# Google native embedding declarations

The native format handshake uses exactly two paired endpoints with
`llm.embeddings`. Request and response formats match within each row:

| Format | Native POST path | Codec mode |
| --- | --- | --- |
| `google.embed_content` | `/v1beta/models/${model}:embedContent` | `unary` |
| `google.batch_embed_contents` | `/v1beta/models/${model}:batchEmbedContents` | `batch` |

These map directly to the merged `prepareGoogleEmbedding(model, body, mode)`
and `readGoogleEmbedding(response, prepared, signal)` exports in
`worker/provider-google-embeddings.ts`. The compiler tests consume its actual
unary/batch fixture, preserve prepared task text and ordered vectors, and reject
foreign model identity or an invalid later vector atomically. Client-owned task
formatting, batch splitting and normalization are not repeated in the Worker.

The origin remains `https://generativelanguage.googleapis.com`, with the original
server-owned `x-goog-api-key` credential. No `/v1beta` suffix is added to the base.
The compiler rejects format/path swaps, aliases, missing pairs, arbitrary model
passthrough, credential overrides, streaming and asynchronous lifecycle metadata.
Native byte/dimension bounds and observed token counts do not establish a
whole-request dollar bound. Eligible model rows remain explicitly unpriced;
the existing generation cards and SSE endpoints are unchanged.

Current eligible model identities are `gemini-embedding-001` and
`gemini-embedding-2`. The source codec also retains the frozen preview wire for
compatibility. Current [Google deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
list `embedding-2-preview` in the already-shutdown section with August 10, 2026,
while its [separate model page](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2-preview)
still uses `gemini-embedding-2-preview`. That naming discrepancy is not resolved
by silently aliasing the model. The preview is excluded from live declarations
pending exact-ID availability qualification. The stable identities and native
methods are documented in the current [embedding guide](https://ai.google.dev/gemini-api/docs/embeddings).

This change qualifies schema/compiler behavior only. The existing YAML owner
adds declarations after the shared runtime binds the codec to actual admission,
dispatch, bounded complete response validation and conservative settlement.
Native client integration must use these exact names. Runtime and client
owners retain credential lineage, selected model, deadline and uncertain-delivery
semantics. No snapshot or client discovery activates from this source fixture.
File-backed asynchronous embedding remains separate and requires scoped job/file
ownership; `batchEmbedContents` is only synchronous batching.

The current Bedrock source already uses flat Marengo 2.7 `inputText` and Cohere v4
dimensions 256/512/1024/1536 with NONE/LEFT/RIGHT truncation. Its fixtures and tests
reject the frozen client's mismatched nested shape, 384/768 dimensions and END
truncation. Those codecs are unchanged. The native client must consume the same
qualified contracts; the existing `aws_bedrock.invoke` format remains intact.
See [Google source contract](google-embedding-contract.md) and
[Bedrock source contract](bedrock-embedding-contract.md). This is not proof of
all native E03 consumers or live account entitlement.
