import test from "node:test";
import { runHttpDeadlineCases } from "./helpers/http-deadline.mjs";

// The strict idle-disconnect reproduction has an explicit diagnostic entry point.
// See docs/api-reference.md#http-cancellation-diagnostics.
test("workerd HTTP endpoint deadline retires before delivery with caller and both ledgers still owned", { timeout: 60_000 }, t =>
  runHttpDeadlineCases(t, ["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json-pre-body-progress"]));
