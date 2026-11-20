import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUpstreamRetentionPolicy as normalize, readUpstreamRetentionPolicy as read } from "../../shared/upstream-retention.ts";
const permission = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "openrouter", protocol: "openrouter.video" }] };
test("upstream retention requires explicit versioned provider/protocol permission independently of logging", () => {
  assert.equal(read(undefined), null); assert.equal(read(null), null);
  assert.equal(read(true), null); assert.equal(read({ retainRequestContent: true }), null);
  assert.deepEqual(normalize(permission), permission);
  assert.notEqual(normalize(permission).allow, permission.allow);
});
for (const [name, value] of [
  ["unknown version", { ...permission, version: "next" }],
  ["extra field", { ...permission, consent: true }],
  ["duplicate", { ...permission, allow: [...permission.allow, ...permission.allow] }],
  ["wildcard", { ...permission, allow: [{ providerId: "*", protocol: "openrouter.video" }] }],
  ["line ending", { ...permission, allow: [{ providerId: "openrouter\n", protocol: "openrouter.video" }] }],
  ["overflow", { ...permission, allow: Array.from({ length: 65 }, (_, n) => ({ providerId: `provider-${n}`, protocol: "video" })) }],
]) test(`upstream retention policy rejects ${name}`, () => { assert.throws(() => normalize(value)); assert.equal(read(value), null); });
