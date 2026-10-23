# Independent retrieval experiment: Tailscale Funnel

Completed 2026-10-23: public calibration passed, then the separately approved one
direct Sol search call returned HTTP-200 tool-level `Internal Error`, no marker
and zero origin requests. Result inconclusive. Fixture/Funnel closed; independent
checks confirmed both configurations `{}` and port 18765 free. No Cloudflare
writes; existing FakeCo resources and the [paired retrieval result](search-semantics-paired-retrieval.md)
remain unchanged.

## Hosting and boundary

Use the authenticated Mac and installed Tailscale 1.102.4:

- CLI: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- Public URL: `https://funnel-fixture.example.invalid/`.
- Dedicated origin: `http://127.0.0.1:18765`.
- Initial read-only preflight: connected, MagicDNS enabled, certificate eligible,
  Funnel/HTTPS capabilities present, Serve/Funnel configuration `{}`, port free.

[Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel) exposes the
service publicly; Serve alone restricts access to the tailnet. Use foreground
mode; HTTPS can trigger automatic certificate issuance. Funnel uses the node's
`.ts.net` name. Foreground configuration is tied to the CLI session, as described
in the [versioned configuration source](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/serve.go).

Do not enroll, read the fallback enrollment key, change tailnet policy, use
`--bg`, or use global `reset`. Unexpected node identity or existing configuration
blocks startup. Public HTTPS reachability and foreground cleanup were observed
in this batch; certificate issuer/state was not inspected or revoked.

## Authorized exposure and calibration result

Exposure began at `2026-10-23T08:16:18.680Z`; automatic deadline
`2026-10-23T08:26:18.680Z`. Foreground ownership and the loopback-only listener
were verified. The enrollment fallback was not used; no Cloudflare writes.

