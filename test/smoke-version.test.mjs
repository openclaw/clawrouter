import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVersionFetch, waitForVersionStability } from "../scripts/smoke-version.mjs";

const versionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const blueId = "11111111-2222-3333-4444-555555555555";
const baseUrl = "https://router.example";
const workerName = "clawrouter-edge";

function fakeClock() {
  let now = 0;
  const delays = [];
  return { delays, nowImpl: () => now, sleepImpl: async (delay) => { delays.push(delay); now += delay; } };
}

function versionResponse(id = versionId, options = {}) {
  return new Response("fixture", { ...options, headers: { "x-clawrouter-version-id": id, ...options.headers } });
}

function assertMismatch(error, actual, path = "/dashboard") {
  assert.ok(error instanceof assert.AssertionError);
  assert.equal(error.code, "ERR_ASSERTION");
  assert.equal(error.actual, actual);
  assert.equal(error.expected, versionId);
  assert.ok(error.message.startsWith(`Worker version override not honored for ${path}`));
  return true;
}

for (const method of ["GET", "HEAD"]) {
  test(`${method} discards fallback and returns only the honored response with override and manual redirects on every attempt`, async () => {
    const clock = fakeClock();
    const logs = [];
    let calls = 0;
    let cancelled = 0;
    const honored = versionResponse();
    const selected = createVersionFetch({ baseUrl, versionId, workerName, ...clock, log: (line) => logs.push(line), fetchImpl: async (input, init) => {
      calls++;
      assert.equal(input.url, `${baseUrl}/dashboard?token=do-not-log`);
      assert.equal(init.headers.get("cloudflare-workers-version-overrides"), `${workerName}="${versionId}"`);
      assert.equal(init.headers.get("authorization"), "Bearer do-not-log");
      assert.equal(init.redirect, "manual");
      if (calls === 2) return honored;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "x-clawrouter-version-id": blueId } });
    } });
    const input = new Request(`${baseUrl}/dashboard?token=do-not-log`, { method, headers: { authorization: "Bearer do-not-log" } });
    assert.equal(await selected(input, { redirect: "follow" }), honored);
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
    assert.deepEqual(clock.delays, [1000]);
    assert.deepEqual(logs, [`Worker version override pending: path=/dashboard expected=${versionId} actual=${blueId} attempt=1 retryInMs=1000`]);
  });
}

test("persistent fallback exhausts the total budget, cancels every body and retains the assertion", async () => {
  const clock = fakeClock();
  let calls = 0;
  let cancelled = 0;
  const selected = createVersionFetch({ baseUrl, versionId, workerName, ...clock, log: () => {}, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "x-clawrouter-version-id": blueId } });
  } });
  await assert.rejects(selected(`${baseUrl}/dashboard`), (error) => assertMismatch(error, blueId));
  assert.equal(clock.nowImpl(), 30_000);
  assert.deepEqual(clock.delays, [1000, 2000, 4000, 5000, 5000, 5000, 5000, 3000]);
  assert.equal(calls, 8);
  assert.equal(cancelled, calls);
});

test("a stalled retry is aborted within the total budget and retains the mismatch assertion", async () => {
  let calls = 0;
  let aborted = false;
  const selected = createVersionFetch({ baseUrl, versionId, workerName, retryTimeoutMs: 30, sleepImpl: async () => {}, log: () => {}, fetchImpl: async (_input, { signal }) => {
    if (++calls === 1) return versionResponse(blueId);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
  } });
  await assert.rejects(selected(`${baseUrl}/dashboard`), (error) => assertMismatch(error, blueId));
  assert.equal(calls, 2);
  assert.equal(aborted, true);
});

test("stalled fallback disposal remains bounded and preserves the assertion", async () => {
  let cancelled = false;
  const selected = createVersionFetch({ baseUrl, versionId, workerName, retryTimeoutMs: 30, log: () => {}, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { "x-clawrouter-version-id": blueId } }) });
  await assert.rejects(selected(`${baseUrl}/dashboard`), (error) => assertMismatch(error, blueId));
  assert.equal(cancelled, true);
});

