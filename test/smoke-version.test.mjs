import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createVersionFetch } from "../scripts/smoke-version.mjs";

const versionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
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
