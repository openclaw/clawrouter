import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startBundledWorkerdFixture } from "../../test/helpers/workerd.mjs";

const { build } = createRequire(import.meta.resolve("wrangler/package.json"))("esbuild");

// Test-only wrappers expose generic storage dumps and closed internal calls.
// Authentication, scope derivation, routing, delivery, witness production and
// every Durable Object run unchanged in workerd with persistent SQLite storage.
const router = `
  import worker from "./worker/index.ts";
  import { PolicyBindingIndexObject as Authority } from "./worker/authority.ts";
  import { BudgetLedgerObject as Budget, UsageLedgerObject as Usage } from "./worker/ledgers.ts";
  import { GrantCredentialObject as Grants, putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
  import { authenticateProxyKey } from "./worker/proxy-auth.ts";
  import { continuationScope } from "./worker/http-continuation.ts";
  async function dump(storage) {
    const schema = [...storage.sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")];
    const tables = Object.fromEntries(schema.filter(row => row.type === "table").map(({ name }) => [name, [...storage.sql.exec('SELECT * FROM "' + name + '"')].map(row => JSON.stringify(row)).sort()]));
    return Response.json({ schema, tables, kv: Object.fromEntries(await storage.list()), alarm: await storage.getAlarm() });
  }
  const dumped = Base => class extends Base {
    constructor(state, env) { super(state, env); this.fixtureStorage = state.storage; }
    async fetch(request) { return new URL(request.url).pathname === "/fixture/dump" ? dump(this.fixtureStorage) : super.fetch(request); }
  };
  export const PolicyBindingIndexObject = dumped(Authority), BudgetLedgerObject = dumped(Budget), UsageLedgerObject = dumped(Usage), GrantCredentialObject = dumped(Grants);
  export default { ...worker, async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/fixture/")) return worker.fetch(request, env, context);
    if (url.pathname.startsWith("/fixture/upstream/")) return fetch("https://fixture.example" + url.pathname, { method: "POST", body: request.body, duplex: "half" });
    const body = await request.json();
    if (url.pathname === "/fixture/object") {
      const namespace = env[body.binding];
      return namespace.get(namespace.idFromName(body.name)).fetch("https://owner" + body.path, { method: "POST", body: JSON.stringify(body.value ?? {}) });
    }
    if (url.pathname === "/fixture/grant") return Response.json(body.revoke ? await revokeGrantCredentials(env, body.key) : await putGrantCredentials(env, body.key, body.grant), { headers: { "x-fixture": "grant" } });
    if (url.pathname === "/fixture/scope") {
      const auth = await authenticateProxyKey(request.headers, env);
      return auth instanceof Response ? auth : Response.json({ scope: await continuationScope(auth) });
    }
    return new Response("unknown fixture", { status: 404 });
  } };
`;
const upstream = `
  export class Upstream {
    constructor(state) { this.storage = state.storage; }
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/upstream/reply") { await this.storage.put("reply", await request.json()); return new Response("ok"); }
      const calls = await this.storage.get("calls") ?? [];
      if (path === "/fixture/upstream/calls") return Response.json(calls);
      calls.push({ method: request.method, url: request.url, accountId: request.headers.get("chatgpt-account-id"), body: request.method === "GET" ? null : JSON.parse(await request.text()) });
      await this.storage.put("calls", calls);
      const reply = await this.storage.get("reply");
      return new Response(reply.wire, { headers: { "content-type": "application/json" } });
    }
  }
  export default { fetch(request, env) { return env.UPSTREAM.get(env.UPSTREAM.idFromName("fixture")).fetch(request); } };
`;

const sha = value => createHash("sha256").update(value).digest("hex");
const keys = { fixture: "Bearer clawrouter-live-fixture-fixture-key", foreign: "Bearer clawrouter-live-foreign-foreign-key" };
const grantRouting = { strategy: "round_robin", stickiness: "none", failover: true };
const policies = [
  { policyId: "fixture", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 1_000_000, requestCostMicros: 100, retainRequestContent: false, grantRouting } },
  { policyId: "foreign", policy: { enabled: true, generation: "g1", providers: ["openai"], tenantId: "other", monthlyBudgetMicros: 1_000_000, requestCostMicros: 100, retainRequestContent: false, grantRouting } },
];
const credentials = ["fixture", "foreign"].map(id => ({ credentialId: id, credential: { enabled: true, secretSha256: sha(`${id}-key`), policyId: id, policyGeneration: "g1", principalId: null } }));
const checkpoint = { type: "compaction", id: "cmp_checkpoint", encrypted_content: "synthetic-opaque-window" };
const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
const compaction = id => JSON.stringify({ id, object: "response.compaction", output: [{ type: "message", role: "user", content: "retained" }, checkpoint], usage }, null, 2) + "\n";
const completed = id => JSON.stringify({ id, object: "response", status: "completed", output: [checkpoint], usage });
const witnessKey = JSON.stringify([checkpoint.id, sha(checkpoint.encrypted_content)]);

