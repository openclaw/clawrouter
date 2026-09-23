import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import packageMetadata from "../package.json" with { type: "json" };

const readinessUrl = new URL("../scripts/smoke-readiness.mjs", import.meta.url).href;
const selfHostUrl = new URL("../scripts/smoke-self-host.mjs", import.meta.url).href;

// A server or test-runner timer in the same process would conceal an unsettled
// top-level await. Only the readiness code owns liveness in these children.
function runChild(source, baseUrl = "http://127.0.0.1:1") {
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      CLAWROUTER_BASE_URL: baseUrl,
      CLAWROUTER_ADMIN_TOKEN: "synthetic-admin",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt,
    }));
  });
}

for (const phase of ["fetch", "body", "cancellation"]) {
  test(`standalone readiness owns the deadline while ${phase} has no referenced handles`, async (t) => {
    t.diagnostic(`Node ${process.version}; Undici ${process.versions.undici}`);
    const result = await runChild(`
      import { waitForHealth } from ${JSON.stringify(readinessUrl)};
      const pending = () => new Promise(() => {});
      await waitForHealth({
        baseUrl: process.env.CLAWROUTER_BASE_URL,
        timeoutMs: 1000,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener("abort", () => console.log("request aborted"));
          return ${phase === "fetch"
            ? "pending()"
            : phase === "body"
              ? "{ ok: true, json: pending }"
              : "{ ok: false, status: 503, body: { cancel: pending } }"};
        },
      });
    `);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /request aborted/);
    assert.match(result.stderr, /health readiness timed out after 1000ms.*health request deadline elapsed/);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
    assert.ok(result.elapsedMs < 2_500, JSON.stringify(result));
  });
}

test("successful readiness clears its referenced request and probe deadlines", async () => {
  const result = await runChild(`
    import { waitForHealth } from ${JSON.stringify(readinessUrl)};
    await waitForHealth({
      baseUrl: process.env.CLAWROUTER_BASE_URL,
      timeoutMs: 4000,
      fetchImpl: async () => Response.json({ ok: true }),
      probeImpl: async () => {},
    });
  `);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.elapsedMs < 2_000, JSON.stringify(result));
});

for (const mode of [
  "delayed listener", "connection reset", "stalled body", "unavailable stream",
  "redirect", "invalid JSON", "invalid health", "wrong version", "catalog failure",
]) {
  test(`self-host CLI preserves its outcome after ${mode} in a separate process`, async (t) => {
    const mutations = [];
    let healthCalls = 0;
    let catalogCalls = 0;
    let stalledBodyClosed = false;
    let firstHealthAt;
    let secondHealthAt;
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/health" || request.url === "/ready") {
        healthCalls += 1;
        if (healthCalls === 1) firstHealthAt = Date.now();
        if (healthCalls === 2) secondHealthAt = Date.now();
        if (healthCalls === 1 && mode === "connection reset") {
          request.socket.destroy();
          return;
        }
        if (healthCalls === 1 && mode === "redirect") {
          response.writeHead(302, { location: "/ready" }).end();
          return;
        }
        if (healthCalls === 1 && (mode === "stalled body" || mode === "unavailable stream")) {
          response.writeHead(mode === "stalled body" ? 200 : 503);
          response.write('{"ok":');
          response.on("close", () => { stalledBodyClosed = true; });
          return;
        }
        if (healthCalls === 1 && mode === "invalid JSON") {
          response.end("invalid");
          return;
        }
        response.end(JSON.stringify({
          ok: mode !== "invalid health",
          version: mode === "wrong version" ? "wrong" : packageMetadata.version,
        }));
      } else if (request.url === "/v1/catalog") {
        catalogCalls += 1;
        if (mode === "catalog failure") response.statusCode = 500;
        response.end(JSON.stringify({ providers: [{ id: "firecrawl" }] }));
      } else if (request.url.startsWith("/v1/admin/")) {
        mutations.push(`${request.method} ${request.url.replace(/self_host_smoke_[a-f0-9]+/g, "fixture")}`);
        response.end('{"ok":true}');
      } else {
        response.writeHead(404).end();
      }
    });
    await listen(server);
    const port = server.address().port;
    let listenerTimer;
    t.after(async () => {
      clearTimeout(listenerTimer);
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });
    if (mode === "delayed listener") {
      await new Promise((resolve) => server.close(resolve));
      listenerTimer = setTimeout(() => server.listen(port, "127.0.0.1"), 350);
    }
    const result = await runChild(`await import(${JSON.stringify(selfHostUrl)});`, `http://127.0.0.1:${port}`);
    assert.equal(result.signal, null, result.stderr);
    if (mode === "invalid health" || mode === "wrong version") {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /health (response must report ok|must report the built release version)/);
      assert.equal(healthCalls, 1, "preserve immediate outer assertions");
      assert.deepEqual(mutations, []);
      return;
    }
    assert.deepEqual(mutations, [
      "PUT /v1/admin/keys/fixture",
      "POST /v1/admin/keys/fixture/revoke",
      "POST /v1/admin/policies/fixture/revoke",
    ]);
    assert.equal(catalogCalls, 1, "run the scoped catalog probe only once");
    if (mode === "catalog failure") {
      assert.equal(result.code, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /self-host smoke ok/);
      return;
    }
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /self-host smoke ok/);
    if (mode === "invalid JSON") {
      assert.ok(healthCalls >= 2, "retry after the malformed first response");
      assert.match(result.stdout, /attempt=1 reason=request error:.*invalid.*JSON.*retryInMs=500/);
      assert.ok(result.elapsedMs < 4_500, JSON.stringify(result));
    } else if (mode !== "delayed listener") {
      assert.equal(healthCalls, 2, JSON.stringify(result));
    }
    if (mode === "connection reset") {
      assert.ok(secondHealthAt - firstHealthAt >= 450, "preserve the 500ms retry delay");
      assert.ok(result.elapsedMs < 2_000, "clear failed-attempt timers after recovery");
    }
    if (mode === "stalled body") {
      assert.equal(stalledBodyClosed, true, "cancel the timed-out response body");
      assert.ok(secondHealthAt - firstHealthAt >= 2_450, "preserve the 2s attempt and 500ms retry");
      assert.ok(secondHealthAt - firstHealthAt < 4_000, "do not inherit the deployed 10s attempt limit");
    }
    if (mode === "unavailable stream") {
      assert.equal(stalledBodyClosed, true, "cancel the unused non-OK response body");
      assert.ok(result.elapsedMs < 2_000, "do not wait for discarded error bodies");
    }
  });
}

for (const phase of ["fetch", "body"]) {
  test(`a late ${phase} outcome cannot publish readiness or start a probe`, async () => {
    const result = await runChild(`
      import assert from "node:assert/strict";
      import { setTimeout as delay } from "node:timers/promises";
      import { waitForHealth } from ${JSON.stringify(readinessUrl)};
      let probes = 0;
      await assert.rejects(waitForHealth({
        baseUrl: process.env.CLAWROUTER_BASE_URL,
        timeoutMs: 1000,
        fetchImpl: async () => ${phase === "fetch"
          ? "{ await delay(1200); return Response.json({ ok: true }); }"
          : "({ ok: true, json: async () => { await delay(1200); throw new Error('late body failure'); } })"},
        probeImpl: () => { probes += 1; },
      }), /health request deadline elapsed/);
      await delay(400);
      assert.equal(probes, 0);
      console.log("bounded failure; no late probe");
    `);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /bounded failure; no late probe/);
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
