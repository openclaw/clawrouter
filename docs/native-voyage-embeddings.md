# Voyage text embeddings

The experimental `voyage` manifest exposes native JSON `POST /v1/embeddings` at
`/v1/native/voyage/v1/embeddings` with `VOYAGE_API_KEY` bearer credentials. The
explicit model rows are `voyage-4-large`, `voyage-4` and `voyage-4-lite`. Native
input type, truncation, dimensions, data type, encoding and result ordering are
preserved. This does not expose contextualized or multimodal embeddings, reranking
or a local `voyage-4-nano` engine.

`providers/_fixtures/voyage/embeddings.json` supplies synthetic 256-dimensional
float wire/results for the scoped client resolver and memory consumer. Native
options and model limits follow the
[embedding reference](https://docs.voyageai.com/reference/embeddings-api).

Voyage reports total input tokens without an output-token field. The focused
`extractVoyageEmbeddingUsage` helper maps a complete successful native response
to input-only usage. It is not wired into the generic observer by this change:
the runtime owner must select it only for `voyage.embeddings`, then qualify
tariff admission and settlement. Missing/invalid usage stays unknown. See
[text embeddings](https://docs.voyageai.com/docs/embeddings).

Until that integration passes, the manifest deliberately has no token tariff.
Hard budgets require explicit fixed request pricing; unmetered requests use the
existing one-microdollar fallback, which is not an upstream invoice estimate.
Worker contract tests exercise native JSON, credential/model authorization,
pre-egress reserve refusal and fixed charging. Live vector quality, priced usage
and OpenClaw memory-consumer acceptance remain separate qualification steps.
Sources checked 2026-11-03.
