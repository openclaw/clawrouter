import assert from "node:assert/strict";
import test from "node:test";

import { deploymentTarget } from "../scripts/deployment-profile.mjs";
import {
  fakecoProviderCredentialPlan,
  verifyExistingFakecoProviderCredentials,
} from "../scripts/provider-credential-preflight.mjs";

const target = deploymentTarget({ CLAWROUTER_DEPLOY_ENV: "fakeco" });
const plan = {
  providers: [
    {
      id: "openai",
      target: { kind: "openai_chat", route: "/v1/chat/completions" },
      requiredConfig: ["OPENAI_API_KEY"],
    },
  ],
};

test("fresh FakeCo upload mode refuses a missing selected provider credential", () => {
  assert.throws(
    () =>
      fakecoProviderCredentialPlan(target, plan, {
        CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "upload",
        CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
      }),
    /upload requires runner values.*openai\(OPENAI_API_KEY\)/,
  );
  const credentialPlan = fakecoProviderCredentialPlan(target, plan, {
    CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "upload",
    CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
    OPENAI_API_KEY: "openai123",
  });
  assert.deepEqual(credentialPlan, {
    mode: "upload",
    providerIds: ["openai"],
    secretNames: ["OPENAI_API_KEY"],
  });
});

test("established FakeCo mode read-only verifies selected provider bindings", async () => {
  const credentialPlan = fakecoProviderCredentialPlan(target, plan, {
    CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "existing",
    CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
  });
  const result = await verifyExistingFakecoProviderCredentials(
    target,
    credentialPlan,
    {
      CLOUDFLARE_ACCOUNT_ID: "fixture-account",
      CLOUDFLARE_API_TOKEN: "cf-token",
    },
    async (url, init) => {
      assert.match(
        url,
        /accounts\/fixture-account\/workers\/scripts\/clawrouter-edge-fakeco\/secrets$/,
      );
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer cf-token");
      return Response.json({
        success: true,
        result: [{ name: "OPENAI_API_KEY", type: "secret_text" }],
      });
    },
  );
  assert.deepEqual(result, { names: ["OPENAI_API_KEY"] });
});

test("established FakeCo mode refuses a fresh Worker or missing binding", async () => {
  const credentialPlan = fakecoProviderCredentialPlan(target, plan, {
    CLAWROUTER_PROVIDER_CREDENTIAL_MODE: "existing",
    CLAWROUTER_SMOKE_LIVE_PROVIDERS: "openai",
  });
  await assert.rejects(
    verifyExistingFakecoProviderCredentials(
      target,
      credentialPlan,
      {
        CLOUDFLARE_ACCOUNT_ID: "fixture-account",
        CLOUDFLARE_API_TOKEN: "cf-token",
      },
      async () => Response.json({ success: false }, { status: 404 }),
    ),
    /choose upload for the first deployment/,
  );
  await assert.rejects(
    verifyExistingFakecoProviderCredentials(
      target,
      credentialPlan,
      {
        CLOUDFLARE_ACCOUNT_ID: "fixture-account",
        CLOUDFLARE_API_TOKEN: "cf-token",
      },
      async () => Response.json({ success: true, result: [] }),
    ),
    /missing selected live provider secret bindings: OPENAI_API_KEY/,
  );
});
