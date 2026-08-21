import assert from "node:assert/strict";
import test from "node:test";

import { PolicyBindingIndexObject } from "../authority.ts";

test("authority responses preserve validation errors and hide runtime failures", async () => {
  let failReads = false;
  const sql = {
    exec(query) {
      if (failReads && query.startsWith("SELECT")) {
        throw new Error("private-stack-sentinel");
      }
      return [];
    },
  };
  const authority = new PolicyBindingIndexObject({ storage: { sql } });

  const invalid = await authority.fetch(
    new Request("https://clawrouter.internal/grant-pools/states", {
      method: "POST",
      body: JSON.stringify({ keys: "not-an-array" }),
    }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: {
      code: "authority_error",
      message: "grant runtime keys must be a bounded array",
    },
  });

  const malformed = await authority.fetch(
    new Request("https://clawrouter.internal/grant-pools/states", {
      method: "POST",
      body: "{",
    }),
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: {
      code: "invalid_json",
      message: "request body must be valid JSON",
    },
  });

  failReads = true;
  const failed = await authority.fetch(
    new Request("https://clawrouter.internal/list", {
      method: "POST",
      body: "{}",
    }),
  );
  assert.equal(failed.status, 500);
  const body = await failed.json();
  assert.deepEqual(body, {
    error: { code: "authority_error", message: "authority request failed" },
  });
  assert.doesNotMatch(JSON.stringify(body), /private-stack-sentinel/);
});
