import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adminRequest } from "../scripts/admin-api.mjs";
import { acceptGrantPoolBaseline, recoverGrantPools } from "../scripts/grant-pool-recovery.mjs";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

test("account cutover keeps actual HTTP and WebSocket offers and dispatch in agreement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-account-cutover-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, 'export { default } from "./worker/index.ts"; export * from "./worker/index.ts";', upstreamScript, { activate: false });
    const request = (path, options) => adminRequest(path, { ...options, env: { CLAWROUTER_BASE_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "fixture-activation-admin" }, fetchImpl: (url, init) => mf.dispatchFetch(url, init) });
    const secret = "account-cutover-proxy", model = "openai/gpt-6-astra";
    await request("/v1/admin/keys/client", { method: "PUT", body: { enabled: true, providers: ["openai"], tenantId: "default", retainRequestContent: false, requestCostMicros: 0, secretSha256: createHash("sha256").update(secret).digest("hex") } });
    const dispatch = (path, init = {}) => mf.dispatchFetch(`https://router.example${path}`, { ...init, headers: { authorization: `Bearer clawrouter-live-client-${secret}`, ...init.headers } });
    const upstream = await mf.getWorker("upstream");
    const calls = async () => (await (await upstream.fetch("https://fixture.example/state")).json()).calls;
    async function check(code, authorization) {
      const before = await calls();
      const catalogResponse = await dispatch("/v1/catalog");
      assert.equal(catalogResponse.status, 200);
      const provider = (await catalogResponse.json()).providers.find(row => row.id === "openai");
      for (const transport of ["http", "websocket"]) {
        const offers = provider.offers.filter(offer => offer.endpoint === "responses" && offer.modelId === model && offer.transport === transport);
        assert.ok(offers.length > 0, `${transport} retains an inspectable offer`);
        assert.ok(offers.every(offer => offer.eligible === !code && offer.reasonCode === code));
      }
      const response = await dispatch("/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: "fixture", max_output_tokens: 8 }) });
      assert.equal(response.status, code ? 503 : 200);
      const body = await response.json();
      if (code) assert.equal(body.error.code, code);
      else assert.equal(body.status, "completed");
      const opened = await dispatch("/v1/responses", { headers: { upgrade: "websocket" } });
      assert.equal(opened.status, 101, "authorization for environment use is checked on each create");
      const socket = opened.webSocket;
      assert.ok(socket);
      socket.accept();
      try {
        const terminal = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("account cutover frame timed out")), 10_000);
          socket.addEventListener("message", event => {
            const frame = JSON.parse(event.data);
            if (frame.type === "error" || frame.type === "response.completed") { clearTimeout(timer); resolve(frame); }
          });
        });
        socket.send(JSON.stringify({ type: "response.create", model, input: "fixture", max_output_tokens: 8 }));
        const frame = await terminal;
        if (code) assert.equal(frame.error.code, code);
        else assert.equal(frame.response.status, "completed");
      } finally { socket.close(1000, "fixture complete"); }
      const after = await calls();
      assert.equal(after.length - before.length, code ? 0 : 2);
      if (!code) assert.deepEqual(after.slice(-2).map(call => call.authorization), [authorization, authorization]);
    }

    await check("grant_pool_not_ready");
    const grantPath = "/v1/admin/upstream-grants/policies/client/account";
    await request(`${grantPath}?mode=replace`, { method: "PUT", body: { provider: "openai", kind: "api_key", credential: "scoped-fixture", enabled: true } });
    await check(undefined, "Bearer scoped-fixture");
    await request(`${grantPath}/revoke`, { method: "POST" });
    await check("grant_pool_not_ready");
    // This test invocation created the complete isolated storage set.
    await acceptGrantPoolBaseline("fresh", { request });
    await recoverGrantPools({ request });
    await check(undefined, "Bearer fixture-upstream-key");
    await request(`${grantPath}?mode=replace`, { method: "PUT", body: { provider: "openai", kind: "api_key", credential: "scoped-fixture", enabled: true } });
    await request(grantPath, { method: "PUT", body: { enabled: false } });
    await check("upstream_grant_pool_unavailable");
    await request(`${grantPath}/revoke`, { method: "POST" });
    await check(undefined, "Bearer fixture-upstream-key");
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

const upstreamScript = `
const calls = [];
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/state') return Response.json({ calls });
  calls.push({ authorization: request.headers.get('authorization') });
  const response = { id: 'cutover_' + calls.length, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } };
  if (request.headers.get('upgrade') !== 'websocket') return Response.json(response);
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].addEventListener('message', () => {
    pair[1].send(JSON.stringify({ type: 'response.created', response: { id: response.id, status: 'in_progress' } }));
    pair[1].send(JSON.stringify({ type: 'response.completed', response }));
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
} };
`;
