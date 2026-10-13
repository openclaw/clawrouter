import assert from "node:assert/strict";
import test from "node:test";
import {
  assertContentLifecycle,
  isAlreadyConfigured,
  provisionContentStorage,
} from "../scripts/provision-content-storage.mjs";

test("content provisioning recognizes duplicate creation without accepting authentication errors", () => {
  assert.equal(isAlreadyConfigured("Invalid Lifecycle Configuration: Rule IDs must be unique. [code: 10061]"), true);
  assert.equal(isAlreadyConfigured("bucket already exists"), true);
  assert.equal(isAlreadyConfigured("Authentication error [code: 10000]"), false);
});

const expectedRule = `name:     request-content-v1-30-days
enabled:  Yes
prefix:   v1/
action:   Expire objects after 30 days`;

test("content provisioning verifies the applied rule after create or duplicate responses", () => {
  const calls = [];
  provisionContentStorage("archive", (args, options) => {
    calls.push({ args, options });
    return args[3] === "list" ? expectedRule : "";
  });
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 4)), [
    ["r2", "bucket", "create", "archive"],
    ["r2", "bucket", "lifecycle", "add"],
    ["r2", "bucket", "lifecycle", "list"],
  ]);
  assert.equal(calls[0].options.allowExisting, true);
  assert.equal(calls[1].options.allowExisting, true);
  assert.equal(calls[2].options, undefined);
  assert.throws(() => provisionContentStorage("archive", () => ""), /verification failed/);
});

test("content lifecycle accepts the exact enabled prefix and age through Wrangler formatting", () => {
  assert.doesNotThrow(() => assertContentLifecycle(
    `Listing lifecycle rules for bucket 'archive'...\n${expectedRule}\n`,
    "archive",
  ));
  assert.doesNotThrow(() => assertContentLifecycle(
    `${expectedRule}, Abort incomplete multipart uploads after 7 days`, "archive",
  ));
  assert.doesNotThrow(() => assertContentLifecycle(
    `${expectedRule.replace("request-content-v1-30-days", "other-rule")}\n\n${expectedRule}`, "archive",
  ));
});

test("content lifecycle rejects missing, disabled, mistargeted, or misaged rules", () => {
  for (const output of [
    "There are no lifecycle rules for bucket 'archive'.",
    expectedRule.replace("enabled:  Yes", "enabled:  No"),
    expectedRule.replace("prefix:   v1/", "prefix:   (all prefixes)"),
    expectedRule.replace("after 30 days", "after 3 days"),
    expectedRule.replace("after 30 days", "on 2026-11-01"),
    expectedRule.replace("Expire objects after 30 days", "(none)"),
    `${expectedRule}\n\n${expectedRule}`,
    `${expectedRule.replace("enabled:  Yes", "enabled:  No")}\n\n${expectedRule.replace("request-content-v1-30-days", "other-rule")}`,
  ]) {
    assert.throws(() => assertContentLifecycle(output, "archive"), /verification failed/);
  }
});

test("content lifecycle preserves significant whitespace in the prefix", () => {
  for (const prefix of [
    "v1/ ", " v1/", "v1/\t", "\tv1/", "v1/\r", "v1/\rhidden",
    // Wrangler indents multiline values and collapses whitespace-only lines.
    "v1/\n          extra", "v1/\n\n          extra", "\u001b[31mv1/\u001b[0m",
  ]) {
    assert.throws(() => assertContentLifecycle(
      expectedRule.replace("prefix:   v1/", `prefix:   ${prefix}`), "archive",
    ), /verification failed/);
  }
  // Wrangler emits LF: treating CRLF as formatting would erase a terminal CR.
  assert.throws(() => assertContentLifecycle(expectedRule.replaceAll("\n", "\r\n"), "archive"), /verification failed/);
  assert.throws(() => assertContentLifecycle(`${expectedRule}\n          extra`, "archive"), /verification failed/);
});
