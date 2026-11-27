# LongCat frozen native contract

The finite frozen scope is `LongCat-2.0` in
`extensions/longcat/openclaw.plugin.json`, strict refreshable discovery and the
`meituan-longcat` provider alias in `extensions/longcat/index.ts`, and the native
thinking wrapper in `extensions/longcat/stream.ts`, all at OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. Preserve the already bundled
`LongCat-2.5` seed unchanged. Adding the missing frozen row does not select a
new generation, silently replace 2.0 or expand the seed's capabilities.

## Primary source split

Checked 2026-11-03:

- The [current Chat reference](https://longcat.chat/platform/docs/api/chat)
  names `LongCat-2.5`; the current [quickstart](https://longcat.chat/platform/docs)
  names the same generation.
- The official [legacy Chat reference](https://longcat.chat/platform/docs/api/chat.html)
  still directly serves `LongCat-2.0`, text input, `max_tokens` maximum 131072,
  native `thinking: {type: enabled|disabled}`, and separate `reasoning_content`.
  Its provenance is explicitly legacy; do not present it as a current account
  inventory response.
- The [change log](https://longcat.chat/platform/docs/change-log) records 2.0's
  release and native tool calling on 2026-06-30. Its May sunset notice names six
  older Flash models, not 2.0. No dated 2.0 shutdown or serving alias was found.
- [List models](https://longcat.chat/platform/docs/api/models) specifies Bearer
  GET `https://api.longcat.chat/openai/v1/models`, returning `object: list` and
  `data` with exact model IDs. The sample only lists 2.5; that sample is not
  evidence that every existing key has lost 2.0 access.

The 2.0 row therefore retains its exact identity, legacy text/output observation
and primary tool contract, with no invented retirement date, serving alias,
account entitlement, price or effort menu. Its context ceiling stays unknown:
the release's rounded 1M wording does not independently establish the frozen
1048576 integer. No 2.5 limit, vision feature or rate is copied into 2.0.
Keyed discovery and any actual 2.0 account acceptance remain separate proof.

## Paths, credentials and controls

Keep the existing base `https://api.longcat.chat/openai/v1`, `/chat/completions`
and new bodyless `/models` endpoint. Frozen OpenClaw's base omits `/v1`; current
primary cURL specifies the full `/openai/v1/chat/completions` URL. The router's
already-working base/path composition is retained, with no `/v1` duplication or
inference from an SDK example. Public native paths are
`/v1/native/longcat/chat/completions` and `/v1/native/longcat/models`; manifest
paths select `chat_completions` or `models_list` under `/v1/proxy/longcat/`.

Only `LONGCAT_API_KEY` and the original LongCat stored grant configure the
upstream. `meituan-longcat` is a routing alias of canonical `longcat`, not a new
family or credential store. Native discovery uses the landed strict
`openai.models` implementation; there is no public/no-key fallback, synthetic
seed refill, new decoder, endpoint auth override or common runtime change.

The frozen client wrapper sets `thinking.type` to disabled only for an off
thinking level, otherwise enabled, and deletes generic `reasoning_effort`.
Source2 owns that client transformation. The router preserves the supplied
native body, tool history and separate assistant reasoning. It does not infer
an effort enum or replace explicit thinking controls. The frozen client says
streaming usage is unsupported, so fixtures require conservative unknown usage
when absent and separately qualify counting when supplied.

## Actual Worker proof and remaining boundaries

The new test module compiles the actual manifest and uses the existing Worker,
authority, grants and SQLite budget fixtures. Cases cover both exact model IDs
on native/manifest JSON and fragmented SSE routes, original keys, reasoning/tool
replay, all four frozen native thinking combinations, declared/catalog facts,
policy/revocation/unknown-price failures, HTTP errors including 410, streaming
errors, disconnect cancellation, optional usage and routing aliases. Discovery
cases cover original-grant filtering, empty results, strict envelopes, rejected
query remapping, upstream denial and revoked credentials. Synthetic policy-fixed
settlement is not an upstream rate or token-pack balance.

Source2 retains actual native SDK replay, the frozen thinking wrapper and
base/path composition proof. Source1 retains shared discovery/runtime/account
boundaries. Source6 owns the later serialized snapshot and composed native
consumer proof. Source4 holds no snapshot lease. Local execution remains
code-only; hosted results must report tests skipped by the snapshot gate as
unrun. No new Messages/Responses route, media feature, token-pack product,
commercial account change, live inference, login, provisioning or manual
deployment is included.
