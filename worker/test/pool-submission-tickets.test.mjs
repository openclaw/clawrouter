import assert from "node:assert/strict";
import test from "node:test";
import { PolicyBindingIndexObject } from "../authority.ts";

test("submission tickets are secret-hashed, payload-bound, and idempotent", async () => {
  const { authority } = authorityFixture();
  const ticket = ticketFixture();
  const created = await post(authority, "/submission-tickets/put", ticket);
  assert.equal(created.response.status, 200);
  assert.equal(created.body.id, ticket.id);
  assert.equal("secretSha256" in created.body, false);

  const wrong = await post(authority, "/submission-tickets/claim", { id: ticket.id, secretSha256: "f".repeat(64), submissionSha256: "b".repeat(64) });
  assert.deepEqual(wrong.body, { outcome: "denied" });

  const claimed = await post(authority, "/submission-tickets/claim", { id: ticket.id, secretSha256: ticket.secretSha256, submissionSha256: "b".repeat(64) });
  assert.equal(claimed.body.outcome, "claimed");
  assert.equal(typeof claimed.body.claimId, "string");
  assert.equal("secretSha256" in claimed.body.ticket, false);

  const changedReplay = await post(authority, "/submission-tickets/claim", { id: ticket.id, secretSha256: ticket.secretSha256, submissionSha256: "c".repeat(64) });
  assert.deepEqual(changedReplay.body, { outcome: "denied" });

  const receipt = { grantKey: "oauth/policy/openai-maintainer", submittedAt: "2026-09-02T18:00:00.000Z" };
  const completed = await post(authority, "/submission-tickets/complete", { id: ticket.id, claimId: claimed.body.claimId, receipt });
  assert.equal(completed.body.outcome, "already_consumed");
  assert.deepEqual(completed.body.receipt, receipt);

  const replay = await post(authority, "/submission-tickets/claim", { id: ticket.id, secretSha256: ticket.secretSha256, submissionSha256: "b".repeat(64) });
  assert.equal(replay.body.outcome, "already_consumed");
  assert.deepEqual(replay.body.receipt, receipt);
});

test("expired submission tickets cannot be claimed", async () => {
  const { authority, tickets } = authorityFixture();
  const ticket = ticketFixture({ id: "pst_expired_ticket_1" });
  await post(authority, "/submission-tickets/put", ticket);
  tickets.set(ticket.id, JSON.stringify({ ...JSON.parse(tickets.get(ticket.id)), expiresAtMs: Date.now() - 1 }));
  const result = await post(authority, "/submission-tickets/claim", { id: ticket.id, secretSha256: ticket.secretSha256, submissionSha256: "b".repeat(64) });
  assert.deepEqual(result.body, { outcome: "expired" });
});

function authorityFixture() {
  const tickets = new Map();
  const sql = {
    exec(query, ...params) {
      if (query.startsWith("CREATE TABLE")) return [];
      if (query.startsWith("SELECT ticket_json FROM pool_submission_tickets")) {
        const value = tickets.get(params[0]);
        return value ? [{ ticket_json: value }] : [];
      }
      if (query.startsWith("DELETE FROM pool_submission_tickets")) {
        for (const [id, value] of tickets) if (JSON.parse(value).expiresAtMs < params[0]) tickets.delete(id);
        return [];
      }
      if (query.startsWith("INSERT INTO pool_submission_tickets") || query.startsWith("INSERT OR REPLACE INTO pool_submission_tickets")) {
        tickets.set(params[0], params[1]);
        return [];
      }
      return [];
    },
  };
  return { authority: new PolicyBindingIndexObject({ storage: { sql } }), tickets };
}

async function post(authority, path, body) {
  const response = await authority.fetch(new Request(`https://clawrouter.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { response, body: await response.json() };
}

function ticketFixture(overrides = {}) {
  const now = Date.now();
  return {
    id: "pst_submission_ticket_1",
    secretSha256: "a".repeat(64),
    scope: "policies",
    scopeId: "policy",
    tokenRef: "openai-maintainer",
    provider: "openai",
    kind: "subscription",
    label: "Maintainer",
    priority: 100,
    weight: 1,
    contributor: "maintainer@example.com",
    createdAtMs: now,
    expiresAtMs: now + 15 * 60_000,
    state: "ready",
    ...overrides,
  };
}
