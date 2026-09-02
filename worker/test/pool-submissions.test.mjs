import assert from "node:assert/strict";
import test from "node:test";
import { poolSubmissionApi } from "../pool-submissions.ts";
import { sha256Hex } from "../utils.ts";
import { attachGrantCredentialNamespace } from "./grant-credential-mock.mjs";

test("a scoped ticket stores only redacted grant metadata in KV", async () => {
  const values = new Map(), ticketToken = "submission-secret";
  const env = await submissionEnv(values, ticketToken);
  const response = await poolSubmissionApi(request(ticketToken, {
    accessToken: "access-private",
    refreshToken: "refresh-private",
    accountId: "account-test",
    expiresAt: "2026-09-03T00:00:00.000Z",
  }), env, "/v1/pool-submissions/pst_submission_ticket_1/consume");

  assert.equal(response.status, 201);
  assert.equal((await response.json()).outcome, "accepted");
  const stored = values.get("oauth/policy/openai-maintainer");
  assert.equal(stored.provider, "openai");
  assert.equal(stored.kind, "subscription");
  assert.equal(stored.credentialStore, "durable_object");
  assert.equal(stored.hasAccessToken, true);
  assert.equal(stored.hasRefreshToken, true);
  assert.equal(stored.accessToken, undefined);
  assert.equal(stored.refreshToken, undefined);
  assert.equal(JSON.stringify(stored).includes("private"), false);
});

test("normal ClawRouter credentials cannot act as submission tickets", async () => {
  const values = new Map();
  const env = await submissionEnv(values, "submission-secret");
  const response = await poolSubmissionApi(request("clawrouter-live-abcd-secretsecret", { accessToken: "access-private" }), env, "/v1/pool-submissions/pst_submission_ticket_1/consume");
  assert.equal(response.status, 401);
  assert.equal(values.size, 0);
});

test("contributors cannot inject refresh endpoints or change ticket scope", async () => {
  const values = new Map();
  const env = await submissionEnv(values, "submission-secret");
  const response = await poolSubmissionApi(request("submission-secret", { accessToken: "access-private", refresh: { tokenUrl: "https://attacker.invalid" } }), env, "/v1/pool-submissions/pst_submission_ticket_1/consume");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_pool_submission");
  assert.equal(values.size, 0);
  assert.equal(env.released, 1);
});

async function submissionEnv(values, ticketToken) {
  const expectedDigest = await sha256Hex(ticketToken);
  const env = {
    released: 0,
    POLICY_KV: {
      async get(key) { return structuredClone(values.get(key) ?? null); },
      async put(key, value) { values.set(key, JSON.parse(value)); },
    },
    ACCESS_CONTROL: {
      idFromName(name) { return name; },
      get() {
        return { async fetch(url, init) {
          const path = new URL(url).pathname, body = JSON.parse(init.body);
          if (path === "/submission-tickets/claim") {
            if (body.secretSha256 !== expectedDigest) return Response.json({ outcome: "denied" });
            return Response.json({ outcome: "claimed", claimId: "claim-1", ticket: ticketView() });
          }
          if (path === "/submission-tickets/complete") return Response.json({ outcome: "already_consumed", ticket: ticketView(), receipt: body.receipt });
          if (path === "/submission-tickets/release") { env.released += 1; return new Response("released"); }
          if (path === "/grant-pools/sync") return new Response("updated");
          return new Response("not found", { status: 404 });
        } };
      },
    },
  };
  return attachGrantCredentialNamespace(env);
}

function request(token, body) {
  return new Request("https://router.example/v1/pool-submissions/pst_submission_ticket_1/consume", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ticketView() {
  return {
    id: "pst_submission_ticket_1",
    scope: "policies",
    scopeId: "policy",
    tokenRef: "openai-maintainer",
    provider: "openai",
    kind: "subscription",
    label: "Maintainer",
    priority: 100,
    weight: 1,
    contributor: "maintainer@example.com",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    state: "claimed",
  };
}
