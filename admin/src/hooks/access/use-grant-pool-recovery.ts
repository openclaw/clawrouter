import { useCallback, useEffect, useRef, useState } from "react";
import type { GrantPoolReadiness } from "../../../../shared/contracts";
import type { ConsoleRequest } from "../../dashboard-fetch";
import { errorMessage } from "../../domain";

type RecoveryAction = "baseline" | "scan" | "advance" | "activate" | "repair";
type Outcome = { key: string; outcome?: string; reason?: string };
type RecoveryResult = GrantPoolReadiness | { readiness: GrantPoolReadiness; outcomes: Outcome[]; cursor?: string | null };
const prefix = "/v1/admin/grant-pools";

export function useGrantPoolRecovery({ request, isCurrent, gatewayOrigin, demoMode, active }: {
  request: ConsoleRequest;
  isCurrent: () => boolean;
  gatewayOrigin: string;
  demoMode: boolean;
  active: boolean;
}) {
  const [state, setState] = useState<GrantPoolReadiness | null>(null);
  const [baseline, setBaseline] = useState<"existing" | "fresh">("existing");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [repairCursor, setRepairCursor] = useState<string | null>(null);
  const pending = useRef(false);
  const started = useRef(false);

  const run = useCallback(async (action?: RecoveryAction, body?: object) => {
    if (pending.current || demoMode || !isCurrent()) return;
    // Admission belongs to the authenticated controller, through any recovery
    // read. Leaving the tab cannot permit a second write or a stale initial GET.
    pending.current = true;
    started.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<RecoveryResult>(gatewayOrigin, `${prefix}/${action ?? "readiness"}`, action ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
      if (!isCurrent()) return;
      if ("readiness" in result) {
        setState(result.readiness);
        setOutcomes(result.outcomes);
        if (action === "repair") setRepairCursor(result.cursor ?? null);
      } else {
        setState(result);
        if (action) setOutcomes([]);
      }
    } catch (caught) {
      if (!isCurrent()) return;
      setError(errorMessage(caught));
      // A lost mutation response needs a fresh revision before another action.
      // Retired identity callbacks cannot issue this read or publish its result.
      if (action) {
        try {
          const current = await request<GrantPoolReadiness>(gatewayOrigin, `${prefix}/readiness`);
          if (isCurrent()) setState(current);
        } catch { /* Keep the failed action visible; retry is operator-owned. */ }
      }
    } finally {
      pending.current = false;
      if (isCurrent()) setBusy(false);
    }
  }, [request, isCurrent, gatewayOrigin, demoMode]);

  useEffect(() => {
    // Bootstrap may fail on a corrupt legacy account. Actual Upstream tab
    // activation, rather than bootstrap success or keyboard focus, owns this read.
    if (active && !started.current) void run();
  }, [active, run]);

  return {
    state, baseline, confirmed, busy, error, outcomes, repairCursor, demoMode,
    refresh: () => run(),
    act: run,
    setBaseline(value: "existing" | "fresh") {
      if (pending.current || !isCurrent()) return;
      setBaseline(value);
      setConfirmed(false);
    },
    setConfirmed(value: boolean) { if (!pending.current && isCurrent()) setConfirmed(value); },
  };
}

export type GrantPoolRecoveryModel = ReturnType<typeof useGrantPoolRecovery>;
