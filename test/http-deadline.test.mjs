import test from "node:test";
import { runHttpDeadlineCases } from "./helpers/http-deadline.mjs";

// The strict idle-disconnect reproduction has an explicit diagnostic entry point.
// See docs/api-reference.md#http-cancellation-diagnostics.
test("workerd HTTP endpoint deadline retires before delivery with caller and both ledgers still owned", { timeout: 60_000 }, t =>
  runHttpDeadlineCases(t, ["json", "sse", "headers", "first-event", "cancel-json-active", "cancel-sse", "cancel-json-pre-body-progress"], witness => reportHttpDeadlineFailure(t, witness)));

// These source-owned sentinel failures are diagnostic only. Neither errorClass
// nor a missing/partial coordinate pair describes the original reason or cause.
const httpDeadlineSentinel = Object.freeze({ diagnostic: "http-deadline-source-boundary" });
async function reportHttpDeadlineFailure(t, witness) {
  const { scenario, site } = witness;
  const errors = [];
  try {
    switch (scenario) {
      case "json": await t.test("HTTP source case: json", () => { throw httpDeadlineSentinel; }); break;
      case "sse": await t.test("HTTP source case: sse", () => { throw httpDeadlineSentinel; }); break;
      case "headers": await t.test("HTTP source case: headers", () => { throw httpDeadlineSentinel; }); break;
      case "first-event": await t.test("HTTP source case: first-event", () => { throw httpDeadlineSentinel; }); break;
      case "cancel-json-active": await t.test("HTTP source case: cancel-json-active", () => { throw httpDeadlineSentinel; }); break;
      case "cancel-sse": await t.test("HTTP source case: cancel-sse", () => { throw httpDeadlineSentinel; }); break;
      case "cancel-json-pre-body-progress": await t.test("HTTP source case: cancel-json-pre-body-progress", () => { throw httpDeadlineSentinel; }); break;
      // Shared setup/disposal has no observed case. Do not fabricate one.
      case null: break;
      default: throw new Error("Unknown HTTP fixture source case");
    }
  } catch (error) { errors.push(error); }
  try {
    switch (site) {
      case "directory": await t.test("HTTP source site: directory", () => { throw httpDeadlineSentinel; }); break;
      case "runtime_start": await t.test("HTTP source site: runtime_start", () => { throw httpDeadlineSentinel; }); break;
      case "policy_namespace": await t.test("HTTP source site: policy_namespace", () => { throw httpDeadlineSentinel; }); break;
      case "policy_setup": await t.test("HTTP source site: policy_setup", () => { throw httpDeadlineSentinel; }); break;
      case "credential_setup": await t.test("HTTP source site: credential_setup", () => { throw httpDeadlineSentinel; }); break;
      case "connection_setup": await t.test("HTTP source site: connection_setup", () => { throw httpDeadlineSentinel; }); break;
      case "direct_url": await t.test("HTTP source site: direct_url", () => { throw httpDeadlineSentinel; }); break;
      case "direct_origin": await t.test("HTTP source site: direct_origin", () => { throw httpDeadlineSentinel; }); break;
      case "budget_namespace": await t.test("HTTP source site: budget_namespace", () => { throw httpDeadlineSentinel; }); break;
      case "case_registration": await t.test("HTTP source site: case_registration", () => { throw httpDeadlineSentinel; }); break;
      case "case_setup": await t.test("HTTP source site: case_setup", () => { throw httpDeadlineSentinel; }); break;
      case "baseline_usage": await t.test("HTTP source site: baseline_usage", () => { throw httpDeadlineSentinel; }); break;
      case "baseline_ledgers": await t.test("HTTP source site: baseline_ledgers", () => { throw httpDeadlineSentinel; }); break;
      case "baseline_selection": await t.test("HTTP source site: baseline_selection", () => { throw httpDeadlineSentinel; }); break;
      case "watch_progress": await t.test("HTTP source site: watch_progress", () => { throw httpDeadlineSentinel; }); break;
      case "watch_stop_check": await t.test("HTTP source site: watch_stop_check", () => { throw httpDeadlineSentinel; }); break;
      case "watch_bookkeeping": await t.test("HTTP source site: watch_bookkeeping", () => { throw httpDeadlineSentinel; }); break;
      case "watch_caller_abort": await t.test("HTTP source site: watch_caller_abort", () => { throw httpDeadlineSentinel; }); break;
      case "request_fetch": await t.test("HTTP source site: request_fetch", () => { throw httpDeadlineSentinel; }); break;
      case "reader_decoder": await t.test("HTTP source site: reader_decoder", () => { throw httpDeadlineSentinel; }); break;
      case "reader_read": await t.test("HTTP source site: reader_read", () => { throw httpDeadlineSentinel; }); break;
      case "reader_result": await t.test("HTTP source site: reader_result", () => { throw httpDeadlineSentinel; }); break;
      case "response_bookkeeping": await t.test("HTTP source site: response_bookkeeping", () => { throw httpDeadlineSentinel; }); break;
      case "reader_acquire": await t.test("HTTP source site: reader_acquire", () => { throw httpDeadlineSentinel; }); break;
      case "reader_release": await t.test("HTTP source site: reader_release", () => { throw httpDeadlineSentinel; }); break;
      case "request_failure_bookkeeping": await t.test("HTTP source site: request_failure_bookkeeping", () => { throw httpDeadlineSentinel; }); break;
      case "cancellation_join": await t.test("HTTP source site: cancellation_join", () => { throw httpDeadlineSentinel; }); break;
      case "request_join": await t.test("HTTP source site: request_join", () => { throw httpDeadlineSentinel; }); break;
      case "cancellation_match_operand": await t.test("HTTP source site: cancellation_match_operand", () => { throw httpDeadlineSentinel; }); break;
      case "settlement": await t.test("HTTP source site: settlement", () => { throw httpDeadlineSentinel; }); break;
      case "receipt_selection": await t.test("HTTP source site: receipt_selection", () => { throw httpDeadlineSentinel; }); break;
      case "ledger_selection": await t.test("HTTP source site: ledger_selection", () => { throw httpDeadlineSentinel; }); break;
      case "cleanup_watch_abort": await t.test("HTTP source site: cleanup_watch_abort", () => { throw httpDeadlineSentinel; }); break;
      case "cleanup_caller_abort": await t.test("HTTP source site: cleanup_caller_abort", () => { throw httpDeadlineSentinel; }); break;
      case "cleanup_join": await t.test("HTTP source site: cleanup_join", () => { throw httpDeadlineSentinel; }); break;
      case "cleanup_settlement": await t.test("HTTP source site: cleanup_settlement", () => { throw httpDeadlineSentinel; }); break;
      case "cleanup_diagnostic": await t.test("HTTP source site: cleanup_diagnostic", () => { throw httpDeadlineSentinel; }); break;
      case "runtime_dispose": await t.test("HTTP source site: runtime_dispose", () => { throw httpDeadlineSentinel; }); break;
      case "directory_remove": await t.test("HTTP source site: directory_remove", () => { throw httpDeadlineSentinel; }); break;
      case "check_01_operands": await t.test("HTTP source site: check_01_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_01_assertion": await t.test("HTTP source site: check_01_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_02_operands": await t.test("HTTP source site: check_02_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_02_assertion": await t.test("HTTP source site: check_02_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_03_operands": await t.test("HTTP source site: check_03_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_03_assertion": await t.test("HTTP source site: check_03_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_04_operands": await t.test("HTTP source site: check_04_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_04_assertion": await t.test("HTTP source site: check_04_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_05_operands": await t.test("HTTP source site: check_05_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_05_assertion": await t.test("HTTP source site: check_05_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_06_operands": await t.test("HTTP source site: check_06_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_06_assertion": await t.test("HTTP source site: check_06_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_07_operands": await t.test("HTTP source site: check_07_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_07_assertion": await t.test("HTTP source site: check_07_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_08_operands": await t.test("HTTP source site: check_08_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_08_assertion": await t.test("HTTP source site: check_08_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_09_operands": await t.test("HTTP source site: check_09_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_09_assertion": await t.test("HTTP source site: check_09_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_10_operands": await t.test("HTTP source site: check_10_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_10_assertion": await t.test("HTTP source site: check_10_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_11_operands": await t.test("HTTP source site: check_11_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_11_assertion": await t.test("HTTP source site: check_11_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_12_operands": await t.test("HTTP source site: check_12_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_12_assertion": await t.test("HTTP source site: check_12_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_13_operands": await t.test("HTTP source site: check_13_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_13_assertion": await t.test("HTTP source site: check_13_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_14_operands": await t.test("HTTP source site: check_14_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_14_assertion": await t.test("HTTP source site: check_14_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_15_operands": await t.test("HTTP source site: check_15_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_15_assertion": await t.test("HTTP source site: check_15_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_16_operands": await t.test("HTTP source site: check_16_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_16_assertion": await t.test("HTTP source site: check_16_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_17_operands": await t.test("HTTP source site: check_17_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_17_assertion": await t.test("HTTP source site: check_17_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_18_operands": await t.test("HTTP source site: check_18_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_18_assertion": await t.test("HTTP source site: check_18_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_19_operands": await t.test("HTTP source site: check_19_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_19_assertion": await t.test("HTTP source site: check_19_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_20_operands": await t.test("HTTP source site: check_20_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_20_assertion": await t.test("HTTP source site: check_20_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_21_operands": await t.test("HTTP source site: check_21_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_21_assertion": await t.test("HTTP source site: check_21_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_22_operands": await t.test("HTTP source site: check_22_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_22_assertion": await t.test("HTTP source site: check_22_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_23_operands": await t.test("HTTP source site: check_23_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_23_assertion": await t.test("HTTP source site: check_23_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_24_operands": await t.test("HTTP source site: check_24_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_24_assertion": await t.test("HTTP source site: check_24_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_25_operands": await t.test("HTTP source site: check_25_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_25_assertion": await t.test("HTTP source site: check_25_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_26_operands": await t.test("HTTP source site: check_26_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_26_assertion": await t.test("HTTP source site: check_26_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_27_operands": await t.test("HTTP source site: check_27_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_27_assertion": await t.test("HTTP source site: check_27_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_28_operands": await t.test("HTTP source site: check_28_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_28_assertion": await t.test("HTTP source site: check_28_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_29_operands": await t.test("HTTP source site: check_29_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_29_assertion": await t.test("HTTP source site: check_29_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_30_operands": await t.test("HTTP source site: check_30_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_30_assertion": await t.test("HTTP source site: check_30_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_31_operands": await t.test("HTTP source site: check_31_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_31_assertion": await t.test("HTTP source site: check_31_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_32_operands": await t.test("HTTP source site: check_32_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_32_assertion": await t.test("HTTP source site: check_32_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_33_operands": await t.test("HTTP source site: check_33_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_33_assertion": await t.test("HTTP source site: check_33_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_34_operands": await t.test("HTTP source site: check_34_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_34_assertion": await t.test("HTTP source site: check_34_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_35_operands": await t.test("HTTP source site: check_35_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_35_assertion": await t.test("HTTP source site: check_35_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_36_operands": await t.test("HTTP source site: check_36_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_36_assertion": await t.test("HTTP source site: check_36_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_37_operands": await t.test("HTTP source site: check_37_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_37_assertion": await t.test("HTTP source site: check_37_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_38_operands": await t.test("HTTP source site: check_38_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_38_assertion": await t.test("HTTP source site: check_38_assertion", () => { throw httpDeadlineSentinel; }); break;
      case "check_39_operands": await t.test("HTTP source site: check_39_operands", () => { throw httpDeadlineSentinel; }); break;
      case "check_39_assertion": await t.test("HTTP source site: check_39_assertion", () => { throw httpDeadlineSentinel; }); break;
      default: throw new Error("Unknown HTTP fixture source site");
    }
  } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "HTTP source marker reporting failed");
}
