import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchTimeoutSignal } from "../../shared/fetch-timeout.ts";

test("fetchTimeoutSignal defaults to 30s and combines a caller abort", () => {
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 30_000);
  const caller = new AbortController();
  const combined = fetchTimeoutSignal(caller.signal, 5_000);
  assert.ok(combined instanceof AbortSignal);
  assert.notEqual(combined, caller.signal);
  assert.equal(combined.aborted, false);
  caller.abort();
  assert.equal(combined.aborted, true);
});

test("fetchTimeoutSignal aborts a TCP accept that never sends an HTTP response", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/hung`, { signal: fetchTimeoutSignal(undefined, 40) }),
      (error) => error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"),
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
