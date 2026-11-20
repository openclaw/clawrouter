# DuckDuckGo native HTML search

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/duckduckgo/src/ddg-client.ts`.

The consumer issues GET `https://html.duckduckgo.com/html` with `q`,
optional `kl` region, and `kp` safe-search setting. It parses HTML anchors
and snippets. Instant Answers JSON is a different surface and cannot substitute
for these search results.

`worker/duckduckgo-html.ts` implements deterministic query construction and
bounded native HTML reading/parsing. It identifies ClawRouter in User-Agent,
sends no upstream credential/cookie, and never impersonates a browser or solves
a challenge. Unsupported and duplicate query fields are rejected.

Response admission requires HTTP 200, HTML MIME, valid UTF-8 through EOF and at
most 2 MiB. The parser preserves highlighted words, common/numeric entities,
result-local snippets and DuckDuckGo redirect destinations. Output links are
untrusted data; no links are fetched. Only HTTP(S) URLs without embedded
credentials survive. Script/comment content cannot supply search results.

Challenge pages, unexpected layouts, explicit empty-result pages, transport
failure and successful results are different outcomes. A challenge is not an
empty successful search. Do not retry it through different identities, proxies,
cookies or browser fingerprints. Unknown layout is an explicit parser failure,
not fabricated zero results.

## Integration boundary

This adapter is not registered and adds no fake provider API badge.

- The current manifest schema requires an auth scheme and has no anonymous
  HTTP variant. The schema owner must add an explicit no-upstream-auth contract;
  an optional invented API key or Cloudflare binding is not equivalent.
- The runtime owner must wire bounded HTML input to outcome observation, keeping
  router authentication/policy admission and original native HTML delivery.
  Request completion must not mark HTTP-200 challenge pages successful. Set a
  deadline and manual redirects; do not retain query or HTML by default.
- The client owner must bridge the frozen native HTML consumer and retain its
  external-content wrapping. Parsed title/snippet strings are untrusted plain
  text, not trusted instructions or executable markup.
- The integration owner must prove the real Worker/client path and capability
  reporting after the schema/runtime contract is active.

The vendor documents a non-JavaScript search website and URL settings. Those
documents do not qualify an automated service contract, an availability promise,
or a production tariff. Deployment/service-use qualification is therefore still
open. No live search, challenge workaround or production integration was performed.
No upstream-dollar price is fabricated; fixed router policy charges remain a
separate basis. Budget/retention tests belong to shared runtime activation.

Six focused tests consume synthetic request/result/empty/challenge/changed-layout
fixtures at `providers/_fixtures/duckduckgo/search.json`. They also test native
chunking, invalid UTF-8, interrupted EOF, byte bounds, and invalid destinations.

Primary evidence checked 2026-11-03:

- [Non-JavaScript search](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript)
- [URL region and safe-search parameters](https://duckduckgo.com/duckduckgo-help-pages/settings/params)

## Separate Microsoft/Edge host boundary

C10 is not Azure Speech. The frozen `extensions/microsoft/speech-provider.ts`
invokes `node-edge-tts@1.2.11` and writes/reads temporary audio through Node
filesystem APIs. The package speaks the consumer Edge WebSocket protocol with
speech configuration, SSML, audio metadata, binary chunks and turn-end messages.

No qualified host bridge is registered for that consumer. Its exact unblock is
a named existing execution host and an authenticated, bounded speech bridge:
caller/policy binding, deadline/cancellation, bounded audio and subtitle output,
ephemeral file custody, no caller-selected path/proxy, and actual Node consumer
proof. Runtime/client owners must qualify that route and service use. No host,
secret or commercial account was provisioned; no Azure alias or production
support claim was added.

Package architecture evidence:
[node-edge-tts source](https://github.com/SchneeHertz/node-edge-tts/blob/master/src/edge-tts.ts).
