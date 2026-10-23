# Responses and alpha retrieval comparison

Status: local preparation only. No new public exposure, credential read, paid
probe, Cloudflare mutation, PR or push. Both live phases need fresh approval.
The previous [Funnel batch](search-semantics-funnel.md) is complete; its approvals
are consumed and its exposure is closed.

## Question and bounds

Compare the published Responses `web_search` path with the experimental standalone
`/v1/alpha/search` path. Same OpenAI key, `gpt-6.1-sol`, Funnel hostname, HTML and
fresh-marker criterion. Fixed order: Responses, then alpha. Each gets a separate
marker generation and zeroed counters; no marker in requests or receipts.

At most two API POST attempts, no retry or fallback. Each has a 90-second timeout,
2 MiB response limit and immediate/15-second-late origin snapshots. No router
call or unrelated inference request. Responses itself invokes model inference:
low reasoning, at most 2048 output tokens and three hosted tool calls, sequential.
The pair requires more than 250 seconds of exposure lifetime before starting;
each individual call also checks its remaining time. One key read for the pair,
into memory only, after separate paid-run approval.

Responses first must produce HTTP 200, a completed response and at least one
completed, recognized web-search call, with no incomplete/refusal/error state or
tool-limit violation. Otherwise stop and clean up before alpha. A valid tool
response without fresh retrieval still permits the alpha comparison. Missing
marker or origin GET alone is a negative observation, not an isolation violation.

## Request contracts

The [official search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
documents hosted search, live-access controls and action metadata. The
[Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
documents the overall built-in tool-call limit. The
[model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) lists web
search support for Sol in Responses. These do not establish an alpha contract.

Responses POST to `https://api.openai.com/v1/responses`:

```json
{
  "model": "gpt-6.1-sol",
  "store": false,
  "reasoning": { "effort": "low" },
  "tools": [{ "type": "web_search", "external_web_access": true }],
  "tool_choice": { "type": "web_search" },
  "max_tool_calls": 3,
  "parallel_tool_calls": false,
  "max_output_tokens": 2048,
  "input": "Use web search to open https://funnel-fixture.example.invalid/ and report the exact value labeled \"Current retrieval marker\" on that page. Retrieve the page itself. If unavailable, say so; do not guess."
}
```

Forcing the tool does not force an `open_page` action. Capture only closed action
counts, completion/error booleans, exact-target-opened boolean, sanitized request
ID, text length, marker-match boolean and safe numeric usage fields. No raw model
text, reasoning, ciphertext, queries, URLs from results, headers or credentials.

Alpha retains the empirical request: fresh UUID, model `gpt-6.1-sol`,
`commands.open: [{ref_id: "https://funnel-fixture.example.invalid/"}]`,
`response_length: "short"`, `settings.external_web_access: true`.
Its usage/charges remain unqualified. Responses token usage does not establish
alpha billing or prove that the two tools use identical retrieval services.

## Approved execution procedure, when authorized

1. Start a new ten-minute foreground exposure:
   `node scripts/search-semantics-endpoint-comparison.mjs --expose-approved`.
   Require the existing authenticated node, empty Serve/Funnel config and free
   port 18765. No enrollment, policy changes, background mode, `off` or `reset`.
2. Verify public calibration from an independent outside-tailnet client. Use the
   private stdin `witness <returned calibration marker>`, then `arm`, `snapshot`.
   Require matching marker/origin GET followed by zero counters. Stop operator
   public requests after arming. No HTTP controls exist.
3. Obtain separate approval for the bounded paid pair and send private stdin
   `compare-approved`. `probe-approved` is not accepted by this runner. The pair
   rotates/reset counters internally only after the first late observation ends.
4. Cleanup follows the attempt, including failure or cancellation: close the
   fixture, terminate its own foreground child, check both configs empty. Outside
   the runner, independently check both status commands and port 18765 free.
   Preserve unexpected/unowned configuration and reconcile read-only.
5. Save a fresh authorization and execution receipt; never overwrite earlier
   campaign receipts. Record partial pairs honestly; no automatic renewal/replay.

While idle, `snapshot`, `stop` and EOF retain the existing private-control
behavior. SIGINT/SIGTERM and the ten-minute deadline also cancel during a running
measurement; an already dispatched provider call may finish under its own timeout.
No raw measurement marker is printed. Abort handling is installed before startup.

## Interpretation

Fresh content requires successful HTTP/tool response, exact new marker and an
origin GET in that generation's measurement window; no overflow or expiration.
Record both snapshots, each endpoint's action/error metadata and the explicit
`measurementComplete` flag. An interrupted window on either endpoint makes the
pair incomplete, including cancellation after alpha has returned HTTP output.

- `both-observed`: fresh retrieval observed through both paths in this batch.
- `responses-only-observed`: inspect native alpha/Codex request/session/reference
  behavior next; this does not prove the cause is alpha-specific.
- `alpha-only-observed`: inspect the Responses prompt/action/cap result next.
- `neither-observed`: no live positive control; stop hosting retries and retain
  uncertainty. Broader cached/live semantics remain gated.
- `incomplete`: prerequisites or a valid Responses control failed, or cancellation
  stopped the pair. Do not promote a single completed row into pair evidence.

The first endpoint may warm hostname visibility/cache for the second. Fresh
markers prevent an old body qualifying, but do not remove order effects. This is
a diagnostic comparison across different invocation styles. Responses success
does not itself qualify Codex's native endpoint, routing or cached-mode semantics.

## Local verification

```sh
node --test test/search-semantics-endpoint-comparison.test.mjs test/responses-search-probe.test.mjs test/search-semantics-funnel.test.mjs test/standalone-search-probe.test.mjs
```

Tests use loopback-only ephemeral fixture ports, mock Tailscale/key access and
mock provider transport. Exercise actual decoders/probes together with independent
generations, stale-marker rejection, same-key reuse, request/tool bounds, partial
pairs, contamination, deadline/cancellation, default single-probe compatibility
and cleanup. They do not expose Funnel or call either provider endpoint.

Preparation verification: 51 focused tests passed. Autoreview of `1309676`
identified one P2: an interrupted alpha window could be classified as completed
negative evidence. Fixed with an explicit measurement-completion flag and
regression cases for cancellation during alpha's request and late window.
Original review status remains `findings`; do not describe it as a clean review.
Results: `~/.codex/review-results/search-endpoint-comparison-20261023/`.
Independent preparation checks found both real Serve/Funnel configurations `{}`
and port 18765 free. New exposure and paid-run approvals remain pending.
