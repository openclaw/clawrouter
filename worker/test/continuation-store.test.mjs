import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { continuationCapacity, continuationRetentionMs } from "../continuation-store.ts";
import { continuationAuthority } from "./continuation-authority.mjs";
import { HttpContinuation } from "../http-continuation.ts";

const owner = { providerId: "openai", endpointId: "responses", grantKey: "oauth/fixture/account-a", lineage: "lineage-a", routeSha256: "f".repeat(64), policyGeneration: "g1" };
const keys = ["a".repeat(64), "b".repeat(64)];
function fixture(t) {
  const namespace = continuationAuthority(t), stub = namespace.get("scope");
  return {
    get state() { return namespace.objects.get("scope"); },
    async call(action, extra = {}) {
      const response = await stub.fetch("https://clawrouter.internal/http-continuations", { method: "POST", body: JSON.stringify({ action, keys, owner, ...extra }) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    },
  };
}

test("identity claims are atomic, immutable, deduplicated and retained from first publication", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.call("resolve"), { owners: [null, null], evidence: [null, null] });
  assert.deepEqual(await f.call("register"), { outcome: "stored" });
  const rows = f.state.db.prepare("SELECT * FROM http_continuations ORDER BY binding_key").all();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].expires_at_ms >= Date.now() + continuationRetentionMs - 1000);
  assert.deepEqual(await f.call("register", { owner: Object.fromEntries(Object.entries(owner).reverse()) }), { outcome: "stored" });
  assert.deepEqual(f.state.db.prepare("SELECT * FROM http_continuations ORDER BY binding_key").all(), rows);
  assert.deepEqual(await f.call("register", { keys: [keys[0], "c".repeat(64)], owner: { ...owner, lineage: "other" } }), { outcome: "conflict" });
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 2);
  assert.deepEqual(await f.call("resolve"), { owners: [owner, owner], evidence: [null, null] });
  assert.equal(f.state.scheduled, rows[0].expires_at_ms);
});

test("capacity never evicts a live owner and failed multi-key claims insert nothing", async t => {
  const f = fixture(t);
  await f.call("resolve");
  f.state.db.prepare("UPDATE http_continuation_count SET count = ?").run(continuationCapacity - 1);
  assert.deepEqual(await f.call("register"), { outcome: "capacity" });
  assert.equal(f.state.db.prepare("SELECT count(*) AS count FROM http_continuations").get().count, 0);
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, continuationCapacity - 1);
});

test("idle records expire in bounded alarm batches with exact persisted counts", async t => {
  const f = fixture(t);
  await f.call("resolve");
  const insert = f.state.db.prepare("INSERT INTO http_continuations (binding_key, owner_json, expires_at_ms) VALUES (?, ?, ?)");
  for (let i = 0; i < 300; i++) insert.run(i.toString(16).padStart(64, "0"), JSON.stringify(owner), Date.now() - 1);
  f.state.db.prepare("UPDATE http_continuation_count SET count = 300").run();
  await f.state.object.alarm();
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 44);
  assert.ok(f.state.scheduled <= Date.now() + 1000);
  await f.state.object.alarm();
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 0);
  assert.equal(f.state.scheduled, null);
});

test("an expired target beyond the cleanup batch can be registered without count drift", async t => {
  const f = fixture(t);
  await f.call("register");
  const insert = f.state.db.prepare("INSERT INTO http_continuations (binding_key, owner_json, expires_at_ms) VALUES (?, ?, ?)");
  for (let i = 0; i < 300; i++) insert.run(i.toString(16).padStart(64, "0"), JSON.stringify(owner), 0);
  f.state.db.prepare("UPDATE http_continuation_count SET count = 302").run();
  f.state.db.prepare("UPDATE http_continuations SET expires_at_ms = ? WHERE binding_key IN (?, ?)").run(Date.now() - 1, ...keys);
  assert.deepEqual(await f.call("resolve"), { owners: [null, null], evidence: [null, null] });
  assert.deepEqual(await f.call("register", { owner: { ...owner, lineage: "new-lineage" } }), { outcome: "stored" });
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 46);
});