The remote web tool reported the URL inaccessible, with no origin requests.
An anonymous [Jina Reader](https://docs.jina.ai/) request then fetched the public
HTTPS URL outside this Mac's tailnet client. HTTP 200 at
`2026-10-23T08:16:48.420Z`; the response contained the current calibration marker.
Exactly one origin GET at `2026-10-23T08:16:47.701Z`, within that request's
`08:16:43.052Z`–`08:16:48.420Z` window. No operator origin requests or other
counted activity. Private witness confirmation matched the returned marker.

The marker was then rotated; generation 1 armed, all counters zero, timestamps
null. No further operator public requests. This qualifies public reachability
for calibration; it does not qualify OpenAI search semantics. One paid retrieval
was subsequently authorized and executed as recorded below. Exposure ended after
that call, before its original deadline.

Ownership/calibration receipt:
`.artifacts/fakeco-codex-search-20261022/funnel-exposure-receipt.json`.
Authorization: `funnel-exposure-authorization.json` in the same directory.
This is the calibration-time snapshot; the final receipt below supersedes its
active-exposure/pending-approval state.

## Authorized retrieval and verified cleanup

Exactly one direct `gpt-6.1-sol` call to
`https://api.openai.com/v1/alpha/search`, `external_web_access: true`.
Dispatched `2026-10-23T08:18:33.078Z`; immediate and 15-second-late observations
complete at `2026-10-23T08:18:48.839Z`.

- HTTP 200; tool-level `Internal Error`; no returned measurement marker.
- Request ID: `req_2133b4eba9c245c1af161064d697a6f9`.
- Text output length 233; encrypted output present; usage absent. Raw output,
  ciphertext, credentials and the measurement marker were not persisted.
- Both snapshots: root GET/HEAD 0/0, robots 0, rejected 0, overflow false,
  first/last GET timestamps null; generation 1 and verified witness retained.
- No retry, additional search, inference, router call, operator public request,
  Cloudflare write, enrollment, policy change or fallback-key access.

Fresh retrieval remains unqualified. Successful independent public calibration
followed by this failure does not identify the cause of the Cloudflare failure,
prove that no upstream network attempt occurred, or establish universal live/cache
semantics. The broader semantics matrix remains gated. Usage was absent; upstream
billing remains unqualified.

The runner closed the fixture, ended its own foreground child and exited 0.
It reported empty Funnel/Serve configurations. Independent post-exit checks
confirmed both `{}` and no listener on 127.0.0.1:18765. No active exposure or
pending Funnel cleanup. Certificate state/CT history was not revoked or cleared.

Final execution/cleanup receipt:
`.artifacts/fakeco-codex-search-20261022/funnel-retrieval-receipt.json`.
Separate retrieval authorization: `funnel-retrieval-authorization.json` in the
same directory. Do not replay under the completed approvals; any further public
exposure or paid retrieval needs a fresh approved batch.

## First authorization: exposure and public calibration

After explicit approval, run from this checkout:

```sh
node scripts/search-semantics-funnel.mjs --expose-approved
```

The runner starts the fixture and this foreground child, with no CLI output or
stdin forwarded:

```sh
"/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
  funnel --https=443 http://127.0.0.1:18765
```

Hard exposure limit: ten minutes from fixture startup, including readiness,
outside-client verification and waiting for search approval. No automatic renewal.
Only exact `/` GET/HEAD and `/robots.txt` GET/HEAD succeed. Everything else is
404. No HTTP controls, filesystem serving, cookies, upstream credentials, or
request/response content logs. Counters are bounded; timestamps cover root GETs.

Fetch the public root from an independent client outside this tailnet. A remote
web-fetch service can be attempted; if it cannot reach the URL, use a confirmed
external client. A local browser/curl using this Mac's MagicDNS does not qualify.
Require the calibration marker in the external response and a root origin GET.
The private stdin command below compares that returned calibration marker; it
does not itself attest where the client ran:

```text
witness <calibration marker from the outside client's response>
arm
snapshot
```

`arm` replaces the marker and clears counters/timestamps. The measurement marker
stays in memory and the served HTML; it is never printed or included in a search
request. It cannot be rotated again in this exposure. Stop operator public
requests after arming. If public calibration cannot be established, stop before
search. Background/public traffic before dispatch also blocks measurement.

## Second authorization: exactly one paid retrieval

Obtain separate approval after external calibration. Then send this private stdin
command while at least 110 seconds remain:

```text
probe-approved
```

Only this command reads the OpenAI key. The runner checks item field metadata
first and stops if populated `ACCESS_INSTRUCTIONS` need operator review, the key
field is missing/ambiguous, or the credential helper fails. Exact reference:
`op://Agent Secrets/OpenAI/OPENAI_API_KEY`. No fallback account or vault; no
secret values in arguments, files or output.

One direct POST to `https://api.openai.com/v1/alpha/search`, model `gpt-6.1-sol`:

```json
{
  "id": "<fresh UUID>",
  "model": "gpt-6.1-sol",
  "commands": {
    "open": [{ "ref_id": "https://funnel-fixture.example.invalid/" }],
    "response_length": "short"
  },
  "settings": { "external_web_access": true }
}
```

Reuse the reviewed direct-search transport: no redirects, 90-second timeout,
2 MiB response limit, no retry. No inference, router call, second control call or
matrix expansion. The endpoint's upstream billing remains unqualified; prior
responses exposed no usage. The endpoint/request shape is empirical, not a
published OpenAI contract.

Record closed response metadata and immediate/15-second-late origin counters.
Qualify fresh retrieval only if the exact new marker is returned, HTTP/tool
success holds, and a root GET occurs during the measurement without counter
overflow or expiration. HEAD alone does not qualify. Failed/tool-error output,
absent marker or absent origin GET is inconclusive. No raw provider text,
ciphertext, marker, prompt, IP, query, headers or User-Agent in the receipt.

Success establishes fresh retrieval on this hosting path for this one endpoint,
model and time. It does not explain the Cloudflare-path failure, establish
universal live/cached semantics, or identify which public client made a GET.

## Cleanup and verification

Cleanup runs after the one probe. Alternatively, send `stop`, close stdin,
interrupt the runner, or let the deadline expire.
The runner closes the fixture and terminates its own foreground child, polling
for removal of the captured session. In the [pinned CLI source](https://github.com/tailscale/tailscale/blob/v1.102.4/cmd/tailscale/cli/serve_v2.go),
`funnel --https=443 off` selects persistent configuration; it does not replace
ending the foreground session. The runner therefore does not issue `off` or
`reset`. Any remaining configuration is reported as nonempty, with a failed
cleanup exit status. Investigate read-only before any additional mutation.
Verify both read-only status commands return `{}` and no fixture listener remains:

```sh
"/Applications/Tailscale.app/Contents/MacOS/Tailscale" funnel status --json
"/Applications/Tailscale.app/Contents/MacOS/Tailscale" serve status --json
lsof -nP -iTCP:18765 -sTCP:LISTEN
```

Certificate issuance may leave certificate state even after exposure ends; cleanup
does not claim to revoke certificates or clear public certificate-transparency
records. Process crashes/suspend are not a wall-clock timer guarantee. Foreground
session lifetime provides an additional daemon-owned cleanup boundary.

## Offline verification

```sh
node --test test/search-semantics-funnel.test.mjs test/standalone-search-probe.test.mjs
```

Tests bind ephemeral loopback ports and mock Tailscale, credentials and provider
transport. Cover rotation, no public controls, contamination, marker/GET pairing,
one attempt, errors, expiration, independent gates, ownership, foreground cleanup,
disconnected/wrong node, port collision and credential metadata checks. These
checks do not issue certificates or demonstrate public exposure.

Preparation verification: 26 focused tests passed, including cancellation during
preflight, fixture acquisition and foreground readiness. A separate local-only
rehearsal used the exact port 18765: HTTP 200, marker present, one origin GET,
then listener closed. Both real Serve/Funnel configurations remain `{}`.

Autoreview of `7daf3c4` found one P2: termination handling was installed after
startup and could leave the child alive if the parent terminated during readiness.
Fixed by installing signal handlers before startup, propagating cancellation,
and covering all three startup stages with regression tests. Review result:
`~/.codex/review-results/search-funnel-preparation-20261023/`. The original review
reports that finding; do not describe it as a clean review. Public HTTPS calibration
and foreground teardown have since passed as recorded above; the one upstream
retrieval was inconclusive.
