# Anthropic Messages price modifiers

Source verification: **2026-10-22 UTC** (2026-10-21 MDT). Applies to the
first-party Anthropic Messages API, not Bedrock/Vertex/Foundry billing.

## Published contracts

- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing)
  and [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode):
  `speed: "fast"` costs **2×** across the full context window, including over
  200k input tokens. Opus 5.5: $8 input / $40 output per million tokens versus
  $4 / $20 standard. Opus 5 and Opus 4.8: $10 / $50 versus $5 / $25.
  Cache multipliers and inference geography compose with this price. These
  multipliers affect token categories only, not the separate $0.01 web-search
  fee: 1,000 input / 20 output Opus 5.5 fast+US tokens plus two searches cost
  29,680 microUSD (4,400 × 2.2 + 20,000) on soft/unmetered keys.
  Opus 5/4.8 require the `fast-mode-2026-02-01` beta header and upstream access;
  Opus 5.5 does not. Fast mode is not available with Batch or Priority Tier.
  `usage.speed` reports `fast` or `standard`. Opus 4.6 has a documented
  standard-speed fallback, but has no bundled card here; no fast tariff is
  inferred for it or another unsupported model.
- [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency):
  Claude 4.6+ `inference_geo: "us"` costs **1.1× every token category**, including
  both cache-write durations, cache reads, and any applicable long-context tier.
  `global` costs 1×. Omission inherits `default_inference_geo` from the upstream
  workspace, including workspaces migrated from a legacy US-only opt-out.
  `usage.inference_geo` reports the actual setting. Older models reject an
  explicitly supplied geography, including `global`.
- [Service tiers](https://platform.claude.com/docs/en/api/service-tiers): requests
  accept `auto` (also the omitted default) or `standard_only`; the response puts
  the assigned tier in **`usage.service_tier`**, not at the message root.
  Existing Priority commitments are negotiated contracts; the document supplies
  capacity burndown factors, **not a public Priority token tariff**. No Priority
  price is invented. Batch is not a synchronous Messages settlement contract.
  Priority is explicitly unavailable on the bundled Opus 5.5, Opus 5, Sonnet 5,
  Fable 5.1, Sonnet 5.5, and Haiku 5.5 models. Omitted/auto remains admitted at
  standard rates on all bundled models for native-client compatibility; positive response evidence of
  Priority still fails safe because no public tariff exists.
- [Messages API reference](https://platform.claude.com/docs/en/api/messages/create):
  request speed/geography and usage speed/geography/tier are nullable. Usage
  geography can also be `not_available` (seen in recorded Haiku 4.5 and Opus 5.5
  responses); it is unreported, not a premium or malformed geography.

## Admission and settlement

A small native-format adapter qualifies the bundled model's base pricing card.
The existing manifest schema has OpenAI service-tier cards, but cannot express
independent request/usage speed and geography or an unknown workspace default.
The adapter scales every token rate, including long-context rates, before the
existing reservation/weighted settlement routines round the totals. Model
support is deliberately enumerated rather than guessed from model-name prefixes.
Adding another Anthropic card must qualify its modifier support as well.

Sonnet 5.5 and Haiku 5.5 now carry source-qualified `pricing.anthropicModifiers`
in YAML and the compiled snapshot: US **1.1×**, global **1×**, no fast tariff,
and standard synchronous service only. Native omitted/null/`auto` and
`standard_only` requests remain admitted, without rewriting. Reported global
usage settles at the unchanged #308 base rates. Haiku's >100k input tier and all
cache categories also receive the US multiplier; unreported geography still
settles at the reserved 1.1× bound. Fast and Priority are explicitly unavailable
for these models in the cited docs. Batch is a separate asynchronous contract.
A null premium in a qualified card refuses that explicit modifier, not default
requests; undocumented premiums must never be guessed. The previously reviewed
legacy-card qualification remains unchanged.

- Reservation uses the requested modifiers. Missing geography on supported
  models reserves at 1.1× without modifying the upstream request. This default
  reservation is 10% higher than global rates and can cause HTTP 402 near a
  budget boundary. Explicit `global` keeps the 1× reservation.
- Settlement prefers authoritative response usage; a documented explicit
  request value is the fallback when that response field is absent. Omitted
  geography with no response geography settles at the same 1.1× rate used for
  admission on geo-capable models, and at base price on older models. Null fields
  and response geography `not_available` count as unreported. This is a
  conservative published-rate charge, not proof of the provider invoice.
- SSE retains speed, geography and tier through cumulative usage deltas that
  omit unchanged fields. Later null fields or `not_available` geography cannot
  erase earlier reported modifiers. Invalid types and unknown strings remain
  unpriced evidence. Cache counters are still merged once.
- Hard budgets reject unknown/unsupported request combinations with HTTP 400
  `pricing_required`, before dispatch. Omitted, null or `auto` tier is admitted
  at the standard rate, including Opus 4.8, Fable 5, Sonnet 4.6 and Haiku 4.5.
  The router never silently rewrites auto to `standard_only`. Unreported response
  tier uses the admitted standard rate; explicit `priority` or `batch` does not.
- An unexpected unpriced successful response (including Priority or Batch) is
  not settled at base price. Nonstream returns HTTP 502 `pricing_required`;
  SSE emits an error frame instead of the successful terminal frame (headers
  may already be HTTP 200). Both use the native Claude `api_error` envelope with
  the router's `request_id`. JSON also sets `request-id` and the separate
  `x-clawrouter-error-code: pricing_required`; a late SSE failure cannot replace
  already-sent headers, so its message explains the pricing failure.
  The dispatched reservation is retained and the
  usage event is `unpriced_usage` / `provider_error`, preserving observed usage
  and the served tier. This is **not a claim to know the provider invoice**.
  A legacy Priority account using auto may incur negotiated charges before the
  error; use `standard_only` or a fixed policy price to avoid that ambiguity.
  No known upper Priority tariff exists; an already-dispatched call cannot be undone.
- Fixed-price policies remain explicit contracts. Soft/unmetered calls retain
  pass-through, but unknown modifier prices are reported as `unpriced_usage`
  with no invented token charge. Known no-output classifier refusals remain
  free; upstream HTTP rejections release the reservation.

## Bounds and remaining limitations

Hard-budget JSON responses are buffered only to the existing 2 MiB usage
inspection limit before success delivery. SSE is demand-driven and buffers at
most one bounded event, forwarding valid UTF-8 events with their original line
endings. A response/event exceeding that inspection bound fails safe as
`pricing_required` and retains the reservation, rather than claiming a verified
base price. Unmetered/soft/fixed-price transport is unchanged. Partial delivery
without terminal usage still follows the existing conservative reservation path.

The separate [web-tool accounting contract](api-reference.md#budgets-usage-and-retention) owns
published search fees and hosted-loop budget limits. This modifier adapter does
not qualify negotiated discounts, subscription entitlement, other hosted fees,
compaction iterations, model fallback, async Batches, new model cards, or
end-to-end data residency. No deployment or paid Anthropic call is part of the
fixture verification. See `test/anthropic-price-modifiers-workerd.test.mjs` for
real Worker/queue/SQL-ledger JSON and fragmented SSE tests.