test("alarm scheduling remains serialized with a concurrent registration", async t => {
  const f = fixture(t);
  await f.call("resolve");
  let release, scheduled;
  const entered = new Promise(resolve => { scheduled = resolve; });
  f.state.beforeSchedule = () => { scheduled(); return new Promise(resolve => { release = resolve; }); };
  const first = f.call("register", { keys: [keys[0]] });
  await entered;
  const second = f.call("register", { keys: [keys[1]] });
  f.state.beforeSchedule = null; release();
  await Promise.all([first, second]);
  assert.equal(f.state.scheduled, f.state.db.prepare("SELECT min(expires_at_ms) AS expiry FROM http_continuations").get().expiry);
});

const producerId = "1".repeat(64), otherProducer = "2".repeat(64);
const responseClaim = { key: keys[0], producerId };
const pending = { version: 1, producerId, state: "pending" };
const final = knowledge => ({ ...pending, state: "final", knowledge });

test("response evidence claims and final CAS preserve routing, expiry, count and immutable producer", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.call("register", { responseClaim }), { outcome: "stored", claim: "owned" });
  const rows = () => f.state.db.prepare("SELECT * FROM http_continuations ORDER BY binding_key").all();
  const initial = rows();
  assert.deepEqual(await f.call("resolve"), { owners: [owner, owner], evidence: [pending, null] });
  assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }), { outcome: "qualified" });
  const qualified = rows();
  f.state.restart();
  for (const row of qualified) assert.equal(row.expires_at_ms, initial[0].expires_at_ms);
  assert.equal(qualified[1].pricing_evidence_json, null, "a turn carrier never receives response pricing evidence");
  assert.deepEqual(await f.call("register", { responseClaim }), { outcome: "stored", claim: "owned" });
  assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }), { outcome: "qualified" });
  for (const extra of [{ knowledge: "unknown" }, { responseClaim: { ...responseClaim, producerId: otherProducer } }]) {
    assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only", ...extra }), { outcome: "producer_conflict" });
  }
  assert.deepEqual(rows(), qualified);
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 2);
  assert.deepEqual((await f.call("resolve")).evidence, [final("token_only"), null]);
});

for (const state of ["pending", "token_only", "unknown", "corrupt", "future"]) test(`${state} evidence rejects other and claim-less producers atomically`, async t => {
  const f = fixture(t);
  await f.call("register", { keys: [keys[0]], responseClaim });
  if (state === "token_only" || state === "unknown") await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: state });
  if (state === "corrupt" || state === "future") f.state.db.prepare("UPDATE http_continuations SET pricing_evidence_json = ?").run(state === "corrupt" ? "{" : JSON.stringify({ ...pending, version: 2 }));
  const before = f.state.db.prepare("SELECT * FROM http_continuations").all(), alarm = f.state.scheduled;
  for (const claim of [undefined, { ...responseClaim, producerId: otherProducer }]) {
    assert.deepEqual(await f.call("register", { responseClaim: claim }), { outcome: "producer_conflict" });
    assert.deepEqual(f.state.db.prepare("SELECT * FROM http_continuations").all(), before);
    assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 1);
    assert.equal(f.state.scheduled, alarm);
  }
});

