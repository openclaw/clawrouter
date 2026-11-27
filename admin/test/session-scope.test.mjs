import assert from "node:assert/strict";
import test from "node:test";
import { browserSession, sessionScopeKey } from "../src/session-scope.ts";

const session = { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", tenantId: "default", subject: "identity-a" };

test("only a verified browser identity can mount protected console data", () => {
  assert.equal(browserSession(session), true);
  assert.equal(browserSession({ ...session, auth: "local", subject: null }), true);
  for (const value of [null, [], {}, { ...session, authenticated: false }, { ...session, auth: "admin_token" }, { ...session, auth: "demo" }, { ...session, role: "owner" }, { ...session, email: "" }, { ...session, subject: {} }, { ...session, tenantId: 3 }]) assert.equal(browserSession(value), false);
});

test("identity changes discard data while same-identity metadata does not", () => {
  const scope = { origin: "https://console.example", demo: false, session };
  const key = sessionScopeKey(scope);
  for (const next of [{ ...scope, origin: "https://other.example" }, { ...scope, demo: true }, ...[{ subject: "identity-b" }, { email: "second@example.com" }, { auth: "local" }, { role: "user" }, { tenantId: "other" }, { authenticated: false }].map((change) => ({ ...scope, session: { ...session, ...change } }))]) assert.notEqual(sessionScopeKey(next), key);
  assert.equal(sessionScopeKey({ ...scope, session: { ...session, groups: ["new-group"], entitlements: { providers: [] } } }), key);
  assert.equal(sessionScopeKey({ ...scope, session: { ...session, subject: undefined } }), sessionScopeKey({ ...scope, session: { ...session, subject: null } }));
});
