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

Precedence remains configured upstream query, endpoint query, then caller query.
Each caller key with values replaces all configured values of that key, without
collapsing its repeated caller values. Query data never selects an arbitrary
upstream URL, changes the proxy-key policy, substitutes upstream credentials, or
satisfies missing mandatory operator configuration.

Existing query restrictions remain authoritative: image generation, Responses
compaction and qualified durable background creation reject caller query. Closed
Responses controls retain their separate query validation and ownership checks.
WebSocket query preparation and multipart transcription are not changed here.
