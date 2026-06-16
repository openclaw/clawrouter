import assert from "node:assert/strict";
import test from "node:test";

import { assertAccessGateResponse } from "../scripts/smoke-access-gate.mjs";

test("Access smoke rejects ClawRouter JSON fallbacks", () => {
  for (const code of ["access_session_required", "access_admin_required", "admin_auth_required"]) {
    const response = Response.json({ error: { code } }, { status: 403 });
    assert.throws(
      () =>
        assertAccessGateResponse(
          response,
          response.headers.get("content-type") ?? "",
          JSON.stringify({ error: { code } }),
          "protected route",
        ),
      new RegExp(code),
    );
  }
});

test("Access smoke accepts redirects and non-ClawRouter challenges", () => {
  assert.doesNotThrow(() =>
    assertAccessGateResponse(new Response(null, { status: 302 }), "", "", "protected route"),
  );
  assert.doesNotThrow(() =>
    assertAccessGateResponse(
      new Response("Forbidden", { status: 403 }),
      "text/plain",
      "Forbidden",
      "protected route",
    ),
  );
});
