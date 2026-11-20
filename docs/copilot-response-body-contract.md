# Copilot response body transport

`readCopilotResponseText(response, { operation, expectedUrl, profile })` reads a
complete response body into UTF-8 text. It does not fetch, parse JSON, authorize a
destination or credential, install a token, cache a catalog, or activate a route.

The caller supplies the original `HttpOperation` and the exact URL of its qualified
request. The actual response URL must be nonempty and equal that URL. Catalog
responses require HTTP 200 and at most 2 MiB; device responses require HTTP 2xx and
at most 8 KiB. These are operational bounds, not vendor limits. There is no account
profile. Redirected responses, other statuses, ranges, used/locked bodies, encoded
content, invalid lengths and non-JSON or non-UTF-8 content types fail with the fixed
content-free error `invalid_copilot_response_body`.

The reader owns one fixed profile-sized byte buffer and one BYOB window of at most
16 KiB (8 KiB for device responses). It checks returned backing-buffer size before
copying. It does not archive chunks or fall back to an unbounded default reader.
All read calls count toward 8192, including empty results and the EOF call. Declared
length must match complete EOF; UTF-8 decoding is fatal. No text is returned on
truncation, cancellation, protocol failure or exhausted bounds.

`operation.wait` and its original signal govern pending reads. On failure, the
reader cancels its body and awaits both the outstanding read and cancellation
settlement before releasing the lock and completing its own promise. It never
releases another reader's locked body, retires the caller's deadline, or starts a
retry. Callers must not treat the earlier rejection of a separate operation race
as retirement of this reader's resources.

## Capacity and authority remain with the caller

This module neither acquires nor releases a capacity lease. The caller must retain
capacity through reading, returned-text retention, subsequent decoding, fresh
authority/policy checks and publication or discard. Wire bounds do not establish
the simultaneous heap cost of UTF-16 text, re-encoding, JSON objects, catalog
projection or discarded metadata. No 32-to-64 MiB catalog charge or 1-to-2 MiB small
profile charge is qualified by this module.

Before common activation, the owner must still qualify aggregate allocations for
discarded catalog containers and preparse node/string limits, and the separate
account response envelope and its bounds. These are internal implementation gaps.
The existing catalog decoder's byte/depth/row/ID bounds do not resolve them.

Original domain, account, GitHub token and generation-lineage authority must be
checked by the common owner before fetching and after parsing. Request factories,
device codecs and catalog decoding retain their existing contracts. Empty results
cannot resurrect seeds or confer inference entitlement; no environment fallback,
pricing or capacity claim is added here.

## Focused proof

The Node tests fetch from an actual loopback HTTP server. The workerd tests fetch
through the existing isolated upstream service fixture and inspect real response
URLs and native byte readers. They cover limits, UTF-8 fragmentation, EOF, status
and metadata rejection, pending cancellation and lock retirement. Explicit read
and cancellation instrumentation adds deterministic empty-read, oversized-backing
and delayed-cleanup faults around fetched bodies; those faults are supplementary
and are not synthetic BYOB evidence for production transport behavior. These tests
do not qualify live Copilot authorization or whole decoded-graph memory accounting.
