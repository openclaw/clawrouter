# Google stable embedding declaration

The bundled Google manifest declares `gemini-embedding-001` and
`gemini-embedding-2` on the existing native embedding runtime:

| Endpoint | Request and response format | POST path |
| --- | --- | --- |
| `embed_content` | `google.embed_content` | `/v1beta/models/${model}:embedContent` |
| `batch_embed_contents` | `google.batch_embed_contents` | `/v1beta/models/${model}:batchEmbedContents` |

The original Google API-key header, origin and finite model identity remain
bound to both native and manifest routes. No model passthrough, credential
query, remote-file fetch or asynchronous batch route is added. Existing
GenerateContent routes and their SSE query remain unchanged.

Primary evidence checked on 2026-11-03:

- [Embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings): 001 is
  text-only with a 2,048-token input window; stable 2 has an 8,192-token window
  and accepts text, image, audio, video and PDF inputs. The existing codec
  qualifies inline parts; it does not authorize arbitrary file URLs. The
  manifest omits a partial modality list for 2 because the current modality
  enum cannot faithfully express PDF support.
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations): 001 remains
  available with earliest shutdown May 14, 2028. Stable 2 has no announced
  shutdown. The frozen preview is retired and is deliberately not declared;
  no silent preview-to-stable alias is introduced.

Both models remain unpriced. Context, dimensions and request limits cannot
establish a whole-request monetary bound. Upstream-dollar hard budgets deny
before egress; an explicitly configured `policy_fixed` charge remains labeled
as such. Native input-token usage does not create an output-token charge.

`worker/test/google-embedding-manifest.test.mjs` compiles the actual YAML,
reads the caller-scoped catalog, then exercises unary/batch native and manifest
Worker routes with synthetic native responses and the original credential.
It also covers unknown-price zero-egress denial. These fixtures prove the
Worker contract; they are not a live-provider receipt or complete OpenClaw
native-memory/async-file certification. Generated snapshot integration remains
serialized separately before bundled discovery activation.
