import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { managedCreateAdmission } = await import("../upstream-retention-admission.ts");
const { managedCreateAdapter } = await import("../managed-lifecycle-adapters.ts");
const native = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/video.json", import.meta.url)));
const adapter = managedCreateAdapter("openrouter.video", "openrouter.video_create");
const admitted = (body, admission) => adapter.prepareAdmitted(body, new Headers(), {}, new URLSearchParams(), admission);

test("actual admission resolver requires both policy and original credential/route receipt, independently of logging", () => {
  const policy = { enabled: true, generation: "synthetic-v1", providers: ["openrouter"],
    upstreamRetention: { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "openrouter", protocol: "openrouter.video" }] } };
  const owner = { providerId: "openrouter", policyGeneration: "synthetic-v1", grantKey: null, routeSha256: "1".repeat(64) };
  const config = { version: "clawrouter.upstream-retention-bindings.v1", bindings: [{ providerId: "openrouter", protocol: "openrouter.video",
    grantKey: null, routeSha256: owner.routeSha256, retention: "allow", expiresAt: "2030-01-01T00:00:00Z" }] };
  const env = { CLAWROUTER_UPSTREAM_RETENTION_BINDINGS: JSON.stringify(config) }, now = Date.parse("2026-01-01T00:00:00Z");
  const resolve = (p = policy, e = env, o = owner) => managedCreateAdmission(p, e, o, "openrouter.video", now);
  for (const retainRequestContent of [false, true]) assert.deepEqual(admitted(native.create, resolve({ ...policy, retainRequestContent })).body, native.create);
  for (const admission of [resolve({ ...policy, upstreamRetention: null, retainRequestContent: true }), resolve(policy, {}),
    resolve(policy, env, { ...owner, grantKey: "synthetic-other-grant" }), resolve(policy, env, { ...owner, routeSha256: "2".repeat(64) }),
    resolve(policy, env, { ...owner, policyGeneration: "changed" }), managedCreateAdmission(policy, env, owner, "openrouter.video", Date.parse("2031-01-01T00:00:00Z"))])
    assert.throws(() => admitted(native.create, admission), /retention_admission_required/);
});
