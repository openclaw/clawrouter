import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { BodyLease, bodyBudgetBytes, bodyBudgetCharged, bodyLeaseMinimum } from "../body-budget.ts";

const MiB = 1024 * 1024;
afterEach(() => assert.equal(bodyBudgetCharged(), 0, "all task-owned charges must be released"));
function lease(t, inputBytes) {
  const value = new BodyLease(); t.after(() => value.release());
  assert.equal(value.grow(inputBytes), true); return value;
}
function split(t, owner, inputCharge, responseCharge) {
  const result = owner.splitCharges(inputCharge, responseCharge); assert.ok(result);
  t.after(() => result.forEach(value => value.release())); return result;
}

for (const order of [[0, 1], [1, 0]]) test(`atomic 64 MiB ingress to 32+64 MiB charges releases in order ${order.join(",")}`, t => {
  const ingress = lease(t, 32 * MiB); assert.equal(bodyBudgetCharged(), 64 * MiB);
  const owners = split(t, ingress, 32 * MiB, 64 * MiB);
  assert.equal(bodyBudgetCharged(), bodyBudgetBytes); assert.equal(ingress.leased, false);
  assert.ok(owners.every(owner => owner.leased)); assert.notEqual(owners[0], owners[1]);
  ingress.release(); ingress.release(); assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  assert.equal(ingress.grow(32 * MiB), false); assert.equal(ingress.splitCharges(MiB, MiB), null);
  owners[order[0]].release(); assert.equal(bodyBudgetCharged(), (order[0] === 0 ? 64 : 32) * MiB);
  owners[order[0]].release(); assert.equal(bodyBudgetCharged(), (order[0] === 0 ? 64 : 32) * MiB);
  owners[order[1]].release(); assert.equal(bodyBudgetCharged(), 0);
});

test("contention fails atomically, preserves the original owner and succeeds after the competing lease releases", t => {
  const ingress = lease(t, 32 * MiB), other = lease(t, MiB);
  assert.equal(bodyBudgetCharged(), 66 * MiB);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(ingress.splitCharges(32 * MiB, 64 * MiB), null);
    assert.equal(ingress.leased, true); assert.equal(other.leased, true); assert.equal(bodyBudgetCharged(), 66 * MiB);
  }
  assert.equal(ingress.grow(32 * MiB), true); assert.equal(bodyBudgetCharged(), 66 * MiB);
  other.release(); assert.equal(bodyBudgetCharged(), 64 * MiB);
  const owners = split(t, ingress, 32 * MiB, 64 * MiB); assert.equal(bodyBudgetCharged(), 96 * MiB);
  owners.forEach(owner => owner.release());
});

test("invalid charge values and total above the ceiling leave ownership unchanged", t => {
  const ingress = lease(t, 32 * MiB);
  const invalid = [undefined, null, "32", NaN, Infinity, -Infinity, -1, 0, -0, 0.5, Number.MAX_SAFE_INTEGER, bodyBudgetBytes + 1, 1n];
  for (const value of invalid) for (const args of [[value, MiB], [MiB, value]]) {
    assert.equal(ingress.splitCharges(...args), null); assert.equal(ingress.leased, true); assert.equal(bodyBudgetCharged(), 64 * MiB);
  }
  assert.equal(ingress.splitCharges(32 * MiB, 64 * MiB + 1), null); assert.equal(bodyBudgetCharged(), 64 * MiB);
  const owners = split(t, ingress, 32 * MiB, 64 * MiB); assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  owners.forEach(owner => owner.release());
});

test("empty, subthreshold, released and transferred owners cannot mint successor charges", t => {
  const empty = lease(t, 0), small = lease(t, bodyLeaseMinimum - 1), released = lease(t, MiB);
  released.release();
  for (const owner of [empty, small, released]) assert.equal(owner.splitCharges(MiB, MiB), null);
  assert.equal(bodyBudgetCharged(), 0);
  const ingress = lease(t, MiB), owners = split(t, ingress, MiB, MiB);
  assert.equal(ingress.splitCharges(MiB, MiB), null); assert.equal(ingress.grow(MiB), false);
  for (const owner of owners) owner.release();
  assert.equal(ingress.splitCharges(MiB, MiB), null); assert.equal(ingress.grow(MiB), false); assert.equal(bodyBudgetCharged(), 0);
});

test("charge-byte units are exact, including charges below the legacy input threshold", t => {
  const ingress = lease(t, MiB), [input, response] = split(t, ingress, 3, 5);
  assert.equal(bodyBudgetCharged(), 8); input.release(); assert.equal(bodyBudgetCharged(), 5);
  response.release(); assert.equal(bodyBudgetCharged(), 0);
});

test("a successor can transfer its own phase without releasing its sibling's capacity", t => {
  const ingress = lease(t, 32 * MiB), [input, response] = split(t, ingress, 32 * MiB, 64 * MiB);
  const [first, second] = split(t, response, 16 * MiB, 48 * MiB);
  assert.equal(bodyBudgetCharged(), 96 * MiB); response.release(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  first.release(); assert.equal(bodyBudgetCharged(), 80 * MiB); input.release(); assert.equal(bodyBudgetCharged(), 48 * MiB);
  second.release(); assert.equal(bodyBudgetCharged(), 0);
});

test("aborted owner cleanup releases either the unchanged ingress or both acknowledged successors", t => {
  for (const transferred of [false, true]) {
    const ingress = lease(t, 32 * MiB), controller = new AbortController(); let owners = [ingress];
    controller.signal.addEventListener("abort", () => owners.forEach(owner => owner.release()), { once: true });
    if (transferred) owners = split(t, ingress, 32 * MiB, 64 * MiB);
    controller.abort(); controller.abort(); assert.equal(bodyBudgetCharged(), 0);
    assert.equal(ingress.splitCharges(MiB, MiB), null);
  }
});

test("failure followed by abort releases only the ingress and preserves another owner's charge", t => {
  const ingress = lease(t, 32 * MiB), other = lease(t, MiB), controller = new AbortController();
  controller.signal.addEventListener("abort", () => ingress.release(), { once: true });
  assert.equal(ingress.splitCharges(32 * MiB, 64 * MiB), null); controller.abort();
  assert.equal(bodyBudgetCharged(), 2 * MiB); assert.equal(other.leased, true); other.release();
});

test("legacy threshold, monotone grow, capacity rejection, release and reuse remain unchanged", t => {
  const owner = lease(t, bodyLeaseMinimum - 1); assert.equal(owner.leased, false); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(owner.grow(MiB), true); assert.equal(bodyBudgetCharged(), 2 * MiB);
  assert.equal(owner.grow(0), true); assert.equal(bodyBudgetCharged(), 2 * MiB);
  const other = lease(t, 47 * MiB); assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  assert.equal(owner.grow(2 * MiB), false); assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  owner.release(); owner.release(); assert.equal(bodyBudgetCharged(), 94 * MiB);
  assert.equal(owner.grow(MiB), true); assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  other.release(); owner.release(); assert.equal(bodyBudgetCharged(), 0);
});
