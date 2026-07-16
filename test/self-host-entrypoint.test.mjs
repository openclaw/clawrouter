import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSelfHostConfig,
  selfHostVariableNames,
} from "../deploy/self-host/entrypoint.mjs";

test("self-host config removes custom routes and adds local policy KV", () => {
  const rendered = renderSelfHostConfig(`name = "clawrouter"

[build]
command = "pnpm build"

[[routes]]
pattern = "example.com"
custom_domain = true

[vars]
EXAMPLE = "kept"
`);

  assert.doesNotMatch(rendered, /\[\[routes\]\]/);
  assert.doesNotMatch(rendered, /\[build\]/);
  assert.doesNotMatch(rendered, /pnpm build/);
  assert.match(rendered, /\[vars\]\nEXAMPLE = "kept"/);
  assert.match(
    rendered,
    /\[\[kv_namespaces\]\]\nbinding = "POLICY_KV"\nid = "self-host-local"/,
  );
});

test("self-host vars include configured provider and explicit custom bindings", () => {
  const snapshot = {
    providers: [
      { config_keys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
      { config_keys: ["ANTHROPIC_API_KEY"] },
    ],
  };
  const names = selfHostVariableNames(snapshot, {
    OPENAI_API_KEY: "test",
    ANTHROPIC_API_KEY: "",
    CUSTOM_BINDING: "custom",
    CLAWROUTER_SELF_HOST_VARS: "CUSTOM_BINDING",
  });

  assert.deepEqual(names, ["CUSTOM_BINDING", "OPENAI_API_KEY"]);
  assert.throws(
    () =>
      selfHostVariableNames(snapshot, {
        CLAWROUTER_ADMIN_TOKEN: "test",
        CLAWROUTER_SELF_HOST_VARS: "CLAWROUTER_ADMIN_TOKEN",
      }),
    /cannot be passed to the Worker/,
  );
});
