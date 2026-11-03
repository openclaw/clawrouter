# DeepSeek native Search runtime

The shared selection path invokes the published `prepareNativeDeepSeekSearch`
leaf for the exact `deepseek.search` format. The original caller, selected grant,
final destination and body remain under common admission and transport control.
The qualified operation is model-less POST to
`https://api.deepseek.com/v1/tools/search`; existing Chat models and token prices
do not authorize or price Search.

The leaf requires explicit `query`, `count` and `need_content:false`. Common
dispatch preserves that body, rejects query/path/origin substitution, acquires
the existing response lease before egress and waits for durable dispatch
acknowledgment. Complete bounded JSON must pass every returned result before
delivery. Result and icon URLs are data, never credential-bearing fetch targets.

Without an explicit fixed policy fee, admission records an unknown native
request-fee gap. Every enforced dollar budget fails before fetch. Unmetered
execution retains `unpriced_usage`; its numeric zero storage value is not a
zero-cost invoice. An explicit `policy_fixed`, including zero, remains a policy
charge. The codec's nonempty-request counter and tariff helper are not consumed
as settlement evidence. Empty results, filtered results and interruptions do not
establish free upstream work. Dispatched uncertainty retains conservative
settlement without retry; known-unsent capacity and acknowledgment failures
release reservations.

Real Worker tests compile the source-owned candidate declaration in memory and
exercise native/manifest routes, original environment/grant credentials, scope
revocation, model-less catalog facts, caller/provider/daily/weekly budget denial,
empty results, response bounds, cancellation and exactly-once settlement. They
do not activate provider YAML or a generated snapshot. Source-owned declaration,
serialized snapshot and actual client qualification remain separate prerequisites.
