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

test("persisted active and paused owners finish publication through authenticated recovery after restart", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-account-restart-"));
  const accounts = [true, false].map(enabled => {
    const id = enabled ? "persist_active" : "persist_paused";
    return { id, enabled, key: `oauth/${id}/account`, path: `/v1/admin/upstream-grants/policies/${id}/account`, credential: `synthetic-upstream-${id}`, secret: `synthetic-proxy-${id}` };
  });
  const requests = [];
  let mf;
  const request = (path, options) => adminRequest(path, { ...options,
    env: { CLAWROUTER_BASE_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "fixture-activation-admin" },
    fetchImpl: async (url, init) => {
      const response = await mf.dispatchFetch(url, init);
      requests.push({ path: new URL(url).pathname, method: init.method, status: response.status });
      return response;
    },
  });
  const start = failPublication => startWorkerdFixture(temporary, persistedOwnerFixture(failPublication), upstreamScript, { activate: false, persistencePath: join(temporary, "resources") });
  async function inspect(account) {
    const owners = await mf.getDurableObjectNamespace("GRANT_CREDENTIALS", "router");
    const response = await owners.get(owners.idFromName(account.key)).fetch("https://credential/fixture-state");
    assert.equal(response.status, 200);
    const owner = await response.json();
    const index = await mf.getDurableObjectNamespace("ACCESS_CONTROL", "router");
    const authority = index.get(index.idFromName("policy-bindings"));
    const read = async (path, body) => {
      const result = await authority.fetch(`https://authority${path}`, { method: "POST", body: JSON.stringify(body) });
      assert.equal(result.status, 200);
      return result.json();
    };
    const attachment = await read("/grant-pools/attachment", { key: account.key });
    const { keys, hasAttachment, ready } = await read("/grant-pools/resolve", { providerId: "openai", policyId: account.id, tenantId: "default", defaultKeys: [] });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    return { ...owner, attachment, pool: { keys, hasAttachment, ready }, projection: await kv.get(account.key) };
  }
  async function upstreamCalls() {
    const upstream = await mf.getWorker("upstream");
    return (await (await upstream.fetch("https://fixture.example/state")).json()).calls;
  }
  async function checkDispatch(account) {
    const before = await upstreamCalls();
    const headers = { authorization: `Bearer clawrouter-live-${account.id}-${account.secret}` };
    const body = { model: "openai/gpt-6-astra", input: "persisted account fixture", max_output_tokens: 8 };
    const response = await mf.dispatchFetch("https://router.example/v1/responses", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, account.enabled ? 200 : 503);
    const result = await response.json();
    if (account.enabled) assert.equal(result.status, "completed");
    else assert.equal(result.error.code, "upstream_grant_pool_unavailable");
    const opened = await mf.dispatchFetch("https://router.example/v1/responses", { headers: { ...headers, upgrade: "websocket" } });
    assert.equal(opened.status, 101);
    const socket = opened.webSocket;
    assert.ok(socket);
    socket.accept();
    try {
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("persisted account frame timed out")), 10_000);
        socket.addEventListener("message", event => {
          const frame = JSON.parse(event.data);
          if (frame.type === "error" || frame.type === "response.completed") { clearTimeout(timer); resolve(frame); }
        });
      });
      socket.send(JSON.stringify({ type: "response.create", ...body }));
      const frame = await terminal;
      if (account.enabled) assert.equal(frame.response.status, "completed");
      else assert.equal(frame.error.code, "upstream_grant_pool_unavailable");
    } finally { socket.close(1000, "fixture complete"); }
    const after = await upstreamCalls();
    assert.equal(after.length - before.length, account.enabled ? 2 : 0);
    if (account.enabled) assert.deepEqual(after.slice(-2).map(call => call.authorization), [`Bearer ${account.credential}`, `Bearer ${account.credential}`]);
  }
  try {
    mf = await start(true);
    const pending = [];
    for (const account of accounts) {
      await request(`/v1/admin/keys/${account.id}`, { method: "PUT", body: { enabled: true, providers: ["openai"], tenantId: "default", retainRequestContent: false, requestCostMicros: 0, secretSha256: createHash("sha256").update(account.secret).digest("hex") } });
      // The released PUT produces the existing v1 row and real admission receipt.
      // Only its derived KV publication fails; no owner/index state is fabricated.
      await assert.rejects(request(`${account.path}?mode=replace`, { method: "PUT", body: { provider: "openai", kind: "api_key", credential: account.credential, enabled: account.enabled } }), /grant credential operation failed/);
      assert.equal(requests.at(-1).status, 500);
      const state = await inspect(account);
      assert.equal(state.record.version, 1);
      assert.equal(state.record.poolSyncPending, true);
      assert.equal(state.record.enabled, account.enabled);
      assert.equal(state.record.credential, account.credential);
      assert.ok(state.record.lineage);
      assert.ok(state.record.poolAdmissionRevision > 0);
      assert.equal(state.attachment.generation, state.record.generation);
      assert.equal(state.attachment.attached, true);
      assert.equal(state.attachment.pending, false);
      assert.equal(state.projection, null);
      assert.equal(state.projectionWrites, 1);
      if (!account.enabled) assert.equal(state.alarm, null, "paused owners need explicit recovery without an alarm");
      pending.push(state);
    }
    assert.deepEqual(await upstreamCalls(), []);
    await mf.dispose();
    mf = undefined;
    mf = await start(false);
    for (const [i, account] of accounts.entries()) {
      const state = await inspect(account);
      assert.deepEqual(state.record, pending[i].record, "the committed owner survives actual workerd termination");
      assert.deepEqual(state.attachment, pending[i].attachment);
      assert.equal(state.projection, null);
      assert.equal(state.projectionWrites, 0, "restart does not publish by itself");
      assert.equal((await request(account.path, { method: "GET" })).publication, "pending");
    }
    // These are now existing, matched persistent bindings, not a fresh baseline.
    await acceptGrantPoolBaseline("existing", { request });
    assert.ok((await recoverGrantPools({ request })).activatedAt);
    const repaired = [];
    for (const [i, account] of accounts.entries()) {
      const state = await inspect(account);
      assert.deepEqual(state.record, { ...pending[i].record, poolSyncPending: false });
      assert.deepEqual(state.attachment, pending[i].attachment);
      assert.equal(state.pool.ready, true);
      assert.equal(state.pool.hasAttachment, true);
      assert.deepEqual(state.pool.keys, account.enabled ? [account.key] : []);
      const projection = JSON.parse(state.projection);
      assert.equal(projection.credentialGeneration, state.record.generation);
      assert.equal(projection.credentialLineage, state.record.lineage);
      assert.equal(projection.enabled, account.enabled);
      assert.equal(projection.hasCredential, true);
      assert.equal(state.projection.includes(account.credential), false);
      assert.equal(state.projectionWrites, 1, "verification does not rewrite an acknowledged projection");
      assert.equal((await request(account.path, { method: "GET" })).publication, "ready");
      if (!account.enabled) assert.equal(state.alarm, null);
      repaired.push(state);
    }
    assert.deepEqual(await upstreamCalls(), [], "administrative recovery never dispatches to the provider");
    for (const account of accounts) await checkDispatch(account);
    const calls = await upstreamCalls();
    const requestCount = requests.length;
    assert.ok((await recoverGrantPools({ request })).activatedAt);
    assert.deepEqual(requests.slice(requestCount).map(({ path, method }) => [path, method]), [["/v1/admin/grant-pools/readiness", "GET"], ["/v1/admin/grant-pools/repair", "POST"]]);
    for (const [i, account] of accounts.entries()) assert.deepEqual(await inspect(account), repaired[i]);
    assert.deepEqual(await upstreamCalls(), calls);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function persistedOwnerFixture(failPublication) {
  return `
    import handler, { GrantCredentialObject as RealGrantCredentialObject } from "./worker/index.ts";
    export * from "./worker/index.ts";
    export class GrantCredentialObject extends RealGrantCredentialObject {
      constructor(state, env) {
        const writes = { count: 0 };
        const kv = new Proxy(env.POLICY_KV, { get(target, property) {
          if (property === "put") return async (...args) => {
            writes.count += 1;
            if (${failPublication}) throw new Error("synthetic projection write failure");
            return target.put(...args);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        super(state, { ...env, POLICY_KV: kv });
        this.fixtureStorage = state.storage;
        this.fixtureWrites = writes;
      }
      async fetch(request) {
        if (new URL(request.url).pathname === "/fixture-state") return Response.json({ record: await this.fixtureStorage.get("credential"), alarm: await this.fixtureStorage.getAlarm(), projectionWrites: this.fixtureWrites.count });
        return super.fetch(request);
      }
    }
    export default handler;
  `;
}

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
