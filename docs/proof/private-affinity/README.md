# Private affinity continuation proof

The contract is that every supported typed affinity-header form retains the
fallback target across subsequent requests, alone or with a response ID. Header
casing and scalar/singleton-array shape remain unchanged.

The proof runs the actual private entrypoint in workerd with synthetic bindings
and a native HTTP upstream restricted to loopback. It tests JSON response headers,
top-level SSE headers, and nested SSE response headers, each with lowercase and
mixed-case names and scalar or singleton-array values. One synthetic 503 forces
fallback, followed by affinity-only and combined-continuation requests.

```sh
npm install --prefix /tmp/clawsweeper-worker-proof-tools --no-save --no-audit --no-fund wrangler@4.107.0
node scripts/proof-private-affinity.mjs d683e35456ce2ff23d886c3fe0bfb90c67a37817 /tmp/clawsweeper-worker-proof-tools .artifacts/private-affinity
```

The baseline exhibits unwrapped mixed-case affinity and rejected lowercase
arrays. The candidate must retain fallback routing in all twelve cases. The
receipt records source hashes, revisions, dirty state, runtime versions, response
statuses and numeric route slots. Synthetic upstream identity values must never
appear in client-visible responses.

This does not exercise a live provider or prove a production deployment. Existing
unit coverage separately preserves tampering, conflicting-origin, and credential
rotation rejection. No upstream configuration or public API shape changes.
