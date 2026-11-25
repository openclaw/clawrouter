import { isDeepStrictEqual } from "node:util";

const warning = /^# \(node:[1-9][0-9]*\) \[UNDICI-ES\] Warning: EventSource is experimental, expect them to change at any time\.(\r?)$/gm;

function canonicalFeedbackRequest(request) {
  const input = request?.body?.input;
  if (!Array.isArray(input) || input.length !== 3 || input[2]?.role !== "user" || typeof input[2].content !== "string") {
    throw new Error("recorded_repair_request_shape");
  }
  let payload;
  try { payload = JSON.parse(input[2].content); } catch { throw new Error("recorded_repair_request_json"); }
  if (JSON.stringify(payload) !== input[2].content || typeof payload?.acceptance?.feedback !== "string") {
    throw new Error("recorded_repair_feedback_shape");
  }
  const feedback = payload.acceptance.feedback, parts = [];
  let warnings = 0, offset = 0;
  for (const match of feedback.matchAll(warning)) {
    parts.push(feedback.slice(offset, match.index), { eventSourceWarning: true, cr: match[1] });
    offset = match.index + match[0].length;
    warnings++;
  }
  parts.push(feedback.slice(offset));
  payload.acceptance.feedback = parts;
  const normalized = structuredClone(request);
  normalized.body.input[2].content = JSON.stringify(payload);
  return { normalized, warnings };
}

// Replay only: restore literal recorded bytes after checking the complete
// request. Only the PID in this exact runtime warning may differ. Never use
// this to build a new inference request or to compare grading outcomes.
export function reconcileRecordedRepairRequest(actual, recorded) {
  if (isDeepStrictEqual(actual, recorded)) return { request: actual, substituted: false, warnings: 0 };
  const a = canonicalFeedbackRequest(actual), b = canonicalFeedbackRequest(recorded);
  if (!a.warnings || a.warnings !== b.warnings || !isDeepStrictEqual(a.normalized, b.normalized)) {
    throw new Error("recorded_repair_request_mismatch");
  }
  return { request: structuredClone(recorded), substituted: true, warnings: a.warnings };
}
