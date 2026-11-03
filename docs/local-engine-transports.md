# Configured local-engine HTTP transports

The `llama-cpp`, `lmstudio`, `ollama`, `omlx`, `sglang` and `vllm` manifests
provide experimental OpenAI-shaped Chat/SSE and model-list routes. Each targets
an existing operator-selected server. None installs a host, starts a process,
loads a model or defaults to localhost.

| Provider | Required bindings |
| --- | --- |
| `llama-cpp` | `LLAMA_CPP_BASE_URL`, `LLAMA_CPP_API_KEY`, `LLAMA_CPP_MODEL` |
| `lmstudio` | `LMSTUDIO_BASE_URL`, `LMSTUDIO_API_KEY`, `LMSTUDIO_MODEL` |
| `ollama` | `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL` |
| `omlx` | `OMLX_BASE_URL`, `OMLX_API_KEY`, `OMLX_MODEL` |
| `sglang` | `SGLANG_BASE_URL`, `SGLANG_API_KEY`, `SGLANG_MODEL` |
| `vllm` | `VLLM_BASE_URL`, `VLLM_API_KEY`, `VLLM_MODEL` |

Configure the base as the reachable OpenAI API prefix, for example
`https://inference.example.com/v1`, without a trailing slash. Use the serving
endpoint or its authenticated reverse proxy's key. A hosted Worker cannot
reach another machine's loopback. Ollama's local service ignores OpenAI API-key
values; authenticate the reachable boundary instead. Do not send an Ollama Cloud
key to an unrelated local gateway.

`<provider>/configured` resolves the explicit model binding. Other unified IDs
strip only that provider prefix and retain the server's model namespace.
`/v1/native/<provider>/chat/completions` accepts native upstream model IDs.
No model limits, modalities, tool support or free tariff are fabricated from
the alias. Hard budgets require an explicit fixed policy price until a tariff
is qualified; unmetered requests remain available.

`GET /v1/native/<provider>/models` and the `models_list` manifest endpoint use
the existing scoped discovery machinery: API-key grants, policy-filtered model
IDs, bounded metadata responses and zero inference charge. Discovery reports
the server's models; it does not automatically turn their arbitrary metadata
into trusted inference capability facts or load a model. No load, unload, model
download or management route is exposed.

Deterministic workerd fixtures exercise selected credentials, discovery,
tool/reasoning SSE bytes, terminal usage, fixed-policy accounting and unknown
tariff denial before egress. Filtered OpenAI model lists require the shared
discovery implementation to select envelope shape by wire format, not the
literal provider ID. Live hardware/model behavior remains separate evidence.

Ollama's native `/api/chat` NDJSON, `/api/tags` and `/api/show` are separate
adapter work; this slice exposes only its documented compatibility transport.
LM Studio Messages/schema selection, runtime-native reasoning controls,
embeddings and typed decisions remain subsequent protocol slices. Host lifecycle
is an architectural dependency, not a reason to omit router transports.

Primary contracts checked 2026-11-03:

- [llama.cpp server APIs](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [LM Studio OpenAI endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [oMLX API compatibility](https://github.com/jundot/omlx)
- [SGLang OpenAI API](https://docs.sglang.io/docs/basic_usage/openai_api_completions)
- [vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/)
