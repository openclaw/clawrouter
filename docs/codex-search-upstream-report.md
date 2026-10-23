# Draft: standalone search returns HTTP-200 Internal Error for fresh URLs

Local draft only. Not submitted. Observed October 22, 2026.

Historical provider-report draft; no provider outreach is part of this campaign.
The user cannot obtain endpoint-owner clarification. Current evidence and release
limits are consolidated in the [qualification report](codex-search-qualification.md).
Later calibrated-origin experiments remained inconclusive; the final two-call
pair had `results` absent in both successful and failing responses. The questions
and reproduction below are archival, not a new probe authorization.

Direct public API requests to `POST https://api.openai.com/v1/alpha/search`
with `gpt-6.1-sol` could search, open a returned reference, and open
`https://openai.com/`. Opening fresh synthetic URLs instead returned HTTP 200
with tool output `Internal Error`. The controlled origin received no page or
robots request, and the response did not contain its hidden content marker.
This prevents qualifying arbitrary fresh-URL retrieval in Codex custom-provider
standalone search. We do not yet know whether this is endpoint availability,
account entitlement, URL/fetch policy, or a service defect.

## Minimal reproduction

Use a ready HTTPS origin serving a new, unprimed path containing a generated
marker. Confirm readiness through a separate path, then send the following
body directly to the API with ordinary API-key authentication. Generate a new
UUID for `id` for each independent mode. Keep credentials in memory; do not
include authorization headers in the report.

```json
{
  "id": "<fresh-session-uuid>",
  "model": "gpt-6.1-sol",
  "commands": {
    "open": [{ "ref_id": "https://<ready-controlled-origin>/<new-path>" }]
  },
  "settings": { "external_web_access": true }
}
```

Control: repeat with another fresh session and `https://openai.com/`.
Expected: fresh-origin content, or a documented tool error explaining the
restriction. Observed: the known URL returns text without the selected tool
errors; the fresh URL returns `Internal Error`, no marker, no origin hit.
The same fresh-URL outcome occurred with `external_web_access: false`; we do
not infer a cache-only contract for this endpoint from that observation.

The direct matrix used ten search API calls, no model inference, five per mode:
query, returned reference, known URL, unique content on the established
`httpbingo.org/base64` service, and a ready controlled tunnel. Both fresh-content
controls failed in both modes. The stable service had a separate successful
readiness request; neither tested content URL was primed locally.

A native Codex CLI 0.163.0 live-search/WebSocket-inference session also failed
to open a fresh controlled URL. Two direct replays, bypassing ClawRouter,
retained that native request's original session ID:

- Exact forwarded body and headers, replacing only API authentication.
- Reduced body containing only `id`, `model`, `commands`, and `settings`.

Both returned the same HTTP-200 tool error with no marker or origin request.
These replays test forwarding equivalence; the independent matrix above tests
fresh sessions. They do not identify which upstream restriction causes failure.

## Request IDs for investigation

| Case | Request ID |
| --- | --- |
| Direct live known-URL control succeeds | `req_34a71a4981b5416594b2ce9a6c7fa95a` |
| Direct live established-service fresh content fails | `req_c3c33d483471457ba299cfd8b4113202` |
| Direct live controlled-origin open fails | `req_f57f0406129d4ec9955045e0c774a6b3` |
| Exact native-payload direct replay fails | `req_ebd08a5954ab419293b2b219dee0ed8b` |
| Reduced-payload direct replay fails | `req_b2f8214422764f9b85f840b6f5d41cf3` |

The temporary origins and native homes have been removed. Original content,
ciphertext, request bodies, and credentials were not retained in report logs.
These request IDs and the local metadata summaries are the available historical
evidence; fresh reproduction needs a new origin/path and generates new IDs.

## Questions for the endpoint owner

1. Is direct URL retrieval supported by this standalone endpoint for ordinary
   public API projects and the listed model? Are additional entitlements needed?
2. What URL eligibility, index coverage, domain age, tunnel, or fetch restrictions
   apply? Can the established-service and controlled-origin failures be classified
   using the request IDs above?
3. What does `external_web_access` guarantee for this endpoint, and what is the
   supported way to distinguish a fetch restriction from a transient service error?

Upstream pricing remains a separate, deliberately unqualified item. This draft
does not assign hosted Responses web-search prices to the standalone endpoint.

Maintainer reproduction commands and bounds:
[rollout investigation](codex-search-rollout.md#retrieval-investigation--october-22-2026).
