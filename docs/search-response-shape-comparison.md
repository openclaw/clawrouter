# Alpha response-shape comparison

Status: preparation only. Paid execution requires separate approval. No new
hosting, fixture sessions, Cloudflare changes, inference calls or router changes.

Question: does a failing Alpha open return structured `results` alongside its
textual `Internal Error`? The preceding [source audit](codex-alpha-source-audit.md)
found opaque result pass-through, without a published schema for structured
errors. This comparison records presence, array length and closed type counts;
it does not inspect or retain result contents.

## Fixed batch

At most two direct POSTs to `https://api.openai.com/v1/alpha/search`, no retries:

1. Open `https://www.iana.org/help/example-domains`. Require HTTP 200, nonempty
   text, no known internal/reference/fetch error, expected title, `example.com`
   and RFC 2606. These preserve the preceding paired experiment's checks. Failure,
   timeout, invalid JSON or oversized response stops before FakeCo.
2. Only after the control passes, open the existing static public URL
   `https://clawrouter-fakeco.openclaw.ai/search-semantics/health`. This URL
   previously returned HTTP-200 tool-level `Internal Error`. It needs no temporary
   diagnostic generation or deployment. Stop after the response or failure.

Both requests use `gpt-6.1-sol`, separate fresh UUID session IDs and identical
settings: `commands.open`, `commands.response_length: "short"`,
`settings.external_web_access: true`. Same exact canonical key, read once via the
existing instruction-checking helper from
`op://Agent Secrets/OpenAI/OPENAI_API_KEY`. No environment credential fallback.
Each request has a 90-second timeout, 2 MiB JSON response limit and no redirect.
No operator public HTTP checks, new hosting, reference navigation, settings
matrix or automatic follow-up calls are included.

The metadata contains HTTP status, validated request ID, output length, known
error flags, content-check booleans, encrypted-output/usage presence and closed
`results` metadata: absent/null/invalid/array, array length, and counts of the
observed `text_result` label, unknown labels and malformed entries. A label is
not DTO validation. No prompts, response text, result contents/type names,
ciphertext, provider error messages or credentials are persisted.

## Operator and receipt

Plan-only, with no credential access, network or receipt creation:

```sh
node scripts/search-response-shape-comparison.mjs --plan
```

After explicit approval for this exact paid batch, use the reviewed source:

```sh
node scripts/search-response-shape-comparison.mjs --run-approved
```

Execution exclusively creates
`.artifacts/fakeco-codex-search-20261022/alpha-response-shape-comparison-execution.jsonl`
with mode 0600. The initial file and containing directory are synchronized before
credential access. Directory open/sync failure stops without reading the key or
dispatching a request. It appends and synchronizes complete
metadata snapshots before each dispatch intent and after each response, then
records the stopping reason. Each line is a complete snapshot; inspect the last
valid line after interruption. An intent counts against the two-call ceiling
even if transmission is uncertain. An existing receipt, including a partial or
failed run, prevents replay. Preserve it and reconcile; do not delete it to retry.
No automatic resumption. Local storage failure stops further calls.

`pair-complete` and exit 0 mean both JSON responses were observed after a passing
control; FakeCo may still have a tool error. Other stopping reasons exit 1.
`structuredResultsWithInternalError` is true for a FakeCo internal error with a
nonempty results array, false for that error with absent/null/invalid/empty
results, and null when the comparison cannot answer that question. Consult the
separate state/count fields to distinguish those cases.

If FakeCo unexpectedly returns the health content, retain that narrower
observation. This batch has no fresh marker or origin counters: neither a control
pass nor a FakeCo content return qualifies fresh retrieval, cache/live semantics,
structured-result semantics, billing, general model support or a failure cause.
Stop after the bounded batch even if it yields no useful distinction. The larger
semantics campaign remains gated on a qualified fresh retrieval control.

## Offline verification

```sh
node --test test/search-response-shape-comparison.test.mjs test/standalone-search-probe.test.mjs test/search-semantics-funnel.test.mjs
```

Provider and credential operations are mocked. Tests exercise request order and
shape, exclusive journal/replay refusal, durable pre-dispatch intent, conditional
stopping, transport/JSON/size errors, each results state, content-only success and
metadata privacy. No Worker, admin or manifest surface changes.

Preparation verification: all 54 tests passed, including 23 new runner scenarios.
No live provider search, 1Password access or Cloudflare operation was performed.

Autoreview of `8d46dec` completed through P2 with one finding: synchronize the
new receipt's containing directory. Fixed before handoff; the tests above verify
sync ordering and failure stopping. The original review status remains `findings`,
not a clean verdict on the follow-up fix. Outputs:
`~/.codex/review-results/alpha-response-shape-comparison-20261023/`.
Preparation receipt and source hashes:
`.artifacts/fakeco-codex-search-20261022/alpha-response-shape-comparison-preparation.json`.
