import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { backgroundRecovery } = await import("../background-recovery.ts");
const { correlateIngressRequest, setBackgroundRecovery, withBackgroundRecovery, withRequestId } = await import("../correlation.ts");

const scope = "a".repeat(64), id = `bg_${"b".repeat(32)}`, locator = `${scope}.${id}`;
const record = {
  id, phase: "outbox", admittedAt: 1, observeUntil: 2, autoRetryUntil: 3, replayUntil: Number.MAX_SAFE_INTEGER,
  eventId: "usage-fixture", requestId: "request-fixture", amount: 100, basis: "manifest_reservation",
  usage: "expired_by_retention", settlements: ["settled", "missing"], lastError: "accounting_unavailable",
  event: { id: "usage-fixture" }, owner: { grantKey: "must-not-project" }, route: { organization: "must-not-project" }, responseId: "must-not-project",
};
function fixture(value = record) {
  const calls = [];
  const env = { ACCESS_CONTROL: { idFromName: name => name, get: name => ({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push({ name, body });
    return Response.json(body.action === "list" ? { records: [value] } : value);
  } }) } };
  return { calls, call: body => backgroundRecovery(new Request("https://router.example/v1/admin/usage/recovery", { method: "POST", body: JSON.stringify(body) }), env) };
}

test("the recovery envelope is closed and invalid actions cannot touch an owner", async () => {
  const f = fixture();
  for (const body of [null, [], { action: "unknown", locator }, { action: "inspect", locator, scope },
    { action: "replay", locator, after: id }, { action: "list", scope, locator },
    { action: "list", scope, after: "invalid" }, { action: "inspect", locator, extra: true }]) {
    await assert.rejects(f.call(body), error => error.status === 400);
  }
  assert.deepEqual(f.calls, []);
});

test("inspection exposes independent ACK dispositions without retained provider metadata", async () => {
  const f = fixture(), response = await f.call({ action: "inspect", locator }), value = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(value.record.usageDisposition, "expired_by_retention");
  assert.deepEqual(value.record.settlementDispositions, ["settled", "missing"]);
  assert.equal(value.record.replayEligible, true); assert.equal(value.record.eventId, record.eventId);
  assert.equal(JSON.stringify(value).includes("must-not-project"), false);
  assert.deepEqual(f.calls, [{ name: `http-continuations:${scope}`, body: { action: "get", id } }]);
});

test("list and replay address only the supplied scope and existing immutable receipt", async () => {
  const f = fixture();
  assert.equal((await (await f.call({ action: "list", scope, after: id })).json()).records.length, 1);
  await f.call({ action: "replay", locator });
  assert.deepEqual(f.calls.map(call => call.body), [{ action: "list", after: id }, { action: "get", id }, { action: "replay", id }]);
  assert.ok(f.calls.every(call => call.name === `http-continuations:${scope}`));
});

test("absent or expired records cannot be presented as paid or replayed", async () => {
  const absent = fixture(null);
  await assert.rejects(absent.call({ action: "inspect", locator }), error => error.status === 404 && error.message.includes("does not confirm settlement"));
  const expired = fixture({ ...record, phase: "expired" });
  await assert.rejects(expired.call({ action: "replay", locator }), error => error.status === 409);
  assert.deepEqual(expired.calls.map(call => call.body.action), ["get"]);
});

test("the ingress-owned recovery locator overrides upstream spoofing without modifying request headers", () => {
  const request = new Request("https://router.example/v1/responses", { headers: { "x-clawrouter-background-recovery": "caller-spoof" } });
  const correlated = correlateIngressRequest(request);
  const response = () => withRequestId(new Response(null, { headers: { "x-clawrouter-background-recovery": "upstream-spoof" } }), correlated.requestId);
  assert.equal(withBackgroundRecovery(response(), request).headers.get("x-clawrouter-background-recovery"), null);
  setBackgroundRecovery(request, locator);
  assert.equal(withBackgroundRecovery(response(), request).headers.get("x-clawrouter-background-recovery"), locator);
  assert.equal(request.headers.get("x-clawrouter-background-recovery"), "caller-spoof");
});
