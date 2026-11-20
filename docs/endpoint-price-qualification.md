# Explicit unpriced endpoint contracts

A model's qualified Chat tariff must not silently price a separate native wire
contract whose usage/accounting path is still unqualified. An absent
`endpointPricing` entry keeps the established model-level fallback. An explicit
entry with `pricing: null` removes that fallback for the named endpoint:

```yaml
endpointPricing:
  messages:
    pricingRef: native-messages-accounting-unqualified
    pricing: null
```

The reference remains required and nonempty, so the source names the unresolved
qualification. `null` means unknown, not zero, and omission is not equivalent to
null. The compiler preserves it in both the provider model and model index.
Existing endpoint selection already replaces the model-level price when an
endpoint card is present; its hard-budget admission therefore rejects the
unpriced endpoint while preserving ordinary priced Chat. Explicit `policy_fixed`
is a separate policy tariff, including an intentional fixed zero.

This is the E09 MiniMax dependency: preserve the existing Chat card while native
Anthropic usage and regional API/OAuth ownership are qualified. This PR activates
no provider endpoint and publishes no new snapshot row.

Before activation, the client/catalog owner must change
`ClientCatalogModel.endpointPricing[*].pricing` in `shared/contracts.ts` to
`ModelPricing | null` and preserve selected-endpoint nulls in actual catalog
consumers. The generic Worker selection already supports the value at runtime;
no pricing-runtime implementation is changed here. These are contract dependencies,
not independent-review gates.
