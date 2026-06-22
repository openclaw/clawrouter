import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, readJson } from "../utils.ts";

test("JSON request parsing rejects bodies above the 8 MiB edge limit", async () => {
  const request = new Request("https://example.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "x".repeat(8 * 1024 * 1024) }),
  });
  await assert.rejects(readJson(request), (error) => error instanceof HttpError && error.status === 413 && error.code === "request_too_large");
});
