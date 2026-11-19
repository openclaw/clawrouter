# Radius native transport

Radius uses Pi messages. OpenRouter backing does not make its wire format Chat
Completions. The API-key product uses `RADIUS_API_KEY` with Bearer authentication;
OAuth device login and refresh are a separate identity lifecycle.

`worker/provider-radius.ts` supplies the focused runtime contract:

- `prepareRadiusRequest(body, selectedModel)` binds the scoped model and preserves
  Pi context, native tool results and options. Disabled reasoning is omitted.
- `createRadiusEventInspector()` receives complete JSON data events from the
  shared SSE framer via `accept(value)`. Call `unavailable()` on malformed JSON,
  incomplete nonempty data, framing limits or unsupported framing; call `result()`
  at delivery completion/cancellation. EOF never synthesizes a native terminal.
- Forward the original SSE bytes. The inspector retains only bounded block
  identities, never tool arguments, output, reasoning or signatures. It checks
  tool start/end identity, terminal reasons and cumulative counters. Its bound is
  4,096 blocks and 1,024 characters per tool ID/name; exceeding it invalidates
  accounting evidence rather than altering the upstream response.
- Pi input excludes cache reads/writes; normalized router input includes both.
  Require the reported total to agree. Native cost fields are not a router tariff
  and must not override policy pricing or a hard-budget preflight.
- `filterRadiusCatalog(document, trustedBaseUrl, allowedModelPredicate)` preserves
  the scoped native model metadata, excludes disabled models and rejects a
  catalog-selected credential origin. Operator qualification must precede any
  change to the trusted service origin.

The frozen OpenClaw client uses `GET https://radius.pi.dev/v1/config` and
`POST <qualified-base>/messages`. Integration should use `radius.messages` and
`radius.config` format IDs. The shared runtime owns framing, discovery policy,
credential materialization, byte forwarding and caller settlement; the actual
Pi client bridge remains a separate consumer proof. This codec does not register
routes or claim live service compatibility.

Sources: [Radius documentation](https://radius.earendil.com/docs) identifies the
API-key and account contracts. The wire and fixture comparison is pinned to
[OpenClaw's Radius stream](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/stream.ts),
[catalog](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/catalog.ts) and
[usage fixture](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/test-support.ts).
No login, account change, live call or secret provisioning is performed.

Run `node --test worker/test/provider-radius.test.mjs`. Shared runtime integration
must add fragmented SSE, cancellation, scoped catalog selection, unknown-price
zero-egress rejection and exact-once caller/account settlement proof.