test("legacy NULL evidence is never adopted and the additive column upgrades existing rows", async t => {
  const f = fixture(t);
  f.state.db.exec("CREATE TABLE http_continuations (binding_key TEXT PRIMARY KEY, owner_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)");
  f.state.db.prepare("INSERT INTO http_continuations VALUES (?, ?, ?)").run(keys[0], JSON.stringify(owner), Date.now() + continuationRetentionMs);
  f.state.db.exec("CREATE TABLE http_continuation_count (id INTEGER PRIMARY KEY, count INTEGER NOT NULL); INSERT INTO http_continuation_count VALUES (1, 1)");
  assert.deepEqual(await f.call("resolve"), { owners: [owner, null], evidence: [null, null] });
  assert.deepEqual(await f.call("register", { responseClaim }), { outcome: "stored", claim: "legacy_unknown" });
  assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }), { outcome: "producer_conflict" });
  assert.deepEqual(await f.call("register"), { outcome: "stored" });
  assert.deepEqual((await f.call("resolve")).evidence, [null, null]);
});

test("lost claim ACK leaves its original pending producer and cannot be adopted on retry", async t => {
  const f = fixture(t);
  f.state.beforeSchedule = () => { throw new Error("fixture lost claim ACK"); };
  await assert.rejects(f.call("register", { responseClaim }));
  assert.deepEqual((await f.call("resolve")).evidence, [pending, null]);
  f.state.restart();
  f.state.beforeSchedule = null;
  assert.deepEqual(await f.call("register", { responseClaim: { ...responseClaim, producerId: otherProducer } }), { outcome: "producer_conflict" });
  assert.deepEqual(await f.call("register", { responseClaim }), { outcome: "stored", claim: "owned" });
});

test("expiry rejects finalization and re-registration starts a new producer with exact counts", async t => {
  const f = fixture(t);
  await f.call("register", { responseClaim });
  f.state.db.prepare("UPDATE http_continuations SET expires_at_ms = 0").run();
  assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }), { outcome: "unavailable" });
  assert.deepEqual(await f.call("register", { responseClaim: { ...responseClaim, producerId: otherProducer } }), { outcome: "stored", claim: "owned" });
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 2);
  assert.deepEqual((await f.call("resolve")).evidence, [{ ...pending, producerId: otherProducer }, null]);
});

test("concurrent response claims never partially insert the losing producer's turn alias", async t => {
  const f = fixture(t), otherTurn = "c".repeat(64);
  const result = await Promise.all([
    f.call("register", { responseClaim }),
    f.call("register", { keys: [keys[0], otherTurn], responseClaim: { ...responseClaim, producerId: otherProducer } }),
  ]);
  assert.deepEqual(result, [{ outcome: "stored", claim: "owned" }, { outcome: "producer_conflict" }]);
  assert.equal(f.state.db.prepare("SELECT count FROM http_continuation_count").get().count, 2);
  assert.equal(f.state.db.prepare("SELECT count(*) AS count FROM http_continuations WHERE binding_key = ?").get(otherTurn).count, 0);
});

test("failed SQL finalization leaves pending ownership intact through reconstruction", async t => {
  const f = fixture(t);
  await f.call("register", { responseClaim });
  f.state.db.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE OF pricing_evidence_json ON http_continuations BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END");
  await assert.rejects(f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }));
  f.state.restart();
  assert.deepEqual((await f.call("resolve")).evidence, [pending, null]);
  f.state.db.exec("DROP TRIGGER fixture_failure");
  assert.deepEqual(await f.call("qualify", { keys: [keys[0]], responseClaim, knowledge: "token_only" }), { outcome: "qualified" });
});

function producerFixture(t, intercept = (_action, dispatch) => dispatch()) {
  const namespace = continuationAuthority(t);
  const env = { ACCESS_CONTROL: { ...namespace, get(name) {
    const stub = namespace.get(name);
    return { fetch(url, init) { return intercept(JSON.parse(init.body).action, () => stub.fetch(url, init)); } };
  } } };
  return {
    async create(body = {}, signal) {
      const continuation = await HttpContinuation.resolve(new Request("https://router.example/v1/responses", { signal }), { capability: "llm.responses", provider: { id: "openai" }, endpoint: { id: "responses" }, body }, { authType: "proxy_key", policyId: "fixture", credentialId: "fixture", principalId: null, policy: { generation: "g1", tenantId: "default" } }, env);
      continuation.bind(owner); return continuation;
    },
    rows() { return [...namespace.objects.values()].flatMap(value => value.db.prepare("SELECT pricing_evidence_json FROM http_continuations").all()).map(row => row.pricing_evidence_json && JSON.parse(row.pricing_evidence_json)); },
  };
}
const created = id => ({ type: "response.created", response: { id } });
const completed = id => ({ type: "response.completed", response: { id } });
const identities = id => [{ kind: "response", value: id }];

