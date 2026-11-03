# Native Bedrock embedding dispatch

The common runtime consumes `prepareNativeBedrockEmbedding` from the landed
response wrapper. It prepares the leaf only after selecting the original
credential/transport and resolving the final URL. The signer returns the exact
region used in its credential scope. That region must match the canonical
`https://bedrock-runtime.<region>.amazonaws.com` destination and the Bedrock
signing service before any reservation or fetch. The leaf receives only the
origin, never credentials or environment configuration.

A qualified endpoint uses `llm.embeddings`, `aws_bedrock.invoke` for both wire
formats, `POST /model/${model}/invoke` and an opaque model segment. The selected
registered model supplies the path; the body remains the native embedding input.
Passthrough, queries, streaming, alternate origins and model remapping do not
qualify. A native path shared with generic Invoke resolves by the selected
model's declared capability, not YAML order. Manifest selection remains explicit.
Provider/schema activation is separate from these candidate runtime fixtures.

The existing protocol codec validates the ten frozen family contracts, including
exact registered profile identities, flat Marengo 2.7 input and qualified Cohere
v4 dimensions/truncation. It does not create profile entitlement or pricing.
Only complete bounded native JSON with all vectors valid reaches the caller.
The request limit is 2 MiB; response limit is 8 MiB. The existing response lease
charges 64 MiB before fetch and is released on every delivery outcome.

Original grants remain authoritative over environment credentials. Admission,
reservation acknowledgment, deadline, cancellation, manual redirects and
exactly-once settlement use existing shared machinery. There is no automatic
replay after dispatch. Unknown whole-request prices remain closed under hard
upstream-dollar budgets; policy-fixed charges stay distinct. Only qualified
Titan input counts are observed. Vector dimensions, output tokens and total
tokens are not fabricated; partial/error delivery retains conservative cost.
