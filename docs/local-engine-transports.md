# Configured local-engine HTTP transports

The `llama-cpp`, `lmstudio`, `ollama`, `omlx`, `sglang` and `vllm` manifests
provide experimental OpenAI-shaped Chat/SSE and model-list routes. Ollama also
exposes native Chat JSON/NDJSON and Tags through its focused runtime adapter. Each targets
an existing operator-selected server. None installs a host, starts a process,
loads a model or defaults to localhost.

| Provider | Required bindings |
| --- | --- |
| `llama-cpp` | `LLAMA_CPP_BASE_URL`, `LLAMA_CPP_MODEL` |
| `lmstudio` | `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL` |
| `ollama` | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| `omlx` | `OMLX_BASE_URL`, `OMLX_MODEL` |
| `sglang` | `SGLANG_BASE_URL`, `SGLANG_MODEL` |
| `vllm` | `VLLM_BASE_URL`, `VLLM_MODEL` |

Configure the base as the reachable OpenAI API prefix, for example
`https://inference.example.com/v1`, without a trailing slash. For Ollama only,
configure the server root (for example `https://ollama.example.com`): its manifest
adds `/v1` for compatibility and `/api` for native endpoints. No URL is rewritten
by guessing which prefix the operator intended. Use the serving
endpoint or its authenticated reverse proxy’s key in the optional
`<PROVIDER>_API_KEY` binding. Leave that binding unset when the configured server
does not require upstream authentication; no placeholder is sent. Router caller
authentication remains mandatory. A hosted Worker cannot
reach another machine's loopback. Ollama's local service ignores OpenAI API-key
values; authenticate the reachable boundary instead. Do not send an Ollama Cloud
key to an unrelated local gateway.

`<provider>/configured` resolves the explicit model binding. Other unified IDs
strip only that provider prefix and retain the server's model namespace.
`/v1/native/<provider>/chat/completions` accepts upstream model IDs (Ollama’s
compatibility path includes `/v1/chat/completions`).
No model limits, modalities, tool support or free tariff are fabricated from
the alias. Hard budgets require an explicit fixed policy price until a tariff
is qualified; unmetered requests remain available.

`GET /v1/native/<provider>/models` (Ollama: `/v1/models`) and the `models_list` endpoint use
the existing scoped discovery machinery: API-key grants, policy-filtered model
IDs, bounded metadata responses and zero inference charge. Discovery reports
the server's models; it does not automatically turn their arbitrary metadata
into trusted inference capability facts or load a model. No load, unload, model
download or management route is exposed.

Deterministic workerd fixtures exercise selected credentials, discovery,
tool/reasoning SSE bytes, terminal usage, fixed-policy accounting and unknown
tariff denial before egress. Filtered OpenAI model lists require the shared
discovery implementation to select envelope shape by wire format, not the
literal provider ID. Discovery currently requires an API-key grant even for an
optional-auth server; the common runtime owner must qualify environment/anonymous
metadata access without inventing a stored credential. Live hardware/model
behavior remains separate evidence.

Ollama's `/v1/native/ollama/api/chat` (manifest endpoint `native_chat`) preserves
native tools/thinking and observes terminal prompt/evaluation counters in JSON or
NDJSON. `/v1/native/ollama/api/tags` (`native_models`) preserves the native model
envelope and filters caller scope. `/api/show` and host management are not
exposed. The inherited runtime fixtures cover fragmented frames, truncation,
embedded errors, cancellation and SQL settlement; this manifest's workerd tests
also exercise selected bindings, both dispatch paths and native discovery.
LM Studio also exposes `/v1/native/lmstudio/messages` and the `messages` manifest
endpoint using its documented Anthropic Messages JSON/SSE contract. It keeps
native tool replay and token counters while using the same selected server bearer
key; model-specific reasoning/image support is not inferred. Its request to the
configured `/v1` base ends in `/messages`.

Runtime-native reasoning controls,
embeddings and typed decisions remain subsequent protocol slices. Host lifecycle
is an architectural dependency, not a reason to omit router transports.

Primary contracts checked 2026-11-03:

- [llama.cpp server APIs](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [LM Studio OpenAI endpoints](https://lmstudio.ai/docs/developer/openai-compat) and
  [Messages/authentication](https://lmstudio.ai/docs/developer/anthropic-compat)
- [Ollama native Chat](https://docs.ollama.com/api/chat) and
  [native Tags](https://docs.ollama.com/api/tags).
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [oMLX API compatibility](https://github.com/jundot/omlx)
- [SGLang OpenAI API](https://docs.sglang.io/docs/basic_usage/openai_api_completions)
- [vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/)