test("request producers freeze inherited facts and preserve repeated routing-only turn carriers", async t => {
  const f = producerFixture(t), parent = await f.create({ input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }] });
  await parent.publishFrame([...identities("parent"), { kind: "turn", value: "turn" }], created("parent"));
  const early = await f.create({ previous_response_id: "parent", input: [] });
  await parent.publishFrame(identities("parent"), completed("parent"));
  const late = await f.create({ previous_response_id: "parent", input: [] });
  for (const [id, producer] of [["early", early], ["late", late]]) {
    await producer.publishFrame([...identities(id), { kind: "turn", value: "turn" }], created(id));
    await producer.publishFrame(identities(id), completed(id));
  }
  assert.deepEqual(f.rows().map(row => row?.knowledge ?? null), ["hosted_tool_fee", null, "unknown", "hosted_tool_fee"]);
});

for (const failure of ["transient", "lost_ack", "semantic"]) test(`${failure} finalization keeps explicit CAS conflict separate from transport ambiguity`, async t => {
  const f = producerFixture(t, async (action, dispatch) => {
    if (action !== "qualify") return dispatch();
    if (failure === "semantic") return Response.json({ outcome: "producer_conflict" });
    if (failure === "lost_ack") await dispatch();
    throw new Error("fixture finalization transport loss");
  });
  const producer = await f.create();
  await producer.publishFrame(identities("response"), created("response"));
  const finish = producer.publishFrame(identities("response"), completed("response"));
  if (failure === "semantic") await assert.rejects(finish, error => error.status === 503 && error.code === "continuation_unavailable");
  else await finish;
  assert.equal(f.rows()[0].state, failure === "lost_ack" ? "final" : "pending");
  const child = await f.create({ previous_response_id: "response" });
  await child.publishFrame(identities("child"), created("child"));
  // The same injected outage affects child finalization; its pending producer
  // still cannot adopt the parent's completed receipt or another producer.
  await assert.rejects((await f.create()).publishFrame(identities("response"), created("response")), error => error.code === "continuation_unavailable");
  assert.equal(f.rows().length, 2);
});

test("a lost claim ACK is hard even if its pending insert committed", async t => {
  let lost = false;
  const f = producerFixture(t, async (action, dispatch) => {
    const result = await dispatch();
    if (action === "register" && !lost) { lost = true; throw new Error("fixture lost claim receipt"); }
    return result;
  });
  const producer = await f.create();
  await assert.rejects(producer.publishFrame(identities("response"), created("response")), error => error.code === "continuation_unavailable");
  assert.equal(f.rows()[0].state, "pending");
  await producer.publishFrame(identities("response"), created("response"));
  await producer.publishFrame(identities("response"), completed("response"));
  assert.equal(f.rows()[0].knowledge, "token_only");
});

test("canceling a create during identity publication cannot start proof finalization after the ACK", async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let qualifications = 0;
  const f = producerFixture(t, async (action, dispatch) => {
    const result = await dispatch();
    if (action === "register") { entered.resolve(); await gate.promise; }
    if (action === "qualify") qualifications++;
    return result;
  });
  const controller = new AbortController(), producer = await f.create({}, controller.signal);
  const publication = producer.publishFrame(identities("response"), completed("response"));
  await entered.promise; controller.abort(); gate.resolve(); await publication;
  assert.equal(qualifications, 0); assert.equal(f.rows()[0].state, "pending");
});
