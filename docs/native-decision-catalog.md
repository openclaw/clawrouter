# Native decision catalog qualification

Decision capability does not imply an OpenAI Decisions wire format. The legacy
OpenAI catalog now advertises `/v1/decisions` only when the provider's selected
decision endpoint declares POST with matching `openai.decisions` request and
response formats. This matches the existing unified dispatch guard. Native-only
decision cards retain their manifest and caller-scoped native routes; mixed
providers retain their Chat offers.

The shared decision metadata is a discriminated union. `baseten-systemone`
preserves the [published schema contract](baseten-systemone-schema.md): 512 total
options, 16,384 tokens per encoded question, provider-defined choice/score
probabilities and one *observed* output token per question. These fields neither
supply a tariff nor replace the actual usage receipt, backend model or selected
model identity. The OpenAI decision metadata remains unchanged.

The focused Worker fixtures compile the exact three frozen SystemOne IDs and
exercise caller-specific environment/pooled and native/manifest catalogs. They
verify no false unified offers, no credential leakage, unchanged native facts,
zero-egress unified rejection and unknown-price denial under hard budgets.
They do not activate a provider or substitute for the source-owned native
response wrapper and actual DecisionV2 consumer qualification.
