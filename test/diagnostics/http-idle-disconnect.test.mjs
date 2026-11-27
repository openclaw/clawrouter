import test from "node:test";
import { runHttpDeadlineCases } from "../helpers/http-deadline.mjs";

// Preserve the full original sequence and strict idle-case assertions.
// This command exits nonzero when the documented transport limitation reproduces.
// See docs/api-reference.md#http-cancellation-diagnostics.
test("diagnostic: HTTP deadlines and indefinitely idle disconnect accounting", { timeout: 60_000 }, t =>
  runHttpDeadlineCases(t, ["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json-pre-body-progress", "cancel-json"]));
