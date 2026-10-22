# Query transport

Native HTTP routes and unified JSON create routes preserve query key/value pairs,
including repeated keys, their interleaving, empty keys and empty values. Encoding
is normalized by `URLSearchParams`; alternate percent-encoding spellings are not
retained byte-for-byte. Fusion forwards the create query to both advisers and the
final synthesizer.

Direct manifest GET requests take declared path parameters from the URL query
(first value wins), remove every occurrence of those selector keys, and preserve
the remaining query sequence. JSON manifest envelopes accept scalar query values
(strings, numbers, booleans) or arrays of those scalars. Array order is retained:

```json
{ "group_by[]": ["project", "", "model"], "limit": 0 }
```

becomes `?group_by%5B%5D=project&group_by%5B%5D=&group_by%5B%5D=model&limit=0`.
Top-level null values and empty arrays add no pairs and do not replace defaults.
Nested objects/arrays and null array items are rejected with `invalid_request_body`
before dispatch. JSON objects cannot represent interleaving between different
keys; use the native URL or direct manifest GET URL when that order matters.

Caller keys that collide with credential or operator `upstream.query` keys are
rejected with `protected_query_parameter` before egress, including query API keys.
Other caller keys replace endpoint defaults without collapsing repeated values.
Query data never selects an arbitrary upstream URL, changes the proxy-key policy,
substitutes upstream credentials, or satisfies missing operator configuration.

Responses ownership hashes the configured create URL before caller query is
applied. A query-bearing create can be continued, retrieved or canceled without
repeating that query; credential/configuration changes still invalidate its owner.
Previously created native continuations whose owner included caller query need
one full-input restart after deployment.

Queries are forwarded to the selected subscription transport too. They do not
select another grant or endpoint; the upstream validates their meaning. This is
transport preservation, not a guarantee that every query is supported by a
subscription service.

Existing query restrictions remain authoritative: image generation, Responses
compaction and qualified durable background creation reject caller query. Closed
Responses controls retain their separate query validation and ownership checks.
WebSocket query preparation and multipart transcription are not changed here.
