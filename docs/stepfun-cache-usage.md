# StepFun standard Chat cache usage

The selected `stepfun` or `stepfun-cn` standard provider, with both request and
response format `openai.chat_completions`, qualifies top-level
`usage.cached_tokens` as an inclusive subset of `usage.prompt_tokens`.
The runtime captures that route context before dispatch. Caller JSON and the
upstream response's model field cannot grant this interpretation. Step Plan and
other providers keep their existing normalization contracts.

The documented example has 591 input tokens, including 512 cached tokens, and
120 output tokens: total 711. Input remains 591. The normalizer neither adds
cached tokens again nor subtracts them from gross input. It requires a safe,
nonnegative integer no larger than the prompt count, consistent with any other
reported cache-hit/miss fields. Invalid or conflicting cache evidence becomes
unknown; it cannot establish a cache discount.

JSON and bounded SSE observers use the same context. Repeated cumulative SSE
snapshots replace earlier counts; they do not accumulate. A terminal is required
for authoritative streaming usage. The real Worker fixtures cover both regional
bindings, route forms and original credentials, unchanged response bytes,
exactly-once accounting, invalid final counts and incomplete streams. Regional
fixture configuration follows source PR697; it does not activate that provider.

No rates are inferred. Policy-fixed charges remain separate from observed usage,
and unknown upstream prices still require the existing admission qualification.

Primary source: [StepFun prompt caching](https://platform.stepfun.ai/docs/en/guides/developer/prompt-cache).
