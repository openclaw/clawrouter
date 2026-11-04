import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./credential-fixture.mjs";
const { normalizePolicy } = await import("../admin.ts");
const { normalizePolicyRecord } = await import("../authority-policy.ts");
import { readInputPublicationPolicy } from "../../shared/input-publication.ts";

const permission = () => ({ version: "clawrouter.input-publication.v1", allow: [{ providerId: "openrouter", endpointId: "music_generate",
  modelId: "openrouter/google/lyria-3-pro-preview", publish: true, forward: false, expiresAt: "9999-01-01T00:00:00.000Z" }] });
const base = { providers: ["openrouter"], enabled: true, retainRequestContent: false, requestCostMicros: 17,
  tenantId: "fixture", budgetScope: "principal", upstreamRetention: { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "openrouter", protocol: "openrouter.music" }] } };
const withoutPermission = ({ inputPublication, ...rest }) => rest;

test("admin preserves legacy policy behavior and unrelated valid fields", () => {
  const legacy = normalizePolicy(base, undefined, false);
  const added = normalizePolicy({ ...base, inputPublication: permission() }, legacy, false);
  assert.deepEqual(withoutPermission(added), legacy);
  assert.equal(Object.hasOwn(legacy, "inputPublication"), false);
  assert.deepEqual(added.inputPublication, permission());
  assert.deepEqual(normalizePolicy(base, added, false).inputPublication, permission());
  assert.deepEqual(normalizePolicy({ ...base, inputPublication: null }, added, false), legacy);
});

test("admin rejects malformed explicit updates but safely drops stale omitted permissions", () => {
  for (const inputPublication of [true, { ...permission(), unexpected: true },
    { ...permission(), allow: [...permission().allow, ...permission().allow] },
    { ...permission(), allow: [{ ...permission().allow[0], expiresAt: "2000-01-01T00:00:00Z" }] }]) {
    assert.throws(() => normalizePolicy({ ...base, inputPublication }, undefined, false), { status: 400, code: "invalid_policy" });
    const legacy = normalizePolicy(base, undefined, false);
    assert.deepEqual(normalizePolicy(base, { ...legacy, inputPublication }, false), legacy);
  }
});

test("authoritative policy materialization normalizes only the explicit permission", () => {
  const legacy = normalizePolicyRecord(base, true);
  const inputPublication = permission();
  const normalized = normalizePolicyRecord({ ...base, inputPublication }, true);
  assert.deepEqual(withoutPermission(normalized), legacy);
  assert.deepEqual(normalized.inputPublication, permission());
  assert.notEqual(normalized.inputPublication.allow, inputPublication.allow);
  for (const inputPublication of [null, { ...permission(), version: "future" },
    { ...permission(), allow: [{ ...permission().allow[0], expiresAt: "2000-01-01T00:00:00Z" }] }])
    assert.deepEqual(normalizePolicyRecord({ ...base, inputPublication }, true), legacy);
});

test("authenticated admin write, durable authority and readback preserve independent false permission", async t => {
  const f = await fixture(t);
  const response = await f.http("/v1/admin/policies/music", "PUT", { ...base, inputPublication: permission() });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).inputPublication, permission());
  const stored = await f.call("/policies/resolve", { policyIds: ["music"] });
  assert.deepEqual(stored.policies[0].policy.inputPublication, permission());
  const listed = (await (await f.http("/v1/admin/policies")).json()).policies.find(row => row.policyId === "music");
  assert.deepEqual(listed.inputPublication, permission());
  assert.equal(listed.requestCostMicros, 17);
  assert.equal(listed.retainRequestContent, false);
  const cleared = await f.http("/v1/admin/policies/music", "PUT", { ...base, inputPublication: null });
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(await cleared.json(), "inputPublication"), false);
  assert.equal(Object.hasOwn((await f.call("/policies/resolve", { policyIds: ["music"] })).policies[0].policy, "inputPublication"), false);
});

test("unauthorized and invalid admin writes cannot add publication permission", async t => {
  const f = await fixture(t);
  const unauthorized = await f.http("/v1/admin/policies/music", "PUT", { ...base, inputPublication: permission() }, { headers: { authorization: "Bearer invalid-fixture-token" } });
  assert.equal(unauthorized.status, 401);
  for (const inputPublication of [{ ...permission(), unknown: true }, { ...permission(), allow: [...permission().allow, ...permission().allow] }]) {
    const invalid = await f.http("/v1/admin/policies/music", "PUT", { ...base, inputPublication });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "invalid_policy");
  }
  assert.equal((await f.call("/policies/resolve", { policyIds: ["music"] })).policies.length, 0);
});

test("admin reads hide malformed or expired stored permission while preserving ordinary policy fields", async t => {
  const f = await fixture(t);
  for (const inputPublication of [{ ...permission(), unknown: true }, { ...permission(), allow: [{ ...permission().allow[0], expiresAt: "2000-01-01T00:00:00Z" }] }]) {
    const policy = { ...normalizePolicy(base, undefined, false), inputPublication };
    await f.call("/policies/put", { policyId: "music", policy });
    const listed = (await (await f.http("/v1/admin/policies")).json()).policies.find(row => row.policyId === "music");
    assert.equal(Object.hasOwn(listed, "inputPublication"), false);
    assert.equal(listed.requestCostMicros, 17);
    assert.deepEqual(listed.upstreamRetention, base.upstreamRetention);
    assert.equal(readInputPublicationPolicy(policy.inputPublication), null);
  }
});