async function bundle(root, replaceWitnessStore = false) {
  // Pre-producer storage emulation: the producer's only persistent change is
  // CompactionWitnessStore inside the existing continuation constructor.
  const plugins = replaceWitnessStore ? [{ name: "pre-producer-storage", setup(builder) {
    builder.onResolve({ filter: /compaction-witness-store\.ts$/ }, args => args.namespace === "pre-producer" ? { path: resolve(root, "worker/compaction-witness-store.ts") } : { path: "store", namespace: "pre-producer" });
    builder.onLoad({ filter: /.*/, namespace: "pre-producer" }, () => ({ resolveDir: resolve(root, "worker"), loader: "ts", contents: `
      export * from "./compaction-witness-store.ts";
      import { HttpError } from "./utils.ts";
      export class CompactionWitnessStore {
        constructor(_storage) {}
        handle() { throw new HttpError(400, "invalid_continuation", "pre-producer continuation stores do not understand witnesses"); }
        expire() {}
        nextDeadline() { return undefined; }
      }` }));
  } }] : [];
  const result = await build({ stdin: { contents: router, resolveDir: root, sourcefile: "compaction-witness-fixture.ts", loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent", plugins });
  return result.outputFiles[0].text;
}

async function fixture(t, firstScript = null) {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-compaction-witness-runtime-"));
  const options = { persistencePath: join(temporary, "resources"), upstreamDurableObjects: { UPSTREAM: { className: "Upstream", useSQLite: true } } };
  const head = await bundle(process.cwd());
  let worker = await startBundledWorkerdFixture(temporary, firstScript ?? head, upstream, options);
  t.after(async () => { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const call = (path, body, authorization = keys.fixture) => worker.dispatchFetch(`https://router.example${path}`, { headers: { authorization }, ...(body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const object = async (binding, name, path, value) => {
    const response = await call("/fixture/object", { binding, name, path, value });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const f = {
    call, object,
    reply: wire => call("/fixture/upstream/reply", { wire }),
    calls: async () => (await call("/fixture/upstream/calls", {})).json(),
    async scope(authorization = keys.fixture) { const response = await call("/fixture/scope", {}, authorization); assert.equal(response.status, 200); return (await response.json()).scope; },
    dump: name => object("ACCESS_CONTROL", name, "/fixture/dump"),
    witnesses: async name => (await f.dump(name)).tables.compaction_witnesses?.map(row => JSON.parse(row)) ?? [],
    resolve: async name => (await object("ACCESS_CONTROL", name, "/http-continuations", { action: "witness_resolve", keys: [witnessKey] })).witnesses,
    admin: async (path, value) => object("ACCESS_CONTROL", "policy-bindings", path, value),
    async mutate(value) { const result = await f.admin("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, ...value }); assert.equal(result.outcome, "updated", JSON.stringify(result)); },
    async restart(script = head) { await worker.dispose(); worker = null; worker = await startBundledWorkerdFixture(temporary, script, upstream, options); },
  };
  for (const [path, value] of [["/policies/initialize-all", policies], ["/credentials/initialize-all", credentials], ["/connections/initialize-all", [{ providerId: "openai", enabled: true, monthlyBudgetMicros: 1_000_000 }]]]) {
    const response = await call("/fixture/object", { binding: "ACCESS_CONTROL", name: "policy-bindings", path, value });
    assert.equal(response.status, 200, await response.clone().text());
  }
  return f;
}
async function deliver(f, wire, path = "/v1/responses/compact", authorization = keys.fixture, body = {}) {
  await f.reply(wire);
  const response = await f.call(path, { model: "openai/gpt-6-astra", input: "fixture", ...body }, authorization);
  const text = await response.text();
  return { status: response.status, text };
}
async function until(read, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value;
  do { value = await read(); if (predicate(value)) return value; await delay(50); } while (Date.now() < deadline);
  assert.fail(`fixture condition timed out: ${JSON.stringify(value)}`);
}
const settledWitness = (f, scope, count = 1) => until(() => f.witnesses(scope), rows => rows.length === count);

test("real workerd keeps a witness private to its authorization scope and immutable against foreign producers", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const own = await f.scope(), foreign = await f.scope(keys.foreign);
  assert.notEqual(own, foreign);
  const produced = await deliver(f, compaction("cmp_own"));
  assert.equal(produced.status, 200); assert.equal(produced.text, compaction("cmp_own"));
  const [witness] = await settledWitness(f, own);
  const stored = JSON.parse(witness.witness_json);
  assert.deepEqual([stored.binding.tenantId, stored.binding.policyId, stored.binding.credentialId], ["tenant", "fixture", "fixture"]);
  assert.ok(!JSON.stringify(await f.dump(own)).includes(checkpoint.encrypted_content));
  const before = await f.dump(own);

  // A foreign credential's lookup lands in its own durable scope and sees nothing.
  assert.deepEqual(await f.resolve(foreign), [null]);
  assert.deepEqual(await f.resolve(own), [stored]);

  // The same item and ciphertext produced by a foreign tenant is its own record;
  // it cannot read, refresh or replace the first scope's witness.
  const replay = await deliver(f, compaction("cmp_foreign"), "/v1/responses/compact", keys.foreign);
  assert.equal(replay.status, 200); assert.equal(replay.text, compaction("cmp_foreign"));
  const [foreignRow] = await settledWitness(f, foreign);
  const foreignWitness = JSON.parse(foreignRow.witness_json);
  assert.deepEqual([foreignWitness.binding.tenantId, foreignWitness.binding.policyId, foreignWitness.binding.credentialId], ["other", "foreign", "foreign"]);
  assert.deepEqual((await f.dump(own)).tables, before.tables);
  assert.deepEqual(await f.resolve(own), [stored]);
  assert.deepEqual(await f.resolve(foreign), [foreignWitness]);

  // Even a foreign binding delivered inside the owner's object is a conflict.
  assert.deepEqual(await f.object("ACCESS_CONTROL", own, "/http-continuations", { action: "witness_register", keys: [], witnesses: [foreignWitness] }), { outcome: "conflict" });
  assert.deepEqual((await f.dump(own)).tables, before.tables);

  // The internal authority route is not reachable through the public Worker.
  for (const authorization of [keys.fixture, keys.foreign]) {
    const response = await f.call("/http-continuations", { action: "witness_resolve", keys: [witnessKey] }, authorization);
    assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "route_not_found");
  }
  assert.equal((await f.calls()).length, 2);
});

test("real workerd revocation and reassignment never rebind or expose an existing witness", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const own = await f.scope();
  assert.equal((await deliver(f, compaction("cmp_before"))).status, 200);
  const [row] = await settledWitness(f, own);
  const stored = JSON.parse(row.witness_json), before = await f.dump(own);

  // Revoked: authentication fails before routing, egress or any witness write.
  await f.mutate({ operation: "revoke", credentialId: "fixture" });
  const revoked = await deliver(f, compaction("cmp_revoked"));
  assert.equal(revoked.status, 403, revoked.text); assert.equal(JSON.parse(revoked.text).error.code, "proxy_key_revoked");
  assert.equal((await f.call("/fixture/scope", {})).status, 403);
  assert.deepEqual((await f.dump(own)).tables, before.tables);
  assert.deepEqual(await f.resolve(own), [stored]);

  // Reassigned to another tenant's policy: the credential derives a new scope,
  // whose lookup cannot see the old binding; new output gets a new binding.
  await f.mutate({ operation: "put", credentialId: "fixture", credential: { enabled: true, secretSha256: sha("fixture-key"), policyId: "foreign" } });
  const reassigned = await f.scope();
  assert.notEqual(reassigned, own);
  assert.deepEqual(await f.resolve(reassigned), [null]);
  assert.equal((await deliver(f, compaction("cmp_reassigned"))).status, 200);
  const [next] = await settledWitness(f, reassigned);
  const nextWitness = JSON.parse(next.witness_json);
  assert.deepEqual([nextWitness.binding.tenantId, nextWitness.binding.policyId, nextWitness.binding.credentialId], ["other", "foreign", "fixture"]);
  assert.deepEqual((await f.dump(own)).tables, before.tables);
  assert.deepEqual(await f.resolve(own), [stored]);

  // Rotated: the old secret is refused; the same credential identity keeps its scope.
  await f.mutate({ operation: "rotate", credentialId: "fixture", secretSha256: sha("rotated-key") });
  const stale = await deliver(f, compaction("cmp_stale_secret"));
  assert.equal(stale.status, 401, stale.text);
  assert.equal(await f.scope("Bearer clawrouter-live-fixture-rotated-key"), reassigned);
  assert.deepEqual(await f.witnesses(reassigned), [next]);
  assert.equal((await f.calls()).length, 2);
});

test("real workerd pooled-grant revocation and reassignment cannot replace the original owner binding", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const grant = "oauth/fixture/openai", put = accountId => f.call("/fixture/grant", { key: grant, grant: { provider: "openai", kind: "subscription", enabled: true, accessToken: `synthetic-${accountId}`, accountId } });
  assert.equal((await put("account-a")).status, 200);
  const own = await f.scope();
  const first = await deliver(f, completed("resp_account_a"), "/v1/responses");
  assert.equal(first.status, 200, first.text);
  const [row] = await settledWitness(f, own);
  const stored = JSON.parse(row.witness_json);
  assert.equal(stored.binding.owner.grantKey, grant); assert.equal(typeof stored.binding.owner.lineage, "string");
  const witnessRows = () => f.dump(own).then(value => value.tables.compaction_witnesses);
  const original = await witnessRows();

  // Revoked grant: later output routes elsewhere and cannot relabel the checkpoint.
  assert.equal((await f.call("/fixture/grant", { key: grant, revoke: true })).status, 200);
  const detached = await deliver(f, completed("resp_detached"), "/v1/responses");
  assert.equal(detached.status, 200, detached.text);
  // Reassigned grant: a new upstream account lineage cannot replace it either.
  assert.equal((await put("account-b")).status, 200);
  const reassigned = await deliver(f, completed("resp_account_b"), "/v1/responses");
  assert.equal(reassigned.status, 200, reassigned.text);
  const calls = await f.calls();
  assert.deepEqual(calls.map(call => call.accountId), ["account-a", null, "account-b"]);
  await until(async () => (await f.dump(own)).tables.http_continuations.length, count => count === 3);
  assert.deepEqual(await witnessRows(), original);
  assert.deepEqual(await f.resolve(own), [stored]);
  const owners = (await f.dump(own)).tables.http_continuations.map(row => JSON.parse(JSON.parse(row).owner_json));
  assert.deepEqual(owners.map(owner => owner.grantKey).sort(), [null, grant, grant]);
  assert.equal(new Set(owners.filter(owner => owner.grantKey).map(owner => owner.lineage)).size, 2, "reassignment produced a new owner lineage");

  // The existing owner check rejects the stale lineage before any egress.
  const stale = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", previous_response_id: "resp_account_a" });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, "continuation_restart_required");
  assert.equal((await f.calls()).length, 3);
});

test("real workerd upgrade preserves continuation, background, settings and accounting state", { timeout: 120_000 }, async t => {
  // CLAWROUTER_UPGRADE_BASE points at an extracted earlier source tree
  // (with node_modules) for an exact-release upgrade; CI uses the emulation.
  const base = process.env.CLAWROUTER_UPGRADE_BASE;
  const f = await fixture(t, base ? await bundle(resolve(base)) : await bundle(process.cwd(), true));
  t.diagnostic(base ? `upgrade baseline: ${resolve(base)}` : "upgrade baseline: pre-producer storage emulation");
  const scope = await f.scope();
  const grant = "oauth/fixture/openai";
  await f.reply(JSON.stringify({ id: "resp_background", object: "response", status: "queued", usage: null }));
  const queued = await f.call("/v1/responses", { model: "openai/gpt-6-astra", input: "fixture", background: true, store: false });
  assert.equal(queued.status, 200, await queued.clone().text()); await queued.text();
  assert.equal((await deliver(f, JSON.stringify({ id: "resp_before", object: "response", status: "completed", output: [], usage }), "/v1/responses")).status, 200);
  assert.equal((await deliver(f, compaction("cmp_before"))).status, 200);
  assert.equal((await f.call("/fixture/grant", { key: grant, grant: { provider: "openai", kind: "subscription", enabled: false, accessToken: "synthetic-disabled", accountId: "account-disabled" } })).status, 200);
  const legs = ["tenant:fixture", "provider:openai"];
  const budget = async () => Object.fromEntries(await Promise.all(legs.map(async name => [name, (await f.object("BUDGET_LEDGER", name, "/fixture/dump")).tables])));
  const ledgerBefore = await until(budget, value => legs.every(name => value[name].budget_reservations?.filter(row => JSON.parse(row).settled === 1).length === 2));
  const usageLedger = () => f.object("USAGE_LEDGER", "policy:tenant:fixture", "/fixture/dump");
  const usageBefore = await until(usageLedger, value => value.tables.usage_events?.length === 2);
  const before = await f.dump(scope), settings = await f.dump("policy-bindings"), grants = await f.object("GRANT_CREDENTIALS", grant, "/fixture/dump");
  assert.equal(before.tables.compaction_witnesses, undefined, "the baseline has no witness storage");
  assert.equal(before.tables.http_continuations.length, 2);
  const job = JSON.parse(JSON.parse(before.tables.responses_background[0]).job_json);
  assert.equal(job.responseId, "resp_background"); assert.notEqual(job.phase, "complete");

  await f.restart();
  // Existing objects open unchanged; additive witness DDL runs on first use only.
  assert.deepEqual((await f.dump("policy-bindings")).tables, settings.tables);
  assert.deepEqual((await f.object("GRANT_CREDENTIALS", grant, "/fixture/dump")).tables, grants.tables);
  const opened = await f.dump(scope);
  for (const table of Object.keys(before.tables).filter(name => name !== "responses_background")) assert.deepEqual(opened.tables[table], before.tables[table], table);
  assert.deepEqual(opened.schema.filter(row => !row.name.startsWith("compaction_witness")), before.schema);
  assert.deepEqual((await usageLedger()).tables, usageBefore.tables);

  // The pre-upgrade continuation still routes, with settings and owner intact.
  const continued = await deliver(f, JSON.stringify({ id: "resp_after", object: "response", status: "completed", output: [], usage }), "/v1/responses", keys.fixture, { previous_response_id: "resp_before" });
  assert.equal(continued.status, 200, continued.text + JSON.stringify(before.tables.http_continuations));
  assert.equal((await f.calls()).at(-1).body.previous_response_id, "resp_before");

  // The pre-upgrade background job is collected once by the upgraded owner.
  await f.reply(JSON.stringify({ id: "resp_background", object: "response", status: "completed", output: [], usage }));
  const collected = await until(() => f.dump(scope), value => JSON.parse(JSON.parse(value.tables.responses_background[0]).job_json).phase === "complete", 30_000);
  const finished = JSON.parse(JSON.parse(collected.tables.responses_background[0]).job_json);
  assert.equal(finished.id, job.id); assert.equal(finished.eventId, job.eventId); assert.equal(finished.amount, 100);

  // Witness storage is added beside the preserved rows on the next delivery.
  const after = await deliver(f, completed("resp_witness_after"), "/v1/responses"); assert.equal(after.status, 200, after.text);
  const [witness] = await settledWitness(f, scope);
  assert.equal(JSON.parse(witness.witness_json).itemId, checkpoint.id);
  const upgraded = await f.dump(scope);
  // Collection closes the pre-upgrade background binding in place; nothing else moves.
  const closed = row => { const value = JSON.parse(row); return JSON.stringify(value.background_job_id === job.id ? { ...value, background_closed: 1 } : value); };
  for (const row of before.tables.http_continuations) assert.ok(upgraded.tables.http_continuations.includes(closed(row)), row);
  assert.deepEqual(upgraded.schema.filter(row => !row.name.startsWith("compaction_witness")), before.schema);
  assert.deepEqual(upgraded.schema.filter(row => row.name.startsWith("compaction_witness")).map(row => row.name), ["compaction_witness_count", "compaction_witness_expiry", "compaction_witnesses"]);
  assert.ok(upgraded.alarm > 0 && upgraded.alarm <= JSON.parse(witness.witness_json).createdAtMs + 30 * 24 * 60 * 60_000, "witness expiry joins the one shared alarm");

  // Accounting: settled pre-upgrade reservations are untouched; the background
  // reservations settle in place exactly once.
  const ledgerAfter = await until(budget, value => legs.every(name => value[name].budget_reservations.filter(row => JSON.parse(row).settled === 1).length >= 5));
  for (const name of legs) {
    for (const row of ledgerBefore[name].budget_reservations.filter(value => JSON.parse(value).settled === 1)) assert.ok(ledgerAfter[name].budget_reservations.includes(row), `${name} settled reservation preserved`);
    const background = job.legs.find(leg => leg.intent.objectName === name).intent.request.reservationId;
    assert.equal(ledgerAfter[name].budget_reservations.map(value => JSON.parse(value)).filter(value => value.reservation_id === background && value.settled === 1).length, 1);
  }
  const usageAfter = await until(usageLedger, value => value.tables.usage_events.length === 5);
  for (const row of usageBefore.tables.usage_events) assert.ok(usageAfter.tables.usage_events.includes(row), "pre-upgrade usage event preserved");
  assert.equal(usageAfter.tables.usage_events.filter(row => JSON.parse(row).id === job.eventId).length, 1);
  assert.equal((await f.calls()).filter(call => call.method === "POST").length, 5);
});