test("caller cancellation during backoff stops without another upstream call", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let calls = 0;
  const selected = createVersionFetch({ baseUrl, versionId, workerName, log: () => {}, sleepImpl: async () => controller.abort(reason), fetchImpl: async () => { calls++; return versionResponse(blueId); } });
  await assert.rejects(selected(`${baseUrl}/dashboard`, { signal: controller.signal }), (error) => error === reason);
  assert.equal(calls, 1);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} fallback is a hard failure with exactly one upstream call`, async () => {
    const clock = fakeClock();
    let calls = 0;
    const selected = createVersionFetch({ baseUrl, versionId, workerName, ...clock, fetchImpl: async () => { calls++; return versionResponse(blueId); } });
    // The init method must take precedence over the Request's GET method.
    await assert.rejects(selected(new Request(`${baseUrl}/dashboard`), { method }), (error) => assertMismatch(error, blueId));
    assert.equal(calls, 1);
    assert.deepEqual(clock.delays, []);
  });
}

for (const actual of [null, "blue", `${versionId}, ${blueId}`]) {
  test(`missing or malformed version ${JSON.stringify(actual)} fails immediately`, async () => {
    const clock = fakeClock();
    let calls = 0;
    const selected = createVersionFetch({ baseUrl, versionId, workerName, ...clock, fetchImpl: async () => {
      calls++;
      return actual === null ? new Response("fixture") : versionResponse(actual);
    } });
    await assert.rejects(selected(`${baseUrl}/dashboard`), (error) => assertMismatch(error, actual));
    assert.equal(calls, 1);
    assert.deepEqual(clock.delays, []);
  });
}

test("Access exceptions remain limited to unversioned protected challenges", async () => {
  const clock = fakeClock();
  let calls = 0;
  let response;
  const selected = createVersionFetch({ baseUrl, versionId, workerName, ...clock, fetchImpl: async () => { calls++; return response; } });
  for (const status of [302, 401, 403]) {
    response = new Response(null, { status, headers: status === 302 ? { location: "https://team.cloudflareaccess.com/login" } : { "content-type": "text/html" } });
    assert.equal(await selected(`${baseUrl}/v1/session`, { method: "POST" }), response);
  }
  response = new Response(null, { status: 302, headers: { location: "/cdn-cgi/access/login" } });
  assert.equal(await selected(`${baseUrl}/dashboard`), response);
  response = new Response(null, { status: 302, headers: { location: "/dashboard/home" } });
  await assert.rejects(selected(`${baseUrl}/dashboard`), /override not honored/);
  response = new Response(null, { status: 403, headers: { "content-type": "application/json" } });
  await assert.rejects(selected(`${baseUrl}/v1/session`), /override not honored/);
  response = new Response(null, { status: 403, headers: { "content-type": "text/html" } });
  await assert.rejects(selected(`${baseUrl}/v1/providers`), /override not honored/);
  response = versionResponse("blue", { status: 403, headers: { "content-type": "text/html" } });
  await assert.rejects(selected(`${baseUrl}/v1/session`), /override not honored/);
  assert.equal(calls, 8);
  assert.deepEqual(clock.delays, []);
});

test("stability requires five consecutive raw honored reads and resets on fallback", async () => {
  const clock = fakeClock();
  const versions = [versionId, versionId, blueId, versionId, versionId, versionId, versionId, versionId];
  let calls = 0;
  let cancelled = 0;
  await waitForVersionStability({ baseUrl, versionId, workerName, ...clock, log: () => {}, fetchImpl: async (url, init) => {
    assert.equal(url, `${baseUrl}/v1/health`);
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.get("cloudflare-workers-version-overrides"), `${workerName}="${versionId}"`);
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "x-clawrouter-version-id": versions[calls++] } });
  } });
  assert.equal(calls, 8);
  assert.equal(cancelled, 8);
  assert.deepEqual(clock.delays, Array(7).fill(1000));
});

test("stability fails clearly at its bound instead of proceeding through intermittent fallback", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(waitForVersionStability({ baseUrl, versionId, workerName, ...clock, log: () => {}, fetchImpl: async () => versionResponse(++calls % 5 ? versionId : blueId) }), /did not stabilize within 30000ms \(5 consecutive honored reads required\)/);
  assert.equal(calls, 30);
  assert.equal(clock.nowImpl(), 30_000);
});

test("stability does not retry missing proof or accept an Access challenge", async () => {
  for (const response of [new Response(null), new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } })]) {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(waitForVersionStability({ baseUrl, versionId, workerName, ...clock, fetchImpl: async () => { calls++; return response; } }), /override not honored/);
    assert.equal(calls, 1);
    assert.deepEqual(clock.delays, []);
  }
});

test("stability aborts a stalled read at its overall deadline", async () => {
  let aborted = false;
  await assert.rejects(waitForVersionStability({ baseUrl, versionId, workerName, timeoutMs: 30, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }) }), /did not stabilize within 30ms/);
  assert.equal(aborted, true);
});

test("deployed smoke completes the stability gate before its first POST", async () => {
  const deployedUrl = new URL("../scripts/smoke-deployed.mjs", import.meta.url).href;
  const packageUrl = new URL("../package.json", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import metadata from ${JSON.stringify(packageUrl)} with { type: "json" };
    let healthReads = 0, posts = 0;
    globalThis.fetch = async (input, init = {}) => {
      const path = new URL(input).pathname;
      const headers = { "x-clawrouter-version-id": ${JSON.stringify(versionId)} };
      if (init.method === "POST") {
        posts++;
        assert.equal(healthReads, 6, "one readiness read plus five stability reads before POST");
        throw new Error("fixture reached first POST");
      }
      if (path === "/v1/health") {
        healthReads++;
        return Response.json({ ok: true, version: metadata.version, versionId: ${JSON.stringify(versionId)} }, { headers });
      }
      if (path === "/") return new Response(null, { status: 302, headers: { ...headers, location: "/dashboard" } });
      if (path === "/catalog") return new Response(null, { status: 302, headers: { ...headers, location: "/dashboard/catalog" } });
      if (path === "/v1/providers") return Response.json({ providers: Array(19).fill({}) }, { headers });
      if (["/v1/routes", "/api/route"].includes(path)) return Response.json({ openaiCompatible: [{}], manifestProxy: [{ route: "/v1/proxy/tavily/search" }] }, { headers });
      if (path === "/v1/entitlements") return Response.json({ error: { code: "client_auth_required" } }, { status: 401, headers });
      return new Response("Access denied", { status: 403, headers: { "content-type": "text/html" } });
    };
    await assert.rejects(import(${JSON.stringify(deployedUrl)}), /fixture reached first POST/);
    assert.equal(posts, 1);
    console.log("first POST followed five stable reads");
  `], { env: { ...process.env, CLAWROUTER_BASE_URL: baseUrl, CLAWROUTER_SMOKE_VERSION_ID: versionId, CLAWROUTER_DEPLOY_ENV: "", CLAWROUTER_WORKER_NAME: workerName }, timeout: 15_000 });
  assert.match(stdout, /first POST followed five stable reads/);
});
test("override reaches HTTP server on every route, preserves auth/body and rejects silent fallback", async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ headers: request.headers, method: request.method, body });
    if (request.url === "/v1/session") { response.writeHead(302, { location: "https://team.cloudflareaccess.com/login" }); response.end(); return; }
    if (request.url === "/v1/admin/test") { response.writeHead(403, { "content-type": "text/html" }); response.end("Access denied"); return; }
    if (request.url !== "/fallback") response.setHeader("x-clawrouter-version-id", request.url === "/wrong" ? "blue" : versionId);
    response.end("green");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const selected = createVersionFetch({ baseUrl, versionId, workerName: "clawrouter-edge" });
  const result = await selected(new Request(`${baseUrl}/v1/proxy/test`, { method: "POST", headers: { authorization: "Bearer fixture" }, body: "payload" }));
  assert.equal(await result.text(), "green");
  assert.equal(calls[0].headers["cloudflare-workers-version-overrides"], `clawrouter-edge="${versionId}"`);
  assert.equal(calls[0].headers.authorization, "Bearer fixture");
  assert.equal(calls[0].method, "POST"); assert.equal(calls[0].body, "payload");
  for (const path of ["/fallback", "/wrong"]) await assert.rejects(selected(`${baseUrl}${path}`), /override not honored/);
  assert.equal((await selected(`${baseUrl}/v1/session`)).status, 302);
  assert.equal((await selected(`${baseUrl}/v1/admin/test`)).status, 403);
});

test("Cloudflare health-record API receives neither override nor new fetch options", async () => {
  const init = { method: "PUT", headers: { authorization: "Bearer fixture" }, body: "health" };
  let calls = 0;
  const selected = createVersionFetch({ baseUrl: "https://router.example", versionId, workerName: "clawrouter-edge", fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "https://api.cloudflare.com/health"); assert.equal(options, init);
    return new Response(null, { status: 204 });
  } });
  assert.equal((await selected("https://api.cloudflare.com/health", init)).status, 204);
  assert.equal(calls, 1);
});

test("malformed version/name fails before any HTTP request", () => {
  for (const options of [{ versionId: "not-a-version", workerName: "worker" }, { versionId, workerName: 'worker="another"' }]) {
    assert.throws(() => createVersionFetch({ baseUrl: "https://router.example", ...options }), /invalid smoke Worker/);
  }
});
