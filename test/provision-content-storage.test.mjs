import assert from "node:assert/strict";
import test from "node:test";
import { isAlreadyConfigured } from "../scripts/provision-content-storage.mjs";

test("content provisioning treats an existing lifecycle rule as configured", () => {
  assert.equal(isAlreadyConfigured("Invalid Lifecycle Configuration: Rule IDs must be unique. [code: 10061]"), true);
  assert.equal(isAlreadyConfigured("bucket already exists"), true);
  assert.equal(isAlreadyConfigured("Authentication error [code: 10000]"), false);
});
