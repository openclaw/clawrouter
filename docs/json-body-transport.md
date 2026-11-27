# Single-use nonmutating JSON transport

`jsonBodyTransport(value, maximumBytes)` returns a handle with exact `bytes`,
`stream()`, `discard()` and a read-only `retirement` reason. It reuses the existing
JSON byte counter, escaping and chunk generator. No route calls it yet.

The caller must provide already validated, structurally bounded plain JSON and
keep that graph immutable for the transport lifetime. Deeply frozen borrowed
input works without replacing fields, cloning the graph, serializing a document
or creating a whole-document UTF-8 buffer. The handle keeps the original graph
until `stream()` transfers that reference to the generator. Sizing is synchronous;
an invalid positive-safe-integer bound or an oversized value throws before a
handle is returned. The bound is encoded wire bytes, not a pool charge.

Each pull coalesces existing escaped pieces and emits at most 64 KiB. Quoted
string pieces contain at most 4,096 source UTF-16 units; surrogate pairs remain
together. The high-water mark is zero. Only the current bounded text/encoding
scratch and one emitted chunk are created by a pull; downstream queues and
transport copies remain their owners' responsibility. The final emitted byte
count must equal the measured count. This check does not make mutable input safe.

`stream()` can be called once. `discard()` can also be used before stream creation
or to fail an existing stream whose dispatch was abandoned. It is synchronous
and idempotent. EOF, cancellation, serialization error or discard clears the
handle's body, iterator and controller references, closes the generator and sets
`retirement` to `eof`, `cancel`, `error` or `discard` once. The closed iterator no
longer retains its object-entry arrays, recursive input references or current
string. The handle cannot create another stream after retirement.

Retirement describes only serializer references. Producer EOF may retire those
references while final encoded bytes are still readable by a consumer. It does
not clear selection, codec, retention or caller references; it does not prove
consumer EOF, physical network cancellation, garbage collection or released pool
capacity. Callers must retain their capacity until every separately owned
allocation and transport lifetime has ended.

The existing `jsonBodyStream`, replayable `mediaJsonBody`, default dispatch,
retention, input parser and body-budget behavior are unchanged. Borrowed music
input, reference images, HTTPS assets and phase-transfer activation remain
separate runtime work with their own authority and lifetime qualification.
